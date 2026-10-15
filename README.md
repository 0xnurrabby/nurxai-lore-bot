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
          + a monospace question, tap-to-copy
        │
        │  you paste the brief into Grok on X
        ▼
you reply to that brief with Grok's answer — in one message, or in several
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

## The two rules that make it survive a real chat window

A hand-run workflow has exactly two ways to go wrong, and both are designed out.

**A paste is bound to the prompt it answers.** Telegram's reply carries the id of
the message being replied to, and every message the bot sends for a brief — the
`Next:` header and the brief itself, one id each — is recorded against that brief
for seven days. So `Reply to Nur…` is not a nicety: it is the mechanism. Answer a
prompt from last week by replying to it and it files against last week's subject,
not today's. A paste sent bare falls back to the single pending brief, and a paste
with neither is refused rather than guessed at:

> I do not know which topic that belongs to. Nothing is pending, and this was not a
> reply to a brief I sent — so I would be guessing.

Message ids are numbered per chat, not globally, so the record is keyed
`<chatId>:<messageId>` — two operators being sent the same brief must not collide
on whatever id Telegram happened to hand the second chat.

**A paste can arrive in pieces.** Telegram refuses anything over 4,096 characters
and a real answer to the research brief is 5,000–20,000, so the operator sends it
as several messages whether or not anyone planned for it. The bot collects them,
re-arming a quiet timer on every piece, and files once the pieces stop — or
immediately on `/done`. One live notice counts up as they arrive, rather than one
line per piece:

```
Collecting for Base (protocol) — 3 messages, 11,204 characters.
```

Pieces are joined on a newline, not glued (`joinParts`). Telegram's hard split at
4,096 lands mid-word, but a person splitting by hand lands on a line ending — and
gluing a consumed line ending back together is what destroys a heading like
`WHAT IT IS`. A spurious break inside a word costs nothing; a consumed heading
costs the field.

Only one paste is collected at a time, and a second document aimed at a different
subject while the first is open is named rather than mixed in. If a parse or a
write fails, the collected text is **kept** and the notice says so — it is never
silently dropped.

---

## The security model

The short version: **this bot cannot read the database, and the only thing that
can reach it is a health check.**

| Property | How |
| --- | --- |
| One path, one response | The process listens on one port and answers exactly one URL, chosen by `HEALTH_PATH`. That URL returns the constant `ok` to `GET` and `HEAD`; everything else is a 404. It reads no body, parses no query string, trusts no header, and reports no version, no uptime, no state and no counts. It cannot start, stop, pause, ask or file anything. It exists only so the host can health-check the process. |
| Nothing else is reachable | Telegram is reached by **long polling**, so there is no webhook URL to guess and no request body to forge. There is no endpoint that makes the bot do something. |
| No database credential | Turso is never touched. Two signed HTTP endpoints are the entire surface. |
| No SQL | There is no query language in this project. Prepared statements live on the NurXai side; here there is a key and an object. |
| One allowlisted set of people | `TELEGRAM_OWNER_ID` — one id or several. Any message from an id that is not on the list is logged and dropped. The bot refuses to start without at least one, because a bot with no allowlist is a bot anyone can drive. |
| Replay-proof | The signature covers `timestamp.method.path.sha256(body)`, and the window is five minutes. A captured request is useless a minute later, and a signature for the queue endpoint does not work on the write endpoint. |
| Fail-closed | With `LORE_AGENT_SECRET` unset, NurXai answers `503` on both endpoints. The door does not exist until the key does. |
| Zero runtime dependencies | `node:`, `fetch`, and `crypto`. Everything that handles a secret or a signature is a file you can read in one sitting. |
| The paste is data | A research document that says "ignore previous instructions" is stored as text. It is never executed, and NurXai clamps every field before it reaches the database. |

What a leak costs: someone with the bot token can ask *you* for lore. They still
cannot read or write the database, because they do not have the secret, and the
secret is not in the token.

---

## More than one person

