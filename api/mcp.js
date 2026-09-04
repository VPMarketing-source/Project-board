/* =========================================================================
   Project Clarity — Calendar MCP server (remote, Streamable HTTP)

   A zero-dependency Vercel serverless function that lets a Claude project
   read (and add to) the Personal Planner calendar. It reads the same
   Supabase rows the web app syncs to, so Claude always sees the live board.

   Endpoint:  https://<your-vercel-domain>/api/mcp?k=<TOKEN>
   Add that full URL as a Custom Connector in Claude.

   Transport: MCP Streamable HTTP, stateless. POST carries a JSON-RPC
   message; we answer with application/json. No sessions, no SSE needed for
   simple request/response tools.

   Tools:
     - get_calendar_week   read one week's sections x days as clean text
     - get_priorities      outstanding (unchecked) items across the next weeks
     - add_calendar_item   append a task/note to a specific day
   ========================================================================= */

const SUPABASE_URL = 'https://rqlrpxxkskqxpjgiqyql.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbHJweHhrc2txeHBqZ2lxeXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5Mjc3OTYsImV4cCI6MjA5NTUwMzc5Nn0.RG7fzJxp_SoSMNxHlkfLgrAx7ycupmt0jEDm3q9XHBE';
const CLIENT_ID = 'vpm';                         // the live planner
const STORE     = 'pc-ops::vpm::calendar::v1';   // its calendar key prefix
const SECTIONS_KEY  = STORE + '::sections::v1';
const SECFREE_KEY   = STORE + '::sectionfree::v1';
const FREEFORM_KEY  = STORE + '::freeform';

// Shared secret — the connector URL must include ?k=<TOKEN>. Not military
// grade (the underlying Supabase anon key is already public), just enough to
// keep the tidy MCP endpoint from being trivially discoverable/usable.
const TOKEN = 'vpm-cal-7f3a9c2e5b18d4';

const PROTOCOL_VERSION = '2025-06-18';

/* ── Supabase helpers ───────────────────────────────────────────────── */
function sbHeaders(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, extra || {});
}
async function readKey(key) {
  const url = SUPABASE_URL + '/rest/v1/planner_state?select=value' +
    '&client_id=eq.' + encodeURIComponent(CLIENT_ID) +
    '&key=eq.' + encodeURIComponent(key);
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase read ' + r.status);
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  const v = rows[0].value;
  const raw = (v && typeof v === 'object' && 'raw' in v) ? v.raw : (typeof v === 'string' ? v : JSON.stringify(v));
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (_) { return raw; }
}
async function writeKey(key, obj) {
  const body = [{ client_id: CLIENT_ID, key, value: { raw: JSON.stringify(obj) }, updated_at: new Date().toISOString() }];
  const r = await fetch(SUPABASE_URL + '/rest/v1/planner_state?on_conflict=client_id,key', {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Supabase write ' + r.status);
}

/* ── Dates ──────────────────────────────────────────────────────────── */
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}
function weekDates(mondayKey) {
  const m = parseYmd(mondayKey);
  const out = [];
  for (let i = 0; i < 7; i++) { const d = new Date(m); d.setDate(m.getDate() + i); out.push(d); }
  return out;
}
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDate(d) { return DOW[(d.getDay() + 6) % 7] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }

/* ── HTML → readable text (checkboxes, dropdowns, dividers) ──────────── */
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/​/g, '');
}
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html;
  // Checkboxes: mark before stripping tags.
  s = s.replace(/<div[^>]*class="[^"]*pc-todo[^"]*is-checked[^"]*"[^>]*>/gi, '\n[x] ');
  s = s.replace(/<div[^>]*class="[^"]*pc-todo(?![^"]*is-checked)[^"]*"[^>]*>/gi, '\n[ ] ');
  // Dropdown/section headings and dividers.
  s = s.replace(/<span[^>]*class="[^"]*pc-drop-title[^"]*"[^>]*>/gi, '\n### ');
  s = s.replace(/<div[^>]*class="[^"]*pc-divider[^"]*"[^>]*>/gi, '\n———\n');
  // Block boundaries → newlines.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|p|li|h[1-6])>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  // Drop the toggle chevron SVGs and any remaining tags.
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Tidy whitespace: trim lines, collapse blank runs, drop empty checkbox rows.
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => {
      if (l === '[x]' || l === '[ ]') return false;      // empty checkbox row
      if (l === '' && (i === 0 || arr[i - 1] === '')) return false; // collapse blanks
      return true;
    });
  return lines.join('\n').trim();
}

