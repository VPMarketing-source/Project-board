/* Node test for the controlled calendar tool layer (api/calendar-tools.js),
   driven through the real MCP handler against an in-memory stand-in for
   Supabase — the same path Claude's connector uses.

   Run:  node tests/calendar-tools.test.js                                */

const assert = require('assert');

const STORE = 'pc-ops::vpm::calendar::v1';
const SECTIONS_KEY = STORE + '::sections::v1';
const SECFREE_KEY = STORE + '::sectionfree::v1';
const AGENTLOG_KEY = STORE + '::agentlog::v1';

/* ── Fake Supabase ──────────────────────────────────────────────────── */
const db = {};
let writes = 0;
global.fetch = async (url, opts) => {
  opts = opts || {};
  if (opts.method === 'POST') {
    writes++;
    JSON.parse(opts.body).forEach((row) => { db[row.key] = row.value.raw; });
    return { ok: true, status: 200, json: async () => [] };
  }
  if (/agent-board|supabase\.co\/rest\/v1\/goals/.test(url)) return { ok: false, status: 401, json: async () => [] };
  const key = decodeURIComponent((/[?&]key=eq\.([^&]*)/.exec(url) || [, ''])[1]);
  const raw = db[key];
  return { ok: true, status: 200, json: async () => (raw == null ? [] : [{ value: { raw } }]) };
};

const handler = require('../api/mcp.js');
const CT = require('../api/calendar-tools.js');
const I = CT._internal;

let nextId = 1;
function call(name, args) {
  const req = {
    method: 'POST', query: { k: 'vpm-cal-7f3a9c2e5b18d4' }, headers: {},
    body: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
  };
  return new Promise((resolve) => {
    const res = { setHeader() {}, end() { resolve(null); }, status() { return res; }, json(p) { resolve(p); } };
    handler(req, res);
  });
}
async function tool(name, args) {
  const r = await call(name, args);
  const result = r.result;
  assert.ok(result, 'no result for ' + name + ': ' + JSON.stringify(r));
  const text = result.content.map((c) => c.text).join('\n');
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}
async function failing(name, args) {
  const r = await call(name, args);
  assert.ok(r.result && r.result.isError, name + ' should have failed but did not');
  return r.result.content.map((c) => c.text).join('\n');
}
const cell = (day, sec) => JSON.parse(db[SECFREE_KEY] || '{}')[day + '::' + sec] || '';
const log = () => JSON.parse(db[AGENTLOG_KEY] || '[]');

/* ── Fixture ────────────────────────────────────────────────────────────
   Deliberately hand-typed-looking HTML, matching what is really in the live
   planner: nested divs, inline styles, checkboxes with and without inputs,
   a plain-text uppercase heading, a timed line and a daily routine block. */
const MON = '2026-09-07', TUE = '2026-09-08', WED = '2026-09-09', THU = '2026-09-10', FRI = '2026-09-11';
const S1 = 's1', S2 = 's2';
const routine =
  '<div><span>Morning Routine</span></div>' +
  '<div class="pc-todo"><input type="checkbox" class="pc-todo-box" contenteditable="false"><span class="pc-todo-text">Stretch</span></div>' +
  '<div class="pc-todo"><input type="checkbox" class="pc-todo-box" contenteditable="false"><span class="pc-todo-text">Medication</span></div>';

function resetDb() {
  Object.keys(db).forEach((k) => delete db[k]);
  db[SECTIONS_KEY] = JSON.stringify({
    [MON]: [{ id: S1, name: 'Work', height: 120 }, { id: S2, name: 'Home', height: 120 }],
  });
  db[SECFREE_KEY] = JSON.stringify({
    [MON + '::' + S1]:
      '<div><span style="font-weight: bold; color: rgb(239, 68, 68);">9:00am - Call Marlene</span></div>' +
      routine +
      '<div>VP MARKETING</div>' +
      '<div class="pc-todo"><input type="checkbox" class="pc-todo-box" contenteditable="false"><span class="pc-todo-text">Write proposal for Life Plus</span></div>' +
      '<div class="pc-todo is-checked"><input type="checkbox" class="pc-todo-box" contenteditable="false" checked=""><span class="pc-todo-text">Send invoice</span></div>' +
      '<div><span style="text-decoration-line: line-through;">3pm - Call Maurice</span></div>' +
      '<div>Upload screenshots to the drive</div>',
    [TUE + '::' + S1]: routine + '<div>VP MARKETING</div>',
    [WED + '::' + S1]: routine,
  });
}
resetDb();

