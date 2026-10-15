import type { QueueTopic } from "./nurxai.ts";

// The question the operator pastes into Grok on X.
//
// There is no Grok API call in this project and there is not meant to be. The
// operator runs the search in the app they already have, which means the bot
// needs no xAI credential, no per-call cost, and no explanation for why a model
// was allowed to spend money on its own initiative.
//
// WHY BANGLISH
// The operator is the one pasting this into a chat window, so it is written the
// way they asked for it — plain Roman-script Bangla, the way they would type it
// themselves. A form-letter in English headings produced form-letter answers;
// a question a person would actually ask produced the rich answer that started
// this. The points below are the same fields the record needs, asked as questions
// rather than demanded as sections.
//
// WHY IT STILL ASKS FOR EVERYTHING
// The record has to carry what a reply needs: what the thing is, who runs it,
// what is true now, the drama, the numbers, and links. Asking for them in prose
// rather than as headings changes nothing about which facts come back — it only
// changes whether a human can paste it without feeling like they are running a
// script.

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

/** What every brief asks, whatever the subject is. */
const QUESTIONS = `- Eta asole ki? Kibhabe kaj kore, ar kar jonno?
- Er pichone kara ache? Founder, CEO, core team — name, role, handle.
- Ekhon ki obostha? Sesh 30 din e ki change hoise, ki ship hoise, ki bhenge gese.
- Er backstory ta ki? Kobe shuru holo, kono pivot, exit, exploit, jhogra, drama — date diye.
- Ja ra asole use kore tara ki bole, ar ja ra dislike kore tara ki bole? Kon specific
  kotha ta tara bole seta bolo, shudhu "bhalo" ba "kharap" na.
- Number diye bolte paro? Users, revenue, TVL, volume, raise, valuation — tarik shoho.
- Eta nije ki claim kore jeta basically unproven?
- Ja source tumi actually dekhecho, tar link dile bhalo hoy.`;

const RULES = `Bangla te likho, roman script e cholbe. Jeta sotti tai likho.

Jodi kono kichu confirm korte na paro, tahole "janina" likho. Bhul likhar cheye janina
bola onek bhalo — ei kotha pore publicly repeat hobe, tai ekta bhul fact ekta faka
jagyer cheye onek kharap.

Kono introduction, conclusion, ba nijer mone kora kichu likho na. Shudhu ja ja
actually paicho seta likho.`;

/** First record for a topic nobody has researched. */
export function buildFreshBrief(topic: QueueTopic): string {
  const subject = topicTitle(topic);
  return [
    `Acca, ${subject} niye aktu bolo.`,
    "",
    QUESTIONS,
    "",
    RULES
  ].join("\n");
}

/**
 * A refresh for a topic whose stored record has expired.
 *
 * The old summary is shown so the answer corrects it instead of starting over —
 * and the explicit instruction to say which parts are dead is what lets the
 * store drop them rather than accumulate contradictions.
 */
export function buildRefreshBrief(topic: QueueTopic): string {
  const subject = topicTitle(topic);
  const known = (topic.knownSummary || "").trim() || "(age kichu nei)";
  return [
    `Acca, ${subject} niye aktu refresh koro.`,
    "",
    "Age amader kache ei record ta chilo:",
    "",
    "---",
    known,
    "---",
    "",
    "Ekhon bolo ki ki change hoise, ar upore ja lekha ache tar kon kon part ar sotti na.",
    "Seta explicitly bolo — karon ja tumi mention korba na, seta amra dhore nibo ekhono",
    "thik ache. Kono kichu na bole gele purano ta theke jabe.",
    "",
    QUESTIONS,
    "",
    RULES,
    "",
    "Bangla spelling ba tone thik korte hobe na. Shudhu fact thik koro."
  ].join("\n");
}

export function buildBrief(topic: QueueTopic): string {
  return topic.reason === "stale" ? buildRefreshBrief(topic) : buildFreshBrief(topic);
}