/* ── Calendar reads ─────────────────────────────────────────────────── */
async function loadAll() {
  const [sections, secfree, freeform] = await Promise.all([
    readKey(SECTIONS_KEY).catch(() => null),
    readKey(SECFREE_KEY).catch(() => null),
    readKey(FREEFORM_KEY).catch(() => null),
  ]);
  return { sections: sections || {}, secfree: secfree || {}, freeform: freeform || {} };
}

function renderWeek(mondayKey, data) {
  const days = weekDates(mondayKey);
  const secs = data.sections[mondayKey] || [];
  const out = [];
  out.push('# Week of ' + niceDate(days[0]) + ' – ' + niceDate(days[6]) + '  (' + mondayKey + ')');
  if (!secs.length) {
    // Fall back to per-day freeform (older content) if no sections this week.
    let any = false;
    days.forEach((d) => {
      const t = htmlToText(data.freeform[ymd(d)]);
      if (t) { any = true; out.push('\n## ' + niceDate(d)); out.push(t); }
    });
    if (!any) out.push('\n(no entries for this week)');
    return out.join('\n');
  }
  secs.forEach((sec) => {
    out.push('\n## ' + (sec.name || 'Section'));
    days.forEach((d) => {
      const t = htmlToText(data.secfree[ymd(d) + '::' + sec.id]);
      if (t) { out.push('- ' + niceDate(d) + ':'); out.push(t.split('\n').map((l) => '    ' + l).join('\n')); }
    });
  });
  return out.join('\n');
}

/* ── Tools ──────────────────────────────────────────────────────────── */
const TOOLS = [
  {
    name: 'get_calendar_week',
    description: "Read one week of the user's planner calendar as clean text — every section (row) and the notes/checkboxes for each day. [x] = done, [ ] = to do. Use this to understand what's planned before advising.",
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string', description: "Monday of the week as YYYY-MM-DD, or 'current' / 'next' / 'last'. Defaults to the current week." },
      },
    },
  },
  {
    name: 'get_priorities',
    description: "List outstanding (unchecked '[ ]') to-do items across the current week and the next few weeks, grouped by day. Use this to help the user prioritise what to do.",
    inputSchema: {
      type: 'object',
      properties: {
        weeks: { type: 'number', description: 'How many weeks ahead to scan, starting from the current week. Default 2.' },
      },
    },
  },
  {
    name: 'add_calendar_item',
    description: "Add a task or note to the user's calendar on a specific day. Appends a line (optionally as a checkbox) to a section for that day. Confirm details with the user before adding.",
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'The day to add to, as YYYY-MM-DD.' },
        text: { type: 'string', description: 'The task/note text.' },
        section: { type: 'string', description: "Which section (row) to add under, by name. Defaults to the week's first section." },
        checkbox: { type: 'boolean', description: 'If true, add it as an unchecked to-do. Default true.' },
      },
      required: ['day', 'text'],
    },
  },
];

function resolveWeek(week) {
  const today = new Date();
  const curMon = mondayOf(today);
  if (!week || week === 'current' || week === 'this') return ymd(curMon);
  if (week === 'next') { const d = new Date(curMon); d.setDate(d.getDate() + 7); return ymd(d); }
  if (week === 'last' || week === 'previous') { const d = new Date(curMon); d.setDate(d.getDate() - 7); return ymd(d); }
  const p = parseYmd(week);
  if (p) return ymd(mondayOf(p));
  return ymd(curMon);
}

