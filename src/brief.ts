import type { QueueTopic } from "./nurxai.ts";

// The question the operator pastes into Grok on X.
//
// There is no Grok API call in this project and there is not meant to be. The
// operator runs the search in the app they already have, which means the bot
// needs no xAI credential, no per-call cost, and no explanation for why a model
// was allowed to spend money on its own initiative.
//
// THREE SHAPES, BECAUSE THERE ARE THREE SITUATIONS
//
//   targeted  — a record exists and holds the shape, but the posts kept carrying
//               specific signals it does not cover. Short, aimed at exactly those.
//   refresh   — a record exists and is out of date. Carries the old record so the
//               answer corrects it instead of starting over.
//   first     — nothing on record. Asks everything, and quotes the posts so the
//               subject is anchored to something real.
//
// The last one is the one that used to be useless. A question that says only
// "Acca, Git niye aktu bolo" gives a search engine nothing: not which project, not
// what subject, not what story. Every shape below therefore carries the actual post
// text when there is any, and says plainly when there is not.
//
// WHY BANGLISH
// The operator is the one pasting this into a chat window, so it is written the way
// they asked for it — plain Roman-script Bangla, the way they would type it
// themselves. A form-letter in English headings produced form-letter answers; a
// question a person would actually ask produced the rich answer that started this.

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

/**
 * One post, flattened to the part that carries its subject.
 *
 * Capped hard. The operator is going to read this inside a chat bubble and the
 * search only needs a starting point; four hundred characters of a stranger's thread
 * is noise, and the first line of a post is almost always its subject.
 */
export function postExcerpt(postText: string, limit = 240): string {
  const oneLine = postText.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit).trimEnd()}…` : oneLine;
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

/**
 * The posts the operator actually kept meeting, quoted.
 *
 * This is the block that makes the question answerable. Without it a search engine
 * gets a bare name; with it, it gets the sentence that made the operator look.
 */
function contextBlock(topic: QueueTopic): string | null {
  const posts = (topic.recentPosts ?? [])
    .map((post) => ({ ...post, postText: post.postText.trim() }))
    .filter((post) => post.postText.length > 0)
    .slice(0, 2);
  if (!posts.length) return null;
  return [
    posts.length === 1
      ? "Amar ei post ta chokhe porchilo:"
      : "Amar bar bar ei rokom post chokhe porchhe:",
    ...posts.map((post) => `"${postExcerpt(post.postText)}"`)
  ].join("\n");
}

/**
 * The signal words the posts carried that the stored record does not cover.
 *
 * NurXai works these out on the reply path already, where they are called
 * missingEvidence: see evaluateNovelty. They are the specific holes, which is why a
 * question aimed at them can be short.
 */
function missingSignals(topic: QueueTopic): string[] {
  const found = new Set<string>();
  for (const post of topic.recentPosts ?? []) {
    for (const signal of post.missing ?? []) {
      const clean = String(signal).trim();
      if (clean) found.add(clean);
    }
  }
  return [...found].slice(0, 6);
}

/** A record exists and holds the shape, but not the specific thing. */
function targetedShape(subject: string, known: string, missing: string[], context: string | null): string {
  return [
    `Acca, ${subject} niye amar kache aktu kichu ache — kintu ei dik ta nei: ${missing.join(", ")}.`,
    ...(context ? ["", context] : []),
    "",
    "Amader record e ja ache, shudhu mone rakhba:",
    "---",
    known,
    "---",
    "",
    `Ei jotil jinish gulo niye bolo: ${missing.join(", ")}. Ki holo, kobe holo, kar sathe`,
    "jotto — ar link dile bhalo hoy.",
    "",
    "Baki ta amader kache ache, abar shuru theke likhte hobe na. Jodi ei dik ta niye",
    'kichu na pao, tahole shudhu "janina" likho.',
    "",
    RULES
  ].join("\n");
}

/** A record exists and is out of date. */
function refreshShape(subject: string, known: string, context: string | null): string {
  return [
    `Acca, ${subject} niye aktu refresh koro.`,
    ...(context ? ["", context] : []),
    "",
    "Age amader kache ei record ta chilo:",
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

/** Nothing on record. */
function firstShape(subject: string, context: string | null): string {
  return [
    `Acca, ${subject} niye jante chai.`,
    "",
    context
      ? `${context}\n\nEi theke bujhe nao byapar ta ki, ar oi sutro dhore bolo.`
      : "Ami ei naam ta shudhu dekhechi, ei bishoye ar kichu jani na — tai ekhon theke shuru koro.",
    "",
    QUESTIONS,
    "",
    RULES
  ].join("\n");
}

export function buildBrief(topic: QueueTopic): string {
  const subject = topicTitle(topic);
  const context = contextBlock(topic);
  const missing = missingSignals(topic);
  const known = (topic.knownSummary || "").trim();

  if (known && missing.length) return targetedShape(subject, known, missing, context);
  if (known) return refreshShape(subject, known, context);
  return firstShape(subject, context);
}

export function buildFreshBrief(topic: QueueTopic): string {
  return firstShape(topicTitle(topic), contextBlock(topic));
}

export function buildRefreshBrief(topic: QueueTopic): string {
  const known = (topic.knownSummary || "").trim() || "(age kichu nei)";
  return refreshShape(topicTitle(topic), known, contextBlock(topic));
}
