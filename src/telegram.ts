import { log, warn } from "./config.ts";

// A minimal Telegram client.
//
// Long polling, not webhooks. That choice is why nothing here needs a public
// URL, a certificate to get right, or a request body anyone can forge: the
// process only makes outbound HTTPS calls to Telegram, exactly like a desktop
// client, and a message arrives because we asked for it. The one listener this
// process does open exists solely to answer a health check — see health.ts.

export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  /**
   * Present when the operator used Telegram's swipe-to-reply. This is the whole
   * mechanism that tells a paste which brief it is answering.
   */
  reply_to_message?: { message_id: number };
};

type TelegramUpdate = { update_id: number; message?: TelegramMessage };

export class Telegram {
  constructor(private readonly token: string) {}

  private url(method: string, query?: Record<string, string>): string {
    const base = `https://api.telegram.org/bot${this.token}/${method}`;
    if (!query) return base;
    const params = new URLSearchParams(query);
    return `${base}?${params.toString()}`;
  }

  private async call<T>(method: string, payload?: unknown, query?: Record<string, string>): Promise<T | null> {
    const res = await fetch(this.url(method, query), {
      method: payload === undefined ? "GET" : "POST",
      headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok || !body?.ok) {
      const description: string = body?.description || "";
      if (method === "sendMessage" && /chat not found/i.test(description)) {
        // The most common first-run failure, and the 400 explains none of it. A
        // bot cannot open a conversation: until the account presses Start on it
        // there is no chat to deliver to, and no amount of retrying changes that.
        warn("[telegram] chat not found — that account has never pressed Start on this bot");
      } else {
        warn("[telegram]", method, "failed", res.status, description);
      }
      return null;
    }
    return body.result as T;
  }

  async getMe(): Promise<{ id: number; username?: string } | null> {
    return this.call<{ id: number; username?: string }>("getMe");
  }

  /**
   * Sends a message, splitting it if it is longer than Telegram allows.
   *
   * Returns the id of every message it produced, because those ids are what a
   * reply can point at later. An empty array means nothing was delivered — which
   * is how "chat not found" reaches the caller.
   */
  async send(
    chatId: number,
    text: string,
    options: { html?: boolean; pre?: boolean; rawHtml?: boolean; silent?: boolean } = {}
  ): Promise<number[]> {
    // Telegram caps a message at 4096 characters. The returned paste is what
    // reaches this limit; the briefs this bot sends are 1,600–2,800, so in
    // practice only an outsider's long answer is ever split here.
    const chunks = options.pre ? splitMessage(text, 3800) : splitMessage(text, 4000);
    const ids: number[] = [];
    for (const chunk of chunks) {
      // Three modes, and the difference is who escapes what:
      //   rawHtml — the caller built the markup and escaped its own text. Used by the
      //             ask header, which emits one anchor per post; escaping it here
      //             would turn the anchors into visible angle brackets.
      //   pre     — the whole chunk is one monospace block with a copy button, and
      //             anything inside it is escaped, tags included.
      //   html    — escape the chunk, keep no structure.
      const body = options.rawHtml
        ? chunk
        : options.pre
          ? `<pre>${toHtml(chunk)}</pre>`
          : options.html
            ? toHtml(chunk)
            : chunk;
      const result = await this.call<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: body,
        ...(options.pre || options.html || options.rawHtml ? { parse_mode: "HTML" } : {}),
        disable_web_page_preview: true,
        ...(options.silent ? { disable_notification: true } : {})
      });
      if (result?.message_id) ids.push(result.message_id);
    }
    return ids;
  }

  /**
   * Replaces the text of a message this bot sent.
   *
   * Used for the collecting notice, so a paste arriving in six parts produces one
   * line that counts up instead of six lines saying almost the same thing.
   */
  async edit(chatId: number, messageId: number, text: string): Promise<boolean> {
    const result = await this.call<TelegramMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true
    });
    return result !== null;
  }

  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  /**
   * The newest update id Telegram is still holding.
   *
   * Called once at startup. On the free tier this process is restarted by every
   * deploy, and the state file sits on an ephemeral filesystem, so the stored
   * offset is usually 0 on boot. Without draining, the first poll would replay up
   * to 24 hours of old commands — some already answered, and some (a `/skip`, a
   * `/next`) that would now land on a different topic.
   */
  async latestUpdateId(): Promise<number | null> {
    try {
      const res = await fetch(this.url("getUpdates", { offset: "-1", limit: "1", timeout: "0" }));
      const body = (await res.json().catch(() => null)) as any;
      if (!res.ok || !body?.ok) return null;
      const updates = (body.result ?? []) as TelegramUpdate[];
      if (!updates.length) return null;
      return Math.max(...updates.map((update) => update.update_id));
    } catch (error: any) {
      warn("[telegram] could not drain the backlog", error?.message || "?");
      return null;
    }
  }

  /**
   * One long poll. Returns an empty array on a timeout or a transient failure,
   * because both look the same from here and the caller should simply poll again.
   */
  async poll(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    try {
      const res = await fetch(this.url("getUpdates", { offset: String(offset), timeout: "50" }), { signal });
      const body = (await res.json().catch(() => null)) as any;
      if (!res.ok || !body?.ok) {
        warn("[telegram] poll failed", res.status, body?.description || "");
        return [];
      }
      return (body.result ?? []) as TelegramUpdate[];
    } catch (error: any) {
      if (error?.name !== "AbortError") warn("[telegram] poll error", error?.message || "?");
      return [];
    }
  }
}

/** Splits on paragraph, then line, then hard boundary — in that order. */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Escapes the three characters Telegram's HTML mode treats as markup. */
export function toHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function describeSender(message: TelegramMessage): string {
  const from = message.from;
  if (!from) return `chat:${message.chat.id}`;
  return `${from.username ? "@" + from.username : from.first_name || "unknown"}(id:${from.id})`;
}

export function noteIgnored(message: TelegramMessage): void {
  log("[telegram] ignored message from", describeSender(message));
}