async function callTool(name, args) {
  if (name === 'get_calendar_week') {
    const data = await loadAll();
    const mondayKey = resolveWeek(args.week);
    return renderWeek(mondayKey, data);
  }

  if (name === 'get_priorities') {
    const data = await loadAll();
    const weeks = Math.max(1, Math.min(8, Number(args.weeks) || 2));
    const curMon = mondayOf(new Date());
    const out = ['# Outstanding to-dos (next ' + weeks + ' week' + (weeks > 1 ? 's' : '') + ')'];
    let found = 0;
    for (let w = 0; w < weeks; w++) {
      const mon = new Date(curMon); mon.setDate(mon.getDate() + w * 7);
      const mondayKey = ymd(mon);
      const secs = data.sections[mondayKey] || [];
      weekDates(mondayKey).forEach((d) => {
        const dayKey = ymd(d);
        const todos = [];
        secs.forEach((sec) => {
          const t = htmlToText(data.secfree[dayKey + '::' + sec.id]);
          t.split('\n').forEach((l) => { if (l.startsWith('[ ]')) todos.push(l.replace(/^\[ \]\s*/, '') + '  (' + sec.name + ')'); });
        });
        // include older freeform unchecked items too
        htmlToText(data.freeform[dayKey]).split('\n').forEach((l) => { if (l.startsWith('[ ]')) todos.push(l.replace(/^\[ \]\s*/, '')); });
        if (todos.length) { found += todos.length; out.push('\n## ' + niceDate(d)); todos.forEach((x) => out.push('- [ ] ' + x)); }
      });
    }
    if (!found) out.push('\nNothing outstanding — all clear, or nothing is planned yet.');
    return out.join('\n');
  }

  if (name === 'add_calendar_item') {
    const day = parseYmd(args.day);
    if (!day) throw new Error("'day' must be a date like 2026-09-08");
    const text = String(args.text || '').trim();
    if (!text) throw new Error("'text' is required");
    const checkbox = args.checkbox !== false;
    const dayKey = ymd(day);
    const mondayKey = ymd(mondayOf(day));
    const data = await loadAll();
    let secs = data.sections[mondayKey] || [];
    if (!secs.length) throw new Error('That week has no sections yet — open the planner and add a section first, then try again.');
    let sec = secs[0];
    if (args.section) {
      const match = secs.find((s) => (s.name || '').toLowerCase() === String(args.section).toLowerCase());
      if (match) sec = match;
    }
    const cellKey = dayKey + '::' + sec.id;
    const secfree = data.secfree;
    const existing = secfree[cellKey] || '';
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const block = checkbox
      ? '<div class="pc-todo"><input type="checkbox" class="pc-todo-box" contenteditable="false"><span class="pc-todo-text">' + safe + '</span></div>'
      : '<div>' + safe + '</div>';
    secfree[cellKey] = existing + block;
    await writeKey(SECFREE_KEY, secfree);
    return 'Added to ' + niceDate(day) + ' under "' + sec.name + '": ' + text +
      '\n\nIt will appear on the planner (it live-syncs).';
  }

  throw new Error('Unknown tool: ' + name);
}

/* ── JSON-RPC / MCP plumbing ────────────────────────────────────────── */
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMessage(m) {
  const { id, method, params } = m || {};
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'clarity-calendar', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || (method && method.indexOf('notifications/') === 0)) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const nm = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const text = await callTool(nm, args);
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + (e && e.message ? e.message : String(e)) }], isError: true });
    }
  }
  if (id === undefined || id === null) return null; // unknown notification
  return rpcError(id, -32601, 'Method not found: ' + method);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch (_) {} }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || 'null')); } catch (_) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Token gate (?k=… or Authorization: Bearer …)
  const q = (req.query && (req.query.k || req.query.token)) || '';
  const auth = (req.headers && (req.headers.authorization || '')).replace(/^Bearer\s+/i, '');
  if (q !== TOKEN && auth !== TOKEN) { res.status(401).json({ error: 'Unauthorized — missing or bad token' }); return; }

  if (req.method === 'GET') {
    // Simple health/info response; the connector uses POST.
    res.status(200).json({ ok: true, server: 'clarity-calendar', transport: 'streamable-http (POST JSON-RPC)' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const msg = await readBody(req);
  if (msg == null) { res.status(400).json({ error: 'Invalid JSON' }); return; }

  try {
    if (Array.isArray(msg)) {
      const results = [];
      for (const m of msg) { const r = await handleMessage(m); if (r) results.push(r); }
      if (!results.length) { res.status(202).end(); return; }
      res.status(200).json(results);
    } else {
      const r = await handleMessage(msg);
      if (r == null) { res.status(202).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(r);
    }
  } catch (e) {
    res.status(200).json(rpcError((msg && msg.id) || null, -32603, 'Internal error: ' + (e && e.message ? e.message : String(e))));
  }
};
