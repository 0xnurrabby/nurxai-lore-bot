import type { Config } from "./config.ts";
import { log, warn } from "./config.ts";
import type { Telegram, TelegramMessage } from "./telegram.ts";
import { describeSender, noteIgnored } from "./telegram.ts";
import type { NurxaiClient, QueueTopic } from "./nurxai.ts";
import { isAskableTopic, isGenericLabel, isSetupError, justifiedBy, preferWithPosts, refusalReason } from "./nurxai.ts";
import { buildAskHeader, buildBrief, topicTitle } from "./brief.ts";
import { parseDocument } from "./claude.ts";
import { writeQuestion } from "./question.ts";
import { isUsableRecord } from "./record.ts";
import {
  type PendingAsk,
  type State,
  briefMessageKey,
  isOnCooldown,
  loadState,
  markAsked,
  pendingHasExpired,
  rememberBrief,
  saveState
} from "./state.ts";

// The whole conversation, in one place.
//
// Two rules make a hand-run workflow survive contact with a real chat window.
//
// 1. A paste is bound to the prompt it answers, not to "whatever is pending".
//    Telegram's reply carries the id of the message being replied to, and every
//    message this bot sends for a brief is recorded against that brief — so a
//    prompt from last week can be answered today and still file against the right
//    subject. The single pending ask is the fallback for a paste sent bare.
//
// 2. A paste can arrive in pieces. Telegram refuses anything over 4096
//    characters, and a real answer to the research brief is 5,000–20,000, so the
//    operator sends it as several messages whether or not anyone planned for it.
//    The bot collects them and files once the pieces stop coming.

const HELP = `NurXai lore bot

NurXai writes replies. When it keeps meeting a topic it knows nothing about,
it says so — and I bring that topic here as a question.

Copy the question into Grok, then reply to my message with the answer. If the
answer comes back in several pieces, send them all — I collect them.

/next     send the next question now
/done     file what I have collected, right now
/skip     drop this one and move on
/status   what is going on`;

/** A repeated queue failure is reported once an hour, not once per poll. */
const QUEUE_ERROR_REPEAT_MS = 60 * 60 * 1000;

/** A paste being collected, before it is worth parsing. */
type Collecting = {
  key: string;
  label: string;
  reason: "no_lore" | "stale";
  chat: number;
  body: string;
  parts: number;
  /** The one "collecting…" message, edited as parts arrive. */
  noticeId: number | null;
  timer: NodeJS.Timeout | null;
};

/**
 * Joins one more piece of a paste onto what is already collected.
 *
 * A newline, not a glue. Telegram splits at exactly 4096 characters, which lands
 * mid-word — but a person splitting it by hand lands on a line ending, and gluing
 * a consumed line ending back together is what destroys a heading like
 * `WHAT IT IS`. A spurious break inside a word costs nothing; a consumed heading
 * costs the field. A boundary that already has whitespace is left alone, so the
 * obvious cases do not pick up a blank line.
 */
export function joinParts(body: string, part: string): string {
  if (!body) return part;
  if (/\s$/.test(body) || /^\s/.test(part)) return body + part;
  return `${body}\n${part}`;
}

export class LoreBot {
  private state: State;
  private stopped = false;
  private controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private collecting: Collecting | null = null;
  /** The last set of refused topics we logged, so the poll does not repeat itself. */
  private lastRefusalSignature = "";
  /** The last queue failure, so an outage is reported once instead of every poll. */
  private lastQueueError: string | null = null;
  private lastQueueErrorAt = 0;

  constructor(
    private readonly config: Config,
    private readonly telegram: Telegram,
    private readonly nurxai: NurxaiClient
  ) {
    this.state = loadState(config.stateFile);
  }

