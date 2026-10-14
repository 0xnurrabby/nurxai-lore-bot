import { log, warn } from "./config.ts";

// A minimal Telegram client.
//
// Long polling, not webhooks. That choice is the reason this bot has no inbound
// port, no public URL and no TLS certificate to get right: it only ever makes
// outbound HTTPS calls to Telegram, exactly like a desktop client. There is
// nothing on this host for anything to connect to.

export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
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
      warn("[telegram]", method, "failed", res.status, body?.description || "");
      return null;
    }
    return body.result as T;
  }

  async getMe(): Promise<{ id: number; username?: string } | null> {
    return this.call<{ id: number; username?: string }>("getMe");
  }

  async send(chatId: number, text: string, options: { html?: boolean; silent?: boolean } = {}): Promise<boolean> {
    // Telegram caps a message at 4096 characters. The Grok prompt is the only
    // thing that could approach it, and a silently truncated prompt would send
    // the operator off to research the wrong question, so this splits rather than
    // truncates.
    const chunks = splitMessage(text, 4000);
    let ok = true;
    for (const chunk of chunks) {
      const result = await this.call<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: options.html ? toHtml(chunk) : chunk,
        ...(options.html ? { parse_mode: "HTML" } : {}),
        disable_web_page_preview: true,
        ...(options.silent ? { disable_notification: true } : {})
      });
      if (!result) ok = false;
    }
    return ok;
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