/* ── Tests ──────────────────────────────────────────────────────────── */
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('classify: every kind is recognised in real hand-typed HTML', async () => {
  const day = await tool('get_day', { date: MON });
  const by = (t) => day.items.find((i) => i.text.indexOf(t) !== -1);
  assert.equal(by('Call Marlene').kind, 'timed');
  assert.equal(by('Call Marlene').style.color, 'red', 'timed items read as red');
  assert.equal(by('Call Marlene').style.bold, true);
  assert.equal(by('VP MARKETING').kind, 'heading');
  assert.equal(by('Write proposal').kind, 'task');
  assert.equal(by('Write proposal').completed, false);
  assert.equal(by('Send invoice').completed, true, 'is-checked → completed');
  assert.equal(by('Call Maurice').completed, true, 'legacy inline line-through → completed');
  assert.equal(by('Upload screenshots').kind, 'note');
  assert.equal(by('Write proposal').heading, 'VP MARKETING', 'task carries its heading');
});

test('classify: a bare number is not a time, a real time is', async () => {
  assert.equal(I.leadingTime('3 emails to send'), null);
  assert.equal(I.leadingTime('3pm - Call Maurice'), 15 * 60);
  assert.equal(I.leadingTime('9:00am - 10:30am Workshop'), 10 * 60 + 30, 'range ends when it ends');
  assert.equal(I.leadingTime('14:30 Review'), 14 * 60 + 30);
});

test('routines: repeated daily tasks are flagged, one-offs are not', async () => {
  const day = await tool('get_day', { date: MON });
  assert.equal(day.items.find((i) => i.text === 'Stretch').routine, true);
  assert.equal(day.items.find((i) => i.text.indexOf('Write proposal') === 0).routine, false);
});

test('counts: routines and completed work are counted separately', async () => {
  const day = await tool('get_day', { date: MON });
  assert.equal(day.counts.open_tasks, 1, 'only the proposal is outstanding substantive work');
  assert.equal(day.counts.completed_tasks, 1);
  assert.equal(day.counts.routines, 2);
  assert.equal(day.counts.timed, 2);
});

test('item ids: stamping is invisible and survives lines added above', async () => {
  const before = cell(MON, S1);
  const dry = await tool('normalise_week', { start_date: MON });
  assert.ok(dry.stamped > 0 && dry.dry_run === true);
  assert.equal(cell(MON, S1), before, 'a dry run writes nothing');

  await tool('normalise_week', { start_date: MON, dry_run: false, reason: 'test' });
  const day = await tool('get_day', { date: MON });
  const proposal = day.items.find((i) => i.text.indexOf('Write proposal') === 0);
  assert.ok(proposal.stamped && proposal.task_id.indexOf('i:') === 0, 'permanent id');
  const I2 = require('../api/calendar-tools.js')._internal;
  assert.equal(I2.classifyCell(cell(MON, S1), MON, { id: S1, name: 'Work' }).length, day.items.length);

  // Insert a line ABOVE it — the id must still address the same task.
  const all = JSON.parse(db[SECFREE_KEY]);
  all[MON + '::' + S1] = '<div class="pc-todo"><span class="pc-todo-text">Brand new line on top</span></div>' + all[MON + '::' + S1];
  db[SECFREE_KEY] = JSON.stringify(all);
  const after = await tool('get_day', { date: MON });
  const same = after.items.find((i) => i.task_id === proposal.task_id);
  assert.ok(same && same.text.indexOf('Write proposal') === 0, 'identity survived a line inserted above it');
});

