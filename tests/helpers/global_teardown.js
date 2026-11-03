const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async () => {
  await globalThis.__MONGO_SERVER__?.stop();
  fs.rmSync(path.join(os.tmpdir(), 'brightminds-test-media'), { recursive: true, force: true });
};
