/* Node test for the Horizon and Years MCP tools (api/planning.js), driven
   through the real JSON-RPC handler in api/mcp.js against an in-memory
   stand-in for Supabase — the same path Agent Board takes.

   The shapes written here have to match what shared/horizon.js and
   shared/years.js render, so the assertions check field names and values,
   not just that a write succeeded.

   Run:  node tests/mcp-planning.test.js                                  */

const assert = require('assert');

const HORIZON_KEY = 'pc-ops::vpm::horizon::v1';
const YEARS_KEY = 'pc-ops::vpm::years::v1';
const YEARS_META_KEY = 'pc-ops::vpm::years::meta::v1';

/* ── Fake Supabase ──────────────────────────────────────────────────── */
const db = {};
global.fetch = async (url, opts) => {
  opts = opts || {};
  if (opts.method === 'POST') {
    JSON.parse(opts.body).forEach((row) => { db[row.key] = row.value.raw; });
    return { ok: true, status: 200, json: async () => [] };
  }
  const key = decodeURIComponent((/[?&]key=eq\.([^&]*)/.exec(url) || [, ''])[1]);
  const raw = db[key];
  return { ok: true, status: 200, json: async () => (raw == null ? [] : [{ value: { raw } }]) };
};

// api/auth.js takes its secrets from the environment; give it a throwaway
// one for the tests rather than relying on any real token.
process.env.PLANNER_MCP_TOKEN = 'test-token-for-the-suite';
const handler = require('../api/mcp.js');

/* ── Driving the handler ────────────────────────────────────────────── */
let nextId = 1;
function rpc(method, params) {
  const req = {
    method: 'POST',
    query: {},
    headers: { authorization: 'Bearer ' + process.env.PLANNER_MCP_TOKEN },
    body: { jsonrpc: '2.0', id: nextId++, method, params },
  };
  return new Promise((resolve) => {
    const res = {
      setHeader() {}, end() { resolve(null); },
      status() { return res; },
      json(payload) { resolve(payload); },
    };
    handler(req, res);
  });
}
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  assert.ok(r && r.result, 'no result for ' + name + ': ' + JSON.stringify(r));
  const text = r.result.content.map((c) => c.text).join('\n');
  if (r.result.isError) throw new Error(text);
  return text;
}
async function failing(name, args) {
  try { await tool(name, args); } catch (e) { return e.message; }
  throw new Error(name + ' was expected to fail');
}
const board = (key) => JSON.parse(db[key] || '{}');
const horizon = () => Object.values(board(HORIZON_KEY));
const years = () => Object.values(board(YEARS_KEY));
const byTitle = (list, t) => list.find((i) => i.title === t);

/* ── Tests ──────────────────────────────────────────────────────────── */
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the connector offers the week, Horizon and Years tools together', async () => {
  const r = await rpc('tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  ['add_calendar_item', 'get_horizon', 'add_horizon_item', 'edit_horizon_item', 'delete_horizon_item',
   'get_years', 'add_year_goal', 'add_year_milestone', 'edit_year_item', 'delete_year_item', 'set_year_theme']
    .forEach((n) => assert.ok(names.indexOf(n) >= 0, 'missing tool ' + n));
  // Every tool has to describe itself, or the agent picks blind.
  r.result.tools.forEach((t) => assert.ok(t.description && t.inputSchema, t.name + ' is underspecified'));
});

test('a Years milestone is added in the shape the planner renders', async () => {
  const out = await tool('add_year_milestone', {
    title: '2XU Half Marathon', date: '2026-11-22', category: 'personal',
  });
  assert.ok(/2026 key dates/.test(out), out);
  const m = byTitle(years(), '2XU Half Marathon');
  assert.ok(m, 'not stored');
  assert.strictEqual(m.kind, 'milestone');
  assert.strictEqual(m.date, '2026-11-22');
  assert.strictEqual(m.year, 2026, 'year comes from the date');
  assert.strictEqual(m.month, 10, 'November is month index 10');
  assert.strictEqual(m.category, 'personal');
  assert.strictEqual(m.source, 'agent', 'agent-written items are marked');
});

