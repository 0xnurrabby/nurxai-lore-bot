import crypto from "node:crypto";
import type { Config } from "./config.ts";
import { warn } from "./config.ts";
import type { LoreRecord } from "./record.ts";

// The bot's only door into NurXai, and the only place a secret is used.
//
// Two calls exist: ask what needs lore, and file lore. There is no query
// language, no table name and no SQL anywhere in this process, so there is
// nothing here to inject into even if every string it handles were hostile.
//
// Signing format (must match dashboard/lib/entity/agent-auth.ts):
//   HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${sha256hex(body)}`)

export type RecentPost = {
  author: string | null;
  postText: string;
  /** Signal words the post carried that the stored record does not cover. */
  missing?: string[];
  /** The post's own permalink, when NurXai could read one. */
  postUrl?: string | null;
  createdAt: string;
};

/**
 * Is this the address of a post on X, and nothing else?
 *
 * The value starts life as a scraped DOM attribute and ends up as the target of a
 * link the operator taps, so it is checked on both sides of the wire rather than
 * trusted on either. Mirrors `isStatusUrl` in NurXai's extract.ts, deliberately:
 * neither side should be the only one that cares.
 */
export function isStatusUrl(value: string | null | undefined): boolean {
  return /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_/.-]*status\/\d{1,25}$/.test((value ?? "").trim());
}

export type QueueTopic = {
  key: string;
  label: string;
  entityType: string | null;
  reason: "no_lore" | "stale";
  misses: number;
  lastSeenAt: string;
  knownSummary: string | null;
  /** What the posts that produced this miss were actually about, newest first. */
  recentPosts?: RecentPost[];
};

export type QueueResponse = {
  generatedAt: string;
  windowDays: number;
  minMisses: number;
  postContextHours?: number;
  topics: QueueTopic[];
};