test('create_task: files under a heading, refuses timed text, dedupes', async () => {
  resetDb();
  const made = await tool('create_task', { date: TUE, text: 'Draft retainer proposal', heading: 'VP MARKETING', reason: 'agreed on the call' });
  assert.equal(made.created, true);
  const day = await tool('get_day', { date: TUE });
  const it = day.items.find((i) => i.text === 'Draft retainer proposal');
  assert.equal(it.heading, 'VP MARKETING', 'landed under the heading, not at the bottom');

  const dup = await tool('create_task', { date: TUE, text: 'draft retainer proposal', reason: 'again' });
  assert.equal(dup.created, false);
  assert.equal(dup.skipped, 'duplicate');

  const err = await failing('create_task', { date: TUE, text: '3pm - Call Bec', reason: 'x' });
  assert.ok(/create_timed_event/.test(err), 'timed text is redirected');
});

test('create_task: a new heading is created with the right colour', async () => {
  await tool('create_task', { date: TUE, text: 'Book florist', heading: 'WEDDING', reason: 'planning' });
  await tool('create_task', { date: TUE, text: 'Ads for Eko Heat', heading: 'EKO HEAT', reason: 'client work' });
  const html = cell(TUE, S1);
  assert.ok(/class="pc-head pc-b pc-fg-black">WEDDING</.test(html), 'WEDDING is black + bold');
  assert.ok(/class="pc-head pc-b pc-fg-green">EKO HEAT</.test(html), 'a client heading is green + bold');
});

test('create_timed_event: red, bold, no checkbox', async () => {
  const ev = await tool('create_timed_event', { date: TUE, time: '2:30pm', text: 'Call Tristan', reason: 'he asked for Tuesday' });
  assert.equal(ev.text, '2:30pm - Call Tristan');
  const html = cell(TUE, S1);
  assert.ok(/class="pc-b pc-fg-red">2:30pm - Call Tristan</.test(html));
  assert.ok(!/pc-todo-box[^>]*>(?=[^<]*2:30pm)/.test(html), 'no checkbox');
  const day = await tool('get_day', { date: TUE });
  assert.equal(day.items.find((i) => i.text.indexOf('Call Tristan') !== -1).kind, 'timed');
});

test('complete_task / uncomplete_task: ticked in place, never moved', async () => {
  const day = await tool('get_day', { date: TUE });
  const t = day.items.find((i) => i.text === 'Draft retainer proposal');
  const done = await tool('complete_task', { task_id: t.task_id, reason: 'finished it' });
  assert.equal(done.completed, true);
  assert.equal(done.date, TUE, 'stayed on its day');
  const after = await tool('get_day', { date: TUE });
  const t2 = after.items.find((i) => i.text === 'Draft retainer proposal');
  assert.equal(t2.completed, true);
  assert.ok(/is-checked/.test(cell(TUE, S1)) && /checked/.test(cell(TUE, S1)));
  const undone = await tool('uncomplete_task', { task_id: t2.task_id, reason: 'not actually done' });
  assert.equal(undone.completed, false);
  const t3 = (await tool('get_day', { date: TUE })).items.find((i) => i.text === 'Draft retainer proposal');
  assert.equal(t3.completed, false);
});

test('complete_task: a plain note is refused unless converted', async () => {
  resetDb();
  const day = await tool('get_day', { date: MON });
  const note = day.items.find((i) => i.text.indexOf('Upload screenshots') === 0);
  const err = await failing('complete_task', { task_id: note.task_id, reason: 'done' });
  assert.ok(/convert_to_task/.test(err));
  const ok = await tool('complete_task', { task_id: note.task_id, reason: 'done', convert_to_task: true });
  assert.equal(ok.completed, true);
});