  async run(): Promise<void> {
    const me = await this.telegram.getMe();
    if (!me) throw new Error("Telegram rejected the bot token (getMe failed)");
    log(
      `[bot] @${me.username || me.id} online; owners ${this.config.ownerIds.join(", ")}; provider ${this.config.provider}`
    );

    // Drain before polling. The state file sits on an ephemeral disk, so after a
    // deploy or a sleep the offset is 0 — and replaying a day of commands would
    // re-run `/next` and `/skip` against whatever topic is pending now.
    const newest = await this.telegram.latestUpdateId();
    if (newest !== null && newest + 1 > this.state.offset) {
      this.state.offset = newest + 1;
      this.persist();
      log(`[bot] skipped the Telegram backlog up to update ${newest}`);
    }

    if (this.state.pending) {
      await this.say(
        `Still waiting on an answer for ${topicTitle(topicOf(this.state.pending))}.\n` +
          `Reply to the question with the answer, or /skip.`
      );
    }

    // Kick off the first ask opportunity without waiting for the timer.
    this.autoAsk().catch((error) => warn("[bot] auto-ask failed", error?.message || "?"));
    this.schedule();

    await this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.collecting?.timer) clearTimeout(this.collecting.timer);
    this.persist();
  }

  private persist(): void {
    saveState(this.config.stateFile, this.state);
  }

  /**
   * Says something to every operator, and reports the message ids it produced.
   *
   * A command has an asker, so `to` sends the answer back to them and nowhere
   * else — two operators should not each get a copy of the other's `/status`. An
   * automatic ask has no asker, so it goes to everyone on the allowlist.
   */
  private async say(
    text: string,
    to?: number,
    options: { pre?: boolean; html?: boolean; rawHtml?: boolean } = {}
  ): Promise<number[]> {
    const ids: number[] = [];
    for (const id of to ? [to] : this.config.ownerIds) ids.push(...(await this.telegram.send(id, text, options)));
    return ids;
  }

  /** Says something to every operator, for notices with no asker to reply to. */
  async notify(text: string): Promise<void> {
    await this.say(text);
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      const updates = await this.telegram.poll(this.state.offset, this.controller.signal);
      if (this.stopped) break;
      for (const update of updates) {
        // Advance first: a crash while handling one message must not replay it.
        this.state.offset = update.update_id + 1;
        const message = update.message;
        if (!message || !message.text) continue;
        if (!this.config.ownerIds.includes(message.from?.id ?? 0)) {
          noteIgnored(message);
          continue;
        }
        try {
          await this.handle(message);
        } catch (error: any) {
          warn("[bot] handler failed", describeSender(message), error?.message || "?");
          await this.say(`Something broke: ${error?.message || "unknown error"}`, message.chat.id);
        }
        this.persist();
      }
      if (updates.length) this.persist();
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.autoAsk();
      } catch (error: any) {
        warn("[bot] auto-ask failed", error?.message || "?");
      }
      this.schedule();
    }, this.config.pollIntervalMs);
  }

  private async handle(message: TelegramMessage): Promise<void> {
    const chat = message.chat.id;
    const raw = (message.text || "").trim();
    const command = raw.startsWith("/") ? raw.split(/[\s@]/)[0]!.toLowerCase() : "";

    switch (command) {
      case "/start":
      case "/help":
        return void this.say(HELP, chat);
      case "/status":
        return void this.say(await this.statusText(), chat);
      case "/done":
        if (!this.collecting) return void this.say("Nothing collected to file.", chat);
        return void this.fileCollected("done");
      case "/skip": {
        const droppedPaste = this.collecting;
        const droppedAsk = this.state.pending;
        if (!droppedPaste && !droppedAsk) return void this.say("Nothing to skip.", chat);
        if (droppedPaste) {
          if (droppedPaste.timer) clearTimeout(droppedPaste.timer);
          this.collecting = null;
          if (droppedPaste.noticeId) await this.telegram.edit(droppedPaste.chat, droppedPaste.noticeId, "Discarded.");
        }
        this.state.pending = null;
        const what = droppedAsk ? topicTitle(topicOf(droppedAsk)) : "that paste";
        return void this.say(`Dropped ${what}. It stays on cooldown, so it will not come straight back.`, chat);
      }
      case "/next":
        return void this.ask(true, chat);
      default:
        break;
    }

    if (command) {
      return void this.say(`Unknown command ${command}. /help`, chat);
    }

    // Not a command: a paste, or another piece of one.
    const target = this.briefFor(message);
    if (!target) {
      return void this.say(
        "I do not know which topic that belongs to. Nothing is pending, and this was not a reply to a\n" +
          "message I sent — so I would be guessing. Reply to the question you are answering, or send\n" +
          "/next for a new one.",
        chat
      );
    }
    return void this.collectPart(target, raw, chat);
  }

  /**
   * Which brief a message answers: the one it was replied to, or the one pending.
   *
   * Reply first, because that is the operator telling us directly, and it stays
   * right even when the prompt is old enough that a newer one has been asked
   * since. Only fall back to "the pending one" for a paste sent bare.
   */
  private briefFor(message: TelegramMessage): PendingAsk | null {
    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo) {
      const bound = this.state.briefs[briefMessageKey(message.chat.id, repliedTo)];
      if (bound) {
        return { key: bound.key, label: bound.label, reason: bound.reason, askedAt: bound.askedAt };
      }
    }
    return this.state.pending;
  }

  private async statusText(): Promise<string> {
    const pending = this.state.pending;
    const now = Date.now();
    const onCooldown = Object.keys(this.state.asked).filter((key) =>
      isOnCooldown(this.state, key, this.config.askCooldownMs, now)
    ).length;

    // Checked live rather than remembered. The state that matters lives on the
    // other host and can change without this process restarting, which is the
    // whole reason a failed startup handshake is not fatal — so /status has to
    // ask, or it would report a stale answer to the one question it exists for.
    const queue = await this.nurxai.queue();
    const link = queue.ok
      ? `reachable, ${queue.data.topics.filter(isAskableTopic).length} topic(s) worth asking about`
      : `${queue.error}${isSetupError(queue.error) ? " — set the same secret on both sides" : ""}`;

    const lines = [
      `NurXai: ${link}`,
      `waiting on: ${pending ? topicTitle(topicOf(pending)) : "nothing"}`,
      `collecting: ${this.collecting ? `${this.collecting.label}, ${this.collecting.parts} message(s), ${this.collecting.body.length} characters` : "nothing"}`,
      `topics on cooldown: ${onCooldown}`,
      `allowed to talk to me: ${this.config.ownerIds.length}`,
      `state file: ${this.config.stateFile}`
    ];
    return lines.join("\n");
  }

  private async fetchQueue(to?: number, manual = false): Promise<QueueTopic[] | null> {
    const result = await this.nurxai.queue();

    if (!result.ok) {
      // The automatic pass runs every three minutes. Saying the same failure every
      // three minutes turns one outage into two, which is what the operator saw at
      // 4:57 and again at 5:00. A repeated error is said once and then held for an
      // hour, and a human asking is always answered.
      const now = Date.now();
      const repeat = this.lastQueueError === result.error && now - this.lastQueueErrorAt < QUEUE_ERROR_REPEAT_MS;
      this.lastQueueError = result.error;
      this.lastQueueErrorAt = now;
      if (manual || !repeat) {
        const hint =
          result.error === "LORE_AGENT_DISABLED"
            ? "\nNurXai has no LORE_AGENT_SECRET set, so its lore endpoints are closed."
            : "\nThe bot is running; the site is not answering. I will keep checking quietly and tell you when it is back.";
        await this.say(`NurXai did not answer (${result.error}).${hint}`, to);
      }
      return null;
    }

    if (this.lastQueueError !== null) {
      this.lastQueueError = null;
      await this.say("NurXai is answering again.", to);
    }

    const waiting = result.data.topics.filter((topic) => topic.misses >= this.config.minMisses);
    const askable = waiting.filter(isAskableTopic);
    const refused = waiting.filter((topic) => !isAskableTopic(topic));

    // Logged only when the set changes. This runs every three minutes, and a line
    // per poll that says the same thing is a hundred lines a day of nothing, which is
    // how a real signal gets missed.
    if (refused.length) {
      const accounts = refused.filter((topic) => refusalReason(topic) === "an-account").map((topic) => topic.key);
      const empty = refused.filter((topic) => refusalReason(topic) === "nothing-to-say").map((topic) => topic.key);
      const addressed = refused.filter((topic) => refusalReason(topic) === "an-address").map((topic) => topic.key);
      const generic = refused.filter((topic) => refusalReason(topic) === "not-a-subject").map((topic) => topic.key);
      const signature = `${accounts.join(",")}|${empty.join(",")}|${addressed.join(",")}|${generic.join(",")}`;
      if (signature !== this.lastRefusalSignature) {
        this.lastRefusalSignature = signature;
        if (accounts.length) log(`[bot] not asking about ${accounts.length} account(s), not subject(s):`, accounts.join(", "));
        if (empty.length) log(`[bot] not asking about ${empty.length} topic(s) with nothing to say:`, empty.join(", "));
        if (addressed.length) log(`[bot] not asking about ${addressed.length} salutation(s), not subject(s):`, addressed.join(", "));
        if (generic.length) log(`[bot] not asking about ${generic.length} generic phrase(s), not subject(s):`, generic.join(", "));
      }
    }
    return askable;
  }

  private async autoAsk(): Promise<void> {
    if (this.stopped || !this.config.autoAsk) return;
    if (this.collecting) return;
    if (this.state.pending) {
      if (!pendingHasExpired(this.state.pending, this.config.pendingTtlMs)) return;
      // One ignored question must not end the conversation. The prompt is still
      // answerable by reply for a week, and the topic keeps its cooldown, so moving
      // on costs nothing and is the difference between prompts arriving on their
      // own and nothing arriving at all.
      log(
        "[bot] unanswered for",
        Math.round((Date.now() - this.state.pending.askedAt) / 60000),
        "minutes, moving on from",
        this.state.pending.key
      );
      this.state.pending = null;
      this.persist();
    }
    await this.ask(false);
  }

  /** `manual` (from /next) ignores the cooldown; automatic asking respects it. */
  private async ask(manual: boolean, to?: number): Promise<void> {
    if (this.state.pending) {
      return void this.say(`Still waiting on ${topicTitle(topicOf(this.state.pending))}. Send the answer, or /skip.`, to);
    }
    if (this.collecting) {
      return void this.say(
        `Still collecting a paste for ${this.collecting.label}. Send /done to file it.`,
        to
      );
    }

    const topics = await this.fetchQueue(to, manual);
    if (!topics) return;

    // A prompt must be caused by something the operator did.
    //
    // A cold record on its own is not a cause, and treating it as one is what produced
    // the same three questions, two hours apart, days after they had been answered.
    // What justifies a question is a post they commented on since we last asked: the
    // first question is caused by the post that raised the topic, a refresh by a newer
    // post that suggests the record is behind. Everything else is the bot talking to
    // itself.
    const caused: QueueTopic[] = [];
    for (const topic of topics) {
      const lastAskedAt = this.state.asked[topic.key]?.at ?? null;
      const post = justifiedBy(topic, lastAskedAt);
      if (post) {
        caused.push(topic);
        continue;
      }
      log(
        "[bot] not asking",
        topic.key,
        lastAskedAt === null ? "— no post of yours brought it up" : "— nothing new since the last question"
      );
    }

    const ready = manual ? caused : caused.filter((topic) => !isOnCooldown(this.state, topic.key, this.config.askCooldownMs));
    const chosen = preferWithPosts(ready);
    if (!chosen) {
      // Only a human asking gets an answer. The automatic pass runs every three
      // minutes, and a "nothing waiting" message every three minutes is its own kind
      // of noise.
      if (manual) {
        await this.say("Nothing to ask about right now — no post of yours has raised a topic we have nothing on.", to);
      }
      return;
    }

    const ask: PendingAsk = {
      key: chosen.key,
      label: topicTitle(chosen),
      reason: chosen.reason,
      askedAt: Date.now()
    };
    markAsked(this.state, ask);

    const why = chosen.reason === "stale" ? "the record is out of date" : "no lore yet";
    const count = `${chosen.misses} post${chosen.misses === 1 ? "" : "s"} without an answer`;

    // Sent to each operator separately so the message ids recorded below belong
    // to the chat they were delivered to.
    const question = await writeQuestion(this.config, chosen);
    for (const chatId of to ? [to] : this.config.ownerIds) {
      const headerIds = await this.telegram.send(chatId, buildAskHeader(chosen, why, count), { rawHtml: true });
      // `pre` gives the answer a monospace block with a copy button, which is the
      // operator's next move and the reason this is not sent as ordinary text.
      const briefIds = await this.telegram.send(chatId, question.text, { pre: true });
      rememberBrief(this.state, chatId, [...headerIds, ...briefIds], ask);
    }
    this.persist();
    log("[bot] asked", chosen.key, chosen.reason, `(question ${question.source}, ${question.text.length} chars)`);
  }

  /**
   * Takes one more piece of a paste, and re-arms the bell that ends it.
   *
   * One paste at a time: a second document aimed at a different subject while the
   * first is still open is a mistake worth naming, not a mixture worth guessing
   * at. See `joinParts` for how the pieces are put back together.
   */
  private async collectPart(target: PendingAsk, raw: string, chat: number): Promise<void> {
    if (this.collecting && this.collecting.key !== target.key) {
      return void this.say(
        `Still collecting for ${this.collecting.label} (${this.collecting.parts} part(s)). ` +
          `Send /done to file it or /cancel to drop it, then start on ${target.label}.`,
        chat
      );
    }

    if (!this.collecting) {
      this.collecting = {
        key: target.key,
        label: target.label,
        reason: target.reason,
        chat,
        body: "",
        parts: 0,
        noticeId: null,
        timer: null
      };
    }

    const paste = this.collecting;
    paste.parts += 1;
    paste.body = joinParts(paste.body, raw);

    // Re-armed on every piece: the bell rings on silence, not on a schedule.
    if (paste.timer) clearTimeout(paste.timer);
    paste.timer = setTimeout(() => {
      void this.fileCollected("quiet").catch((error) => warn("[bot] auto-file failed", error?.message || "?"));
    }, this.config.pasteQuietMs);

    await this.showCollecting();
  }

  private async showCollecting(): Promise<void> {
    const paste = this.collecting;
    if (!paste) return;
    const chars = paste.body.length.toLocaleString("en-US");
    const seconds = Math.round(this.config.pasteQuietMs / 1000);
    const text =
      paste.parts === 1
        ? `Collecting for ${paste.label} — 1 message, ${chars} characters.\n` +
          `Send the rest if there is more; I file ${seconds}s after the last one, or send /done now.`
        : `Collecting for ${paste.label} — ${paste.parts} messages, ${chars} characters.`;

    if (paste.noticeId) {
      // Editing beats sending: a six-part paste gets one line that counts up
      // rather than six lines that say nearly the same thing.
      const edited = await this.telegram.edit(paste.chat, paste.noticeId, text);
      if (edited) return;
    }
    const ids = await this.telegram.send(paste.chat, text);
    if (ids.length) paste.noticeId = ids[ids.length - 1]!;
  }

  private async fileCollected(why: "done" | "quiet"): Promise<void> {
    const paste = this.collecting;
    if (!paste) return;
    if (paste.timer) clearTimeout(paste.timer);
    paste.timer = null;

    const chars = paste.body.length.toLocaleString("en-US");
    if (paste.noticeId) {
      await this.telegram.edit(
        paste.chat,
        paste.noticeId,
        `${why === "done" ? "Filing" : "Nothing more arrived — filing"} ${chars} characters for ${paste.label}…`
      );
    }

    const filed = await this.file(paste.body, paste.chat, paste.key, paste.reason, paste.label);
    if (filed) {
      // Only now is it safe to forget: a failed parse or a refused write has to
      // leave the document somewhere, or the operator's paste is gone.
      this.collecting = null;
      if (paste.noticeId) await this.telegram.edit(paste.chat, paste.noticeId, `Read ${chars} characters.`);
      // And straight on to the next one. Waiting for the timer here is what made
      // the operator press /next to get anything done.
      this.autoAsk().catch((error) => warn("[bot] auto-ask after filing failed", error?.message || "?"));
    } else {
      // Kept, and deliberately not re-armed: retrying on a timer would hammer a
      // failure the operator has not fixed yet.
      if (paste.noticeId) {
        await this.telegram.edit(
          paste.chat,
          paste.noticeId,
          `Kept ${chars} characters for ${paste.label}. Send /done to try again, or /cancel to drop it.`
        );
      }
    }
  }

  /** Files one document against one topic. Returns whether it landed. */
  private async file(
    document: string,
    to: number,
    key: string,
    reason: "no_lore" | "stale",
    label: string
  ): Promise<boolean> {
    // A brief that was already sent can still be answered. If it was built around a
    // phrase like "Plan B", the answer is not lore about a company, and filing it
    // would poison the record the reply writer reads. Refuse it here too.
    if (isGenericLabel(label, key)) {
      await this.say(
        `That brief is about "${label}", which is a phrase from a post, not a company or project. There is nothing to research. Send /skip to drop it.`,
        to
      );
      return false;
    }

    await this.telegram.typing(to);
    const outcome = await parseDocument(this.config, document, { key, label });
    if (!outcome.ok) {
      // A half paste and a correction are the two common failures, and neither is
      // helped by the parser's internal wording. Say what to do next instead.
      const hint = /clear subject/i.test(outcome.reason)
        ? "\n\nThat usually means the paste was half an answer, or a correction that never named the product. If there is more, send the rest now. If that was all of it, start with the subject's name and paste again."
        : "";
      await this.say(`Could not use that: ${outcome.reason}.${hint}`, to);
      return false;
    }

    const usable = isUsableRecord(outcome.record);
    if (!usable.ok) {
      await this.say(`Could not use that: ${usable.reason}.`, to);
      return false;
    }

    const written = await this.nurxai.write(key, outcome.record);
    if (!written.ok) {
      await this.say(`NurXai refused the write: ${written.error}.`, to);
      return false;
    }

    // Cleared only when the paste was answering the ask that is currently open.
    // Filing an old brief by reply must not silently drop today's question.
    if (this.state.pending && this.state.pending.key === key) this.state.pending = null;
    this.persist();

    const record = outcome.record;
    const freshness = written.data.freshnessUntil.slice(0, 10);
    // Only mention the key when it is not the one we asked about. Saying
    // "key x-base (as x-base)" was noise that made the operator stop and read it.
    const storedAs = written.data.key && written.data.key !== key ? `stored as ${written.data.key}` : null;
    await this.say(
      [
        `Filed: ${record.canonicalName}`,
        storedAs,
        `${written.data.created ? "new record" : "record updated"} · good until ${freshness}`,
        `confidence ${written.data.confidence}`,
        `state ${record.currentState.length} · timeline ${record.timeline.length} · team ${record.team.length} · sources ${record.citations.length}` +
          (outcome.truncated ? "\n(the paste was trimmed to 40k characters before parsing)" : ""),
        "",
        `Every reply NurXai writes about this now reads it${reason === "stale" ? " — and the parts your answer did not mention were left in place" : ""}.`
      ]
        .filter((line) => line !== null)
        .join("\n"),
      to
    );
    log("[bot] filed", written.data.key, "created:", written.data.created, "confidence:", written.data.confidence);
    return true;
  }
}

function topicOf(ask: PendingAsk): QueueTopic {
  return {
    key: ask.key,
    label: ask.label,
    entityType: null,
    reason: ask.reason,
    misses: 0,
    lastSeenAt: "",
    knownSummary: null
  };
}
