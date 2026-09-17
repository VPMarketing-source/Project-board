/* =========================================================================
   Project Clarity — controlled calendar tool layer

   Ten narrow, validated tools over the EXISTING planner calendar, so the
   calendar can be driven conversationally:

     Matthew  →  Claude  →  these tools  →  the existing calendar

   Nothing here touches raw database rows: every read and write goes through
   api/calendar-core.js, against the same planner_state keys the browser UI
   reads and writes. No new tables, no schema change, no UI change.

   Item identity
   -------------
   Actionable lines get a permanent id stored INSIDE the existing HTML blob:

     <div class="pc-todo" data-item-id="ci-mg3k1x4b7">…</div>

   The attribute is invisible in the planner and survives lines being added,
   removed or reordered above it. Lines written before this layer existed are
   still recognised; they are addressed by a content hash (t:…) and stamped
   with a permanent id the first time they are mutated, or in bulk by
   normalise_week. Every write re-reads the cell and re-resolves the item, so
   a cell that changed underneath us is refused, not overwritten.

   Styling rules (enforced here, not chosen by the caller)
   ------------------------------------------------------
     client / VP MARKETING headings  →  green + bold   (pc-head pc-b pc-fg-green)
     PERSONAL / WEDDING headings     →  black + bold   (pc-head pc-b pc-fg-black)
     timed items                     →  red + bold     (pc-b pc-fg-red, no checkbox)
     completed items                 →  is-checked, struck through by the planner

   Every mutation is logged with what changed, when, and why — `reason` is a
   required argument on all of them.
   ========================================================================= */

const crypto = require('crypto');
const C = require('./calendar-core.js');
const { fetchGoalContext, goalContextFromArg } = require('./goals-source.js');

const LOG_CAP = 500;
const DEFAULT_MAX_TASKS_PER_DAY = 6;   // soft, configurable — a warning, never a rule

