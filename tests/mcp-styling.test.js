/* Node test for the calendar MCP's per-item styling (api/mcp.js).
   Runs the real handler against an in-memory stand-in for Supabase, so it
   exercises the actual JSON-RPC path the connector uses.

   Run:  node tests/mcp-styling.test.js                                   */

const assert = require('assert');

const STORE = 'pc-ops::vpm::calendar::v1';
const SECTIONS_KEY = STORE + '::sections::v1';
const SECFREE_KEY = STORE + '::sectionfree::v1';

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

const handler = require('../api/mcp.js');

/* ── Driving the handler ────────────────────────────────────────────── */
let nextId = 1;
function call(name, args) {
  const req = {
    method: 'POST',
    query: { k: 'vpm-cal-7f3a9c2e5b18d4' },
    headers: {},
    body: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
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
  const r = await call(name, args);
  const result = r.result;
  assert.ok(result, 'no result for ' + name + ': ' + JSON.stringify(r));
  const text = result.content.map((c) => c.text).join('\n');
  if (result.isError) throw new Error(text);
  return { text, content: result.content };
}
const cell = (day, sec) => JSON.parse(db[SECFREE_KEY] || '{}')[day + '::' + sec] || '';

/* ── Fixture: one week, two sections ────────────────────────────────── */
const MONDAY = '2026-09-07';
const TUE = '2026-09-08';
db[SECTIONS_KEY] = JSON.stringify({
  [MONDAY]: [{ id: 's1', name: 'Work', height: 120 }, { id: 's2', name: 'Home', height: 120 }],
});

/* ── Tests ──────────────────────────────────────────────────────────── */
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a plain add is unchanged — a to-do with no styling classes', async () => {
  await tool('add_calendar_item', { day: TUE, text: 'Send the invoice', section: 'Work' });
  const html = cell(TUE, 's1');
  assert.strictEqual(
    html,
    '<div class="pc-todo"><input type="checkbox" class="pc-todo-box" contenteditable="false"><span class="pc-todo-text">Send the invoice</span></div>'
  );
});

test('heading + bold + green: no checkbox, styled classes', async () => {
  const r = await tool('add_calendar_item', {
    day: TUE, text: 'VP MARKETING', section: 'Work', heading: true, bold: true, color: 'green',
  });
  assert.ok(!/Error/.test(r.text), r.text);
  const html = cell(TUE, 's1');
  assert.ok(html.includes('<div class="pc-head pc-b pc-fg-green">VP MARKETING</div>'), html);
});

test('heading + bold + black works too', async () => {
  await tool('add_calendar_item', { day: TUE, text: 'PERSONAL', section: 'Home', heading: true, bold: true, color: 'black' });
  assert.ok(cell(TUE, 's2').includes('<div class="pc-head pc-b pc-fg-black">PERSONAL</div>'));
});

test('bold + red (a timed item) renders bold red with no checkbox', async () => {
  await tool('add_calendar_item', { day: TUE, text: '3:00pm - Call Marlene', section: 'Work', bold: true, color: 'red' });
  const html = cell(TUE, 's1');
  assert.ok(html.includes('<div class="pc-b pc-fg-red">3:00pm - Call Marlene</div>'), html);
});

test('an unknown colour is ignored, not rejected', async () => {
  await tool('add_calendar_item', { day: TUE, text: 'Chartreuse thing', section: 'Home', color: 'chartreuse', bold: true });
  assert.ok(cell(TUE, 's2').includes('<div class="pc-b">Chartreuse thing</div>'), cell(TUE, 's2'));
});

test('an explicit checkbox:true still wins over styling', async () => {
  await tool('add_calendar_item', { day: TUE, text: 'Styled but tickable', section: 'Home', bold: true, color: 'red', checkbox: true });
  assert.ok(cell(TUE, 's2').includes('<div class="pc-todo pc-b pc-fg-red">'), cell(TUE, 's2'));
});

test("'after' inserts directly below the matching line", async () => {
  await tool('add_calendar_item', { day: TUE, text: 'Draft the deck', section: 'Work', after: 'VP MARKETING' });
  const html = cell(TUE, 's1');
  const head = html.indexOf('VP MARKETING');
  const added = html.indexOf('Draft the deck');
  const timed = html.indexOf('Call Marlene');
  assert.ok(head < added && added < timed, 'expected the new line between the heading and the timed item: ' + html);
});

