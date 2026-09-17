/* Node test for endpoint auth (api/auth.js) — header vs query string, and
   rotation with several tokens valid at once.

   Run:  node tests/auth.test.js                                          */

const assert = require('assert');

function fresh(env) {
  delete require.cache[require.resolve('../api/auth.js')];
  const saved = {};
  ['PLANNER_MCP_TOKEN', 'PLANNER_MCP_TOKEN_PREVIOUS', 'PLANNER_MCP_ALLOW_LEGACY', 'PLANNER_MCP_ALLOW_QUERY_TOKEN']
    .forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.keys(env || {}).forEach((k) => { process.env[k] = env[k]; });
  const mod = require('../api/auth.js');
  return { mod, restore: () => Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }) };
}
const bearer = (t) => ({ headers: { authorization: 'Bearer ' + t }, query: {} });
const queryK = (t) => ({ headers: {}, query: { k: t } });

const NEW = 'vpm-cal-newsecret-0001';
const OLD = 'vpm-cal-7f3a9c2e5b18d4';   // the pre-rotation constant

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('a Bearer header with the current token is accepted', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW });
  const r = mod.authenticate(bearer(NEW));
  assert.equal(r.ok, true); assert.equal(r.via, 'header');
  restore();
});

test('rotation step b: the new AND old tokens both work', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW });
  assert.equal(mod.authenticate(bearer(NEW)).ok, true, 'new token works');
  assert.equal(mod.authenticate(bearer(OLD)).ok, true, 'legacy token still works — nothing breaks');
  restore();
});

test('rotation step d: retiring the legacy token kills it, new one survives', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW, PLANNER_MCP_ALLOW_LEGACY: 'false' });
  assert.equal(mod.authenticate(bearer(NEW)).ok, true);
  assert.equal(mod.authenticate(bearer(OLD)).ok, false, 'the leaked token is dead');
  restore();
});

test('an outgoing token can be kept alive explicitly during a rotation', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW, PLANNER_MCP_TOKEN_PREVIOUS: 'vpm-cal-interim', PLANNER_MCP_ALLOW_LEGACY: 'false' });
  assert.equal(mod.authenticate(bearer('vpm-cal-interim')).ok, true);
  restore();
});

test('a query-string token still works by default, and is flagged as such', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW });
  const r = mod.authenticate(queryK(NEW));
  assert.equal(r.ok, true); assert.equal(r.via, 'query', 'so the caller can be warned off it');
  restore();
});

test('query-string tokens can be refused outright', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW, PLANNER_MCP_ALLOW_QUERY_TOKEN: 'false' });
  const r = mod.authenticate(queryK(NEW));
  assert.equal(r.ok, false);
  assert.ok(/Authorization: Bearer/.test(r.reason));
  assert.equal(mod.authenticate(bearer(NEW)).ok, true, 'the header path is unaffected');
  restore();
});

test('wrong and missing tokens are refused, and nothing echoes the secret', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW });
  const wrong = mod.authenticate(bearer('nope'));
  const missing = mod.authenticate({ headers: {}, query: {} });
  assert.equal(wrong.ok, false);
  assert.equal(missing.ok, false);
  [wrong.reason, missing.reason].forEach((m) => assert.ok(m.indexOf(NEW) === -1 && m.indexOf(OLD) === -1, 'no token in the message'));
  restore();
});

test('token comparison is length-safe (no crash on odd input)', () => {
  const { mod, restore } = fresh({ PLANNER_MCP_TOKEN: NEW });
  assert.equal(mod.sameToken('', ''), false);
  assert.equal(mod.sameToken('short', NEW), false);
  assert.equal(mod.sameToken(NEW, NEW), true);
  restore();
});

test('the live handler enforces it end to end', async () => {
  const { restore } = fresh({ PLANNER_MCP_TOKEN: NEW });
  delete require.cache[require.resolve('../api/mcp.js')];
  const handler = require('../api/mcp.js');
  const run = (req) => new Promise((resolve) => {
    const headers = {};
    const res = { setHeader(k, v) { headers[k] = v; }, end() { resolve({ code: res.code, headers }); },
      status(c) { res.code = c; return res; }, json(p) { resolve({ code: res.code, body: p, headers }); } };
    handler(Object.assign({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, req), res);
  });
  const good = await run(bearer(NEW));
  assert.ok(good.body.result, 'Bearer gets in');
  const legacy = await run(queryK(OLD));
  assert.ok(legacy.body.result, 'the legacy URL still works during the rotation');
  assert.ok(/Authorization: Bearer/.test(legacy.headers.Warning || ''), 'and is warned about');
  const bad = await run(bearer('nope'));
  assert.equal(bad.code, 401);
  restore();
  delete require.cache[require.resolve('../api/mcp.js')];
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ✓ ' + n); pass++; }
    catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; }
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
