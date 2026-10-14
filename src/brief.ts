import type { QueueTopic } from "./nurxai.ts";

// The research brief the operator pastes into Grok on X.
//
// There is no Grok API call in this project and there is not meant to be. The
// operator runs the search in the app they already have, which means the bot
// needs no xAI credential, no per-call cost, and no explanation for why a model
// was allowed to spend money on its own initiative.
//
// The format is fixed sections rather than JSON. Grok's answer is prose whatever
// we ask for, and a prompt demanding JSON produces either broken JSON or a
// refusal; fixed headings survive being copied out of a chat window intact. The
// parser in claude.ts is what turns headings into a record.

const KEY_PREFIXES = ["x-", "site-", "token-", "name-", "narr-", "co-", "person-", "org-", "topic-"];

/** `x-aerodrome` → `Aerodrome`. Best effort: the key is the only name we have. */
export function prettifyKey(key: string): string {
  let rest = key;
  for (const prefix of KEY_PREFIXES) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  const words = rest.replace(/[-_]+/g, " ").trim();
  if (!words) return key;
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function topicTitle(topic: QueueTopic): string {
  const label = topic.label && topic.label !== topic.key ? topic.label : prettifyKey(topic.key);
  return topic.entityType ? `${label} (${topic.entityType})` : label;
}

const SECTIONS = `NAME
  The canonical name, plus every alias, @handle and $ticker people actually use.

WHAT IT IS
  Two or three sentences. What it does, and who it is for.

WHO RUNS IT
  Founders and core team: name, role, handle. Write UNKNOWN rather than guessing
  at a name.

WHAT IS TRUE RIGHT NOW
  Three to six bullets. Current state only: what shipped, what broke, what
  changed, where the numbers sit. Date every bullet.

THE BACKSTORY
  The history that matters, oldest first. Milestones, decisions, and above all
  any fight, exit, exploit, pivot or drama. Date each one.

COMMUNITY SENTIMENT
  How the people who genuinely use it talk about it, and what the people who
  dislike it say. Name the specific complaint and the specific praise.

NUMBERS
  Concrete figures you can stand behind: TVL, users, revenue, volume, raises,
  valuations. Give the date for each.

WHAT CHANGED RECENTLY
  Only the last 30 days.

TRUE VS CLAIMED
  Anything the project says about itself that is disputed or unproven.

SOURCES
  Up to ten URLs you actually retrieved.`;

function header(topic: QueueTopic): string {
  return `SUBJECT: ${topicTitle(topic)}\nINTERNAL KEY: ${topic.key}`;
}

function rules(): string {
  return `Plain text with those headings and nothing else. No introduction, no
conclusion, no commentary, no suggested posts or replies — this is read by a
program, not by a person.

If you cannot confirm something, write UNKNOWN. An empty answer is far more
useful than an invented one: anything wrong here gets repeated in public.`;
}

/** A first record for a topic nobody has researched. */
export function buildFreshBrief(topic: QueueTopic): string {
  return [
    "RESEARCH BRIEF",
    "",
    header(topic),
    "",
    "Search X and the open web for what is true about this subject right now, then",
    "answer with exactly these headings, in this order.",
    "",
    SECTIONS,
    "",
    rules()
  ].join("\n");
}

/**
 * A refresh for a topic whose stored record has expired.
 *
 * The old summary is shown so the answer corrects it instead of starting over —
 * and the explicit instruction to call out what is no longer true is what lets
 * the store drop the stale parts rather than accumulate contradictions.
 */
export function buildRefreshBrief(topic: QueueTopic): string {
  const known = (topic.knownSummary || "").trim() || "(nothing usable on file)";
  return [
    "RESEARCH BRIEF — REFRESH",
    "",
    header(topic),
    "",
    "We already have the following record on file, and some of it is out of date:",
    "",
    "---",
    known,
    "---",
    "",
    "Search X and the open web, then answer with exactly these headings, in this",
    "order. Write what is true now; do not repeat the record above back to us.",
    "",
    SECTIONS,
    "",
    "WHAT CHANGED RECENTLY must also say, in plain terms, which parts of the record",
    "above are no longer true. Those parts are deleted when your answer is filed, so",
    "anything you leave unmentioned is treated as still correct.",
    "",
    rules(),
    "",
    "Do not correct spelling or tone. Only correct facts."
  ].join("\n");
}

export function buildBrief(topic: QueueTopic): string {
  return topic.reason === "stale" ? buildRefreshBrief(topic) : buildFreshBrief(topic);
}
