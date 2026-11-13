# BrightMinds Backend

REST API for the BrightMinds app: casts (videos), users, universities, virtual labs and research
topics. New casts are enriched in the background with OpenAI (transcription, quiz question, topic
detection). Images are never generated: a cast's image is a frame of its video.

**Stack:** Node 22 · Express 5 · MongoDB (Mongoose 8) · Redis (Bull queues) · Jest · Docker Compose

## Quick start

```bash
cp .env.example .env                              # then set JWT_SECRET (and OPENAI_API_KEY, EMAIL_PWD for full features)
docker compose -f docker-compose.dev.yml up -d    # MongoDB + Redis on localhost
npm install
npm run dev                                       # http://localhost:3000/health
```

## Commands

| Command                           | Description                                |
| --------------------------------- | ------------------------------------------ |
| `npm run dev`                     | Start with auto-reload                     |
| `npm start`                       | Start (production)                         |
| `npm test`                        | Run all tests (no DB/Redis/network needed) |
| `npm run test:coverage`           | Tests + coverage report in `coverage/`     |
| `npm run lint` / `npm run format` | ESLint / Prettier                          |
| `npm run check`                   | Lint + format check + tests (what CI runs) |

## Configuration

All variables are documented in [`.env.example`](.env.example). Required in production:
`MONGODB_URI`, `JWT_SECRET`, `PUBLIC_BASE_URL`. The server refuses to start without them.
With docker compose, `MONGODB_URI` is set by the stack (bundled MongoDB); use
`COMPOSE_MONGODB_URI` to point at an external database instead.

## AI processing

New casts are enriched in the background (`services/ai_pipeline.js`): transcript + subtitles,
quiz question + department (one structured call), topic (from the atlas catalog). Each step is saved as soon as
it succeeds and skipped when its output exists, so retries resume where they stopped. **No image
is ever generated** (see "Images" below).

- **Failures:** OpenAI unreachable / rate-limited → retried 4 times with backoff. Bad key, no
  credit or unknown model → alert email (`OPENAI_ALERT_EMAIL_TO`) and OpenAI calls paused 1 h.
  Cast-specific errors (moderation...) → cast marked `failed` after `AI_MAX_ATTEMPTS` days.
- **Daily retry** (`AI_RETRY_CRON`, default 03:00 server time) re-queues every cast still missing
  outputs. State per cast: `processing` field (`pending` / `processing` / `done` / `failed`).
- **Commands** (on the server: `docker compose exec brightminds npm run ai -- <command>`):
  `check` (key, models, parameters) · `status` (unprocessed casts and last error) ·
  `retry` (queue now) · `retry --failed` (also casts that gave up).
- **Models** (env overrides): `OPENAI_CHAT_MODEL` (`gpt-6.1-terra`, with
  `OPENAI_REASONING_EFFORT=low`), `OPENAI_TRANSCRIPTION_MODEL` (`whisper-1`: the only model
  with timestamps, so the only one producing subtitles; other models give text only).

## Images

A cast's image is a frame of its video (`services/thumbnail.js`, ffmpeg), saved as a 980×560 JPEG
`cast_images/thumb_*.jpg` at upload. The app sends the moment the author picked (`thumbnailTime`,
seconds); without it (API uploads) the most representative frame after the intro is chosen
automatically. `PUT /cast/:id` with `thumbnailTime` re-picks it. At startup, casts whose image is
not a video thumbnail (former AI illustrations) get an automatic thumbnail in the background
(`services/thumbnail_backfill.js`, idempotent).

## Virtual labs

A lab is a department (the 26 OpenAlex fields in `lists/departments.js`). The size of a lab on the app's map is
how much research is done in its field, kept on the lab itself: `research.works12m` (works OpenAlex lists for the
field over the last 12 months) and `research.level` (0-100: log scale between the quietest and the busiest lab).
`services/lab_research.js` creates the 26 labs and fills `research` with a single OpenAlex `group_by` request, at
server start when the data is missing or older than a week, then every Monday at 01:00. If OpenAlex cannot be
reached the previous values stay (a failed refresh is retried at most once an hour, on demand).
`GET /virtual/lab/overview` returns every lab with `works12m`, `level`, `casts`, `topics`, `catalog` and `hot` (research values are
`null` until the first refresh, and the app then draws all labs at the same size).

## Research atlas (topics and scores)

Topics are the research subjects users can follow: which ones are hot, and how far along each is. They live in
layers (`models/topic_model.js`, `lists/departments.js`):

```
domain (4)  >  lab = OpenAlex field (26)  >  area = OpenAlex subfield (~250)  >  topic (~4,500)
```