`TELEGRAM_OWNER_ID` takes one id or several, separated by commas or spaces. That
is for the ordinary case of one operator with two Telegram accounts, and the rules
are chosen so two accounts can never corrupt each other's work:

- **A command answers its sender only.** `/status` and `/next` go back to whoever
  typed them, so a second account is never notified about the first one's chores.
- **An automatic ask goes to everyone.** It has no sender — the bot spoke first —
  so every account on the list sees it.
- **A paste is filed against the one pending brief, whoever sends it.** There is
  still exactly one open question, so the second person to paste is told nothing
  is pending rather than having their document filed against the wrong topic.
- **Every other id is logged and dropped**, and the bot refuses to start when the
  list is empty.

---

## Running it on a free host

Render's free tier only runs **web services**, and it stops an instance after
fifteen minutes without an HTTP request. A long-polling bot makes no inbound
requests, so on its own it would be killed every fifteen minutes and the Telegram
poll would die with it. Two things fix that:

1. `src/health.ts` gives the process a port to bind and a URL to answer, so the
   host is satisfied that it is alive.
2. An external ping every five minutes stops Render from idling it out.

### UptimeRobot, exactly

1. Sign in at [uptimerobot.com](https://uptimerobot.com) → **Add New Monitor**.
2. **Monitor Type:** `HTTP(s)`
3. **Friendly Name:** `NurXai lore bot`
4. **URL (or IP):** the full health URL, including the path and the scheme —
   `https://<your-service>.onrender.com<HEALTH_PATH>`
   e.g. `https://nurxai-lore-bot.onrender.com/up-7f3a91c4`
5. **Monitoring Interval:** `5 minutes`
6. Leave everything else at its default. Save.

**Why five minutes:** Render idles a free service after fifteen, so anything
faster than that works; five is the free plan's finest granularity and uses the
least of your monitor quota. Setting it to one minute gains nothing.
**Why the path is random:** the health URL is the entire inbound surface. With a
conventional path like `/health`, every scanner on the internet would find it.
With `HEALTH_PATH` set to a random slug, a scanner gets a 404 on `/` and a 404 on
`/health` and cannot tell this host apart from an empty one.

**Free-tier arithmetic:** keeping one service awake around the clock is about 730
instance-hours a month against a 750-hour allowance. One service, all month, is
what the free tier is for — but a *second* always-on free service would eat into
it.

**If the ping ever stops**, nothing is lost. The bot sleeps, Telegram buffers
updates for 24 hours, and the next ping wakes it — and `latestUpdateId()` at
startup skips whatever it missed rather than replaying it.

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
TELEGRAM_OWNER_ID=5005957731,7704510926
NURXAI_BASE_URL=https://nurxai.xyz
LORE_AGENT_SECRET=<the same value as on NurXai>
ANTHROPIC_API_KEY=sk-ant-...
```

`AI_GATEWAY_API_KEY` can be used instead of `ANTHROPIC_API_KEY` — the same key
NurXai already uses. Anthropic wins when both are set.

### 6. Deploying

On Render, create a **Web Service** (the free plan has no background workers) from
this repo:

| Setting | Value |
| --- | --- |
| Environment | `Node` |
| Build Command | `npm install --include=dev && npm run check` |
| Start Command | `npm start` |
| Health Check Path | the same value as `HEALTH_PATH` |
| Instance Type | `Free` |

`--include=dev` matters: `NODE_ENV=production` skips devDependencies and the bot
runs from `tsx`, which is one. The `npm run check` on the build is a deploy gate —
it typechecks and runs the 61 offline assertions, so a broken commit cannot ship.

Set `HEALTH_PATH` to a random slug and give the same value to the health check
path:

```bash
node -e "console.log('/up-' + require('crypto').randomBytes(6).toString('hex'))"
```

`PORT` is set by Render; you do not set it yourself. On a machine with no health
check, leaving `PORT` unset is better — the process then opens no listener at all.

### 7. Run it locally

```bash
npm install
npm run check     # typecheck + 61 offline assertions
npm start
```

On startup it verifies the Telegram token and performs one signed handshake with
NurXai. A wrong secret, a clock outside the five-minute window, or an unset secret
on the server is reported immediately — in the log, and as a Telegram message to
every operator — rather than after you have pasted 20,000 characters of research.

A failed handshake is **reported, not fatal**. The mistake is almost always on the
other host — a secret that has not been set there yet is the common case by far —
so the bot stays up and keeps retrying per command instead of crash-looping over
another service's configuration. Set the secret there and it starts working with
no redeploy here.

---

## Commands

Four, because the loop is: a question arrives, you paste it somewhere. Nothing
else needs a verb.

| Command | Does |
| --- | --- |
| `/next` | Send the next question now, without waiting for the timer |
| `/done` | File what I have collected, without waiting for the quiet timer |
| `/skip` | Drop this question and the collected paste; the topic goes on cooldown |
| `/status` | Whether NurXai is reachable, what is open, what is being collected |
| any other text | Collected as the answer to the question you replied to |

`/queue`, `/pause`, `/resume` and `/cancel` are gone. Asking is already
one-at-a-time — a new question only arrives after you file or skip the last one —
so there was nothing for `/pause` to pause, and `/cancel` was the same verb as
`/skip`.

---

## Design notes

**One outstanding question, ever.** The pending topic is stored, and a paste is
always filed against exactly that topic — or against the message you replied to,
which is the same topic stated explicitly. A queue of open questions is how the
wrong research ends up filed against the wrong subject without anyone noticing.

**Triggers come from real usage.** The queue reads the cache-event log the reply
path already writes, so "this topic matters" is measured from posts that actually
happened rather than guessed from a list. A topic needs at least two posts
(`LORE_MIN_MISSES`) before it is worth your time.

**A question about a person is not asked.** An `x-<handle>` key with no entity
type means the resolver found nothing to call the subject and fell back to the
author of the post. That is a stranger, not a topic, and NurXai's own rule is that
lore is never keyed on an individual author — so `isAskableTopic` refuses it and
logs what it skipped. This is a guard, not a fix: the scoring that lets an author
outrank the subject lives on the NurXai side and still needs to change.

**Stale records get corrected, not duplicated.** When a topic's stored record has
expired, the question carries the old summary and the parser's answer replaces it.
The instruction is explicit: anything no longer true has to be named, because the
parts that go unmentioned are treated as still correct.

**The question is written the way the operator writes.** Roman-script Bangla, in a
monospace block, because it is going into a chat window and a form-letter in
English headings produced form-letter answers. The points are the same fields the
record needs — asked as questions rather than demanded as sections — and the parser
is told to write the record in English regardless, because the reply writer's
output is English and Bengali fields would bleed into it.

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
| `src/brief.ts` | The question you paste into Grok, in the operator's own register |
| `src/claude.ts` | Document → record. The one model call. |
| `src/record.ts` | The record's shape, and whether it is worth filing |
| `src/state.ts` | One small JSON file: offset, pending ask, cooldowns, and which message carried which brief |
| `src/health.ts` | The single inbound path, and why it exists |
| `src/flow.ts` | The whole conversation |
| `scripts/selfcheck.ts` | 61 offline assertions over the pure parts |

---

## Known limits

- **A deploy logs a few 409s.** Render starts the new instance before stopping the
  old one, so for about ten seconds two processes long-poll Telegram and Telegram
  rejects both (`terminated by other getUpdates request`). It stops on its own when
  the old instance is killed, and nothing is lost — the drain at startup means the
  survivor does not replay what the other one consumed.
- **The state file is ephemeral on a free host.** Render's filesystem does not
  survive a deploy, so `offset`, the pending ask, the cooldowns and the brief map
  all reset. Losing the offset is handled (`latestUpdateId()` skips the backlog
  rather than replaying it). Losing the brief map means a reply to an *old* prompt
  degrades to the pending fallback, and losing a pending ask costs one re-ask. A
  paste **in flight** when the process dies is lost, because it only ever existed
  in memory — that is the one case where a redeploy costs an actual paste, so do
  not push while one is open.
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