/* ── small helpers ──────────────────────────────────────────────────── */
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function hash8(s) { return crypto.createHash('sha1').update(norm(s)).digest('hex').slice(0, 8); }
function revOf(html) { return crypto.createHash('sha1').update(String(html || '')).digest('hex').slice(0, 10); }
let idSeq = 0;
function newItemId() {
  return 'ci-' + Date.now().toString(36) + (idSeq++).toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/* ── time parsing (same rules as shared/planner-style.js) ───────────── */
const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';
const RANGE_RE = new RegExp('^\\s*' + TIME + '\\s*(?:[-\u2013\u2014]|to\\b)\\s*' + TIME, 'i');
const SINGLE_RE = new RegExp('^\\s*' + TIME, 'i');
function toMinutes(h, m, mer) {
  let hour = Number(h);
  if (hour > 23) return null;
  const ap = (mer || '').replace(/\./g, '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  const mins = Number(m || 0);
  if (mins > 59) return null;
  return hour * 60 + mins;
}
// Minutes-of-day a line is "over" at, or null when the line is not timed.
function leadingTime(text) {
  const r = RANGE_RE.exec(text);
  if (r && (r[2] || r[3]) && (r[5] || r[6])) {
    const end = toMinutes(r[4], r[5], r[6] || r[3]);
    if (end != null) return end;
  }
  const s = SINGLE_RE.exec(text);
  if (!s) return null;
  if (!s[2] && !s[3]) return null;          // bare number → not a time
  return toMinutes(s[1], s[2], s[3]);
}

/* ── block splitting, with offsets so inserts land exactly ───────────── */
function splitTop(html, base) {
  const out = [];
  let depth = 0, start = 0, i = 0;
  const push = (end) => { if (html.slice(start, end).trim()) out.push({ start: base + start, end: base + end }); };
  while (i < html.length) {
    if (/^<div\b/i.test(html.slice(i, i + 5))) {
      if (depth === 0 && i > start) { push(i); start = i; }
      depth++;
      const gt = html.indexOf('>', i);
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    if (/^<\/div>/i.test(html.slice(i, i + 6))) {
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
function outerTag(block) { const m = /^<div\b[^>]*>/i.exec(block); return m ? m[0] : ''; }
function classesOf(block) {
  const m = /^<div\b[^>]*\bclass="([^"]*)"/i.exec(block);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}
function isTodoBlock(block) {
  return classesOf(block).indexOf('pc-todo') !== -1 || /class="[^"]*pc-todo-text/i.test(outerTag(block) ? block : '');
}
// A wrapper <div> whose body is itself blocks gets opened up, so one visible
// line is one item even in hand-typed, deeply nested content. A pc-todo is
// always a leaf: its own body is decoration, not separate lines.
function leafRanges(cell, range) {
  const block = cell.slice(range.start, range.end);
  const tag = outerTag(block);
  if (tag && !isTodoBlock(block) && /<\/div>\s*$/i.test(block)) {
    const innerStart = range.start + tag.length;
    const innerEnd = range.end - block.match(/<\/div>\s*$/i)[0].length;
    const inner = cell.slice(innerStart, innerEnd);
    if (/<div\b/i.test(inner)) {
      const kids = splitTop(inner, innerStart);
      if (kids.length) {
        const out = [];
        kids.forEach((k) => out.push(...leafRanges(cell, k)));
        if (out.length) return out;
      }
    }
  }
  return [range];
}
function allLeaves(cell) {
  const out = [];
  splitTop(String(cell || ''), 0).forEach((r) => out.push(...leafRanges(cell, r)));
  return out;
}

/* ── one cell → classified items ────────────────────────────────────── */
const GREEN_RE = /rgb\(\s*(?:22|16|21|34)\s*,/i;                 // the greens the editor writes
const RED_RE = /rgb\(\s*(?:239|220|192|255)\s*,\s*(?:68|38|57|0)\s*,/i;
const BOLD_RE = /font-weight:\s*(?:bold|[6-9]00)/i;
const BLACK_HEADS = /^(personal|wedding)\b/i;

function textOf(block) {
  return C.htmlToText(block).replace(/^\[[x ]\]\s*/, '').replace(/\s+/g, ' ').trim();
}
function itemIdOn(block) {
  const m = /^<div\b[^>]*\bdata-item-id="([^"]+)"/i.exec(block);
  return m ? m[1] : null;
}
function colourOf(block, cls) {
  if (cls.indexOf('pc-fg-green') !== -1) return 'green';
  if (cls.indexOf('pc-fg-red') !== -1) return 'red';
  if (cls.indexOf('pc-fg-black') !== -1) return 'black';
  if (RED_RE.test(block)) return 'red';
  if (GREEN_RE.test(block)) return 'green';
  return null;
}
function classifyCell(cell, dayKey, section) {
  const html = String(cell || '');
  const items = [];
  let heading = null;          // nearest preceding heading
  let routineGroup = false;    // inside a "… routine" run
  allLeaves(html).forEach((r, idx) => {
    const block = html.slice(r.start, r.end);
    const text = textOf(block);
    if (!text) return;
    const cls = classesOf(block);
    const todo = isTodoBlock(block);
    const completed = cls.indexOf('is-checked') !== -1 ||
      /\bis-checked\b/.test(outerTag(block)) ||
      /text-decoration(?:-line)?:\s*line-through/i.test(block) ||
      /<s>|<strike>/i.test(block);
    const bold = cls.indexOf('pc-b') !== -1 || BOLD_RE.test(block);
    const time = leadingTime(text);
    const isHeading = cls.indexOf('pc-head') !== -1 ||
      (!todo && time == null && text.length <= 48 &&
       (bold || (text === text.toUpperCase() && /[A-Z]{2,}/.test(text) && !/[.?!]$/.test(text))));
    const kind = isHeading ? 'heading' : (time != null ? 'timed' : (todo ? 'task' : 'note'));
    if (isHeading) { heading = text; routineGroup = /\broutines?\b/i.test(text); }
    else if (kind === 'note' && /\broutines?\b/i.test(text)) { routineGroup = true; }

    const id = itemIdOn(block);
    items.push({
      ref: id ? 'i:' + id : 't:' + dayKey + ':' + section.id + ':' + hash8(text),
      item_id: id,
      date: dayKey,
      section: section.name || 'Section',
      section_id: section.id,
      heading: isHeading ? null : heading,
      text,
      kind,
      completed,
      routine: kind === 'task' && routineGroup,
      time: time,
      bold,
      color: colourOf(block, cls),
      index: idx,
      start: r.start,
      end: r.end,
      block,
    });
  });
  return items;
}

/* ── the calendar, as this layer sees it ────────────────────────────── */
function sectionsFor(data, dayKey) {
  const mondayKey = C.ymd(C.mondayOf(C.parseYmd(dayKey)));
  return data.sections[mondayKey] || [];
}
function dayItems(data, dayKey, sectionName) {
  const secs = sectionsFor(data, dayKey).filter(
    (s) => !sectionName || norm(s.name) === norm(sectionName));
  const out = [];
  secs.forEach((sec) => {
    out.push(...classifyCell(data.secfree[dayKey + '::' + sec.id], dayKey, sec));
  });
  return out;
}
function publicItem(it) {
  return {
    task_id: it.ref, date: it.date, section: it.section, heading: it.heading,
    text: it.text, kind: it.kind, completed: it.completed, routine: it.routine,
    style: { bold: it.bold, color: it.color },
    stamped: !!it.item_id,
  };
}

/* Routines also give themselves away by repetition: the same task on three or
   more days of the week is a standing routine, not outstanding work. */
function routineTexts(data, dayKey) {
  const mondayKey = C.ymd(C.mondayOf(C.parseYmd(dayKey)));
  const seen = {};
  C.weekDates(mondayKey).forEach((d) => {
    const k = C.ymd(d);
    const onThisDay = {};
    dayItems(data, k).forEach((it) => {
      if (it.kind !== 'task') return;
      onThisDay[norm(it.text)] = true;
    });
    Object.keys(onThisDay).forEach((t) => { seen[t] = (seen[t] || 0) + 1; });
  });
  const out = {};
  Object.keys(seen).forEach((t) => { if (seen[t] >= 3) out[t] = true; });
  return out;
}

/* ── resolving a task_id ────────────────────────────────────────────── */
function resolveRef(data, ref) {
  const r = String(ref || '').trim();
  if (!r) throw new Error("'task_id' is required — get_day or get_week gives you one for every line.");
  if (r.indexOf('i:') === 0) {
    const want = r.slice(2);
    for (const cellKey of Object.keys(data.secfree || {})) {
      const html = data.secfree[cellKey];
      if (!html || html.indexOf('data-item-id="' + want + '"') === -1) continue;
      const [dayKey, sid] = cellKey.split('::');
      const sec = sectionsFor(data, dayKey).find((s) => s.id === sid) || { id: sid, name: 'Section' };
      const hit = classifyCell(html, dayKey, sec).find((it) => it.item_id === want);
      if (hit) return hit;
    }
    throw new Error('No calendar item with id ' + want + ' — it may have been deleted. Re-read the day.');
  }
  const m = /^t:(\d{4}-\d{2}-\d{2}):([^:]+):([0-9a-f]{8})$/.exec(r);
  if (!m) throw new Error('Unrecognised task_id "' + r + '". Use the task_id from get_day or get_week.');
  const [, dayKey, sid, h] = m;
  const sec = sectionsFor(data, dayKey).find((s) => s.id === sid);
  if (!sec) throw new Error('That task_id points at a section that no longer exists on ' + dayKey + '.');
  const hits = classifyCell(data.secfree[dayKey + '::' + sid], dayKey, sec).filter((it) => hash8(it.text) === h);
  if (!hits.length) throw new Error('That line is no longer on ' + dayKey + ' (it was edited, moved or removed). Re-read the day.');
  if (hits.length > 1) {
    throw new Error(hits.length + ' lines on ' + dayKey + ' read exactly "' + hits[0].text +
      '". Run normalise_week first so each one has its own permanent id.');
  }
  return hits[0];
}

/* ── cell editing ───────────────────────────────────────────────────── */
function splice(html, start, end, replacement) {
  return String(html || '').slice(0, start) + replacement + String(html || '').slice(end);
}
function stamp(block, itemId) {
  if (itemIdOn(block)) return { block, id: itemIdOn(block) };
  const tag = outerTag(block);
  if (!tag) return { block, id: null };        // bare span/text run — stays hash-addressed
  return { block: block.replace(tag, tag.replace(/^<div\b/i, '<div data-item-id="' + itemId + '"')), id: itemId };
}
function headingStyleFor(name) {
  return { heading: true, bold: true, color: BLACK_HEADS.test(String(name || '').trim()) ? 'black' : 'green', any: true };
}
function buildHeadingBlock(name, itemId) {
  const cs = C.styleClasses(headingStyleFor(name));
  return '<div data-item-id="' + itemId + '" class="' + cs.join(' ') + '">' + C.escapeHtml(name) + '</div>';
}
function buildTaskBlock(text, itemId, checked) {
  return '<div data-item-id="' + itemId + '" class="pc-todo' + (checked ? ' is-checked' : '') + '">' +
    '<input type="checkbox" class="pc-todo-box" contenteditable="false"' + (checked ? ' checked' : '') + '>' +
    '<span class="pc-todo-text">' + C.escapeHtml(text) + '</span></div>';
}
function buildTimedBlock(label, itemId) {
  return '<div data-item-id="' + itemId + '" class="pc-b pc-fg-red">' + C.escapeHtml(label) + '</div>';
}

/* Where a new line belongs in a cell: under its heading when one is asked
   for (creating that heading, correctly styled, when the day lacks it),
   otherwise at the bottom. Returns the new cell HTML. */
function insertIntoCell(cell, dayKey, sec, block, headingName) {
  let html = String(cell || '');
  if (!headingName) return html + block;
  const items = classifyCell(html, dayKey, sec);
  const hIdx = items.findIndex((it) => it.kind === 'heading' && norm(it.text) === norm(headingName));
  if (hIdx === -1) {
    return html + buildHeadingBlock(headingName, newItemId()) + block;
  }
  // End of that heading's run: the last item before the next heading.
  let at = items[hIdx].end;
  for (let i = hIdx + 1; i < items.length; i++) {
    if (items[i].kind === 'heading') break;
    at = items[i].end;
  }
  return splice(html, at, at, block);
}

/* ── the mutation log ───────────────────────────────────────────────── */
async function appendLog(entries) {
  if (!entries.length) return;
  let log = [];
  try { log = (await C.readKey(C.AGENTLOG_KEY)) || []; } catch (_) { log = []; }
  if (!Array.isArray(log)) log = [];
  const at = new Date().toISOString();
  entries.forEach((e) => log.unshift(Object.assign({ at }, e)));
  await C.writeKey(C.AGENTLOG_KEY, log.slice(0, LOG_CAP));
}
function logEntry(tool, actor, reason, detail) {
  return Object.assign({ tool, actor: actor || 'claude', reason: String(reason || '').trim() }, detail);
}
function requireReason(args, tool) {
  const r = String(args.reason == null ? '' : args.reason).trim();
  if (!r) throw new Error("'reason' is required for " + tool + " — say what the change is for, it goes in the calendar change log.");
  return r;
}
function requireDay(v, field) {
  const d = C.parseYmd(v);
  if (!d) throw new Error("'" + (field || 'date') + "' must be a date like 2026-09-17.");
  return C.ymd(d);
}
function pickSection(data, dayKey, wanted) {
  const secs = sectionsFor(data, dayKey);
  if (!secs.length) {
    throw new Error('The week of ' + dayKey + ' has no sections yet — open the planner once for that week, then try again.');
  }
  if (!wanted) return secs[0];
  const hit = secs.find((s) => norm(s.name) === norm(wanted));
  if (!hit) throw new Error('No section named "' + wanted + '" that week. Sections: ' + secs.map((s) => s.name).join(', ') + '.');
  return hit;
}
function checkRev(data, cellKey, expectRev) {
  if (!expectRev) return;
  const now = revOf(data.secfree[cellKey] || '');
  if (now !== expectRev) {
    throw new Error('That day changed since you read it (cell_rev ' + expectRev + ' → ' + now + '). Re-read the day and try again.');
  }
}

/* =========================================================================
   Reads
   ========================================================================= */
async function getDay(args) {
  const dayKey = requireDay(args.date, 'date');
  const data = await C.loadAll();
  const secs = sectionsFor(data, dayKey);
  const routines = routineTexts(data, dayKey);
  const items = dayItems(data, dayKey, args.section).map((it) => {
    const p = publicItem(it);
    if (p.kind === 'task' && routines[norm(it.text)]) p.routine = true;
    return p;
  });
  const tasks = items.filter((i) => i.kind === 'task');
  return {
    date: dayKey,
    weekday: C.dowName(dayKey),
    sections: secs.map((s) => ({ name: s.name, id: s.id, cell_rev: revOf(data.secfree[dayKey + '::' + s.id] || '') })),
    counts: {
      tasks: tasks.length,
      open_tasks: tasks.filter((t) => !t.completed && !t.routine).length,
      completed_tasks: tasks.filter((t) => t.completed).length,
      routines: tasks.filter((t) => t.routine).length,
      timed: items.filter((i) => i.kind === 'timed').length,
    },
    items,
  };
}

async function getWeek(args) {
  const start = args.start_date ? requireDay(args.start_date, 'start_date') : C.ymd(C.mondayOf(new Date()));
  const mondayKey = C.ymd(C.mondayOf(C.parseYmd(start)));
  const data = await C.loadAll();
  const routines = routineTexts(data, mondayKey);
  const days = C.weekDates(mondayKey).map((d) => {
    const dayKey = C.ymd(d);
    const items = dayItems(data, dayKey).map((it) => {
      const p = publicItem(it);
      if (p.kind === 'task' && routines[norm(it.text)]) p.routine = true;
      return p;
    });
    const tasks = items.filter((i) => i.kind === 'task');
    return {
      date: dayKey,
      weekday: C.dowName(dayKey),
      counts: {
        open_tasks: tasks.filter((t) => !t.completed && !t.routine).length,
        completed_tasks: tasks.filter((t) => t.completed).length,
        routines: tasks.filter((t) => t.routine).length,
        timed: items.filter((i) => i.kind === 'timed').length,
      },
      items,
    };
  });
  return {
    week_of: mondayKey,
    sections: (data.sections[mondayKey] || []).map((s) => ({ name: s.name, id: s.id })),
    days,
  };
}

async function getChangeLog(args) {
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
  let log = [];
  try { log = (await C.readKey(C.AGENTLOG_KEY)) || []; } catch (_) { log = []; }
  if (!Array.isArray(log)) log = [];
  const since = args.since ? String(args.since) : '';
  const rows = log.filter((e) => !since || String(e.at || '') >= since).slice(0, limit);
  return { entries: rows.length, changes: rows };
}

/* =========================================================================
   Writes
   ========================================================================= */
async function createTask(args) {
  const reason = requireReason(args, 'create_task');
  const dayKey = requireDay(args.date, 'date');
  const text = String(args.text || '').trim();
  if (!text) throw new Error("'text' is required.");
  if (leadingTime(text) != null) {
    throw new Error('That text starts with a time — use create_timed_event so it is stored as a red/bold timed item.');
  }
  const data = await C.loadAll();
  const sec = pickSection(data, dayKey, args.section);
  const cellKey = dayKey + '::' + sec.id;
  checkRev(data, cellKey, args.expect_cell_rev);

  const heading = String(args.heading || '').trim();
  if (args.skip_if_duplicate !== false) {
    const dup = dayItems(data, dayKey).find((it) => it.kind === 'task' && norm(it.text) === norm(text));
    if (dup) {
      return { created: false, skipped: 'duplicate', existing: publicItem(dup), message: '"' + text + '" is already on ' + dayKey + '.' };
    }
  }
  const id = newItemId();
  const block = buildTaskBlock(text, id, false);
  data.secfree[cellKey] = insertIntoCell(data.secfree[cellKey], dayKey, sec, block, heading);
  await C.writeKey(C.SECFREE_KEY, data.secfree);
  await appendLog([logEntry('create_task', args.actor, reason, {
    date: dayKey, section: sec.name, heading: heading || null, item_id: id,
    before: null, after: text,
  })]);
  return { created: true, task_id: 'i:' + id, date: dayKey, section: sec.name, heading: heading || null, text };
}

async function createTimedEvent(args) {
  const reason = requireReason(args, 'create_timed_event');
  const dayKey = requireDay(args.date, 'date');
  const text = String(args.text || '').trim();
  const time = String(args.time || '').trim();
  if (!text) throw new Error("'text' is required.");
  if (!time || leadingTime(time) == null) {
    throw new Error("'time' must read like 9am, 9:30am, 14:30 or 9:00am - 10:30am.");
  }
  const label = time + ' - ' + text;
  const data = await C.loadAll();
  const sec = pickSection(data, dayKey, args.section);
  const cellKey = dayKey + '::' + sec.id;
  checkRev(data, cellKey, args.expect_cell_rev);
  const heading = String(args.heading || '').trim();
  const dup = dayItems(data, dayKey).find((it) => it.kind === 'timed' && norm(it.text) === norm(label));
  if (dup && args.skip_if_duplicate !== false) {
    return { created: false, skipped: 'duplicate', existing: publicItem(dup) };
  }
  const id = newItemId();
  const block = buildTimedBlock(label, id);
  data.secfree[cellKey] = insertIntoCell(data.secfree[cellKey], dayKey, sec, block, heading);
  await C.writeKey(C.SECFREE_KEY, data.secfree);
  await appendLog([logEntry('create_timed_event', args.actor, reason, {
    date: dayKey, section: sec.name, heading: heading || null, item_id: id, before: null, after: label,
  })]);
  return { created: true, task_id: 'i:' + id, date: dayKey, section: sec.name, text: label, style: { bold: true, color: 'red' } };
}

/* Move one item to another day (and optionally another section), keeping the
   heading it sat under when the target day has or can have one. */
async function moveTask(args) {
  const reason = requireReason(args, 'move_task');
  const toDay = requireDay(args.new_date, 'new_date');
  const data = await C.loadAll();
  const it = resolveRef(data, args.task_id);
  checkRev(data, it.date + '::' + it.section_id, args.expect_cell_rev);
  if (it.kind === 'heading') throw new Error('That is a heading, not a task — headings are not moved by this tool.');
  if (it.completed && args.force !== true) {
    throw new Error('"' + it.text + '" is already completed, and completed work stays on the day it was done. Pass force:true only if you really mean to move it.');
  }
  const toSec = pickSection(data, toDay, args.new_section || (it.date === toDay ? it.section : it.section));
  if (toDay === it.date && toSec.id === it.section_id) {
    return { moved: false, reason_skipped: 'already there', task_id: it.ref };
  }
  const dup = dayItems(data, toDay).find((x) => x.kind === it.kind && norm(x.text) === norm(it.text));
  if (dup && args.skip_if_duplicate !== false) {
    return { moved: false, skipped: 'duplicate', existing: publicItem(dup), message: '"' + it.text + '" is already on ' + toDay + '.' };
  }
  // Stamp on the way out, so the item keeps one identity from here on.
  const stamped = stamp(it.block, it.item_id || newItemId());
  const fromCell = it.date + '::' + it.section_id;
  data.secfree[fromCell] = splice(data.secfree[fromCell] || '', it.start, it.end, '');
  const toCell = toDay + '::' + toSec.id;
  data.secfree[toCell] = insertIntoCell(data.secfree[toCell], toDay, toSec, stamped.block, it.heading || '');
  await C.writeKey(C.SECFREE_KEY, data.secfree);
  await appendLog([logEntry('move_task', args.actor, reason, {
    item_id: stamped.id, text: it.text, kind: it.kind,
    before: { date: it.date, section: it.section, heading: it.heading },
    after: { date: toDay, section: toSec.name, heading: it.heading },
  })]);
  return {
    moved: true, task_id: stamped.id ? 'i:' + stamped.id : it.ref, text: it.text,
    from: { date: it.date, section: it.section }, to: { date: toDay, section: toSec.name, heading: it.heading },
  };
}

async function setCompletion(args, wantDone, toolName) {
  const reason = requireReason(args, toolName);
  const data = await C.loadAll();
  const it = resolveRef(data, args.task_id);
  checkRev(data, it.date + '::' + it.section_id, args.expect_cell_rev);
  if (it.kind === 'heading') throw new Error('That is a heading — the planner strikes a heading through on its own once every task under it is ticked.');
  if (it.completed === wantDone) {
    return { changed: false, task_id: it.ref, text: it.text, completed: it.completed, message: 'Already ' + (wantDone ? 'completed' : 'open') + '.' };
  }
  let block = it.block;
  const isTodo = isTodoBlock(block);
  if (!isTodo) {
    if (args.convert_to_task !== true) {
      throw new Error('"' + it.text + '" is a plain line, not a checkbox task, so it has no completion state. ' +
        'Pass convert_to_task:true to turn it into a ticked task, or leave it as it is.');
    }
    const id = it.item_id || newItemId();
    block = buildTaskBlock(it.text, id, wantDone);
  } else {
    const tag = outerTag(block);
    let cls = classesOf(block).filter((c) => c !== 'is-checked');
    if (wantDone) cls.push('is-checked');
    let newTag = /\bclass="/i.test(tag)
      ? tag.replace(/\bclass="[^"]*"/i, 'class="' + cls.join(' ') + '"')
      : tag.replace(/^<div\b/i, '<div class="' + cls.join(' ') + '"');
    block = block.replace(tag, newTag);
    if (/<input[^>]*pc-todo-box/i.test(block)) {
      block = wantDone
        ? block.replace(/(<input[^>]*pc-todo-box[^>]*?)(\s*\/?>)/i, (m0, a, b) => (/checked/i.test(a) ? m0 : a + ' checked' + b))
        : block.replace(/(<input[^>]*pc-todo-box[^>]*?)\s+checked(?:="[^"]*")?/i, '$1');
    } else {
      // A pc-todo row typed without its input: give it one so the tick shows.
      block = block.replace(/(<div\b[^>]*>)/i, '$1<input type="checkbox" class="pc-todo-box" contenteditable="false"' + (wantDone ? ' checked' : '') + '>');
    }
    const st = stamp(block, it.item_id || newItemId());
    block = st.block;
  }
  const cellKey = it.date + '::' + it.section_id;
  data.secfree[cellKey] = splice(data.secfree[cellKey] || '', it.start, it.end, block);
  await C.writeKey(C.SECFREE_KEY, data.secfree);
  const id = itemIdOn(block);
  await appendLog([logEntry(toolName, args.actor, reason, {
    date: it.date, section: it.section, item_id: id, text: it.text,
    before: { completed: it.completed }, after: { completed: wantDone },
  })]);
  return { changed: true, task_id: id ? 'i:' + id : it.ref, date: it.date, text: it.text, completed: wantDone };
}
const completeTask = (a) => setCompletion(a, true, 'complete_task');
const uncompleteTask = (a) => setCompletion(a, false, 'uncomplete_task');

async function deleteTask(args) {
  const reason = requireReason(args, 'delete_task');
  const data = await C.loadAll();
  const it = resolveRef(data, args.task_id);
  checkRev(data, it.date + '::' + it.section_id, args.expect_cell_rev);
  if (it.kind === 'heading' && args.force !== true) {
    throw new Error('That is a heading ("' + it.text + '"). Deleting it would orphan the tasks under it — pass force:true if you really mean to.');
  }
  const cellKey = it.date + '::' + it.section_id;
  data.secfree[cellKey] = splice(data.secfree[cellKey] || '', it.start, it.end, '');
  await C.writeKey(C.SECFREE_KEY, data.secfree);
  await appendLog([logEntry('delete_task', args.actor, reason, {
    date: it.date, section: it.section, heading: it.heading, item_id: it.item_id,
    kind: it.kind, before: it.text, after: null,
  })]);
  return { deleted: true, date: it.date, section: it.section, text: it.text, kind: it.kind };
}

/* Give every addressable line a permanent id, without changing how the
   calendar looks. Safe to run repeatedly. */
async function normaliseWeek(args) {
  const start = args.start_date ? requireDay(args.start_date, 'start_date') : C.ymd(C.mondayOf(new Date()));
  const mondayKey = C.ymd(C.mondayOf(C.parseYmd(start)));
  const dry = args.dry_run !== false;
  const data = await C.loadAll();
  const secs = data.sections[mondayKey] || [];
  let stampedCount = 0, unstampable = 0;
  const touched = [];
  C.weekDates(mondayKey).forEach((d) => {
    const dayKey = C.ymd(d);
    secs.forEach((sec) => {
      const cellKey = dayKey + '::' + sec.id;
      let html = data.secfree[cellKey];
      if (!html) return;
      // Late to early, so earlier offsets stay valid as we rewrite.
      const items = classifyCell(html, dayKey, sec).filter((it) => !it.item_id).reverse();
      items.forEach((it) => {
        const st = stamp(it.block, newItemId());
        if (!st.id) { unstampable++; return; }
        html = splice(html, it.start, it.end, st.block);
        stampedCount++;
        touched.push({ date: dayKey, section: sec.name, text: it.text, item_id: st.id });
      });
      if (!dry) data.secfree[cellKey] = html;
    });
  });
  if (!dry && stampedCount) {
    await C.writeKey(C.SECFREE_KEY, data.secfree);
    await appendLog([logEntry('normalise_week', args.actor, String(args.reason || 'stamp permanent item ids'), {
      week_of: mondayKey, before: null, after: stampedCount + ' items given permanent ids',
    })]);
  }
  return {
    week_of: mondayKey, dry_run: dry, stamped: stampedCount,
    unstampable_lines: unstampable, items: touched.slice(0, 100),
    note: 'Invisible in the planner: only a data-item-id attribute is added.',
  };
}

/* ── rollover ───────────────────────────────────────────────────────── */
function rolloverPlanFor(data, dayKey, toDay, routines, sectionName) {
  const move = [], held = [];
  const targetTexts = {};
  dayItems(data, toDay).forEach((it) => { targetTexts[norm(it.text)] = it; });
  dayItems(data, dayKey, sectionName).forEach((it) => {
    const why = (r) => held.push({ task_id: it.ref, text: it.text, kind: it.kind, held_because: r });
    if (it.kind === 'heading' || it.kind === 'note') return;                  // structure/notes stay
    if (it.completed) { why('completed — completed work stays on the day it was done'); return; }
    if (it.kind === 'timed') { why('timed event — a past commitment is history, not outstanding work'); return; }
    if (it.routine || routines[norm(it.text)]) { why('recurring routine — routines do not roll forward'); return; }
    if (targetTexts[norm(it.text)]) { why('already on ' + toDay + ' — not duplicated'); return; }
    move.push(it);
    targetTexts[norm(it.text)] = it;      // so two identical lines don't both land
  });
  return { move, held };
}

async function rolloverIncompleteTasks(args) {
  const reason = requireReason(args, 'rollover_incomplete_tasks');
  const fromDay = requireDay(args.date, 'date');
  const toDay = args.to_date ? requireDay(args.to_date, 'to_date') : C.addDays(fromDay, 1);
  if (toDay <= fromDay) throw new Error("'to_date' must be after 'date' — work rolls forward, never back.");
  const dry = args.dry_run === true;
  const data = await C.loadAll();
  const routines = routineTexts(data, fromDay);
  const plan = rolloverPlanFor(data, fromDay, toDay, routines, args.section);
  const moved = [];
  if (!dry) {
    // Late offsets first: removing a line must not shift the ones still to go.
    const ordered = plan.move.slice().sort((a, b) => (a.date === b.date ? b.start - a.start : 0));
    for (const it of ordered) {
      const toSec = pickSection(data, toDay, args.to_section || it.section);
      const stamped = stamp(it.block, it.item_id || newItemId());
      const fromCell = it.date + '::' + it.section_id;
      data.secfree[fromCell] = splice(data.secfree[fromCell] || '', it.start, it.end, '');
      const toCell = toDay + '::' + toSec.id;
      data.secfree[toCell] = insertIntoCell(data.secfree[toCell], toDay, toSec, stamped.block, it.heading || '');
      moved.push({ item_id: stamped.id, text: it.text, heading: it.heading, from: it.date, to: toDay, section: toSec.name });
    }
    if (moved.length) {
      await C.writeKey(C.SECFREE_KEY, data.secfree);
      await appendLog(moved.map((m) => logEntry('rollover_incomplete_tasks', args.actor, reason, {
        item_id: m.item_id, text: m.text,
        before: { date: m.from, heading: m.heading }, after: { date: m.to, section: m.section, heading: m.heading },
      })));
    }
  }
  return {
    dry_run: dry, from: fromDay, to: toDay,
    rolled: dry ? plan.move.length : moved.length,
    would_roll: dry ? plan.move.map((it) => ({ task_id: it.ref, text: it.text, heading: it.heading, section: it.section })) : undefined,
    moved: dry ? undefined : moved,
    held_back: plan.held,
  };
}

/* Overdue cleanup: every past day in a window, rolled onto one target day.
   Defaults to a dry run, because it touches several days at once. */
async function rolloverOverdueTasks(args) {
  const reason = requireReason(args, 'rollover_overdue_tasks');
  const through = requireDay(args.through_date, 'through_date');
  const toDay = args.to_date ? requireDay(args.to_date, 'to_date') : C.addDays(through, 1);
  const lookback = Math.max(1, Math.min(60, Number(args.lookback_days) || 14));
  if (toDay <= through) throw new Error("'to_date' must be after 'through_date'.");
  const dry = args.dry_run !== false;
  const data = await C.loadAll();

  const days = [];
  for (let i = lookback; i >= 0; i--) {
    const d = C.addDays(through, -i);
    if (d && d <= through) days.push(d);
  }
  const perDay = [];
  const moved = [];
  for (const dayKey of days) {
    if (!sectionsFor(data, dayKey).length) continue;
    const routines = routineTexts(data, dayKey);
    const plan = rolloverPlanFor(data, dayKey, toDay, routines, args.section);
    if (!plan.move.length && !plan.held.length) continue;
    perDay.push({
      date: dayKey, weekday: C.dowName(dayKey),
      would_roll: plan.move.map((it) => ({ task_id: it.ref, text: it.text, heading: it.heading, section: it.section })),
      held_back: plan.held.length,
    });
    if (dry) continue;
    const ordered = plan.move.slice().sort((a, b) => b.start - a.start);
    for (const it of ordered) {
      const toSec = pickSection(data, toDay, args.to_section || it.section);
      const stamped = stamp(it.block, it.item_id || newItemId());
      const fromCell = it.date + '::' + it.section_id;
      data.secfree[fromCell] = splice(data.secfree[fromCell] || '', it.start, it.end, '');
      const toCell = toDay + '::' + toSec.id;
      data.secfree[toCell] = insertIntoCell(data.secfree[toCell], toDay, toSec, stamped.block, it.heading || '');
      moved.push({ item_id: stamped.id, text: it.text, heading: it.heading, from: it.date, to: toDay, section: toSec.name });
    }
  }
  if (!dry && moved.length) {
    await C.writeKey(C.SECFREE_KEY, data.secfree);
    await appendLog(moved.map((m) => logEntry('rollover_overdue_tasks', args.actor, reason, {
      item_id: m.item_id, text: m.text,
      before: { date: m.from, heading: m.heading }, after: { date: m.to, section: m.section, heading: m.heading },
    })));
  }
  return {
    dry_run: dry, window: { from: days[0] || through, through }, to: toDay,
    days_with_overdue_work: perDay.length,
    total: dry ? perDay.reduce((n, d) => n + d.would_roll.length, 0) : moved.length,
    by_day: perDay, moved: dry ? undefined : moved,
    note: dry ? 'Nothing was written. Re-run with dry_run:false to apply.' : undefined,
  };
}

/* =========================================================================
   optimise_week — advisory only, never writes
   ========================================================================= */
const REVENUE_RE = /\b(revenue|sales|sell|proposal|pitch|lead|leads|prospect|outreach|quote|invoice|pricing|upsell|close|deal|retainer|new client|discovery call|funnel|offer)\b/i;
const RETENTION_RE = /\b(client|retention|renewal|report|reporting|check ?in|review call|onboard|onboarding|qbr|account|campaign|ads?|email marketing|flows?|performance)\b/i;
const DECISION_RE = /\b(decide|decision|approve|approval|sign|choose|strategy|strategic|plan|planning|hire|hiring|budget|positioning|roadmap|review and)\b/i;
const DELEGATE_RE = /\b(upload|format|resize|export|schedule|scheduling|post|posting|data entry|admin|chase|follow up|collect|tidy|rename|screenshot|copy paste|send report)\b/i;
const AUTOMATE_RE = /\b(daily|weekly|every day|recurring|sync|reminder|report|export|backup|repetitive|check inbox|update sheet)\b/i;
const LOW_VALUE_RE = /\b(scroll|browse|tidy|misc|random|maybe|someday|look into|research a bit)\b/i;

function goalTokens(ctx) {
  const words = {};
  const add = (s) => norm(s).split(' ').forEach((w) => { if (w.length > 3) words[w] = true; });
  ctx.goals.forEach((g) => { add(g.title); add(g.detail); add(g.area); add(g.pillar); });
  (ctx.priorities.milestones || []).forEach((m) => add(m.name));
  (ctx.priorities.quarter_themes || []).forEach((t) => add(t.theme));
  (ctx.priorities.pillars || []).forEach((p) => { add(p.name); add(p.description); });
  return words;
}
function alignedGoals(text, ctx) {
  const t = norm(text);
  const hits = [];
  ctx.goals.forEach((g) => {
    const key = norm(g.title).split(' ').filter((w) => w.length > 3);
    const area = norm(g.area).split(' ').filter((w) => w.length > 3);
    const pillar = norm(g.pillar).split(' ').filter((w) => w.length > 3);
    const overlap = key.concat(area, pillar).filter((w) => t.indexOf(w) !== -1);
    if (overlap.length) hits.push({ goal: g.title, tier: g.tier, matched_on: overlap.slice(0, 4) });
  });
  return hits;
}
function scoreItem(it, ctx, tokens) {
  const t = it.text;
  let score = 0;
  const why = [];
  const goals = alignedGoals(t, ctx);
  if (goals.length) {
    score += 3 + Math.min(2, goals.length);
    why.push('matches ' + goals.map((g) => '"' + g.goal + '"').join(', '));
  }
  if (REVENUE_RE.test(t)) { score += 4; why.push('revenue generating'); }
  if (RETENTION_RE.test(t)) { score += 3; why.push('client retention / growth'); }
  if (DECISION_RE.test(t)) { score += 2; why.push('needs your decision'); }
  if (norm(t).split(' ').some((w) => tokens[w])) { score += 1; why.push('on-theme with current priorities'); }
  if (DELEGATE_RE.test(t)) { score -= 2; why.push('mechanical — someone else could do it'); }
  if (AUTOMATE_RE.test(t)) { score -= 1; why.push('repeats — a candidate for automation'); }
  if (LOW_VALUE_RE.test(t)) { score -= 3; why.push('vague / low value as written'); }
  return { score, why, goals };
}
// A recurring cadence beats a mechanical verb: "weekly report export" is
// something to automate, not something to hand to a person every week.
const CADENCE_RE = /\b(daily|weekly|monthly|every day|every week|recurring|sync|backup)\b/i;
function triage(it, s) {
  if (CADENCE_RE.test(it.text) && AUTOMATE_RE.test(it.text) && s.score < 6) return 'automate';
  if (DELEGATE_RE.test(it.text) && s.score < 6) return 'delegate';
  if (AUTOMATE_RE.test(it.text) && s.score < 5) return 'automate';
  if (LOW_VALUE_RE.test(it.text) || s.score <= -2) return 'remove';
  if (s.score <= 1 && !s.goals.length) return 'defer';
  return 'keep';
}

async function optimiseWeek(args) {
  const start = args.start_date ? requireDay(args.start_date, 'start_date') : C.ymd(C.mondayOf(new Date()));
  const mondayKey = C.ymd(C.mondayOf(C.parseYmd(start)));
  const cap = Math.max(1, Math.min(30, Number(args.max_tasks_per_day) || DEFAULT_MAX_TASKS_PER_DAY));

  // Goals first, always: the week is judged against them, never in a vacuum.
  let ctx = null, goalsError = null;
  try { ctx = await fetchGoalContext({}); }
  catch (e) { goalsError = e; }
  if (!ctx) {
    const supplied = goalContextFromArg(args.goals, args.priorities);
    if (!supplied) {
      const err = new Error((goalsError && goalsError.message) ||
        'I could not read your current goals, so I will not guess at them.');
      err.code = (goalsError && goalsError.code) || 'goals_unavailable';
      throw err;
    }
    ctx = supplied;
  }
  const tokens = goalTokens(ctx);

  const data = await C.loadAll();
  const routines = routineTexts(data, mondayKey);
  const today = C.ymd(new Date());

  const loadByDay = [], high = [], low = [], delegate = [], automate = [], defer = [], remove = [], warnings = [];
  C.weekDates(mondayKey).forEach((d) => {
    const dayKey = C.ymd(d);
    const items = dayItems(data, dayKey);
    const tasks = items.filter((it) => it.kind === 'task' && !(it.routine || routines[norm(it.text)]));
    const open = tasks.filter((it) => !it.completed);
    const timed = items.filter((it) => it.kind === 'timed');
    loadByDay.push({
      date: dayKey, weekday: C.dowName(dayKey), past: dayKey < today,
      substantive_open_tasks: open.length,
      completed_tasks: tasks.filter((t) => t.completed).length,
      routines_excluded: items.filter((it) => it.kind === 'task' && (it.routine || routines[norm(it.text)])).length,
      timed_commitments_excluded: timed.length,
      over_soft_cap: open.length > cap,
    });
    if (open.length > cap && dayKey >= today) {
      warnings.push({
        date: dayKey, weekday: C.dowName(dayKey), open_tasks: open.length, soft_cap: cap,
        note: open.length + ' substantive tasks against a soft cap of ' + cap + ' (plus ' + timed.length +
              ' timed commitments). Worth a look — not automatically a task to move.',
      });
    }
    open.forEach((it) => {
      const s = scoreItem(it, ctx, tokens);
      const row = {
        task_id: it.ref, date: dayKey, heading: it.heading, text: it.text,
        score: s.score, why: s.why, goals: s.goals.map((g) => g.goal),
      };
      if (s.score >= 5) high.push(row); else if (s.score <= 1) low.push(row);
      const t = triage(it, s);
      if (t === 'delegate') delegate.push(row);
      else if (t === 'automate') automate.push(row);
      else if (t === 'defer') defer.push(row);
      else if (t === 'remove') remove.push(row);
    });
  });
  high.sort((a, b) => b.score - a.score);
  low.sort((a, b) => a.score - b.score);

  // Proposed moves: only overdue work and the lowest-value item on days that
  // are over the soft cap, and only onto lighter days later in the week. These
  // are suggestions for Matthew to approve — this tool writes nothing.
  const futureLoad = loadByDay.filter((d) => d.date >= today);
  const lightest = futureLoad.slice().sort((a, b) => a.substantive_open_tasks - b.substantive_open_tasks);
  const proposed = [];
  loadByDay.filter((d) => d.date < today).forEach((d) => {
    const n = d.substantive_open_tasks;
    if (n) proposed.push({ kind: 'overdue', from: d.date, to: today, items: n, how: 'rollover_overdue_tasks(through_date:"' + C.addDays(today, -1) + '")', why: n + ' unfinished task(s) stranded on ' + C.dowName(d.date) + '.' });
  });
  warnings.forEach((w) => {
    const target = lightest.find((d) => d.date > w.date && d.substantive_open_tasks + 1 <= cap);
    const candidates = low.filter((r) => r.date === w.date).slice(0, Math.max(1, w.open_tasks - cap));
    candidates.forEach((cand) => {
      proposed.push({
        kind: 'rebalance', task_id: cand.task_id, text: cand.text, from: w.date,
        to: target ? target.date : null,
        how: target ? 'move_task(task_id, new_date:"' + target.date + '")' : 'needs a decision — every later day is at or over the cap',
        why: 'Lowest goal alignment on an overloaded day' + (target ? ('; ' + C.dowName(target.date) + ' has room.') : '.'),
      });
    });
  });

  return {
    week_of: mondayKey,
    advisory: true,
    wrote_nothing: true,
    goals_source: ctx.source,
    goals: ctx.goals.map((g) => ({ title: g.title, tier: g.tier, area: g.area, target: g.target, current: g.current, status: g.status })),
    priorities: ctx.priorities,
    soft_cap_per_day: cap,
    load_by_day: loadByDay,
    high_value: high.slice(0, 20),
    low_value: low.slice(0, 20),
    delegate_candidates: delegate.slice(0, 15),
    automate_candidates: automate.slice(0, 15),
    defer_candidates: defer.slice(0, 15),
    remove_candidates: remove.slice(0, 15),
    overload_warnings: warnings,
    proposed_moves: proposed,
    reasoning: [
      'Read your current goals and priorities first, then judged the week against them — not against free space.',
      'Weighted revenue generation highest, then client retention and growth, then decisions that need you.',
      'Routines and timed commitments are excluded from the load count; the ' + cap + '-task cap is a soft warning, not a rule.',
      'Nothing was changed. Approve what you want and I will apply it with move_task / delete_task / rollover tools, each one logged.',
    ],
  };
}

module.exports = {
  // reads
  getDay, getWeek, getChangeLog,
  // writes
  createTask, createTimedEvent, moveTask, completeTask, uncompleteTask, deleteTask,
  rolloverIncompleteTasks, rolloverOverdueTasks, normaliseWeek,
  // advisory
  optimiseWeek,
  // internals worth testing
  _internal: {
    classifyCell, leadingTime, allLeaves, norm, hash8, revOf, splice, stamp, itemIdOn,
    buildTaskBlock, buildTimedBlock, buildHeadingBlock, headingStyleFor, insertIntoCell,
    rolloverPlanFor, scoreItem, triage, resolveRef, newItemId, isTodoBlock,
  },
};
