# CLAUDE.md

BrightMinds backend: REST API (Express 5, Mongoose 8, Node 22) for the BrightMinds mobile app.
The only content is **casts** (videos; there are no articles), enriched in the background with OpenAI
(transcription + subtitles, quiz question, department; see README "AI processing") and classified
into OpenAlex **topics** whose impact/activity scores are recomputed weekly. Images are never
generated: a cast uses a frame of its video.

## Commands

```bash
npm run dev            # watch mode (needs MongoDB + Redis: docker compose -f docker-compose.dev.yml up -d)
npm test               # all tests (in-memory MongoDB, no network, no Redis)
npx jest tests/integration/cast.test.js   # one file
npm run lint           # ESLint
npm run format         # Prettier (write)
npm run check          # lint + format check + tests — run before declaring work done
```

## Layout

| Path                   | Role                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `server.js`            | Process entry: validate config, connect DB, start queue workers + cron, listen, graceful shutdown |
| `app.js`               | Express app only (no side effects) — imported by tests                                            |
| `config/index.js`      | **Only** place that reads `process.env`                                                           |
| `routes/`              | One router per resource; `routes/index.js` maps mount prefix → router                             |
| `controllers/`         | Request handlers (thin: validate, call models/services, respond)                                  |
| `services/`            | Business logic & integrations (OpenAI, mail, media files, topics, metrics, rewards, learning)     |
| `queues/`              | Bull cast queue, runs `services/ai_pipeline.js` (daily retry: `services/ai_retry.js`)             |
| `middleware/`          | `auth` (JWT), `upload` (multer), `error_handler`, `rate_limit`                                    |
| `models/`              | Mongoose schemas                                                                                  |
| `views/html.js`        | HTML pages (email confirmation, password reset) and email bodies                                  |
| `utils/http.js`        | `HttpError`, `badRequest`, `notFound`, `assertObjectId`, `parseJsonField`, `pick`                 |
| `lists/departments.js` | Allowed departments ↔ OpenAlex field ids                                                          |
| `backend/media/`       | Uploaded/generated files (git-ignored), served at `/backend/media/*`                              |
| `openapi.yaml`         | API contract — must list every route (enforced by `tests/unit/openapi.test.js`)                   |

## Conventions

- **Errors**: controllers are `async` and `throw` (`badRequest`, `notFound`, `new HttpError(status, msg)`).
  Express 5 forwards rejections to `middleware/error_handler.js`, which also maps Mongoose
  validation/cast errors → 400 and duplicate keys → 409, and deletes `req.file` on failure.
  Error body is `{ error, message }` (same text; legacy clients read either).
- **Inputs**: call `assertObjectId()` on every id param. Never spread `req.body` into a model —
  whitelist with `pick(body, FIELDS)`. Coerce query/body values used in Mongo filters to strings
  (prevents `{ $ne: null }` injection).
- **Compatibility**: the mobile app depends on current success payloads and status codes
  (e.g. some updates return 201). Do not change them without being asked.
- **Files**: uploads only through `middleware/upload.js`; build URLs/paths with `services/media.js`
  (`mediaUrl`, `mediaPathFromUrl`, `deleteMediaByUrl`). Never join user input into a path.
- **Images**: never generate images (no image model). Cast images are video frames from
  `services/thumbnail.js` (`createCastThumbnail`: `time` = author's moment, omitted = automatic;
  files `thumb_*.jpg`, which the startup backfill uses to recognise converted casts). The URL is
  not client-editable.
- **Auth**: protect write routes with `authenticate`, per-user routes with `[authenticate, requireSelf('id')]`.
  Enforcement is controlled by `AUTH_REQUIRED` (currently off in production until the app sends tokens).
- **Topics**: always go through `services/topics.js` (`createTopicIfNotExist`, `removeExistingTopic`,
  `moveCastTopic`). `Pending Topic` / `Pending Department` are placeholders until a queue job fills them.
