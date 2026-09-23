/* =========================================================================
   Project Clarity — Horizon + Years tools for the calendar MCP

   The MCP could already read and write the week planner. These are the
   other two planning layers, so an agent can work the whole system:

     Week     execution    api/mcp.js — *_calendar_item
     Horizon  preparation  this file  — *_horizon_item
     Years    direction    this file  — *_year_goal / *_year_milestone

   Same Supabase rows the browser writes, same shapes, so anything written
   here renders in the planner exactly as if it had been typed in:

     pc-ops::vpm::horizon::v1      { id: item }   shared/horizon.js
     pc-ops::vpm::years::v1        { id: item }   shared/years.js
     pc-ops::vpm::years::meta::v1  { '2026': { theme } }

   Both boards are dicts keyed by item id, which is what makes this safe to
   write from a second place: sync.js merges per entry, so an agent adding
   one item never overwrites an item the browser is editing.

   Items written here are marked source: 'agent', so it stays visible which
   ones came from a person and which from Agent Board.

   The matching rule for edit/delete mirrors the week tools: exact title
   wins, otherwise a single containing match, and an ambiguous one refuses
   rather than guessing.
   ========================================================================= */

const CLIENT_ID = 'vpm';
const HORIZON_KEY    = 'pc-ops::' + CLIENT_ID + '::horizon::v1';
const YEARS_KEY      = 'pc-ops::' + CLIENT_ID + '::years::v1';
const YEARS_META_KEY = 'pc-ops::' + CLIENT_ID + '::years::meta::v1';

const MON_NICE = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW_NICE = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* ── Shapes, mirrored from the browser modules ───────────────────────── */
const HZ_TYPES = ['event', 'prep', 'client', 'business', 'personal'];
const HZ_TYPE_LABEL = {
  event: 'key date', prep: 'preparation', client: 'client milestone',
  business: 'business milestone', personal: 'personal / capacity',
};
const YR_CATS = ['business', 'personal'];
const YR_STATUS = ['planned', 'active', 'done', 'paused'];
const YR_METRICS = ['', 'currency', 'number', 'percent'];

/* ── Dates ───────────────────────────────────────────────────────────── */
function pad2(n) { return String(n).padStart(2, '0'); }
function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) ? d : null;
}
const isMonthKey = (s) => /^\d{4}-\d{2}$/.test(String(s || '').trim());
function monthKeyOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function niceDay(s) {
  const d = parseDate(s);
  return d ? DOW_NICE[d.getDay()] + ' ' + d.getDate() + ' ' + MON_NICE[d.getMonth()] + ' ' + d.getFullYear() : '';
}
function niceMonth(mk) {
  return isMonthKey(mk) ? MON_NICE[Number(mk.slice(5)) - 1] + ' ' + mk.slice(0, 4) : mk;
}
function addMonthKey(mk, n) {
  const d = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5)) - 1 + n, 1);
  return monthKeyOf(d);
}
function weeksBefore(dateStr, weeks) {
  const d = parseDate(dateStr);
  if (!d || !weeks) return '';
  d.setDate(d.getDate() - Math.round(weeks) * 7);
  return ymdOf(d);
}

