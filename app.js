// Builds the Express app. No side effects (DB connection, workers, cron) — see server.js.
const express = require('express');
const helmet = require('helmet');
const mongoose = require('mongoose');
const config = require('./config');
const routes = require('./routes');
const { MEDIA_URL_PREFIX } = require('./services/media');
const { notFoundHandler, errorHandler } = require('./middleware/error_handler');

const app = express();

app.set('trust proxy', config.trustProxy);

// CSP is off because the HTML pages (email confirmation, password reset) use inline styles/scripts.
// Media must be loadable cross-origin by the mobile and web clients.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content, Accept, Content-Type, Authorization'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Express 5 leaves req.body undefined when no body was sent; controllers expect an object.
app.use((req, res, next) => {
  req.body ??= {};
  next();
});

app.get('/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down' });
});

app.use(MEDIA_URL_PREFIX, express.static(config.mediaRoot, { index: false }));

for (const [prefix, router] of Object.entries(routes)) {
  app.use(prefix, router);
}

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
