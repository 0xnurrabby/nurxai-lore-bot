import type { Config } from "./config.ts";
import { log, warn } from "./config.ts";
import type { Telegram, TelegramMessage } from "./telegram.ts";
import { describeSender, noteIgnored } from "./telegram.ts";
import type { NurxaiClient, QueueTopic } from "./nurxai.ts";
import { isSetupError } from "./nurxai.ts";
import { buildBrief, topicTitle } from "./brief.ts";
import { parseDocument } from "./claude.ts";
import { isUsableRecord } from "./record.ts";
import { type PendingAsk, type State, isOnCooldown, loadState, markAsked, saveState } from "./state.ts";

// The whole conversation, in one place.
//
// The design constraint is that a paste must never be ambiguous. Only one brief
// is ever outstanding: `state.pending` holds it, `/skip` clears it, and a paste
// is always filed against exactly that topic. Anything else — a queue of open
// questions, a topic chosen by a reply — is a way to file the wrong research
// against the wrong subject and never notice.
//
// The allowlist is a set, not a single name. Two accounts belonging to the same
// operator is the normal case, and it does not weaken anything: the pending brief
// is still singular, so a second operator can read it, ask for it, or file it,
// but two people pasting two documents into one open question is not possible.

const HELP = `NurXai lore bot

NurXai writes replies. When it keeps meeting a topic it knows nothing about,
it says so — and I bring that topic here.

/next     the next research brief
/queue    what is waiting, and how often it came up
/status   what is pending
/skip     drop the pending brief
/pause    stop asking automatically
/resume   start asking again

To file lore: paste a brief's answer back here as plain text.`;