- **Catalog.** OpenAlex's topic taxonomy is the backbone: it covers every discipline, is open (CC0) and has a stable
  id per topic. `services/atlas_sync.js` downloads all topics (about 25 requests) and keeps each one as a Topic
  document (`source: 'openalex'`) whether or not a cast uses it; casts are classified into it in two short steps,
  area then topic (`services/generate_topic.js`). Topics typed by an author stay (`source: 'author'`) and disappear with
  their last cast. A topic that leaves OpenAlex is `retired`, never deleted while casts use it.
- **Cross-references.** Each topic carries `ids` (Wikipedia title, Wikidata item, MeSH descriptor), its keywords and
  its area, so the same subject can be asked of other platforms. A Wikipedia link is trusted (`anchor: 'match'`)
  only when it is really about the topic.
- **Score** (`services/topic_scoring.js`, `services/topic_metrics.js`). Works (articles and reviews) are counted in
  three rolling 12-month windows ending at least 30 days ago, so late-indexed works do not look like a drop.
  Growth is compared with the topic's own area (median trend of its solid topics), shrunk with a Gamma-Poisson
  empirical-Bayes posterior so that small topics are not over-read, and kept with a credible interval.
  - `trend`: `surging` / `rising` (the lower bound beats the area), `steady`, `cooling` (the upper bound is under
    it) or `niche` (too few works to tell). `phase`: `emerging`, `growing`, `mature`, `declining`.
  - `hot` (0-100 within the lab) blends growth (45%), acceleration (20%), impact = share of top-10% cited works
    (20%) and volume (15%); topics too small to rank have `hot: null`.
  - `featured`: the hottest topics of each lab are listed in the app even without casts.
- **Independent signals** (`services/signals.js`, `services/topic_signals.js`) for the tracked topics (the top 15 of
  each lab and those with casts): PubMed (by MeSH descriptor), arXiv (for the labs it covers) and Wikipedia page
  views. They only count for 25% of `hot`, so one source cannot make a topic hot. Semantic Scholar (non-commercial
  licence) and Crossref (no topic data) are not used.
- **Refresh.** `services/atlas.js`: at server start when the data is older than a week, then every Monday at 02:00
  (`ATLAS_REFRESH_CRON`), in the background; a failure keeps the previous scores and is retried at most once an hour.
  The first run takes about 7 minutes. **Set `OPENALEX_API_KEY`** (free, openalex.org/settings/api): without a key
  OpenAlex shares a small daily budget per IP.
- **Endpoints:** `GET /atlas` (domains and labs), `/atlas/hot`, `/atlas/lab/:name`, `/atlas/topics` (search, filters,
  paging), `/atlas/status`, `GET /topic/:id/progress` (trend, yearly output, signals). `GET /topic` and
  `/topic/department/:name` keep their shape and list the topics with casts, the featured ones and the author's.
- **Commands** (on the server: `docker compose exec brightminds npm run atlas -- <command>`): `status` ·
  `sync` · `metrics` · `signals` · `all` · `hot [lab]` · `topic <text>`.

## Casts only (articles removed)

The app only shares casts. At startup `services/cast_only_migration.js` (idempotent) cleans the
database: users lose `articlePublications` and the `type` of their evaluation list / bookmarks
(article entries are removed), the learning stat `contents` becomes `casts`, topics lose
`articleIDs` / `articleCount` (topics that only had articles are deleted) and an empty `articles`
collection is dropped (one that still holds documents is left alone, with a warning). Leftover
`articleQueue` jobs in Redis are harmless; remove them with
`redis-cli --scan --pattern 'bull:articleQueue:*' | xargs redis-cli del`.

List endpoints (`/cast`, trending, by category / department / author, suggestions, expanded
bookmarks) return cards: the transcript (`description`), the quiz (`evaluation`) and `processing`
only come with `GET /cast/:id` (the quiz question with `GET /cast/evaluation/:id`).

## Accounts and email

Signup, login, email confirmation and password reset live in `controllers/auth_controller.js`.

- **Usable at once.** Signup creates the account and returns a `token`: the user is logged in and
  can use the app while the email is unconfirmed (`isVerified: false`). Login works the same.
  Sending the confirmation email never fails the signup (`emailSent` / `emailStatus` tell the app;
  `POST /user/:id/verification/resend` sends it again).
- **Passwords:** 8 to 72 bytes, not only spaces, not a very common one, not the email or the name
  (`services/credentials.js`, also used by the reset form). Hashed with bcrypt (`BCRYPT_ROUNDS`, 12).
- **Login** answers the same 401 for an unknown email and a wrong password. Emails are
  case-insensitive (accounts saved with capitals before that still log in).
