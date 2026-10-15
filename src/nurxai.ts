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
  createdAt: string;
};

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
export function isAskableTopic(
  topic: Pick<QueueTopic, "key" | "entityType" | "knownSummary" | "recentPosts">
): boolean {
  if (!(topic.knownSummary ?? "").trim() && !(topic.recentPosts ?? []).length) return false;
  if (topic.entityType) return true;
  return !/^x-[a-z0-9_]+$/i.test(topic.key);
}

/**
 * Picks the topic to ask about, preferring one we can actually be specific about.
 *
 * A topic with no post on file can only be asked about by name, and a name is not a
 * question — "Acca, Git niye aktu bolo" is what that produces. So a topic carrying a
 * recent angle wins over one that is not, and a bare topic is only used when there is
 * nothing better. That case is real and temporary: post contexts started being
 * written on the day this arrived, so every topic the queue held beforehand is bare.
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
