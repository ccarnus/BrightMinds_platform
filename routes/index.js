// Mount prefix -> router. app.js mounts these; tests use this map to check openapi.yaml coverage.
module.exports = {
  '/cast': require('./cast_route'),
  '/user': require('./user_route'),
  '/university': require('./university_route'),
  '/virtual/lab': require('./virtual_lab_route'),
  '/topic': require('./topic_route'),
  '/learning': require('./learning_route'),
};