test('move_task: keeps the heading, refuses completed work, dedupes', async () => {
  resetDb();
  const day = await tool('get_day', { date: MON });
  const prop = day.items.find((i) => i.text.indexOf('Write proposal') === 0);
  const moved = await tool('move_task', { task_id: prop.task_id, new_date: TUE, reason: 'Monday is full' });
  assert.equal(moved.moved, true);
  assert.equal(moved.to.date, TUE);
  const tue = await tool('get_day', { date: TUE });
  const landed = tue.items.find((i) => i.text.indexOf('Write proposal') === 0);
  assert.equal(landed.heading, 'VP MARKETING', 'heading preserved on the target day');
  assert.ok(!(await tool('get_day', { date: MON })).items.some((i) => i.text.indexOf('Write proposal') === 0), 'gone from Monday');

  const done = (await tool('get_day', { date: MON })).items.find((i) => i.text === 'Send invoice');
  const err = await failing('move_task', { task_id: done.task_id, new_date: TUE, reason: 'tidy' });
  assert.ok(/completed work stays/.test(err));
});

test('stale-write protection: a changed cell is refused', async () => {
  resetDb();
  const day = await tool('get_day', { date: MON });
  const rev = day.sections.find((s) => s.id === S1).cell_rev;
  const t = day.items.find((i) => i.text.indexOf('Write proposal') === 0);
  // Someone edits the day in the browser meanwhile.
  const all = JSON.parse(db[SECFREE_KEY]);
  all[MON + '::' + S1] += '<div>Something Matthew typed</div>';
  db[SECFREE_KEY] = JSON.stringify(all);
  const err = await failing('move_task', { task_id: t.task_id, new_date: TUE, reason: 'x', expect_cell_rev: rev });
  assert.ok(/changed since you read it/.test(err));
});

test('every mutation requires a reason', async () => {
  const day = await tool('get_day', { date: MON });
  const t = day.items.find((i) => i.text.indexOf('Write proposal') === 0);
  for (const [name, args] of [
    ['create_task', { date: TUE, text: 'x' }],
    ['move_task', { task_id: t.task_id, new_date: TUE }],
    ['complete_task', { task_id: t.task_id }],
    ['delete_task', { task_id: t.task_id }],
    ['rollover_incomplete_tasks', { date: MON }],
  ]) {
    const err = await failing(name, args);
    assert.ok(/'reason' is required/.test(err), name + ' must require a reason');
  }
});

test('rollover: only outstanding actionable work moves, with its heading', async () => {
  resetDb();
  const dry = await tool('rollover_incomplete_tasks', { date: MON, dry_run: true, reason: 'planning ahead' });
  assert.equal(dry.rolled, 1, 'only the open proposal rolls');
  assert.equal(dry.would_roll[0].text.indexOf('Write proposal'), 0);
  assert.equal(dry.to, TUE, 'defaults to the next day');
  const held = (t) => dry.held_back.find((h) => h.text.indexOf(t) !== -1).held_because;
  assert.ok(/completed/.test(held('Send invoice')));
  assert.ok(/timed/.test(held('Call Marlene')));
  assert.ok(/routine/.test(held('Stretch')));
  assert.equal(cell(TUE, S1).indexOf('Write proposal'), -1, 'dry run wrote nothing');

  const real = await tool('rollover_incomplete_tasks', { date: MON, reason: 'not finished Monday' });
  assert.equal(real.rolled, 1);
  const tue = await tool('get_day', { date: TUE });
  assert.equal(tue.items.find((i) => i.text.indexOf('Write proposal') === 0).heading, 'VP MARKETING');
});

test('rollover: never creates a duplicate', async () => {
  resetDb();
  const all = JSON.parse(db[SECFREE_KEY]);
  all[TUE + '::' + S1] += '<div class="pc-todo"><span class="pc-todo-text">Write proposal for Life Plus</span></div>';
  db[SECFREE_KEY] = JSON.stringify(all);
  const dry = await tool('rollover_incomplete_tasks', { date: MON, dry_run: true, reason: 'check' });
  assert.equal(dry.rolled, 0);
  assert.ok(/already on/.test(dry.held_back.find((h) => h.text.indexOf('Write proposal') === 0).held_because));
});

