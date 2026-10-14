# NurXai Lore Bot

A Telegram bot that turns repeated interest in a topic into a **lore record**
NurXai can read when it writes replies.

It exists because of a specific failure. NurXai writes a reply from the post, its
quoted post and the top replies in the thread — and when a topic keeps coming up
that it knows nothing about, the reply has nothing real to say. Live research on
the reply path was how that used to be handled, and it was the wrong shape: every
reply paid for a search it usually did not need, and the knowledge was thrown away
at the end of the call.

This bot inverts it. Knowledge is acquired **once, by hand, for the topics that
actually recur**, and it is written down.

---

## The loop

```
NurXai keeps writing replies about Aerodrome and has no record of it
        │
        │  the reply path logs "lore miss" every time
        ▼
GET /api/lore/queue        →  x-aerodrome, no lore, 7 posts
        │
        ▼
Telegram: "Next: Aerodrome (protocol) — no lore yet, 7 posts without an answer"
          + a research brief, formatted for Grok
        │
        │  you paste the brief into Grok on X
        ▼
you paste Grok's answer back into Telegram
        │
        ▼
one Claude call restates the document as a fixed-shape record
        │
        ▼
POST /api/lore             →  Turso
        │
        ▼
every later reply about Aerodrome reads it
```

There is no Grok API call anywhere in this project. You run the search in the app
you already have, which is why the bot needs no xAI credential, costs nothing per
research and cannot spend money on its own initiative.

---

## The security model

The short version: **this bot cannot read the database, and nothing can reach
this bot.**

| Property | How |
| --- | --- |
| No inbound port | Telegram long polling. The process only makes outbound HTTPS calls, so there is no host to scan, no webhook URL to guess and no certificate to get right. |
| No database credential | Turso is never touched. Two signed HTTP endpoints are the entire surface. |
| No SQL | There is no query language in this project. Prepared statements live on the NurXai side; here there is a key and an object. |
| One allowlisted human | `TELEGRAM_OWNER_ID`. Any message from any other id is logged and dropped. The bot refuses to start without it, because a bot with no allowlist is a bot anyone can drive. |
| Replay-proof | The signature covers `timestamp.method.path.sha256(body)`, and the window is five minutes. A captured request is useless a minute later, and a signature for the queue endpoint does not work on the write endpoint. |
| Fail-closed | With `LORE_AGENT_SECRET` unset, NurXai answers `503` on both endpoints. The door does not exist until the key does. |
| Zero runtime dependencies | `node:`, `fetch`, and `crypto`. Everything that handles a secret or a signature is a file you can read in one sitting. |
| The paste is data | A research document that says "ignore previous instructions" is stored as text. It is never executed, and NurXai clamps every field before it reaches the database. |

What a leak costs: someone with the bot token can ask *you* for lore. They still
cannot read or write the database, because they do not have the secret, and the
secret is not in the token.

---

## Setup

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather) → `/newbot`. Take the token.

### 2. Find your Telegram user id

Message [@userinfobot](https://t.me/userinfobot). It replies with `Id: 123456789`.

### 3. Generate the shared secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Configure NurXai

Set on the NurXai host (Render → environment), then redeploy:

```
LORE_AGENT_SECRET=<the same value>
```

Until this is set, `GET /api/lore/queue` and `POST /api/lore` both return `503`.

### 5. Configure this bot

```bash
cp .env.example .env
```

```ini
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_ID=123456789
NURXAI_BASE_URL=https://nurxai.xyz
LORE_AGENT_SECRET=<the same value as on NurXai>
ANTHROPIC_API_KEY=sk-ant-...
```

`AI_GATEWAY_API_KEY` can be used instead of `ANTHROPIC_API_KEY` — the same key
NurXai already uses. Anthropic wins when both are set.

### 6. Run it

```bash
npm install
npm run check     # typecheck + 29 offline assertions
npm start
```

On startup it verifies the Telegram token and performs one signed handshake with
NurXai. A wrong secret, a clock outside the five-minute window, or an unset secret
on the server is reported immediately and clearly, rather than after you have
pasted 20,000 characters of research.

---

## Commands

| Command | Does |
| --- | --- |
| `/next` | Sends the next research brief (ignores the cooldown — you asked) |
| `/queue` | What is waiting and how often each topic came up |
| `/status` | What is pending, whether automatic asking is on |
| `/skip` | Drops the pending brief; the topic stays on cooldown |
| `/pause` / `/resume` | Turns automatic asking off and on |
| any other text | Filed as the answer to the pending brief |

---

## Design notes

**One outstanding brief, ever.** The pending topic is stored, and a paste is
always filed against exactly that topic. A queue of open questions, or a topic
chosen by which message you replied to, is how the wrong research ends up filed
against the wrong subject without anyone noticing.

**Triggers come from real usage.** The queue reads the cache-event log the reply
path already writes, so "this topic matters" is measured from posts that actually
happened rather than guessed from a list. A topic needs at least two posts
(`LORE_MIN_MISSES`) before it is worth your time.

**Stale records get corrected, not duplicated.** When a topic's stored record has
expired, the brief carries the old summary and the parser's answer replaces it.
The instruction is explicit: anything no longer true has to be named, because the
parts that go unmentioned are treated as still correct.

**The brief asks for headings, not JSON.** Grok's answer is prose whatever you ask
for; a prompt demanding JSON gets broken JSON or a refusal. Fixed headings survive
being copied out of a chat window intact, and `extractJsonObject` in `claude.ts`
handles the model's output robustly enough that a fenced block or a stray sentence
does not matter.

**The record's shape is validated twice, for two different reasons.** `coerceRecord`
here exists so you get a useful error before a wasted round trip.
`parseEntityIntel` on the NurXai side is the actual gate — it clamps lengths,
drops non-`http(s)` citations and refuses records with no summary, because it is
the side that has to survive a hostile paste.

---

## Files

| File | Job |
| --- | --- |
| `src/index.ts` | Entry point, shutdown, startup handshake |
| `src/config.ts` | Environment, validated once at startup |
| `src/telegram.ts` | Telegram client — long poll, send, split, escape |
| `src/nurxai.ts` | The signed client. The only place a secret is used. |
| `src/brief.ts` | The research brief you paste into Grok |
| `src/claude.ts` | Document → record. The one model call. |
| `src/record.ts` | The record's shape, and whether it is worth filing |
| `src/state.ts` | One small JSON file: offset, pending ask, cooldowns |
| `src/flow.ts` | The whole conversation |
| `scripts/selfcheck.ts` | 29 offline assertions over the pure parts |

---

## Known limits

- **Topics are entity-level.** A project, company, protocol or token. Narrative
  keys (`narr-…`) are not aggregated yet, so one story told across several
  entities is researched per entity.
- **No `/add` for a topic that has not shown up in usage.** The key has to come
  from the queue, because a key invented here would not match the key the reply
  path derives, and the record would never be found.
- **Refreshes merge rather than prune inside a timeline.** `entity_state` rows
  supersede by label, so "what is true now" is replaced correctly; historical
  timeline entries accumulate, which is usually what you want from history but
  means a superseded milestone is not automatically removed.
