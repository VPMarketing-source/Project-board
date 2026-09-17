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

   Tools — the original text-addressed five:
     - get_calendar_week    read one week's sections x days as clean text
     - get_priorities       outstanding (unchecked) items across the next weeks
     - add_calendar_item    append a task/note to a specific day
     - delete_calendar_item remove a line from a day by its text
     - edit_calendar_item   change a line's text, keeping its checkbox state

   ...and the controlled tool layer (api/calendar-tools.js), which is what
   makes the calendar conversational — Matthew talks to Claude, Claude calls
   these, they drive the existing calendar:
     - get_day / get_week           structured items, each with a task_id
     - create_task                  a to-do, filed under its heading
     - create_timed_event           a red/bold timed commitment
     - move_task                    one item to another day, heading intact
     - complete_task / uncomplete_task   ticked in place, never moved
     - delete_task                  remove one item
     - rollover_incomplete_tasks    one day's unfinished work → the next day
     - rollover_overdue_tasks       sweep work stranded in past days
     - optimise_week                ADVISORY: reads his goals, never writes
     - get_calendar_change_log      what was changed, when, by whom and why
     - normalise_week               stamp permanent item ids (invisible)

   Every mutation takes a required `reason` and is logged. Reads are free.
   No new tables: the log is one more key under the same pc-ops:: prefix.

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

const CORE = require('./calendar-core.js');
const CT = require('./calendar-tools.js');

// The store, dates, HTML⇄text and styling helpers now live in
// api/calendar-core.js so the Reid/Claude tool layer shares them verbatim.
const {
  CLIENT_ID, SECTIONS_KEY, SECFREE_KEY, FREEFORM_KEY,
  readKey, writeKey, loadAll,
  ymd, parseYmd, mondayOf, weekDates, niceDate,
  htmlToText, splitBlocks,
  readStyle, styleClasses, styleClassesOn, withClasses, escapeHtml, buildBlock,
  collectMatches, chooseMatch,
} = CORE;

// Shared secret — the connector URL must include ?k=<TOKEN>. Not military
// grade (the underlying Supabase anon key is already public), just enough to
// keep the tidy MCP endpoint from being trivially discoverable/usable.
const TOKEN = 'vpm-cal-7f3a9c2e5b18d4';

const PROTOCOL_VERSION = '2025-06-18';

/* ── Calendar reads ─────────────────────────────────────────────────── */

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


/* ── Controlled calendar tools (api/calendar-tools.js) ────────────────
   The narrow, validated layer that makes the calendar conversational:

     Matthew  →  Claude  →  these tools  →  the existing calendar

   Claude calls them directly; Reid can call the same endpoint. Reads are
   free. Every write takes a required `reason`, is logged, and addresses one
   item by the task_id a read handed out. optimise_week never writes. */
const DAY_ARG = { type: 'string', description: 'A date as YYYY-MM-DD.' };
const REASON_ARG = { type: 'string', description: 'Why this change is being made, in a few words. Required — it is what the change log shows when Matthew asks what was changed and why.' };
const ACTOR_ARG = { type: 'string', description: 'Who asked for it: "claude" (default), "reid" or "matthew".' };
const REV_ARG = { type: 'string', description: "Optional: the cell_rev you read for that day's section. The write is refused if the day changed since — use it when acting on something you read a while ago." };