export type WriteResponse = {
  ok: true;
  key: string;
  entityId: string;
  created: boolean;
  accepted: boolean;
  confidence: number;
  freshnessUntil: string;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/**
 * When a post arrived, in epoch milliseconds.
 *
 * Two formats have to work: SQLite's `datetime('now')`, which is `YYYY-MM-DD HH:MM:SS`
 * in UTC with no zone marker, and an ISO string. The first is what post_contexts
 * writes. Reading it as local time would be wrong by the offset — and a post's age is
 * now what decides whether a question is justified, so being hours out matters.
 */
export function postTimeMs(createdAt: string): number {
  const raw = (createdAt || "").trim();
  if (!raw) return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Why a topic is not worth asking about at all, or null if it is.
 *
 * Two refusals for two different reasons, kept apart because they want different
 * log lines and different fixes:
 *
 *   nothing-to-say — no record and no post. The question could only name the topic
 *                    ("Acca, Git niye aktu bolo"), which a search engine cannot
 *                    answer and the operator should not have to read.
 *   an-account     — a bare `x-<handle>` with no entity type. The resolver found
 *                    nothing to call the subject and fell back to the author or a
 *                    mention. That is a person, and NurXai's own rule is that lore is
 *                    never keyed on one.
 *   an-address     — "Dear Claude" and the like. A salutation addressed to several
 *                    products is not a company, and asking a search engine what it
 *                    is produces a question the operator can only be embarrassed by.
 */
export type TopicRefusal = "nothing-to-say" | "an-account" | "an-address" | null;

/**
 * A salutation is not a subject.
 *
 * "Dear Claude" is how one post addressed four AI products in an open letter. It is
 * not a company, a protocol or a token, and a research question built from it can
 * only ask the operator whether a greeting is a project. Whatever the extractor did
 * upstream, this is the last place such a topic can be stopped before it reaches the
 * operator's chat.
 */
export function isAddressedLabel(label: string, key: string): boolean {
  const fromKey = key.replace(/^(?:name|narr|topic|org|co|person)-/, "").replace(/[-_]+/g, " ").trim();
  return /^(dear|hi|hello|hey|to|attention)\b/i.test(label.trim()) ||
    /^(dear|hi|hello|hey|to|attention)\b/i.test(fromKey);
}

export function refusalReason(
  topic: Pick<QueueTopic, "key" | "entityType"> &
    Partial<Pick<QueueTopic, "label" | "knownSummary" | "recentPosts">>
): TopicRefusal {
  const hasSomething = Boolean((topic.knownSummary ?? "").trim()) || (topic.recentPosts ?? []).length > 0;
  if (!hasSomething) return "nothing-to-say";
  if (isAddressedLabel(topic.label ?? "", topic.key)) return "an-address";
  if (topic.entityType) return null;
  return /^x-[a-z0-9_]+$/i.test(topic.key) ? "an-account" : null;
}

export function isAskableTopic(
  topic: Pick<QueueTopic, "key" | "entityType"> &
    Partial<Pick<QueueTopic, "label" | "knownSummary" | "recentPosts">>
): boolean {
  return refusalReason(topic) === null;
}

/**
 * The post that justifies asking about this topic, or null if nothing does.
 *
 * A prompt must be caused by something the operator did. A stale record is not a
 * cause, and treating it as one is exactly what produced the same three questions,
 * two hours apart, days after they had been answered — "kono karon chara", as the
 * operator put it. What justifies a question is a post they commented on since we
 * last asked: the first question is caused by the post that raised the topic, and a
 * refresh is caused by a newer post that suggests the record is behind.
 *
 * A post that arrived before our last question has already had its question. Asking
 * about it again is the same thing over again, which is the complaint.
 */
export function justifiedBy(
  topic: Pick<QueueTopic, "recentPosts">,
  lastAskedAt: number | null,
  now = Date.now()
): RecentPost | null {
  const posts = (topic.recentPosts ?? []).filter((post) => postTimeMs(post.createdAt) > 0);
  if (!posts.length) return null;

  let newest = posts[0]!;
  for (const post of posts) {
    if (postTimeMs(post.createdAt) > postTimeMs(newest.createdAt)) newest = post;
  }

  const arrivedAt = postTimeMs(newest.createdAt);
  // A post from the future is a clock disagreement, not a cause. Treat it as now:
  // refusing would go silent forever, and accepting it is what a corrected clock does.
  if (arrivedAt > now + 60_000) return newest;
  if (lastAskedAt !== null && arrivedAt <= lastAskedAt) return null;
  return newest;
}

/**
 * Whether a topic is worth asking the operator about.
 *
 * Two refusals, for two different reasons.
 *
 * A question with nothing to say is the failure this exists to prevent. A topic
 * with no record and no post can only be named — "Acca, Git niye aktu bolo" — which
 * a search engine cannot answer and the operator cannot use. So a topic is worth
 * asking about only when there is something to be specific about: a record to
 * correct, or a post to quote. A topic that has gone quiet for a day therefore
 * drops out on its own, which is the intended shape — it comes back when a post
 * about it arrives again.
 *
 * And an `x-<handle>` key with no entity type means the resolver found nothing to
 * call the subject and fell back to the author of the post. That is a stranger, not
 * a topic, and NurXai's own rule is that lore is never keyed on an individual
 * author. A handle that resolved to a real profile is attributed to that profile's
 * key instead, so what is left as a bare handle really is an unresolved post.
 *
 * Guards, not fixes. The scoring that decides the subject lives on the NurXai side.
 */
export function preferWithPosts(topics: QueueTopic[]): QueueTopic | null {
  return topics.find((topic) => (topic.recentPosts?.length ?? 0) > 0) ?? topics[0] ?? null;
}

const QUEUE_PATH = "/api/lore/queue";
const WRITE_PATH = "/api/lore";

/**
 * Errors that mean "the two sides disagree", as opposed to "the network is having
 * a minute". Only the first kind is worth telling the operator about at startup,
 * because only the first kind is something anyone can go and fix.
 */
export function isSetupError(error: string): boolean {
  return ["LORE_AGENT_DISABLED", "BAD_SIGNATURE", "STALE_SIGNATURE", "BAD_TIMESTAMP", "SIGNATURE_REQUIRED"].includes(
    error
  );
}

export function signRequest(secret: string, method: string, path: string, timestamp: string, body: string): string {
  const digest = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${method.toUpperCase()}.${path}.${digest}`, "utf8")
    .digest("hex");
}

export class NurxaiClient {
  constructor(private readonly config: Config) {}

  private async request<T>(method: "GET" | "POST", path: string, bodyObject?: unknown): Promise<ApiResult<T>> {
    const body = bodyObject === undefined ? "" : JSON.stringify(bodyObject);
    const timestamp = String(Date.now());
    const signature = signRequest(this.config.secret, method, path, timestamp, body);

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          "x-lore-agent-timestamp": timestamp,
          "x-lore-agent-signature": signature,
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body || undefined,
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error: any) {
      warn("[nurxai]", method, path, "unreachable", error?.message || "?");
      return { ok: false, status: 0, error: "UNREACHABLE" };
    }

    const payload = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const error = typeof payload?.error === "string" ? payload.error : `HTTP_${res.status}`;
      // A clock that has drifted past the five-minute window looks exactly like a
      // wrong secret from here, and the two need different fixes, so say so.
      if (error === "STALE_SIGNATURE" || error === "BAD_TIMESTAMP") {
        warn("[nurxai] the request clock is outside the five-minute window — check this host's time");
      }
      if (error === "BAD_SIGNATURE") {
        warn("[nurxai] signature rejected — LORE_AGENT_SECRET here must equal the one on NurXai");
      }
      return { ok: false, status: res.status, error };
    }
    return { ok: true, data: payload as T };
  }

  async queue(): Promise<ApiResult<QueueResponse>> {
    return this.request<QueueResponse>("GET", QUEUE_PATH);
  }

  async write(key: string, record: LoreRecord): Promise<ApiResult<WriteResponse>> {
    return this.request<WriteResponse>("POST", WRITE_PATH, { key, intel: record });
  }
}