test('rollover_overdue_tasks: sweeps a range, dry by default', async () => {
  resetDb();
  const all = JSON.parse(db[SECFREE_KEY]);
  all[TUE + '::' + S1] += '<div class="pc-todo"><span class="pc-todo-text">Chase Qubik feedback</span></div>';
  db[SECFREE_KEY] = JSON.stringify(all);
  const dry = await tool('rollover_overdue_tasks', { through_date: WED, to_date: THU, lookback_days: 7, reason: 'catching up' });
  assert.equal(dry.dry_run, true, 'defaults to a dry run');
  assert.equal(dry.total, 2, 'Monday and Tuesday each had one outstanding task');
  assert.equal(dry.days_with_overdue_work, 3);
  assert.equal(cell(THU, S1), '', 'nothing written');

  const real = await tool('rollover_overdue_tasks', { through_date: WED, to_date: THU, lookback_days: 7, dry_run: false, reason: 'catching up' });
  assert.equal(real.total, 2);
  const thu = await tool('get_day', { date: THU });
  assert.ok(thu.items.some((i) => i.text.indexOf('Write proposal') === 0));
  assert.ok(thu.items.some((i) => i.text === 'Chase Qubik feedback'));
  assert.ok(!(await tool('get_day', { date: MON })).items.some((i) => i.text.indexOf('Write proposal') === 0));
  assert.equal((await tool('get_day', { date: MON })).items.filter((i) => i.text === 'Stretch').length, 1, 'routines stayed');
});

test('delete_task: removes one line, protects headings', async () => {
  resetDb();
  const day = await tool('get_day', { date: MON });
  const note = day.items.find((i) => i.text.indexOf('Upload screenshots') === 0);
  const head = day.items.find((i) => i.text === 'VP MARKETING');
  const err = await failing('delete_task', { task_id: head.task_id, reason: 'tidy' });
  assert.ok(/heading/.test(err));
  const del = await tool('delete_task', { task_id: note.task_id, reason: 'Sarah is doing it' });
  assert.equal(del.deleted, true);
  assert.ok(cell(MON, S1).indexOf('Upload screenshots') === -1);
  assert.ok((await tool('get_day', { date: MON })).items.some((i) => i.text.indexOf('Write proposal') === 0), 'neighbours untouched');
});

test('change log: what changed, when and why', async () => {
  const entries = await tool('get_calendar_change_log', { limit: 10 });
  const del = entries.changes.find((c) => c.tool === 'delete_task');
  assert.ok(del.at && /Sarah is doing it/.test(del.reason));
  assert.ok(/Upload screenshots/.test(del.before), 'before is kept');
  assert.equal(del.after, null);
  assert.equal(del.actor, 'claude');
});

test('optimise_week: refuses to guess when goals cannot be read', async () => {
  const err = await failing('optimise_week', { start_date: MON });
  assert.ok(/goals/i.test(err) && !/generic/.test(err));
});

