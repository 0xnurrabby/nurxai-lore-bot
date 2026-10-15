import fs from "node:fs";
import path from "node:path";
import { warn } from "./config.ts";

// Local state, in one small JSON file.
//
// It holds four things and nothing else: where the Telegram poll got to, which
// topic is waiting for a paste, when each topic was last asked about, and which
// Telegram message carried which brief. None of it is secret, none of it is a
// copy of the lore — the lore lives in NurXai and nowhere else.

export type PendingAsk = {
  key: string;
  label: string;
  reason: "no_lore" | "stale";
  askedAt: number;
};

/** Which brief a message carried, so a reply to it resolves the topic. */
export type SentBrief = {
  key: string;
  label: string;
  reason: "no_lore" | "stale";
  askedAt: number;
};

export type State = {
  version: 1;
  /** The next Telegram update offset. Persisted so a restart does not replay commands. */
  offset: number;
  /** At most one outstanding ask, so a paste is never ambiguous. */
  pending: PendingAsk | null;
  /** key → when we last asked. This is the bot's own cooldown. */
  asked: Record<string, { at: number; reason: string }>;
  /**
   * `"<chatId>:<messageId>"` → the brief that message carried.
   *
   * Message ids are unique per chat, not globally, so the chat is part of the
   * key: two operators being sent the same brief would otherwise collide on
   * whatever id Telegram happened to hand the second chat.
   *
   * This is what makes replying to a prompt from three days ago file against the
   * right topic. Without it the only thing identifying a paste would be "whatever
   * is pending now", and an old prompt would be answered against today's subject.
   */
  briefs: Record<string, SentBrief>;
};

/** How long a sent prompt stays answerable by reply. */
const BRIEF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** And how many of them we keep, so the file cannot grow without limit. */
const BRIEF_MAX = 200;
const ASKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyState(): State {
  return { version: 1, offset: 0, pending: null, asked: {}, briefs: {} };
}

export function loadState(file: string): State {
  try {
    if (!fs.existsSync(file)) return emptyState();
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<State>;
    return {
      version: 1,
      offset: typeof raw.offset === "number" && Number.isFinite(raw.offset) ? raw.offset : 0,
      pending: raw.pending && typeof raw.pending.key === "string" ? (raw.pending as PendingAsk) : null,
      asked: raw.asked && typeof raw.asked === "object" ? (raw.asked as State["asked"]) : {},
      briefs: raw.briefs && typeof raw.briefs === "object" ? (raw.briefs as State["briefs"]) : {}
    };
  } catch (error: any) {
    // A corrupt state file must not stop the bot: the worst case is re-asking a
    // topic, which is free, where refusing to start is not.
    warn("[state] could not read", file, error?.message || "?", "— starting fresh");
    return emptyState();
  }
}

export function saveState(file: string, state: State): void {
  const trimmed: State = {
    ...state,
    asked: pruneAsked(state.asked, Date.now()),
    briefs: pruneBriefs(state.briefs, Date.now())
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // Write then rename: a crash mid-write leaves the previous file intact rather
    // than a truncated one.
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (error: any) {
    warn("[state] could not write", file, error?.message || "?");
  }
}

export function pruneAsked(asked: State["asked"], now: number): State["asked"] {
  const out: State["asked"] = {};
  for (const [key, entry] of Object.entries(asked)) {
    if (entry && now - Number(entry.at) < ASKED_TTL_MS) out[key] = entry;
  }
  return out;
}

export function pruneBriefs(briefs: State["briefs"], now: number): State["briefs"] {
  const kept = Object.entries(briefs)
    .filter(([, brief]) => brief && typeof brief.key === "string" && now - Number(brief.askedAt) < BRIEF_TTL_MS)
    // Oldest first, then drop from the front: a burst of asking must not push out
    // the prompt somebody is slowly working through.
    .sort((a, b) => Number(a[1].askedAt) - Number(b[1].askedAt))
    .slice(-BRIEF_MAX);
  return Object.fromEntries(kept);
}

export function briefMessageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Records that these messages carried this brief, so a reply to any of them —
 * part one of three, the header, a week later — resolves the topic.
 */
export function rememberBrief(state: State, chatId: number, messageIds: number[], ask: PendingAsk): void {
  for (const messageId of messageIds) {
    state.briefs[briefMessageKey(chatId, messageId)] = {
      key: ask.key,
      label: ask.label,
      reason: ask.reason,
      askedAt: ask.askedAt
    };
  }
}

/**
 * Whether an open question has waited long enough to stop blocking the next one.
 *
 * The clock is the ask's own timestamp, like the cooldown: two clocks for one
 * decision is two chances to disagree.
 */
export function pendingHasExpired(pending: PendingAsk | null, ttlMs: number, now = Date.now()): boolean {
  if (!pending) return false;
  return now - Number(pending.askedAt) >= ttlMs;
}

export function isOnCooldown(state: State, key: string, cooldownMs: number, now = Date.now()): boolean {
  const entry = state.asked[key];
  if (!entry) return false;
  return now - Number(entry.at) < cooldownMs;
}

/**
 * The ask carries its own timestamp and that timestamp *is* the cooldown clock.
 * Taking a second `now` here would mean two clocks for one decision, and the one
 * that got written to disk would not be the one that was read back.
 */
export function markAsked(state: State, ask: PendingAsk): void {
  state.pending = ask;
  state.asked[ask.key] = { at: ask.askedAt, reason: ask.reason };
}