- **Casts only**: there is a single content type. `evaluation_list` and `bookmarkedcontent` entries hold cast ids
  (`contentid`) with no `type`; cast rules shared by the endpoints live in `services/cast.js`. List endpoints return
  cards (`CARD_PROJECTION`: no `description`, `evaluation`, `processing`): add new list endpoints with the same
  projection. Data left by the retired articles is cleaned at start by `services/cast_only_migration.js`
  (idempotent); never reintroduce `articles` without a new design.
- **Quiz rewards**: `services/rewards.js` holds the pure rules (XP, levels, streak, badges);
  `POST /user/:id/quiz` grades against the stored `evaluation.correct` and is the only writer of
  `user.rewards` (never add it to `SELF_EDITABLE_FIELDS`). The app mirrors the XP/level rules in
  `src/features/track/utils/rewards.js` for live previews — change both together. Badge icons live in the
  app (`BADGE_STYLES`): add one there when adding a badge.
- **Learning paths**: `services/learning.js` holds the path catalog (`follower`, `explorer`, `deep_learner`,
  `researcher`; keys are stable, the app keys its visuals on them) and the pure milestone rules: goals read
  lifetime `user.learning.stats`, so progress never resets when switching path. Accept keys and display names via
  `resolvePathKey` (legacy "DeepLearner" included); Career is retired (`RETIRED_PATHS`). Concurrent counters go
  through `services/learning_activity.js` (atomic `$inc`, milestones recorded once). `user.learning` is never
  self-editable. The legacy `tracking` field is migrated at server start by `services/learning_migration.js`
  (idempotent, keyed on `learning.version`); `GET /user/:id/tracking` and `PUT /user/:id/update/tracking` stay as
  derived views for app versions <= 1.0.5.
- **Config**: new env var → `config/index.js` + `.env.example` (+ README if operators must set it).
- **Units**: cast `duration` is in minutes.
- **Style**: Prettier (single quotes, 100 cols) + ESLint. Short JSDoc on non-obvious functions; no noise comments.

## Adding an endpoint

1. Route in `routes/<resource>_route.js` (with auth middleware if it writes or is user-private).
2. Handler in `controllers/`, logic shared across resources in `services/`.
3. Document it in `openapi.yaml` (the test fails otherwise).
4. Integration test in `tests/integration/` using `supertest` + `tests/helpers/{db,fixtures}.js`.

## Testing

- `tests/helpers/global_setup.js` starts one `mongodb-memory-server`; `useTestDatabase()` gives each file its own DB.
- With `NODE_ENV=test` (set in `tests/helpers/setup_env.js`) external services are stubbed:
  OpenAI generators return fixed mocks, the mailer records into `sentMessages`, queues record into
  `queue.jobs` instead of using Redis. Tests must never hit the network.
- To exercise the real AI code paths, set `config.isTest = false` and `jest.mock('openai')` with a
  fake client (see `tests/integration/ai_pipeline.test.js`).
- Mock modules with `jest.mock()` for anything else external (see `services/video` in `cast.test.js`).
- Toggle auth enforcement in a test with `config.auth.required = true` (reset it in `afterAll`).

## Gotchas

- `User` `toJSON` strips `password` and tokens, but `.lean()` bypasses it — never return lean user docs.
- Bull queue name `castQueue` is persisted in Redis: don't rename.
- AI calls go through `callOpenAI()` (`services/openai.js`), which classifies errors
  (`config` / `transient` / `content`) — that kind drives retries, alerts and the attempt count.
  Pipeline steps must stay idempotent (skip when the output exists) and save as soon as they succeed.
- The app compares the chosen answer to `evaluation.correct` as a string: keep the
  `{ question, responses, correct }` shape with `correct` being one of `responses`.
- Media URLs stored in MongoDB embed `PUBLIC_BASE_URL`; changing it doesn't rewrite existing documents.
- `services/topic_indicator_computor.js` skips network calls when `config.isTest`; its unit test
  sets `NODE_ENV=development` and mocks `axios` to exercise them.
- Deployment: home server (`ssh homeboy`, LAN only), service `brightminds` in `/opt/homeboy/compose.yml`
  behind Caddy at `https://api.greenlights.us`; push to `main` then run `/opt/homeboy/deploy.sh`.
