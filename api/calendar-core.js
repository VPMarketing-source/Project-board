/* =========================================================================
   Project Clarity — calendar core

   The primitives the calendar MCP server and the Reid tool layer share:
   the Supabase key/value store, dates, the HTML ⇄ text conversion and the
   per-item styling classes.

   Everything here was lifted verbatim out of api/mcp.js so both tool sets
   read and write the calendar exactly the same way. It stores nothing new:
   the calendar is still {cellKey: html} under one planner_state key.
   ========================================================================= */

const SUPABASE_URL = 'https://rqlrpxxkskqxpjgiqyql.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbHJweHhrc2txeHBqZ2lxeXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5Mjc3OTYsImV4cCI6MjA5NTUwMzc5Nn0.RG7fzJxp_SoSMNxHlkfLgrAx7ycupmt0jEDm3q9XHBE';
const CLIENT_ID = 'vpm';                         // the live planner
const STORE     = 'pc-ops::vpm::calendar::v1';   // its calendar key prefix
const SECTIONS_KEY  = STORE + '::sections::v1';
const SECFREE_KEY   = STORE + '::sectionfree::v1';
const FREEFORM_KEY  = STORE + '::freeform';
// Reid's mutation log. A new key under the same prefix, so it syncs and is
// picked up by api/backup.js like everything else — no migration.
const AGENTLOG_KEY  = STORE + '::agentlog::v1';

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
function addDays(dayKey, n) {
  const d = parseYmd(dayKey);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return ymd(d);
}
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDate(d) { return DOW[(d.getDay() + 6) % 7] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
function dowName(dayKey) { const d = parseYmd(dayKey); return d ? DOW[(d.getDay() + 6) % 7] : ''; }

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

/* ── Per-item styling ────────────────────────────────────────────────
   Agent Board sends heading / bold / color alongside an item's text. We
   keep them on the item's own block as classes the planner styles. */
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

/* ── Finding one line in a day (text matching, used by the older tools) ── */
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

/* ── Whole-calendar read ────────────────────────────────────────────── */
async function loadAll() {
  const [sections, secfree, freeform] = await Promise.all([
    readKey(SECTIONS_KEY).catch(() => null),
    readKey(SECFREE_KEY).catch(() => null),
    readKey(FREEFORM_KEY).catch(() => null),
  ]);
  return { sections: sections || {}, secfree: secfree || {}, freeform: freeform || {} };
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, CLIENT_ID, STORE,
  SECTIONS_KEY, SECFREE_KEY, FREEFORM_KEY, AGENTLOG_KEY,
  sbHeaders, readKey, writeKey, loadAll,
  ymd, parseYmd, mondayOf, weekDates, addDays, niceDate, dowName, DOW, MONTHS,
  decodeEntities, htmlToText, splitBlocks,
  COLORS, STYLE_CLASS, readStyle, styleClasses, styleClassesOn, withClasses,
  escapeHtml, todoBlock, buildBlock,
  collectMatches, chooseMatch,
};