test('optimise_week: advisory only — writes nothing', async () => {
  resetDb();
  const all = JSON.parse(db[SECFREE_KEY]);
  all[MON + '::' + S1] +=
    '<div class="pc-todo"><span class="pc-todo-text">Outreach to 10 new ecommerce leads</span></div>' +
    '<div class="pc-todo"><span class="pc-todo-text">Upload screenshots to the drive</span></div>' +
    '<div class="pc-todo"><span class="pc-todo-text">Weekly report export for Qubik</span></div>' +
    '<div class="pc-todo"><span class="pc-todo-text">Scroll competitor accounts</span></div>' +
    '<div class="pc-todo"><span class="pc-todo-text">Decide 2027 pricing</span></div>' +
    '<div class="pc-todo"><span class="pc-todo-text">Client review call prep for Life Plus</span></div>';
  db[SECFREE_KEY] = JSON.stringify(all);
  const before = db[SECFREE_KEY];
  writes = 0;

  const out = await tool('optimise_week', {
    start_date: MON, max_tasks_per_day: 4,
    goals: ['Reach $50,000/month revenue within 6 months', 'Build VP Marketing into a Fractional CMO + AI model'],
  });
  assert.equal(writes, 0, 'optimise_week must never write');
  assert.equal(db[SECFREE_KEY], before);
  assert.equal(out.advisory, true);
  assert.ok(out.high_value.some((h) => /Outreach/.test(h.text)), 'revenue work ranks high');
  assert.ok(out.delegate_candidates.some((d) => /Upload screenshots/.test(d.text)));
  assert.ok(out.automate_candidates.some((d) => /Weekly report export/.test(d.text)));
  assert.ok(out.remove_candidates.some((d) => /Scroll/.test(d.text)));
  assert.ok(out.high_value.some((h) => /Decide 2027 pricing/.test(h.text)) ||
            out.high_value.some((h) => /Client review call/.test(h.text)));
  assert.ok(out.proposed_moves.length >= 1, 'proposes moves for approval');
});

test('optimise_week: the per-day cap is a soft warning, and excludes routines/timed', async () => {
  const out = await tool('optimise_week', { start_date: MON, max_tasks_per_day: 4, goals: ['Reach $50,000/month revenue'] });
  const mon = out.load_by_day.find((d) => d.date === MON);
  assert.equal(mon.routines_excluded, 2);
  assert.equal(mon.timed_commitments_excluded, 2);
  assert.equal(mon.over_soft_cap, true);
  assert.equal(out.soft_cap_per_day, 4);
  const relaxed = await tool('optimise_week', { start_date: MON, max_tasks_per_day: 20, goals: ['Reach $50,000/month revenue'] });
  assert.equal(relaxed.overload_warnings.length, 0, 'the cap is configurable, not a rule');
  assert.equal(relaxed.wrote_nothing, true);
});

test('the original five MCP tools still work', async () => {
  resetDb();
  const r = await call('get_calendar_week', { week: MON });
  const text = r.result.content.map((c) => c.text).join('\n');
  assert.ok(/# Week of/.test(text) && /Write proposal for Life Plus/.test(text));
  const add = await call('add_calendar_item', { day: TUE, text: 'Legacy path still adds', section: 'Work' });
  assert.ok(!add.result.isError, add.result.content[0].text);
  assert.ok(cell(TUE, S1).indexOf('Legacy path still adds') !== -1);
  const edit = await call('edit_calendar_item', { day: TUE, text: 'Legacy path still adds', new_text: 'Edited legacy line' });
  assert.ok(!edit.result.isError);
  const del = await call('delete_calendar_item', { day: TUE, text: 'Edited legacy line' });
  assert.ok(!del.result.isError);
  const pri = await call('get_priorities', { weeks: 1 });
  assert.ok(!pri.result.isError);
});

test('tools/list exposes both the old and the new tools', async () => {
  const r = await new Promise((resolve) => {
    const res = { setHeader() {}, end() { resolve(null); }, status() { return res; }, json(p) { resolve(p); } };
    handler({ method: 'POST', query: { k: 'vpm-cal-7f3a9c2e5b18d4' }, headers: {}, body: { jsonrpc: '2.0', id: 99, method: 'tools/list' } }, res);
  });
  const names = r.result.tools.map((t) => t.name);
  ['get_calendar_week', 'add_calendar_item', 'get_day', 'get_week', 'create_task', 'create_timed_event',
   'move_task', 'complete_task', 'uncomplete_task', 'delete_task', 'rollover_incomplete_tasks',
   'rollover_overdue_tasks', 'optimise_week'].forEach((n) => assert.ok(names.includes(n), 'missing ' + n));
});

/* ── Runner ─────────────────────────────────────────────────────────── */
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
