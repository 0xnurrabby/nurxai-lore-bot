import fs from "node:fs";
import path from "node:path";

// Configuration, validated once at startup and then frozen.
//
// Everything here is read from the environment and the process refuses to start
// when something required is missing. That is on purpose: a bot that starts with
// half a config and discovers it later fails at the worst moment — in the middle
// of a paste the operator has already waited for.

export type Provider = "anthropic" | "gateway";

export type Config = {
  telegramToken: string;
  ownerId: number;
  baseUrl: string;
  secret: string;
  provider: Provider;
  parserModel: string;
  parserKey: string;
  parserTimeoutMs: number;
  stateFile: string;
  autoAsk: boolean;
  askCooldownMs: number;
  minMisses: number;
  pollIntervalMs: number;
};

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  const load = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load === "function") {
    load.call(process, file);
    return;
  }
  // Node < 20.12. Deliberately minimal: KEY=VALUE, no interpolation, no quoting
  // tricks. A half-implemented dotenv is a way to load the wrong secret quietly.
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function str(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = str(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = str(env, name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv();

  const problems: string[] = [];

  const telegramToken = str(env, "TELEGRAM_BOT_TOKEN");
  if (!telegramToken) problems.push("TELEGRAM_BOT_TOKEN is required (from @BotFather)");

  const ownerRaw = str(env, "TELEGRAM_OWNER_ID");
  const ownerId = Number(ownerRaw);
  if (!ownerRaw) {
    problems.push("TELEGRAM_OWNER_ID is required — an empty allowlist is an open bot");
  } else if (!Number.isInteger(ownerId) || ownerId <= 0) {
    problems.push("TELEGRAM_OWNER_ID must be a positive integer");
  }

  const secret = str(env, "LORE_AGENT_SECRET");
  if (!secret) problems.push("LORE_AGENT_SECRET is required");
  else if (secret.length < 32) problems.push("LORE_AGENT_SECRET must be at least 32 characters");

  const anthropicKey = str(env, "ANTHROPIC_API_KEY");
  const gatewayKey = str(env, "AI_GATEWAY_API_KEY");
  let provider: Provider = "anthropic";
  let parserKey = anthropicKey;
  if (!anthropicKey) {
    if (gatewayKey) {
      provider = "gateway";
      parserKey = gatewayKey;
    } else {
      problems.push("set ANTHROPIC_API_KEY, or AI_GATEWAY_API_KEY as a fallback");
    }
  }

  const baseUrl = (str(env, "NURXAI_BASE_URL") || "https://nurxai.xyz").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) {
    problems.push("NURXAI_BASE_URL must be an https origin — the signature travels in a header");
  }

  if (problems.length) {
    throw new Error(`Cannot start:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    telegramToken,
    ownerId,
    baseUrl,
    secret,
    provider,
    parserModel:
      str(env, "LORE_PARSER_MODEL") || (provider === "anthropic" ? "claude-haiku-4-5" : "anthropic/claude-haiku-4.5"),
    parserKey,
    parserTimeoutMs: num(env, "LORE_PARSER_TIMEOUT_MS", 45_000),
    stateFile: path.resolve(process.cwd(), str(env, "LORE_STATE_FILE") || "state.json"),
    autoAsk: bool(env, "LORE_AUTO_ASK", true),
    askCooldownMs: num(env, "LORE_ASK_COOLDOWN_HOURS", 24) * 60 * 60 * 1000,
    minMisses: Math.max(1, Math.round(num(env, "LORE_MIN_MISSES", 2))),
    pollIntervalMs: Math.max(5, num(env, "LORE_POLL_INTERVAL_MINUTES", 30)) * 60 * 1000
  };
}

export function log(...parts: unknown[]): void {
  console.log(new Date().toISOString(), ...parts);
}

export function warn(...parts: unknown[]): void {
  console.warn(new Date().toISOString(), ...parts);
}