- **Links:** confirmation links last 72 h, reset links 1 h and work once. Only a SHA-256 of the
  token is stored (`services/email_tokens.js`; links sent before that change still work). Per
  account and kind: 1 email per minute and 5 per hour (`services/account_email.js`); the reset
  request always answers 200 so it cannot reveal which emails have an account. A reset also
  confirms the email, and a notice email follows every password change.
- **Changing the email** (`PUT /user/:id`) makes the account unconfirmed again and sends a new link.
- **Rate limits** (`middleware/rate_limit.js`, per IP): failed logins 8 per account / 60 per IP
  every 15 min (successful logins are not counted), signups 10 per hour, email requests 10 per 15 min.
- **Mail delivery** (`services/mailer.js`): Gmail SMTP with `EMAIL_USER` / `EMAIL_PWD` (an app
  password; spaces in it are ignored). Timeouts, one retry on temporary failures, errors classified
  (`config` / `transient` / `recipient`). The server logs at startup whether the credentials work.
  On the server: `docker compose exec brightminds npm run mail -- check` (verify the account, sends
  nothing) and `npm run mail -- test you@example.com` (sends the three emails as a preview).
- **Email design:** `views/emails.js` (light, responsive, with a plain-text part); pages opened from
  the links are in `views/html.js`. The blue header shows the white logo
  `backend/media/verification_email/BrightMinds_title.png`: that folder is git-ignored and must exist on the server.

## API

- Contract: [`openapi.yaml`](openapi.yaml) (a test fails if a route is missing from it).
- Auth: `POST /user/login` returns a JWT; send it as `Authorization: Bearer <token>`.
  It is only **enforced** when `AUTH_REQUIRED=true`.
- Errors: `{ "error": "...", "message": "..." }`.
- Quiz rewards: `POST /user/:id/quiz` grades answers server-side and awards XP, levels, a daily streak and
  badges (rules in `services/rewards.js`); `GET /user/:id/rewards` returns them. Both accept
  `utcOffsetMinutes` so streaks follow the user's local day; a client `quizId` makes retries harmless.
- Learning paths: `GET /learning/paths` (catalog), `GET` / `PUT /user/:id/learning` (profile, milestone journey,
  path change) and `POST /user/:id/learning/papers` (opened research papers). Accounts still on the legacy
  `tracking` field are migrated automatically when the server starts.

## Project layout

```
server.js      process entry (DB, workers, cron, listen)   app.js       Express app
config/        env configuration                           routes/      routers
controllers/   request handlers                            services/    business logic, OpenAI, mail, media
queues/        background jobs (Bull)                      middleware/  auth, uploads, errors, rate limit
models/        Mongoose schemas                            views/       HTML pages & emails
tests/         unit + integration tests                    backend/media/  uploaded files (git-ignored)
```

Working with Claude Code: conventions and workflows are in [`CLAUDE.md`](CLAUDE.md).

## CI

`.github/workflows/ci.yml` — every push: lint, format check, tests with coverage, then builds the
Docker image and smoke-tests the full stack (`/health`).

## Production

Live at `https://api.greenlights.us` on the home server (Homeboy Network repo/folder):

- Clone in `/opt/homeboy/repos/brightminds`; services `brightminds`, `brightminds-mongo`,
  `brightminds-redis` in `/opt/homeboy/compose.yml`; Caddy terminates TLS.
- Secrets in `/opt/homeboy/brightminds.env` (`JWT_SECRET`, `OPENAI_API_KEY`, `EMAIL_USER`,
  `EMAIL_PWD`, `OPENAI_ALERT_EMAIL_TO`); `PUBLIC_BASE_URL` etc. are set in `compose.yml`.
- Uploads in the clone's `backend/media` (bind mount); MongoDB and Redis in Docker volumes.
- Deploy: push to `main`, then `/opt/homeboy/deploy.sh` on the server.

`docker-compose.yml` in this repo is the standalone equivalent (used by CI).

## Remaining actions

- [ ] Backups: scheduled `mongodump` + copy of `backend/media` off the server.
- [ ] Remove the old AWS secrets from GitHub (`AWS_*`, `HOST_IP`, `SSH_KEY`, `MONGODB_URI_TEST`)
      and decommission the EC2/PM2 instance and MongoDB Atlas cluster.

**Application**

- [ ] Update the mobile app to send `Authorization: Bearer <token>` on protected routes
      (see `security` in `openapi.yaml`), then set `AUTH_REQUIRED=true`.
- [ ] Before **2027-02-26** (`whisper-1` shutdown): switch `OPENAI_TRANSCRIPTION_MODEL` to its
      successor. Check whether it returns timestamps; if not, subtitles need another source.
