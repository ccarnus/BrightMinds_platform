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

## CI / CD

- **CI** (`.github/workflows/ci.yml`) — every push: lint, format check, tests with coverage, then
  builds the Docker image and smoke-tests the full stack (`/health`).
- **Deploy** (`.github/workflows/deploy.yml`) — manual (_Actions → Deploy → Run workflow_): reruns
  CI, then SSHes into the server, checks out the commit and runs `docker compose up -d --build`.

## Production

```bash
git clone git@github.com:ccarnus/brightminds.git && cd brightminds
cp .env.example .env                  # fill in production values
sudo chown -R 1000:1000 backend/media # the container runs as uid 1000 and writes uploads here
docker compose up -d --build --wait
```

The stack runs the API (bound to `127.0.0.1:3000`), MongoDB and Redis. Uploaded media is stored
in `./backend/media` on the host; MongoDB and Redis data in Docker volumes.

## Remaining actions

**Security — do first**

- [ ] **Rotate the MongoDB Atlas password**: it was committed in `app.js` (removed now, but still
      in git history). Optionally purge history with `git filter-repo`.
- [ ] Remove the old AWS secrets from GitHub (`AWS_*`, `HOST_IP`, `SSH_KEY`, `MONGODB_URI_TEST`)
      and decommission the EC2/PM2 instance once the new server is live.

**Server**

- [ ] Linux host with Docker Engine + Compose plugin; CPU with AVX (required by MongoDB ≥ 5).
- [ ] Deploy user in the `docker` group, SSH key-only login; firewall allowing only 22/80/443.
- [ ] Clone the repo (read-only GitHub deploy key) into the deploy path, then
      `sudo chown -R 1000:1000 backend/media` (uploads fail with EACCES otherwise).
- [ ] Create `.env` from `.env.example`: `JWT_SECRET` (`openssl rand -hex 32`),
      `PUBLIC_BASE_URL=https://api.brightmindsresearch.com`, `OPENAI_API_KEY`, `EMAIL_PWD`,
      `OPENAI_ALERT_EMAIL_TO`. To stay on Atlas, set `COMPOSE_MONGODB_URI` (not `MONGODB_URI`).
- [ ] Reverse proxy with TLS for `api.brightmindsresearch.com` → `127.0.0.1:3000`
      (Caddy, or nginx + certbot). Allow request bodies ≥ 1 GB (video uploads). Point DNS to the server.
- [ ] Migrate data: copy the old server's `backend/media/*` into `./backend/media`
      (`chown -R 1000:1000`), and `mongodump`/`mongorestore` if leaving Atlas.
- [ ] Cutover: stop new uploads on the old server and wait for its Bull queues to drain — jobs
      left in the old Redis are lost and those casts/articles would stay "Pending".
- [ ] Backups: scheduled `mongodump` + copy of `backend/media` off the server.

**GitHub**

- [ ] Create the `production` environment (Settings → Environments), optionally with required reviewers.
- [ ] Add environment secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key),
      `DEPLOY_PATH` (repo path on the server), optional `DEPLOY_PORT`.
- [ ] Run the _Deploy_ workflow once and check `https://api.brightmindsresearch.com/health`.

**Application**

- [ ] Update the mobile app to send `Authorization: Bearer <token>` on protected routes
      (see `security` in `openapi.yaml`), then set `AUTH_REQUIRED=true`.
- [ ] Review OpenAI models (`gpt-4`, `dall-e-3`, `whisper-1` by default are older models; check
      OpenAI's deprecation page). Override with `OPENAI_CHAT_MODEL` / `OPENAI_IMAGE_MODEL` /
      `OPENAI_TRANSCRIPTION_MODEL`.