test('the milestone reads back on the Years board under its year', async () => {
  const out = await tool('get_years', { from_year: 2026 });
  assert.ok(/^# Years 2026 – 2028/.test(out), out);
  assert.ok(/## 2026/.test(out), out);
  assert.ok(/Key dates \/ milestones/.test(out), out);
  assert.ok(/Sun 22 Nov 2026 — 2XU Half Marathon  \[personal\]/.test(out), out);
});

test('a milestone can be dated to a month when the day is unknown', async () => {
  await tool('add_year_milestone', { title: 'Overseas trip', year: 2027, month: 4, category: 'personal', notes: 'Dates TBC' });
  const m = byTitle(years(), 'Overseas trip');
  assert.strictEqual(m.year, 2027);
  assert.strictEqual(m.month, 3, 'April is month index 3');
  assert.strictEqual(m.date, '', 'no exact date yet');
});

test('a milestone with neither a date nor a year is refused, not guessed', async () => {
  const msg = await failing('add_year_milestone', { title: 'Something vague' });
  assert.ok(/date|year/i.test(msg), msg);
});

test('a bad date is refused', async () => {
  const msg = await failing('add_year_milestone', { title: 'Bad date', date: '22-11-2026' });
  assert.ok(/must be a date/.test(msg), msg);
});

test('a yearly goal carries its measure, and reads back with progress', async () => {
  await tool('add_year_goal', {
    title: '$50k/month revenue', year: 2027, category: 'business',
    metric: 'currency', current_value: 14000, target_value: 50000, status: 'active',
  });
  const g = byTitle(years(), '$50k/month revenue');
  assert.strictEqual(g.kind, 'goal');
  assert.strictEqual(g.metricType, 'currency');
  assert.strictEqual(g.currentValue, '14000');
  assert.strictEqual(g.targetValue, '50000');
  const out = await tool('get_years', { from_year: 2027, years: 1 });
  assert.ok(/\$14k → \$50k/.test(out), out);
});

test('a goal defaults to business and planned', async () => {
  await tool('add_year_goal', { title: 'Improve systems and workflows', year: 2026 });
  const g = byTitle(years(), 'Improve systems and workflows');
  assert.strictEqual(g.category, 'business');
  assert.strictEqual(g.status, 'planned');
});

test('an unknown category falls back rather than erroring', async () => {
  await tool('add_year_goal', { title: 'Odd category goal', year: 2026, category: 'clients' });
  assert.strictEqual(byTitle(years(), 'Odd category goal').category, 'business');
});

test('a year theme can be set and cleared', async () => {
  await tool('set_year_theme', { year: 2027, theme: 'Increase revenue and build an AI-led team' });
  assert.strictEqual(board(YEARS_META_KEY)['2027'].theme, 'Increase revenue and build an AI-led team');
  assert.ok(/Theme: Increase revenue/.test(await tool('get_years', { from_year: 2027, years: 1 })));
  await tool('set_year_theme', { year: 2027, theme: '' });
  assert.ok(!board(YEARS_META_KEY)['2027'].theme, 'cleared');
});

test('a Horizon item is added in the shape the planner renders', async () => {
  await tool('add_horizon_item', {
    title: 'Black Friday', date: '2026-11-27', type: 'event', prep_weeks: 6,
    checklist: ['Confirm offers', 'Creative ready'], client: 'Retail',
  });
  const it = byTitle(horizon(), 'Black Friday');
  assert.strictEqual(it.month, '2026-11', 'month comes from the date');
  assert.strictEqual(it.prepWeeks, 6);
  assert.strictEqual(it.prepStart, '2026-10-16', 'six weeks back, got ' + it.prepStart);
  assert.deepStrictEqual(it.checklist, [
    { text: 'Confirm offers', done: false }, { text: 'Creative ready', done: false },
  ]);
  assert.strictEqual(it.source, 'agent');
});

test('the Horizon board reads back with its preparation date', async () => {
  const out = await tool('get_horizon', { from: '2026-10', months: 3 });
  assert.ok(/^# Horizon: Oct 2026 – Dec 2026/.test(out), out);
  assert.ok(/## Nov 2026/.test(out), out);
  assert.ok(/- Black Friday  \[key date\]  Fri 27 Nov 2026  \(Retail\)/.test(out), out);
  assert.ok(/start preparing Fri 16 Oct 2026/.test(out), out);
  assert.ok(/\[ \] Confirm offers/.test(out), out);
  assert.ok(/## Oct 2026\n\(nothing\)/.test(out), 'an empty month says so');
});

test('the three layers link: Horizon can name the goal it serves', async () => {
  await tool('add_horizon_item', {
    title: 'Build outbound process', month: '2027-01', type: 'prep',
    supports_goal: '$50k/month revenue', projects: ['Outbound'],
  });
  const it = byTitle(horizon(), 'Build outbound process');
  const goal = byTitle(years(), '$50k/month revenue');
  assert.strictEqual(it.linkedGoal, goal.id, 'linked by id, not by title');
  assert.deepStrictEqual(it.linkedProjects, ['Outbound']);
});

test('and a goal can name the Horizon work supporting it', async () => {
  await tool('edit_year_item', { title: '$50k/month revenue', supported_by: ['Build outbound process'] });
  const goal = byTitle(years(), '$50k/month revenue');
  const hz = byTitle(horizon(), 'Build outbound process');
  assert.deepStrictEqual(goal.linkedHorizon, [hz.id]);
});

test('a milestone can point at both its goal and its Horizon item', async () => {
  await tool('add_year_milestone', {
    title: '$50k/month target', date: '2027-03-31', category: 'business',
    supports_goal: '$50k/month revenue', horizon_item: 'Build outbound process',
  });
  const m = byTitle(years(), '$50k/month target');
  assert.strictEqual(m.goalId, byTitle(years(), '$50k/month revenue').id);
  assert.strictEqual(m.horizonId, byTitle(horizon(), 'Build outbound process').id);
});

test('linking to a goal that does not exist is refused', async () => {
  const msg = await failing('add_horizon_item', { title: 'Orphan', month: '2027-02', supports_goal: 'no such goal' });
  assert.ok(/No yearly goal matches/.test(msg), msg);
});

test('editing changes only what is passed', async () => {
  await tool('edit_horizon_item', { title: 'Black Friday', client: 'FUDGE' });
  const it = byTitle(horizon(), 'Black Friday');
  assert.strictEqual(it.client, 'FUDGE', 'changed');
  assert.strictEqual(it.checklist.length, 2, 'checklist untouched');
  assert.strictEqual(it.prepWeeks, 6, 'lead time untouched');
});

test('moving a Horizon date recomputes when preparation starts', async () => {
  await tool('edit_horizon_item', { title: 'Black Friday', date: '2026-11-20' });
  const it = byTitle(horizon(), 'Black Friday');
  assert.strictEqual(it.date, '2026-11-20');
  assert.strictEqual(it.prepStart, '2026-10-09', 'got ' + it.prepStart);
});

test('reporting progress on a goal is one edit', async () => {
  await tool('edit_year_item', { title: '$50k/month revenue', current_value: 21000 });
  assert.strictEqual(byTitle(years(), '$50k/month revenue').currentValue, '21000');
  assert.ok(/\$21k → \$50k/.test(await tool('get_years', { from_year: 2027, years: 1 })));
});

test('an ambiguous title refuses rather than editing the wrong thing', async () => {
  await tool('add_year_milestone', { title: 'Christmas', date: '2026-12-25' });
  await tool('add_year_milestone', { title: 'Christmas', date: '2027-12-25' });
  const msg = await failing('edit_year_item', { title: 'Christmas', notes: 'which one?' });
  assert.ok(/2 Years items match/.test(msg), msg);
  // …and the year narrows it down.
  await tool('edit_year_item', { title: 'Christmas', year: 2027, notes: 'Campaigns and client management' });
  const m = years().filter((i) => i.title === 'Christmas' && i.year === 2027)[0];
  assert.strictEqual(m.notes, 'Campaigns and client management');
});

test('deleting a goal leaves the milestones that served it', async () => {
  await tool('add_year_goal', { title: 'Temporary goal', year: 2028 });
  await tool('add_year_milestone', { title: 'Serves the temp goal', date: '2028-05-01', supports_goal: 'Temporary goal' });
  await tool('delete_year_item', { title: 'Temporary goal' });
  assert.ok(!byTitle(years(), 'Temporary goal'), 'goal gone');
  const m = byTitle(years(), 'Serves the temp goal');
  assert.ok(m, 'milestone kept');
  assert.strictEqual(m.goalId, '', 'and no longer points at a goal that is gone');
});

test('deleting a Horizon item removes only that item', async () => {
  const before = horizon().length;
  await tool('delete_horizon_item', { title: 'Build outbound process' });
  assert.strictEqual(horizon().length, before - 1);
  assert.ok(byTitle(horizon(), 'Black Friday'), 'its neighbour survives');
});

test('the week planner tools still work alongside them', async () => {
  db['pc-ops::vpm::calendar::v1::sections::v1'] = JSON.stringify({ '2026-11-16': [{ id: 's1', name: 'Work' }] });
  const out = await tool('add_calendar_item', { day: '2026-11-17', text: 'Check BF creative', section: 'Work' });
  assert.ok(/Added to Tue 17 Nov/.test(out), out);
  assert.ok(/Check BF creative/.test(await tool('get_calendar_week', { week: '2026-11-16' })));
});

test('the three boards stay in their own keys', async () => {
  assert.ok(db[HORIZON_KEY] && db[YEARS_KEY], 'both boards written');
  assert.ok(!/pc-todo/.test(db[YEARS_KEY]), 'Years never holds week-planner HTML');
  assert.ok(Object.keys(board(HORIZON_KEY)).every((k) => /^hz_/.test(k)), 'Horizon ids');
  assert.ok(Object.keys(board(YEARS_KEY)).every((k) => /^yr_/.test(k)), 'Years ids');
});

/* ── Runner ─────────────────────────────────────────────────────────── */
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); pass++; }
    catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
