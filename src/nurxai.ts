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
 * Whether a topic is a subject or just the account that happened to post.
 *
 * An `x-<handle>` key with no entity type means the resolver found nothing to
 * call the subject and fell back to the author. That is not a topic — it is a
 * stranger — and NurXai's own rule is that lore is never keyed on an individual
 * author. So the bot refuses to ask about one rather than spending a research on
 * a private person and writing them into the store.
 *
 * This is a guard, not a fix. It stops the noise; the scoring that makes an
 * author outrank the subject is on the NurXai side and still needs to change.
 */
export function isAskableTopic(topic: Pick<QueueTopic, "key" | "entityType">): boolean {
  if (topic.entityType) return true;
  return !/^x-[a-z0-9_]+$/i.test(topic.key);
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
