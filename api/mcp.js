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
     - get_calendar_week    read one week's sections x days as clean text
     - get_priorities       outstanding (unchecked) items across the next weeks
     - add_calendar_item    append a task/note to a specific day
     - delete_calendar_item remove a line from a day by its text
     - edit_calendar_item   change a line's text, keeping its checkbox state

   Per-item styling
   ----------------
   add_calendar_item / edit_calendar_item accept three optional arguments —
   heading (boolean), bold (boolean) and color ("green" | "black" | "red").
   They are stored on the item's own block as classes the planner styles:

     pc-head                 a heading line, never a to-do (no checkbox)
     pc-b                    bold
     pc-fg-green|black|red   text colour

   Anything unrecognised is ignored rather than rejected, and an item written
   without them keeps exactly today's plain rendering. The classes live on the
   block element, so get_calendar_week's text output is untouched: heading and
   timed lines read as plain lines, to-dos still read as "[ ]" / "[x]".
   Strike-through is deliberately NOT stored here — only the planner knows
   when a box is ticked or a time has passed, so it decides that at render.
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

/* ── Cell HTML → top-level blocks ───────────────────────────────────────
   A day-cell is a flat run of block elements (pc-todo divs, plain divs,
   dividers). Splitting on top-level <div> boundaries by depth gives each
   visible line as one block string, so delete/edit can act on a whole
   line without touching its neighbours. Text between blocks (bare text
   nodes, <br> runs) is kept as its own pseudo-block. */