const CALENDAR_TOOLS = [
  {
    name: 'get_day',
    description: "Read one day of Matthew's planner as structured items. Each item comes back with a task_id (use it for every mutation), its kind (task / timed / heading / note), whether it is completed, whether it is a recurring routine, the heading it sits under and its styling. Start here before changing anything on a day.",
    inputSchema: {
      type: 'object',
      properties: { date: DAY_ARG, section: { type: 'string', description: 'Only this section (row) of the day, by name. All sections when omitted.' } },
      required: ['date'],
    },
  },
  {
    name: 'get_week',
    description: "Read a whole week as structured items, with per-day counts of open tasks, completed tasks, routines and timed commitments. Use this to talk through the week, spot overloaded days, and find task_ids. start_date can be any day in the week — it snaps to the Monday.",
    inputSchema: { type: 'object', properties: { start_date: { type: 'string', description: 'Any day in the week, YYYY-MM-DD. Defaults to this week.' } } },
  },
  {
    name: 'create_task',
    description: "Add a to-do (checkbox) to a day. Give `heading` to file it under a category or client heading — the heading is created with the right styling if the day lacks it (client and VP MARKETING headings green + bold, PERSONAL and WEDDING black + bold). Refuses text that starts with a time: that is create_timed_event. Skips silently if the same task is already on that day.",
    inputSchema: {
      type: 'object',
      properties: {
        date: DAY_ARG, text: { type: 'string', description: 'The task text.' },
        section: { type: 'string', description: "Section (row) name. Defaults to the week's first section." },
        heading: { type: 'string', description: 'The category/client heading it belongs under, e.g. "VP MARKETING", "PERSONAL".' },
        skip_if_duplicate: { type: 'boolean', description: 'Default true.' },
        reason: REASON_ARG, actor: ACTOR_ARG, expect_cell_rev: REV_ARG,
      },
      required: ['date', 'text', 'reason'],
    },
  },
  {
    name: 'create_timed_event',
    description: "Add a timed commitment to a day — stored red and bold, with no checkbox, as the planner styles timed items. The planner strikes it through by itself once the time has passed. Time reads like 9am, 9:30am, 14:30 or '9:00am - 10:30am'.",
    inputSchema: {
      type: 'object',
      properties: {
        date: DAY_ARG, time: { type: 'string', description: 'When, e.g. "3pm" or "9:00am - 10:30am".' },
        text: { type: 'string', description: 'What it is, e.g. "Call Marlene".' },
        section: { type: 'string', description: 'Section (row) name.' },
        heading: { type: 'string', description: 'Heading to file it under.' },
        reason: REASON_ARG, actor: ACTOR_ARG, expect_cell_rev: REV_ARG,
      },
      required: ['date', 'time', 'text', 'reason'],
    },
  },
  {
    name: 'move_task',
    description: "Move one item to another day, keeping the heading it sat under (creating that heading on the target day if needed). Refuses to move completed work — completed items stay on the day they were done — and skips the move if the same task is already on the target day.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'From get_day / get_week.' },
        new_date: DAY_ARG,
        new_section: { type: 'string', description: 'Section on the target day. Defaults to the same section name.' },
        force: { type: 'boolean', description: 'Move even a completed item. Only when Matthew explicitly asks.' },
        reason: REASON_ARG, actor: ACTOR_ARG, expect_cell_rev: REV_ARG,
      },
      required: ['task_id', 'new_date', 'reason'],
    },
  },
  {
    name: 'complete_task',
    description: "Tick a task off. It stays exactly where it is — the planner strikes it through. A plain (non-checkbox) line has no completion state; pass convert_to_task:true to turn it into a ticked task instead.",
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, convert_to_task: { type: 'boolean' }, reason: REASON_ARG, actor: ACTOR_ARG, expect_cell_rev: REV_ARG },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'uncomplete_task',
    description: 'Untick a task that was marked done by mistake. It stays where it is.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, reason: REASON_ARG, actor: ACTOR_ARG, expect_cell_rev: REV_ARG },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'delete_task',
    description: "Remove one item from the calendar. Use it when something is genuinely not happening — prefer move_task for work that still needs doing. Refuses to delete a heading unless forced.",
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, force: { type: 'boolean', description: 'Allow deleting a heading.' }, reason: REASON_ARG, actor: ACTOR_ARG, expect_cell_rev: REV_ARG },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'rollover_incomplete_tasks',
    description: "Roll one day's unfinished work onto the next day (or another day with to_date). Moves only open, non-routine, untimed tasks, keeping their heading. Completed work stays put, recurring routines do not roll, past timed events do not roll, and nothing is duplicated. Use dry_run:true to show Matthew the list first.",
    inputSchema: {
      type: 'object',
      properties: {
        date: DAY_ARG,
        to_date: { type: 'string', description: 'Where it lands. Defaults to the next day.' },
        section: { type: 'string', description: 'Only roll this section.' },
        to_section: { type: 'string', description: 'Land everything in this section instead of the one it came from.' },
        dry_run: { type: 'boolean', description: 'Default false. True lists what would move and writes nothing.' },
        reason: REASON_ARG, actor: ACTOR_ARG,
      },
      required: ['date', 'reason'],
    },
  },
  {
    name: 'rollover_overdue_tasks',
    description: "Clean up work stranded in the past: every day up to through_date (default 14 days back) is swept onto one target day. Same rules as rollover_incomplete_tasks. DEFAULTS TO A DRY RUN because it touches several days — show Matthew what it found, then re-run with dry_run:false.",
    inputSchema: {
      type: 'object',
      properties: {
        through_date: { type: 'string', description: 'The last past day to sweep, YYYY-MM-DD (usually yesterday).' },
        to_date: { type: 'string', description: 'Where it all lands. Defaults to the day after through_date.' },
        lookback_days: { type: 'number', description: 'How far back to look. Default 14, max 60.' },
        section: { type: 'string' }, to_section: { type: 'string' },
        dry_run: { type: 'boolean', description: 'Default TRUE. Pass false to actually move the work.' },
        reason: REASON_ARG, actor: ACTOR_ARG,
      },
      required: ['through_date', 'reason'],
    },
  },
  {
    name: 'optimise_week',
    description: "ADVISORY ONLY — it never changes the calendar. Reads Matthew's current goals and priorities first, then judges the week against them: load per day, goal alignment, high-value work (revenue generation, client retention/growth, decisions that need him), low-value work, delegate / automate / defer / remove candidates, overload warnings against a SOFT per-day cap, and proposed moves. Talk the recommendations through with him, then apply the ones he approves with move_task / delete_task / the rollover tools. Errors rather than guessing if his goals cannot be read.",
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Any day in the week. Defaults to this week.' },
        max_tasks_per_day: { type: 'number', description: 'Soft cap for the overload warning. Default 6. Routines and timed commitments are never counted.' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Only used when his goals cannot be read from Agent Board — e.g. he states them in conversation.' },
        priorities: { type: 'array', items: { type: 'string' }, description: 'Same: a fallback, not the normal path.' },
      },
    },
  },
  {
    name: 'get_calendar_change_log',
    description: "What was changed in the calendar, when, by whom and why — newest first. Answers \"what did you change in my calendar?\". Reads only.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Default 40, max 200.' }, since: { type: 'string', description: 'ISO timestamp — only changes at or after it.' } },
    },
  },
  {
    name: 'normalise_week',
    description: "Housekeeping: give every line in a week a permanent item id inside the existing HTML, so items keep their identity when lines are added or reordered above them. Invisible in the planner. Defaults to a dry run; pass dry_run:false to apply.",
    inputSchema: {
      type: 'object',
      properties: { start_date: { type: 'string' }, dry_run: { type: 'boolean', description: 'Default true.' }, reason: { type: 'string' }, actor: ACTOR_ARG },
    },
  },
];

const CALENDAR_TOOL_FNS = {
  get_day: CT.getDay,
  get_week: CT.getWeek,
  create_task: CT.createTask,
  create_timed_event: CT.createTimedEvent,
  move_task: CT.moveTask,
  complete_task: CT.completeTask,
  uncomplete_task: CT.uncompleteTask,
  delete_task: CT.deleteTask,
  rollover_incomplete_tasks: CT.rolloverIncompleteTasks,
  rollover_overdue_tasks: CT.rolloverOverdueTasks,
  optimise_week: CT.optimiseWeek,
  get_calendar_change_log: CT.getChangeLog,
  normalise_week: CT.normaliseWeek,
};

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

  if (Object.prototype.hasOwnProperty.call(CALENDAR_TOOL_FNS, name)) {
    const out = await CALENDAR_TOOL_FNS[name](args || {});
    return JSON.stringify(out, null, 2);
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
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS.concat(CALENDAR_TOOLS) });
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
