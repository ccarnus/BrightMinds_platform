FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# The ffprobe/ffmpeg packages only make their binary executable for its owner (root here),
# but the app runs as `node`: open them to everyone, and check below that `node` can run them.
RUN npm ci --omit=dev && npm cache clean --force \
  && chmod a+rx node_modules/@ffprobe-installer/*/ffprobe node_modules/@ffmpeg-installer/*/ffmpeg

COPY --chown=node:node . .
RUN mkdir -p backend/media && chown node:node backend/media

USER node
RUN node -e "for (const p of ['@ffprobe-installer/ffprobe', '@ffmpeg-installer/ffmpeg']) require('child_process').execFileSync(require(p).path, ['-version'], { stdio: 'ignore' })"
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
