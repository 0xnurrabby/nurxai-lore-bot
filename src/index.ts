import { loadConfig, log, warn } from "./config.ts";
import { Telegram } from "./telegram.ts";
import { NurxaiClient } from "./nurxai.ts";
import { LoreBot } from "./flow.ts";
import { startHealthServer, type HealthServer } from "./health.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new Telegram(config.telegramToken);
  const nurxai = new NurxaiClient(config);

  // Bind before anything slow. The host watches for the port and fails the deploy
  // if it never opens, so opening it first means a network error later is a
  // running service with a bad log line rather than a deploy that never lands.
  let health: HealthServer | null = null;
  if (config.port > 0) {
    health = startHealthServer({ port: config.port, path: config.healthPath });
    log(`[bot] health listener on port ${health.port}${config.healthPath}`);
  } else {
    log("[bot] no PORT set — running without an HTTP listener");
  }

  // Handshake before polling. A bad secret or a closed endpoint is a setup
  // mistake, and finding it now costs one request while finding it after the
  // operator has pasted 20,000 characters of research costs their afternoon.
  const probe = await nurxai.queue();
  if (!probe.ok) {
    const fatal = ["LORE_AGENT_DISABLED", "BAD_SIGNATURE", "STALE_SIGNATURE", "BAD_TIMESTAMP", "SIGNATURE_REQUIRED"];
    if (fatal.includes(probe.error)) {
      throw new Error(
        `the NurXai handshake failed (${probe.error}).\n` +
          `  - LORE_AGENT_SECRET here and on ${config.baseUrl} must be the same value, at least 32 characters\n` +
          `  - ${config.baseUrl} must have LORE_AGENT_SECRET set at all — without it the endpoints answer 503`
      );
    }
    warn("[bot] NurXai did not answer the handshake:", probe.error, "— starting anyway, commands will report it");
  } else {
    log(`[bot] NurXai reachable, ${probe.data.topics.length} topic(s) waiting`);
  }

  const bot = new LoreBot(config, telegram, nurxai);

  const shutdown = (signal: string) => {
    log(`[bot] ${signal} received, stopping`);
    bot.stop();
    health?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await bot.run();
}

main().catch((error: any) => {
  console.error(error?.message || error);
  process.exit(1);
});