test("an 'after' that matches nothing falls back to the bottom", async () => {
  await tool('add_calendar_item', { day: TUE, text: 'Tail item', section: 'Work', after: 'no such line' });
  assert.ok(cell(TUE, 's1').trim().endsWith('Tail item</span></div>'), cell(TUE, 's1'));
});

test('edit keeps the checkbox state and can restyle', async () => {
  // Tick the invoice todo the way the planner would, then edit it.
  const sf = JSON.parse(db[SECFREE_KEY]);
  sf[TUE + '::s1'] = sf[TUE + '::s1'].replace('class="pc-todo"', 'class="pc-todo is-checked"');
  db[SECFREE_KEY] = JSON.stringify(sf);

  await tool('edit_calendar_item', { day: TUE, text: 'Send the invoice', new_text: 'Send the invoice today', section: 'Work', bold: true, color: 'red' });
  const html = cell(TUE, 's1');
  assert.ok(html.includes('<div class="pc-todo is-checked pc-b pc-fg-red">'), html);
  assert.ok(html.includes('>Send the invoice today</span>'), html);
});

test('edit without styling arguments leaves the styling alone', async () => {
  await tool('edit_calendar_item', { day: TUE, text: 'Call Marlene', new_text: '4:00pm - Call Marlene', section: 'Work' });
  assert.ok(cell(TUE, 's1').includes('<div class="pc-b pc-fg-red">4:00pm - Call Marlene</div>'), cell(TUE, 's1'));
});

test('edit can promote a line to a heading (losing its checkbox)', async () => {
  await tool('add_calendar_item', { day: TUE, text: 'Wedding stuff', section: 'Home' });
  await tool('edit_calendar_item', { day: TUE, text: 'Wedding stuff', new_text: 'WEDDING', section: 'Home', heading: true, bold: true, color: 'black' });
  const html = cell(TUE, 's2');
  assert.ok(html.includes('<div class="pc-head pc-b pc-fg-black">WEDDING</div>'), html);
  assert.ok(!html.includes('Wedding stuff'), html);
});

test('the week text is unchanged by styling: headings/timed lines are plain lines', async () => {
  const { text } = await tool('get_calendar_week', { week: MONDAY });
  assert.ok(text.startsWith('# Week of Mon 7 Sep – Sun 13 Sep  (2026-09-07)'), text);
  assert.ok(text.includes('\n## Work'), text);
  assert.ok(text.includes('\n- Tue 8 Sep:'), text);
  // Styled lines carry no inline markers at all.
  assert.ok(/^\s+VP MARKETING$/m.test(text), text);
  assert.ok(/^\s+4:00pm - Call Marlene$/m.test(text), text);
  assert.ok(/^\s+\[x\] Send the invoice today$/m.test(text), text);
  assert.ok(/^\s+\[ \] Draft the deck$/m.test(text), text);
  assert.ok(!/pc-|<div|\*\*/.test(text), text);
});

test('include_styles adds a separate JSON block and does not touch the text', async () => {
  const plain = await tool('get_calendar_week', { week: MONDAY });
  const withStyles = await tool('get_calendar_week', { week: MONDAY, include_styles: true });
  assert.strictEqual(withStyles.content.length, 2);
  assert.strictEqual(withStyles.content[0].text, plain.text, 'week text must be byte-for-byte identical');
  const parsed = JSON.parse(withStyles.content[1].text);
  const head = parsed.styles.find((s) => s.text === 'VP MARKETING');
  assert.deepStrictEqual(
    { heading: head.heading, bold: head.bold, color: head.color, day: head.day, section: head.section },
    { heading: true, bold: true, color: 'green', day: TUE, section: 'Work' }
  );
  const timed = parsed.styles.find((s) => s.text === '4:00pm - Call Marlene');
  assert.deepStrictEqual({ heading: timed.heading, bold: timed.bold, color: timed.color }, { heading: false, bold: true, color: 'red' });
});

test('delete still removes exactly one styled line', async () => {
  await tool('delete_calendar_item', { day: TUE, text: 'Tail item', section: 'Work' });
  assert.ok(!cell(TUE, 's1').includes('Tail item'));
  assert.ok(cell(TUE, 's1').includes('VP MARKETING'));
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
