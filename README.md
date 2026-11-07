# BrightMinds Backend

REST API for the BrightMinds app: casts (videos), articles, users, universities, virtual labs and
research topics. New content is enriched in the background with OpenAI (transcription, quiz
question, illustration, topic detection).

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

## API

- Contract: [`openapi.yaml`](openapi.yaml) (a test fails if a route is missing from it).
- Auth: `POST /user/login` returns a JWT; send it as `Authorization: Bearer <token>`.
  It is only **enforced** when `AUTH_REQUIRED=true`.
- Errors: `{ "error": "...", "message": "..." }`.

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
- [ ] Review OpenAI models (`gpt-4`, `dall-e-3`, `whisper-1` by default are older models; check
      OpenAI's deprecation page). Override with `OPENAI_CHAT_MODEL` / `OPENAI_IMAGE_MODEL` /
      `OPENAI_TRANSCRIPTION_MODEL`.