function splitBlocks(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  let depth = 0, start = 0, i = 0;
  const push = (end) => { const s = html.slice(start, end); if (s.trim()) out.push(s); };
  while (i < html.length) {
    const open = /^<div\b/i.test(html.slice(i, i + 5));
    const close = /^<\/div>/i.test(html.slice(i, i + 6));
    if (open) {
      if (depth === 0 && i > start) { push(i); start = i; }
      depth++;
      i = html.indexOf('>', i) + 1 || html.length;
      continue;
    }
    if (close) {
      depth = Math.max(0, depth - 1);
      i += 6;
      if (depth === 0) { push(i); start = i; }
      continue;
    }
    i++;
  }
  if (start < html.length) push(html.length);
  return out;
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

/* ── Per-item styling ────────────────────────────────────────────────
   Agent Board sends heading / bold / color alongside an item's text. We
   keep them on the item's own block as classes, alongside its text and
   (for a to-do) its checkbox state. Unknown values are dropped silently —
   a write must never fail because of a combination we don't know. */
const COLORS = { green: 'pc-fg-green', black: 'pc-fg-black', red: 'pc-fg-red' };
const STYLE_CLASS = /^(pc-head|pc-b|pc-fg-(?:green|black|red))$/;

function readStyle(args) {
  const color = String(args.color == null ? '' : args.color).trim().toLowerCase();
  return {
    heading: args.heading === true,
    bold: args.bold === true,
    color: Object.prototype.hasOwnProperty.call(COLORS, color) ? color : '',
    // true when the caller asked for *any* styling at all
    any: args.heading === true || args.bold === true || Object.prototype.hasOwnProperty.call(COLORS, color),
  };
}
function styleClasses(style) {
  const cs = [];
  if (style.heading) cs.push('pc-head');
  if (style.bold) cs.push('pc-b');
  if (style.color) cs.push(COLORS[style.color]);
  return cs;
}
// The styling classes a stored block already carries.
function styleClassesOn(block) {
  const m = /^<div\b[^>]*\bclass="([^"]*)"/i.exec(block);
  if (!m) return [];
  return m[1].split(/\s+/).filter((c) => STYLE_CLASS.test(c));
}
function withClasses(tag, classes) {
  return classes.length ? tag + ' class="' + classes.join(' ') + '"' : tag;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function todoBlock(safeText, classes, checked) {
  return '<div' + (classes.length ? ' class="' + classes.join(' ') + '"' : ' class="pc-todo"') + '>' +
    '<input type="checkbox" class="pc-todo-box" contenteditable="false"' + (checked ? ' checked' : '') + '>' +
    '<span class="pc-todo-text">' + safeText + '</span></div>';
}
// Build the stored block for a brand-new item.
function buildBlock(text, checkbox, style) {
  const safe = escapeHtml(text);
  const cs = styleClasses(style);
  if (style.heading || !checkbox) return '<' + withClasses('div', cs) + '>' + safe + '</div>';
  return todoBlock(safe, ['pc-todo'].concat(cs), false);
}

/* One entry per styled line in a week: which day and section it sits on, its
   text, and the heading/bold/color it was written with. Purely additive — it
   is never folded into renderWeek's text. */
function weekStyles(mondayKey, data) {
  const out = [];
  (data.sections[mondayKey] || []).forEach((sec) => {
    weekDates(mondayKey).forEach((d) => {
      const dayKey = ymd(d);
      splitBlocks(data.secfree[dayKey + '::' + sec.id] || '').forEach((block) => {
        const cs = styleClassesOn(block);
        if (!cs.length) return;
        const t = htmlToText(block).replace(/^\[[x ]\]\s*/, '').trim();
        if (!t) return;
        const color = cs.map((c) => (/^pc-fg-(\w+)$/.exec(c) || [])[1]).find(Boolean) || null;
        out.push({
          day: dayKey, section: sec.name || 'Section', text: t,
          heading: cs.indexOf('pc-head') !== -1,
          bold: cs.indexOf('pc-b') !== -1,
          color,
        });
      });
    });
  });
  return out;
}

/* ── Finding one line in a day ───────────────────────────────────────
   Shared by delete/edit (which must land on exactly one line) and by
   add's optional 'after' (which quietly falls back when unsure). */
function collectMatches(data, dayKey, targets, wanted) {
  const matches = [];
  const want = wanted.toLowerCase();
  targets.forEach((sec) => {
    const cellKey = dayKey + '::' + sec.id;
    const html = data.secfree[cellKey] || '';
    splitBlocks(html).forEach((block) => {
      const t = htmlToText(block).replace(/^\[[x ]\]\s*/, '').trim();
      if (!t) return;
      const lower = t.toLowerCase();
      if (lower === want || lower.indexOf(want) !== -1) {
        matches.push({ cellKey, block, text: t, secName: sec.name || 'Section', exact: lower === want });
      }
    });
  });
  return matches;
}
function chooseMatch(matches) {
  const exact = matches.filter((m) => m.exact);
  if (exact.length === 1) return exact[0];
  return matches.length === 1 ? matches[0] : null;
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
        include_styles: { type: 'boolean', description: 'If true, also return each styled line\'s heading/bold/color as a separate JSON block, after the week text. The week text itself is identical either way. Default false.' },
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
    name: 'delete_calendar_item',
    description: "Remove one line (to-do or note) from a day by its text. Matches the line's visible text, case-insensitively; exact match wins, otherwise a single containing match. Refuses when the text matches several lines — give more of the text.",
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'The day the line is on, as YYYY-MM-DD.' },
        text: { type: 'string', description: 'The visible text of the line to remove (or a unique part of it).' },
        section: { type: 'string', description: 'Which section (row) it is under, by name. Searches every section when omitted.' },
      },
      required: ['day', 'text'],
    },
  },
  {
    name: 'edit_calendar_item',
    description: "Change one line's text on a day, keeping its checkbox and checked state. Same matching rules as delete_calendar_item. Optionally restyle it with heading / bold / color; styling arguments you leave out are left as they are.",
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'The day the line is on, as YYYY-MM-DD.' },
        text: { type: 'string', description: 'The current visible text of the line (or a unique part of it).' },
        new_text: { type: 'string', description: 'What the line should say instead.' },
        section: { type: 'string', description: 'Which section (row) it is under, by name. Searches every section when omitted.' },
        heading: { type: 'boolean', description: 'If true, the line is a heading, not a task — it renders as a heading with no checkbox.' },
        bold: { type: 'boolean', description: 'If true, render the line bold.' },
        color: { type: 'string', description: 'Text colour for the line: "green", "black" or "red". Anything else is ignored.' },
      },
      required: ['day', 'text', 'new_text'],
    },
  },
  {
    name: 'add_calendar_item',
    description: "Add a task, heading or note to the user's calendar on a specific day. Appends a line (optionally as a checkbox) to a section for that day, or inserts it after an existing line with 'after'. Lines can be styled with heading / bold / color. Confirm details with the user before adding.",
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'The day to add to, as YYYY-MM-DD.' },
        text: { type: 'string', description: 'The task/note text.' },
        section: { type: 'string', description: "Which section (row) to add under, by name. Defaults to the week's first section." },
        checkbox: { type: 'boolean', description: 'If true, add it as an unchecked to-do. Defaults to true for a plain line, and to false when heading/bold/color are given (a styled heading or timed item is not a to-do).' },
        heading: { type: 'boolean', description: 'If true, the line is a heading, not a task — it renders as a heading with no checkbox.' },
        bold: { type: 'boolean', description: 'If true, render the line bold.' },
        color: { type: 'string', description: 'Text colour for the line: "green", "black" or "red". Anything else is ignored.' },
        after: { type: 'string', description: 'Insert the new line directly after the line whose text matches this (e.g. the heading it belongs under), instead of at the bottom of the day. Same matching rules as edit_calendar_item; falls back to the bottom when nothing matches.' },
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
    const text = renderWeek(mondayKey, data);
    // Styling never goes inline: the week text is parsed downstream and must
    // stay byte-for-byte what it has always been. Callers who want the colours
    // ask for them, and get them as their own JSON block alongside the text.
    if (args.include_styles === true) {
      return { text, extra: JSON.stringify({ week: mondayKey, styles: weekStyles(mondayKey, data) }, null, 2) };
    }
    return text;
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

  if (name === 'delete_calendar_item' || name === 'edit_calendar_item') {
    const day = parseYmd(args.day);
    if (!day) throw new Error("'day' must be a date like 2026-09-08");
    const wanted = String(args.text || '').trim();
    if (!wanted) throw new Error("'text' is required");
    const newText = name === 'edit_calendar_item' ? String(args.new_text || '').trim() : '';
    if (name === 'edit_calendar_item' && !newText) throw new Error("'new_text' is required");

    const dayKey = ymd(day);
    const mondayKey = ymd(mondayOf(day));
    const data = await loadAll();
    const secs = data.sections[mondayKey] || [];
    const targets = args.section
      ? secs.filter((s) => (s.name || '').toLowerCase() === String(args.section).toLowerCase())
      : secs;
    if (!targets.length) throw new Error(args.section ? 'No section named "' + args.section + '" that week.' : 'That week has no sections.');

    // Every match across the searched cells: { cellKey, block, text, secName }.
    const matches = collectMatches(data, dayKey, targets, wanted);
    const pick = chooseMatch(matches);
    if (!pick) {
      if (!matches.length) throw new Error('No line on ' + niceDate(day) + ' matches "' + wanted + '".');
      throw new Error(matches.length + ' lines match "' + wanted + '" on ' + niceDate(day) + ' (' +
        matches.slice(0, 4).map((m) => '"' + m.text.slice(0, 60) + '"').join(', ') + '). Give more of the text.');
    }

    const html = data.secfree[pick.cellKey] || '';
    if (name === 'delete_calendar_item') {
      data.secfree[pick.cellKey] = html.replace(pick.block, '');
      await writeKey(SECFREE_KEY, data.secfree);
      return 'Removed from ' + niceDate(day) + ' under "' + pick.secName + '": ' + pick.text + '\n\nThe planner live-syncs.';
    }
    const safe = escapeHtml(newText);
    const style = readStyle(args);
    // Styling is only touched when the caller asks: pass none of heading/bold/
    // color and the line keeps exactly the look it already has.
    const cs = style.any ? styleClasses(style) : styleClassesOn(pick.block);
    const isTodo = /pc-todo-text/.test(pick.block);
    let newBlock;
    if (cs.indexOf('pc-head') !== -1 || !isTodo) {
      // A heading is never a to-do, and a plain line stays a plain line.
      newBlock = '<' + withClasses('div', cs) + '>' + safe + '</div>';
    } else {
      // Keep the row (and its checked state); swap the label's content and
      // rewrite the class list so the styling matches.
      const checked = /\bis-checked\b/.test(pick.block);
      const rowClasses = ['pc-todo'].concat(checked ? ['is-checked'] : []).concat(cs);
      newBlock = pick.block
        .replace(/(<span[^>]*class="[^"]*pc-todo-text[^"]*"[^>]*>)[\s\S]*?(<\/span>)/, '$1' + safe.replace(/\$/g, '$$$$') + '$2')
        .replace(/^<div\b[^>]*?(?:\sclass="[^"]*")?([^>]*)>/i, '<div class="' + rowClasses.join(' ') + '"$1>');
    }
    data.secfree[pick.cellKey] = html.replace(pick.block, newBlock);
    await writeKey(SECFREE_KEY, data.secfree);
    return 'Changed on ' + niceDate(day) + ' under "' + pick.secName + '": "' + pick.text + '" is now "' + newText + '".\n\nThe planner live-syncs.';
  }

  if (name === 'add_calendar_item') {
    const day = parseYmd(args.day);
    if (!day) throw new Error("'day' must be a date like 2026-09-08");
    const text = String(args.text || '').trim();
    if (!text) throw new Error("'text' is required");
    const style = readStyle(args);
    // A plain line is still a to-do by default. A styled line (a heading, or a
    // bold/coloured timed item) is not: those are labels, not boxes to tick —
    // unless the caller explicitly asks for a checkbox anyway.
    const checkbox = style.heading ? false
      : (args.checkbox === true ? true : (style.any ? false : args.checkbox !== false));
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
    const block = buildBlock(text, checkbox, style);

    // 'after' drops the line directly below an existing one (its heading, say)
    // instead of at the bottom of the day. Ambiguous or missing → bottom, so a
    // vague 'after' never costs the caller the write.
    let placedAfter = '';
    const afterText = String(args.after || '').trim();
    if (afterText) {
      const anchor = chooseMatch(collectMatches(data, dayKey, [sec], afterText));
      if (anchor && anchor.cellKey === cellKey) {
        const at = existing.indexOf(anchor.block);
        if (at !== -1) {
          const end = at + anchor.block.length;
          secfree[cellKey] = existing.slice(0, end) + block + existing.slice(end);
          placedAfter = anchor.text;
        }
      }
    }
    if (!placedAfter) secfree[cellKey] = existing + block;

    await writeKey(SECFREE_KEY, secfree);
    return 'Added to ' + niceDate(day) + ' under "' + sec.name + '"' +
      (placedAfter ? ', after "' + placedAfter + '"' : '') + ': ' + text +
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
      const res = await callTool(nm, args);
      const content = typeof res === 'string'
        ? [{ type: 'text', text: res }]
        : [{ type: 'text', text: res.text }].concat(res.extra ? [{ type: 'text', text: res.extra }] : []);
      return rpcResult(id, { content });
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
