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
quiz question + department (one structured call), OpenAlex topic. Each step is saved as soon as
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