export class LoreBot {
  private state: State;
  private stopped = false;
  private controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;

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
        `Still waiting on a paste for ${topicTitle(topicOf(this.state.pending))}.\nSend the answer, or /skip.`
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
    this.persist();
  }

  private persist(): void {
    saveState(this.config.stateFile, this.state);
  }

  /**
   * Where a message goes.
   *
   * A command has an asker, so the answer goes back to them and nowhere else —
   * two operators should not each get a copy of the other's `/status`. An
   * automatic ask has no asker, so it goes to everyone on the allowlist. Either
   * way there is still exactly one outstanding brief, so whoever pastes first
   * files it and the other is simply told nothing is pending.
   */
  private async say(text: string, to?: number): Promise<void> {
    for (const id of to ? [to] : this.config.ownerIds) await this.telegram.send(id, text);
  }

  /**
   * Says something to every operator. For notices where there is no asker to
   * reply to, like a failed startup handshake.
   */
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
      case "/skip": {
        if (!this.state.pending) return void this.say("Nothing is pending.", chat);
        const dropped = this.state.pending;
        this.state.pending = null;
        return void this.say(
          `Dropped ${topicTitle(topicOf(dropped))}. It stays on cooldown, so it will not come straight back.`,
          chat
        );
      }
      case "/pause":
        this.state.paused = true;
        return void this.say("Paused. /next still works, /resume restarts it.", chat);
      case "/resume":
        this.state.paused = false;
        return void this.say("Resumed.", chat);
      case "/queue":
        return void this.showQueue(chat);
      case "/next":
        return void this.ask(true, chat);
      default:
        break;
    }

    if (command) {
      return void this.say(`Unknown command ${command}. /help`, chat);
    }

    if (!this.state.pending) {
      return void this.say(
        "Nothing is pending, so I do not know which topic that belongs to.\nSend /next for a brief first.",
        chat
      );
    }
    return void this.file(raw, chat);
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
      ? `reachable, ${queue.data.topics.length} topic(s) waiting`
      : `${queue.error}${isSetupError(queue.error) ? " — set the same secret on both sides" : ""}`;

    const lines = [
      `NurXai: ${link}`,
      `pending: ${pending ? topicTitle(topicOf(pending)) : "none"}`,
      `automatic asking: ${
        this.state.paused ? "paused" : this.config.autoAsk ? `every ${Math.round(this.config.pollIntervalMs / 60000)}m` : "off"
      }`,
      `topics on cooldown: ${onCooldown}`,
      `allowed to talk to me: ${this.config.ownerIds.length}`,
      `state file: ${this.config.stateFile}`
    ];
    return lines.join("\n");
  }

  private async fetchQueue(to?: number): Promise<QueueTopic[] | null> {
    const result = await this.nurxai.queue();
    if (!result.ok) {
      const hint =
        result.error === "LORE_AGENT_DISABLED"
          ? "\nNurXai has no LORE_AGENT_SECRET set, so its lore endpoints are closed."
          : "";
      await this.say(`Could not read the queue: ${result.error}${hint}`, to);
      return null;
    }
    return result.data.topics.filter((topic) => topic.misses >= this.config.minMisses);
  }

  private async showQueue(to?: number): Promise<void> {
    const topics = await this.fetchQueue(to);
    if (!topics) return;
    if (!topics.length) {
      return void this.say("Nothing waiting. Every topic NurXai meets has lore.", to);
    }
    const lines = topics.map((topic, index) => {
      const seen = `${topic.misses} post${topic.misses === 1 ? "" : "s"}`;
      const cooldown = isOnCooldown(this.state, topic.key, this.config.askCooldownMs) ? " (on cooldown)" : "";
      return `${index + 1}. ${topicTitle(topic)} — ${topic.reason === "stale" ? "record is stale" : "no lore yet"}, ${seen}${cooldown}`;
    });
    await this.say(`Waiting:\n\n${lines.join("\n")}\n\n/next to start on the top one.`, to);
  }

  private async autoAsk(): Promise<void> {
    if (this.stopped || this.state.paused || !this.config.autoAsk) return;
    if (this.state.pending) return;
    await this.ask(false);
  }

  /** `manual` (from /next) ignores the cooldown; automatic asking respects it. */
  private async ask(manual: boolean, to?: number): Promise<void> {
    if (this.state.pending) {
      return void this.say(`Still waiting on ${topicTitle(topicOf(this.state.pending))}. Send the answer, or /skip.`, to);
    }

    const topics = await this.fetchQueue(to);
    if (!topics) return;
    if (!topics.length) {
      return void this.say("Nothing waiting right now.", to);
    }

    const chosen =
      topics.find((topic) => manual || !isOnCooldown(this.state, topic.key, this.config.askCooldownMs)) ?? null;
    if (!chosen) {
      log("[bot] every waiting topic is on cooldown");
      return;
    }

    const ask: PendingAsk = {
      key: chosen.key,
      label: topicTitle(chosen),
      reason: chosen.reason,
      askedAt: Date.now()
    };
    markAsked(this.state, ask);
    this.persist();

    const why = chosen.reason === "stale" ? "the record is out of date" : "no lore yet";
    const count = `${chosen.misses} post${chosen.misses === 1 ? "" : "s"} without an answer`;
    await this.say(
      `Next: ${topicTitle(chosen)}\n${why} — ${count}.\n\n` +
        `Paste the brief below into Grok on X, then paste its answer back here.\n/skip to drop it.`,
      to
    );
    await this.say(buildBrief(chosen), to);
    log("[bot] asked", chosen.key, chosen.reason);
  }

  private async file(document: string, to: number): Promise<void> {
    const pending = this.state.pending;
    if (!pending) return;

    await this.telegram.typing(to);
    const outcome = await parseDocument(this.config, document);
    if (!outcome.ok) {
      await this.say(
        `Could not use that: ${outcome.reason}.\n\nThe brief is still pending. Paste again, or /skip.`,
        to
      );
      return;
    }

    const usable = isUsableRecord(outcome.record);
    if (!usable.ok) {
      await this.say(
        `Could not use that: ${usable.reason}.\n\nThe brief is still pending. Paste again, or /skip.`,
        to
      );
      return;
    }

    const written = await this.nurxai.write(pending.key, outcome.record);
    if (!written.ok) {
      await this.say(
        `NurXai refused the write: ${written.error}.\n\nThe brief is still pending, so nothing was lost — ` +
          `fix the cause and paste again, or /skip.`,
        to
      );
      return;
    }

    this.state.pending = null;
    this.persist();

    const record = outcome.record;
    const freshness = written.data.freshnessUntil.slice(0, 10);
    await this.say(
      [
        `Filed: ${record.canonicalName}`,
        `key ${written.data.key}`,
        `${written.data.created ? "new record" : "record updated"} · good until ${freshness}`,
        `confidence ${written.data.confidence}`,
        `state ${record.currentState.length} · timeline ${record.timeline.length} · team ${record.team.length} · sources ${record.citations.length}` +
          (outcome.truncated ? "\n(the paste was trimmed to 40k characters before parsing)" : ""),
        "",
        "Every reply NurXai writes about this now reads it."
      ].join("\n"),
      to
    );
    log("[bot] filed", written.data.key, "created:", written.data.created, "confidence:", written.data.confidence);
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
