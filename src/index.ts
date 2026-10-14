import { loadConfig, log, warn } from "./config.ts";
import { Telegram } from "./telegram.ts";
import { NurxaiClient, isSetupError } from "./nurxai.ts";
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
  //
  // It is reported, not fatal. The mistake is almost always on the *other* host
  // — a secret that has not been set there yet is the common case by far — and
  // dying over another service's configuration would mean a red deploy, a crash
  // loop, and a redeploy needed here before a fix over there could take effect.
  // Staying up means the fix is one edit over there and nothing here.
  let handshakeNotice: string | null = null;
  const probe = await nurxai.queue();
  if (probe.ok) {
    log(`[bot] NurXai reachable, ${probe.data.topics.length} topic(s) waiting`);
  } else if (isSetupError(probe.error)) {
    handshakeNotice =
      `NurXai refused me: ${probe.error}.\n\n` +
      `Both sides need the same LORE_AGENT_SECRET, at least 32 characters:\n` +
      `  - here, in this service's environment\n` +
      `  - on ${config.baseUrl}, or its lore endpoints answer 503 and nothing can reach them\n\n` +
      `Everything else is running. Fix the secret there and this starts working — ` +
      `no redeploy here is needed.`;
    warn("[bot] NurXai rejected the handshake:", probe.error, "— running anyway, commands will report it");
  } else {
    warn("[bot] NurXai did not answer the handshake:", probe.error, "— starting anyway, commands will report it");
  }

  const bot = new LoreBot(config, telegram, nurxai);
  if (handshakeNotice) await bot.notify(handshakeNotice);

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