/* ── Argument helpers ────────────────────────────────────────────────── */
function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function str(v) { return v == null ? '' : String(v).trim(); }
function oneOf(v, allowed, fallback) {
  const s = str(v).toLowerCase();
  return allowed.indexOf(s) >= 0 ? s : fallback;
}
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
function asDict(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

// Exact title wins; otherwise a single containing match. Anything else is
// refused with the candidates listed, so nothing is edited by guesswork.
function pickByTitle(list, wanted, what) {
  const want = wanted.toLowerCase();
  const matches = list.filter((i) => String(i.title || '').toLowerCase().indexOf(want) !== -1);
  const exact = matches.filter((i) => String(i.title || '').toLowerCase() === want);
  const pick = exact.length === 1 ? exact[0] : (matches.length === 1 ? matches[0] : null);
  if (pick) return pick;
  if (!matches.length) throw new Error('No ' + what + ' matches "' + wanted + '".');
  throw new Error(matches.length + ' ' + what + 's match "' + wanted + '" (' +
    matches.slice(0, 4).map((m) => '"' + m.title + '"').join(', ') + '). Give more of the title.');
}

/* ── Horizon items ───────────────────────────────────────────────────── */
function hzNormalise(raw, id) {
  const it = Object.assign({}, raw || {});
  it.id = it.id || id || newId('hz');
  it.title = str(it.title);
  it.type = oneOf(it.type, HZ_TYPES, 'event');
  it.date = parseDate(it.date) ? it.date : '';
  it.month = isMonthKey(it.month) ? it.month : (it.date ? it.date.slice(0, 7) : monthKeyOf(new Date()));
  it.prepWeeks = Number(it.prepWeeks) > 0 ? Number(it.prepWeeks) : null;
  it.prepStart = parseDate(it.prepStart) ? it.prepStart
    : (it.date && it.prepWeeks ? weeksBefore(it.date, it.prepWeeks) : '');
  it.client = str(it.client);
  it.notes = str(it.notes);
  it.checklist = Array.isArray(it.checklist)
    ? it.checklist.map((c) => (typeof c === 'string' ? { text: c, done: false }
        : { text: str(c && c.text), done: !!(c && c.done) })).filter((c) => c.text)
    : [];
  it.parentId = it.parentId || '';
  it.linkedGoal = it.linkedGoal || '';
  it.linkedProjects = asList(it.linkedProjects);
  it.source = it.source === 'manual' ? 'manual' : 'agent';
  it.createdAt = it.createdAt || new Date().toISOString();
  it.updatedAt = new Date().toISOString();
  return it;
}
async function hzLoad(io) { return asDict(await io.readKey(HORIZON_KEY).catch(() => null)); }
function hzList(all) {
  return Object.keys(all).map((id) => hzNormalise(all[id], id))
    .sort((a, b) => (a.month || '').localeCompare(b.month || '') || (a.date || '').localeCompare(b.date || ''));
}

/* ── Years items ─────────────────────────────────────────────────────── */
function yrNormalise(raw, id) {
  const it = Object.assign({}, raw || {});
  it.id = it.id || id || newId('yr');
  it.kind = it.kind === 'milestone' ? 'milestone' : 'goal';
  it.title = str(it.title);
  it.notes = str(it.notes);
  it.source = it.source === 'manual' ? 'manual' : 'agent';
  it.createdAt = it.createdAt || new Date().toISOString();
  it.updatedAt = new Date().toISOString();
  it.order = Number(it.order) || 0;

  if (it.kind === 'milestone') {
    it.date = parseDate(it.date) ? it.date : '';
    it.year = Number(it.year) || (it.date ? Number(it.date.slice(0, 4)) : new Date().getFullYear());
    it.month = it.date ? Number(it.date.slice(5, 7)) - 1
      : (Number.isInteger(it.month) && it.month >= 0 && it.month <= 11 ? it.month : null);
    it.goalId = it.goalId || '';
    it.horizonId = it.horizonId || '';
    // A milestone may be a plain one, so '' is allowed here.
    it.category = oneOf(it.category, YR_CATS, '');
    return it;
  }
  it.description = str(it.description);
  it.year = Number(it.year) || new Date().getFullYear();
  it.category = oneOf(it.category, YR_CATS, 'business');
  it.status = oneOf(it.status, YR_STATUS, 'planned');
  it.targetDate = parseDate(it.targetDate) ? it.targetDate : '';
  it.metricType = oneOf(it.metricType, YR_METRICS, '');
  it.currentValue = it.currentValue === 0 || it.currentValue ? String(it.currentValue) : '';
  it.targetValue = it.targetValue === 0 || it.targetValue ? String(it.targetValue) : '';
  it.linkedClients = asList(it.linkedClients);
  it.linkedProjects = asList(it.linkedProjects);
  it.linkedHorizon = asList(it.linkedHorizon);
  it.priority = oneOf(it.priority, ['high', 'normal', 'low'], 'normal');
  return it;
}
async function yrLoad(io) { return asDict(await io.readKey(YEARS_KEY).catch(() => null)); }
async function yrMeta(io) { return asDict(await io.readKey(YEARS_META_KEY).catch(() => null)); }
function yrList(all) { return Object.keys(all).map((id) => yrNormalise(all[id], id)); }

function fmtValue(v, metric) {
  if (v === '' || v == null || isNaN(Number(v))) return '';
  const n = Number(v);
  if (metric === 'percent') return n + '%';
  const short = Math.abs(n) >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'm'
    : Math.abs(n) >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k'
    : String(n);
  return (metric === 'currency' ? '$' : '') + short;
}

/* ── Rendering ───────────────────────────────────────────────────────── */
function renderHorizon(items, firstMonth, months) {
  const out = ['# Horizon: ' + niceMonth(firstMonth) + ' – ' + niceMonth(addMonthKey(firstMonth, months - 1))];
  for (let i = 0; i < months; i++) {
    const mk = addMonthKey(firstMonth, i);
    const mine = items.filter((it) => it.month === mk);
    out.push('\n## ' + niceMonth(mk));
    if (!mine.length) { out.push('(nothing)'); continue; }
    mine.forEach((it) => {
      out.push('- ' + it.title + '  [' + HZ_TYPE_LABEL[it.type] + ']' +
        (it.date ? '  ' + niceDay(it.date) : '') + (it.client ? '  (' + it.client + ')' : ''));
      if (it.prepStart && it.type !== 'prep') out.push('    start preparing ' + niceDay(it.prepStart));
      it.checklist.forEach((c) => out.push('    ' + (c.done ? '[x] ' : '[ ] ') + c.text));
      if (it.notes) out.push('    note: ' + it.notes);
    });
  }
  return out.join('\n');
}

function renderYears(items, meta, firstYear, years) {
  const thisYear = new Date().getFullYear();
  const out = ['# Years ' + firstYear + ' – ' + (firstYear + years - 1)];
  for (let i = 0; i < years; i++) {
    const y = firstYear + i;
    out.push('\n## ' + y + (y === thisYear ? '  (current year)' : ''));
    const theme = (meta[y] || meta[String(y)] || {}).theme;
    if (theme) out.push('Theme: ' + theme);

    YR_CATS.forEach((cat) => {
      const goals = items.filter((it) => it.kind === 'goal' && it.year === y && it.category === cat);
      if (!goals.length) return;
      out.push('\n' + cat.toUpperCase());
      goals.forEach((g) => {
        const target = fmtValue(g.targetValue, g.metricType);
        const current = fmtValue(g.currentValue, g.metricType);
        const bits = [];
        if (target) bits.push(current ? current + ' → ' + target : 'target ' + target);
        if (g.targetDate) bits.push(niceDay(g.targetDate));
        if (g.status !== 'planned') bits.push(g.status);
        if (g.linkedClients.length) bits.push(g.linkedClients.join(', '));
        out.push('- ' + g.title + (bits.length ? '  (' + bits.join(' · ') + ')' : ''));
      });
    });

    const ms = items.filter((it) => it.kind === 'milestone' && it.year === y)
      .sort((a, b) => ((a.month == null ? 99 : a.month) - (b.month == null ? 99 : b.month)) ||
                      String(a.date).localeCompare(String(b.date)));
    if (ms.length) {
      out.push('\nKey dates / milestones');
      ms.forEach((m) => out.push('- ' + (m.date ? niceDay(m.date) : (m.month == null ? 'date TBC' : MON_NICE[m.month] + ' ' + y)) +
        ' — ' + m.title + (m.category ? '  [' + m.category + ']' : '') + (m.notes ? '  — ' + m.notes : '')));
    }
    if (!theme && !items.some((it) => it.year === y)) out.push('(nothing set for this year)');
  }
  return out.join('\n');
}

/* ── Tools ───────────────────────────────────────────────────────────── */
const HZ_TYPE_DESC = "One of: 'event' (a fixed date), 'prep' (preparation), 'client', 'business', 'personal'. Default 'event'.";

const PLANNING_TOOLS = [
  {
    name: 'get_horizon',
    description: "Read the Horizon board — the next few months of significant things and what needs preparing for them. Use this before adding to Horizon so you can see what is already there.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First month to show, as YYYY-MM. Defaults to the current month.' },
        months: { type: 'number', description: 'How many months to show. Default 6.' },
      },
    },
  },
  {
    name: 'add_horizon_item',
    description: "Add something significant to the Horizon board — a key date, a client or business milestone, a preparation block, or a personal event that affects capacity. Not for ordinary tasks: those belong on the week planner (add_calendar_item). Give prep_weeks on a dated event and the planner shows when preparation has to start.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What it is, e.g. "Black Friday" or "Client launch".' },
        date: { type: 'string', description: 'The date it happens, as YYYY-MM-DD, when it has one.' },
        month: { type: 'string', description: 'Which month column it belongs in, as YYYY-MM. Taken from the date when omitted.' },
        type: { type: 'string', description: HZ_TYPE_DESC },
        prep_weeks: { type: 'number', description: 'How many weeks of preparation it needs before the date.' },
        client: { type: 'string', description: 'Client or category it belongs to.' },
        checklist: { type: 'array', items: { type: 'string' }, description: 'A few steps to show under it.' },
        notes: { type: 'string', description: 'Anything else worth keeping with it.' },
        supports_goal: { type: 'string', description: 'Title of the yearly goal in the Years view that this serves, if any.' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Projects this is delivered through.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'edit_horizon_item',
    description: "Change a Horizon item, found by its title. Only the fields you pass are changed; everything else, including its checklist, is left alone.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The current title (or a unique part of it).' },
        new_title: { type: 'string', description: 'What it should be called instead.' },
        date: { type: 'string', description: 'New date, as YYYY-MM-DD.' },
        month: { type: 'string', description: 'New month column, as YYYY-MM.' },
        type: { type: 'string', description: HZ_TYPE_DESC },
        prep_weeks: { type: 'number', description: 'New preparation lead time in weeks.' },
        client: { type: 'string', description: 'New client or category.' },
        checklist: { type: 'array', items: { type: 'string' }, description: 'Replaces the checklist.' },
        notes: { type: 'string', description: 'Replaces the notes.' },
        supports_goal: { type: 'string', description: 'Title of the yearly goal this serves.' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Replaces the project list.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'delete_horizon_item',
    description: "Remove one item from the Horizon board by its title. Refuses when the title matches several items.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The title of the item to remove (or a unique part of it).' } },
      required: ['title'],
    },
  },
  {
    name: 'get_years',
    description: "Read the Years board — the 1–3 year direction: each year's theme, its business and personal goals, and its key dates. Use this before adding to Years.",
    inputSchema: {
      type: 'object',
      properties: {
        from_year: { type: 'number', description: 'First year to show. Defaults to the current year.' },
        years: { type: 'number', description: 'How many years to show. Default 3.' },
      },
    },
  },
  {
    name: 'add_year_goal',
    description: "Add a goal to a year on the Years board. This layer is deliberately sparse — only outcomes big enough to set the direction of a whole year belong here, a handful per year. Anything smaller belongs in Horizon or on the week planner.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The outcome, e.g. "$50k/month revenue".' },
        year: { type: 'number', description: 'Which year it belongs to. Defaults to the current year.' },
        category: { type: 'string', description: "'business' or 'personal'. Default 'business'." },
        description: { type: 'string', description: 'One line of context.' },
        status: { type: 'string', description: "'planned', 'active', 'done' or 'paused'. Default 'planned'." },
        target_date: { type: 'string', description: 'A date it should be true by, as YYYY-MM-DD.' },
        metric: { type: 'string', description: "How it is measured: 'currency', 'number' or 'percent'. Leave out when it is not measurable." },
        current_value: { type: 'number', description: 'Where it is now — only with a metric.' },
        target_value: { type: 'number', description: 'Where it needs to get to — only with a metric.' },
        clients: { type: 'array', items: { type: 'string' }, description: 'Clients this goal relates to.' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Projects that deliver it.' },
        supported_by: { type: 'array', items: { type: 'string' }, description: 'Titles of Horizon items that support this goal.' },
        priority: { type: 'string', description: "'high', 'normal' or 'low'. Default 'normal'." },
        notes: { type: 'string', description: 'Anything else worth keeping with it.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_year_milestone',
    description: "Add a key date to a year on the Years board — the small dated rows under a year's goals, e.g. \"2XU Half Marathon\" or \"Q1 planning\". Keep these to the dates that genuinely matter at the scale of a year.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What it is.' },
        date: { type: 'string', description: 'When it is, as YYYY-MM-DD.' },
        year: { type: 'number', description: 'Which year, when there is no exact date yet.' },
        month: { type: 'number', description: 'Month number 1–12, when the day is not known yet.' },
        category: { type: 'string', description: "'business' or 'personal'. Leave out for a plain milestone." },
        supports_goal: { type: 'string', description: 'Title of the yearly goal this milestone serves.' },
        horizon_item: { type: 'string', description: 'Title of the Horizon item that prepares for it.' },
        notes: { type: 'string', description: 'A short line shown under the title.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'edit_year_item',
    description: "Change a goal or key date on the Years board, found by its title. Only the fields you pass are changed.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The current title (or a unique part of it).' },
        new_title: { type: 'string', description: 'What it should be called instead.' },
        year: { type: 'number', description: 'Move it to another year.' },
        category: { type: 'string', description: "'business' or 'personal'." },
        description: { type: 'string', description: 'Goals only: one line of context.' },
        status: { type: 'string', description: "Goals only: 'planned', 'active', 'done' or 'paused'." },
        target_date: { type: 'string', description: 'Goals only: a date it should be true by, as YYYY-MM-DD.' },
        date: { type: 'string', description: 'Key dates only: when it is, as YYYY-MM-DD.' },
        metric: { type: 'string', description: "Goals only: 'currency', 'number' or 'percent'." },
        current_value: { type: 'number', description: 'Goals only: where it is now — use this to report progress.' },
        target_value: { type: 'number', description: 'Goals only: where it needs to get to.' },
        clients: { type: 'array', items: { type: 'string' }, description: 'Goals only: replaces the client list.' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Goals only: replaces the project list.' },
        supported_by: { type: 'array', items: { type: 'string' }, description: 'Goals only: titles of Horizon items supporting it.' },
        supports_goal: { type: 'string', description: 'Key dates only: title of the yearly goal it serves.' },
        priority: { type: 'string', description: "Goals only: 'high', 'normal' or 'low'." },
        notes: { type: 'string', description: 'Replaces the notes.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'delete_year_item',
    description: "Remove a goal or key date from the Years board by its title. Refuses when the title matches several items.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title to remove (or a unique part of it).' },
        year: { type: 'number', description: 'Narrow the search to one year.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_year_theme',
    description: "Set (or clear) the one-line direction shown under a year on the Years board, e.g. \"Build foundations and scale delivery\".",
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Which year.' },
        theme: { type: 'string', description: 'The line to show. An empty string clears it.' },
      },
      required: ['year'],
    },
  },
];

/* ── Dispatch ────────────────────────────────────────────────────────── */
async function callPlanningTool(name, args, io) {
  /* ── Horizon ──────────────────────────────────────────────────────── */
  if (name === 'get_horizon') {
    const months = Math.max(1, Math.min(24, Number(args.months) || 6));
    const from = isMonthKey(args.from) ? args.from : monthKeyOf(new Date());
    return renderHorizon(hzList(await hzLoad(io)), from, months);
  }

  if (name === 'add_horizon_item') {
    const title = str(args.title);
    if (!title) throw new Error("'title' is required");
    if (args.date && !parseDate(args.date)) throw new Error("'date' must be a date like 2026-11-22");
    const all = await hzLoad(io);

    let linkedGoal = '';
    if (str(args.supports_goal)) {
      const goals = yrList(await yrLoad(io)).filter((i) => i.kind === 'goal');
      linkedGoal = pickByTitle(goals, str(args.supports_goal), 'yearly goal').id;
    }
    const it = hzNormalise({
      title,
      type: args.type,
      date: str(args.date),
      month: str(args.month),
      prepWeeks: args.prep_weeks,
      client: str(args.client),
      notes: str(args.notes),
      checklist: asList(args.checklist),
      linkedGoal,
      linkedProjects: asList(args.projects),
    });
    all[it.id] = it;
    await io.writeKey(HORIZON_KEY, all);
    return 'Added to Horizon under ' + niceMonth(it.month) + ': ' + it.title +
      (it.date ? ' (' + niceDay(it.date) + ')' : '') +
      (it.prepStart ? '\nPreparation starts ' + niceDay(it.prepStart) + '.' : '') +
      '\n\nIt will appear on the planner (it live-syncs).';
  }

  if (name === 'edit_horizon_item' || name === 'delete_horizon_item') {
    const all = await hzLoad(io);
    const pick = pickByTitle(hzList(all), str(args.title), 'Horizon item');
    if (name === 'delete_horizon_item') {
      delete all[pick.id];
      Object.keys(all).forEach((k) => { if (all[k] && all[k].parentId === pick.id) all[k].parentId = ''; });
      await io.writeKey(HORIZON_KEY, all);
      return 'Removed from Horizon: ' + pick.title + '\n\nThe planner live-syncs.';
    }
    const next = Object.assign({}, pick);
    if (str(args.new_title)) next.title = str(args.new_title);
    if (args.date !== undefined) {
      if (args.date && !parseDate(args.date)) throw new Error("'date' must be a date like 2026-11-22");
      next.date = str(args.date);
      if (next.date) next.month = next.date.slice(0, 7);
      // The lead time is what was agreed; the start date is derived from it,
      // so moving the event has to move the preparation with it.
      next.prepStart = '';
    }
    if (str(args.month)) next.month = str(args.month);
    if (args.type !== undefined) next.type = args.type;
    if (args.prep_weeks !== undefined) { next.prepWeeks = args.prep_weeks; next.prepStart = ''; }
    if (args.client !== undefined) next.client = str(args.client);
    if (args.notes !== undefined) next.notes = str(args.notes);
    if (args.checklist !== undefined) next.checklist = asList(args.checklist);
    if (args.projects !== undefined) next.linkedProjects = asList(args.projects);
    if (str(args.supports_goal)) {
      const goals = yrList(await yrLoad(io)).filter((i) => i.kind === 'goal');
      next.linkedGoal = pickByTitle(goals, str(args.supports_goal), 'yearly goal').id;
    }
    const saved = hzNormalise(next, pick.id);
    all[saved.id] = saved;
    await io.writeKey(HORIZON_KEY, all);
    return 'Updated on Horizon: ' + saved.title + ' (' + niceMonth(saved.month) + ')' +
      (saved.prepStart ? '\nPreparation starts ' + niceDay(saved.prepStart) + '.' : '') +
      '\n\nThe planner live-syncs.';
  }

  /* ── Years ────────────────────────────────────────────────────────── */
  if (name === 'get_years') {
    const years = Math.max(1, Math.min(10, Number(args.years) || 3));
    const from = Number(args.from_year) || new Date().getFullYear();
    return renderYears(yrList(await yrLoad(io)), await yrMeta(io), from, years);
  }

  if (name === 'add_year_goal' || name === 'add_year_milestone') {
    const title = str(args.title);
    if (!title) throw new Error("'title' is required");
    const all = await yrLoad(io);
    const isGoal = name === 'add_year_goal';

    if (isGoal) {
      let linkedHorizon = [];
      if (asList(args.supported_by).length) {
        const hz = hzList(await hzLoad(io));
        linkedHorizon = asList(args.supported_by).map((t) => pickByTitle(hz, t, 'Horizon item').id);
      }
      const g = yrNormalise({
        kind: 'goal', title,
        year: args.year, category: args.category, description: str(args.description),
        status: args.status, targetDate: str(args.target_date),
        metricType: args.metric, currentValue: args.current_value, targetValue: args.target_value,
        linkedClients: asList(args.clients), linkedProjects: asList(args.projects),
        linkedHorizon, priority: args.priority, notes: str(args.notes),
      });
      if (g.targetDate && !parseDate(g.targetDate)) throw new Error("'target_date' must be a date like 2026-11-22");
      all[g.id] = g;
      await io.writeKey(YEARS_KEY, all);
      return 'Added to ' + g.year + ' under ' + g.category + ': ' + g.title +
        '\n\nIt will appear on the planner (it live-syncs).';
    }

    if (args.date && !parseDate(args.date)) throw new Error("'date' must be a date like 2026-11-22");
    let goalId = '';
    if (str(args.supports_goal)) {
      goalId = pickByTitle(yrList(all).filter((i) => i.kind === 'goal'), str(args.supports_goal), 'yearly goal').id;
    }
    let horizonId = '';
    if (str(args.horizon_item)) {
      horizonId = pickByTitle(hzList(await hzLoad(io)), str(args.horizon_item), 'Horizon item').id;
    }
    const m = yrNormalise({
      kind: 'milestone', title,
      date: str(args.date),
      year: args.year,
      month: Number.isFinite(Number(args.month)) && args.month ? Number(args.month) - 1 : undefined,
      category: args.category, notes: str(args.notes), goalId, horizonId,
    });
    if (!m.date && m.month == null && !args.year) {
      throw new Error("Give a 'date' (YYYY-MM-DD), or a 'year' with an optional 'month' (1–12).");
    }
    all[m.id] = m;
    await io.writeKey(YEARS_KEY, all);
    return 'Added to ' + m.year + ' key dates: ' + m.title +
      (m.date ? ' — ' + niceDay(m.date) : (m.month == null ? ' (date TBC)' : ' — ' + MON_NICE[m.month] + ' ' + m.year)) +
      '\n\nIt will appear on the planner (it live-syncs).';
  }

  if (name === 'edit_year_item' || name === 'delete_year_item') {
    const all = await yrLoad(io);
    let list = yrList(all);
    if (Number(args.year)) list = list.filter((i) => i.year === Number(args.year));
    const pick = pickByTitle(list, str(args.title), 'Years item');

    if (name === 'delete_year_item') {
      delete all[pick.id];
      Object.keys(all).forEach((k) => { if (all[k] && all[k].goalId === pick.id) all[k].goalId = ''; });
      await io.writeKey(YEARS_KEY, all);
      return 'Removed from ' + pick.year + ': ' + pick.title + '\n\nThe planner live-syncs.';
    }

    const next = Object.assign({}, pick);
    if (str(args.new_title)) next.title = str(args.new_title);
    if (Number(args.year)) next.year = Number(args.year);
    if (args.category !== undefined) next.category = args.category;
    if (args.notes !== undefined) next.notes = str(args.notes);
    if (pick.kind === 'goal') {
      if (args.description !== undefined) next.description = str(args.description);
      if (args.status !== undefined) next.status = args.status;
      if (args.target_date !== undefined) next.targetDate = str(args.target_date);
      if (args.metric !== undefined) next.metricType = args.metric;
      if (args.current_value !== undefined) next.currentValue = args.current_value;
      if (args.target_value !== undefined) next.targetValue = args.target_value;
      if (args.clients !== undefined) next.linkedClients = asList(args.clients);
      if (args.projects !== undefined) next.linkedProjects = asList(args.projects);
      if (args.priority !== undefined) next.priority = args.priority;
      if (args.supported_by !== undefined) {
        const hz = hzList(await hzLoad(io));
        next.linkedHorizon = asList(args.supported_by).map((t) => pickByTitle(hz, t, 'Horizon item').id);
      }
    } else {
      if (args.date !== undefined) {
        if (args.date && !parseDate(args.date)) throw new Error("'date' must be a date like 2026-11-22");
        next.date = str(args.date);
        if (next.date) { next.year = Number(next.date.slice(0, 4)); next.month = Number(next.date.slice(5, 7)) - 1; }
      }
      if (str(args.supports_goal)) {
        next.goalId = pickByTitle(yrList(all).filter((i) => i.kind === 'goal'), str(args.supports_goal), 'yearly goal').id;
      }
    }
    const saved = yrNormalise(next, pick.id);
    all[saved.id] = saved;
    await io.writeKey(YEARS_KEY, all);
    return 'Updated in ' + saved.year + ': ' + saved.title + '\n\nThe planner live-syncs.';
  }

  if (name === 'set_year_theme') {
    const year = Number(args.year);
    if (!year) throw new Error("'year' is required, e.g. 2027");
    const meta = await yrMeta(io);
    const theme = str(args.theme);
    if (theme) meta[year] = Object.assign({}, meta[year], { theme });
    else if (meta[year]) delete meta[year].theme;
    await io.writeKey(YEARS_META_KEY, meta);
    return theme ? 'Set the ' + year + ' direction: ' + theme : 'Cleared the ' + year + ' direction.';
  }

  return null;     // not one of ours
}

module.exports = {
  PLANNING_TOOLS, callPlanningTool,
  HORIZON_KEY, YEARS_KEY, YEARS_META_KEY,
  hzNormalise, yrNormalise,        // exported for the tests
};
