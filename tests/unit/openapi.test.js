// Keeps openapi.yaml in sync with the Express routes: every route documented, nothing stale.
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const routes = require('../../routes');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'];
const spec = yaml.parse(fs.readFileSync(path.join(__dirname, '../../openapi.yaml'), 'utf8'));

const documented = new Set(
  Object.entries(spec.paths).flatMap(([route, operations]) =>
    Object.keys(operations)
      .filter((method) => HTTP_METHODS.includes(method))
      .map((method) => `${method.toUpperCase()} ${route}`)
  )
);

const implemented = new Set(['GET /health']);
for (const [prefix, router] of Object.entries(routes)) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const route = (prefix + (layer.route.path === '/' ? '' : layer.route.path)).replace(
      /:(\w+)/g,
      '{$1}'
    );
    Object.keys(layer.route.methods).forEach((method) =>
      implemented.add(`${method.toUpperCase()} ${route}`)
    );
  }
}

test('every implemented route is documented in openapi.yaml', () => {
  expect([...implemented].filter((op) => !documented.has(op))).toEqual([]);
});

test('openapi.yaml documents no route that does not exist', () => {
  expect([...documented].filter((op) => !implemented.has(op))).toEqual([]);
});
