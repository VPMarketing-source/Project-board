/* =========================================================================
   Project Clarity — goals + priorities source of truth

   optimise_week must optimise time against what Matthew is actually trying
   to achieve, so it reads his goals from Agent Board (the system that owns
   them) rather than being told them on every call:

     goals  →  priorities (milestones / quarter themes / pillars)  →  calendar

   HOW IT READS THEM
   -----------------
   Through Agent Board's own MCP server — <APP_URL>/api/mcp — calling its
   read tool `get_goals`. That server is OAuth, read-only by default, with
   access tokens that expire hourly and can be revoked from its Billing page.

   It is deliberately NOT read with Agent Board's Supabase service key. That
   key bypasses Row-Level Security on the whole Agent Board database — every
   client, invoice and stored credential — and by standing rule it never
   leaves Agent Board's own server. This file has no code path that would
   accept one.

     AGENT_BOARD_MCP_URL     https://<app>/api/mcp
     AGENT_BOARD_MCP_TOKEN   a read-scoped OAuth access token

   Until that is wired, optimise_week keeps today's behaviour: goals passed
   in explicitly by the caller, flagged `supplied_by_caller`. There is
   deliberately NO generic fallback — optimising a week against invented
   goals is worse than refusing.
   ========================================================================= */

const ENV_MCP_URL = ['AGENT_BOARD_MCP_URL'];
const ENV_MCP_TOKEN = ['AGENT_BOARD_MCP_TOKEN'];

function pickEnv(names) {
  for (const n of names) { const v = process.env[n]; if (v && String(v).trim()) return String(v).trim(); }
  return '';
}
function config() {
  return { url: pickEnv(ENV_MCP_URL).replace(/\/+$/, ''), token: pickEnv(ENV_MCP_TOKEN) };
}

/* One JSON-RPC tools/call against Agent Board's MCP. */
async function callAgentBoardTool(name, args) {
  const { url, token } = config();
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args || {} },
    }),
  });
  if (r.status === 401 || r.status === 403) {
    const e = new Error('Agent Board rejected the read (' + r.status + ') — the access token has expired ' +
      '(they last an hour) or was revoked. Refresh it, or tell me your goals and I will use those.');
    e.code = 'goals_unauthorised';
    throw e;
  }
  if (!r.ok) throw new Error('Agent Board MCP ' + r.status + ' calling ' + name);
  const body = await r.json();
  if (body && body.error) throw new Error('Agent Board MCP: ' + (body.error.message || 'error'));
  const result = body && body.result;
  if (!result) throw new Error('Agent Board MCP returned no result for ' + name);
  const text = (result.content || []).map((c) => c.text).filter(Boolean).join('\n');
  if (result.isError) throw new Error('Agent Board MCP: ' + text);
  try { return JSON.parse(text); } catch (_) { return text; }
}

const TIER_ORDER = { north_star: 0, primary: 1, outcome: 2, milestone: 3 };
function quarterOf(d) { return Math.floor(d.getMonth() / 3) + 1; }

/* Normalise whatever shape get_goals returns into the one optimise_week
   reads. It is tolerant on purpose: a field Agent Board renames should cost
   a detail in the output, not the whole analysis. */
function shapeGoals(payload) {
  const raw = Array.isArray(payload) ? payload
    : (payload && (payload.goals || payload.items || payload.data)) || [];
  return (Array.isArray(raw) ? raw : []).map((g) => (typeof g === 'string' ? { title: g } : g))
    .filter((g) => g && (g.title || g.name))
    .map((g) => ({
      title: g.title || g.name,
      detail: g.detail || g.description || '',
      area: g.area || '',
      tier: g.tier || '',
      weight: Number(g.weight || 0),
      status: g.status || '',
      pillar: g.pillar || (g.pillar_name || ''),
      target: g.target || (g.target_value ? g.target_value + (g.unit ? ' ' + g.unit : '') : ''),
      current: g.current || (g.current_value ? g.current_value + (g.unit ? ' ' + g.unit : '') : ''),
      target_date: g.target_date || '',
    }));
}
function shapePriorities(payload) {
  const p = (payload && (payload.priorities || payload)) || {};
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? { name: x } : x)).filter(Boolean);
  return {
    milestones: list(p.milestones).map((m) => ({ name: m.name || m.title, status: m.status || '', due: m.due_date || m.due || '' })).filter((m) => m.name),
    quarter_themes: list(p.quarter_themes || p.themes).map((t) => ({ theme: t.theme || t.name || t.title, quarter: t.quarter, year: t.year })).filter((t) => t.theme),
    pillars: list(p.pillars).map((x) => ({ name: x.name || x.title, description: x.description || '' })).filter((x) => x.name),
  };
}

/* Current goals and the priorities hanging off them. Throws a message worth
   showing the user when the source cannot be reached or is empty. */
async function fetchGoalContext(opts) {
  const o = opts || {};
  const { url, token } = config();
  if (!url || !token) {
    const e = new Error(
      "Cannot read your goals: Agent Board's MCP is not wired up for this deployment yet " +
      '(needs AGENT_BOARD_MCP_URL and a read-scoped AGENT_BOARD_MCP_TOKEN). Tell me your current ' +
      'goals and priorities and I can pass them in explicitly instead.');
    e.code = 'goals_unavailable';
    throw e;
  }
  const now = o.now instanceof Date ? o.now : new Date();
  const payload = await callAgentBoardTool('get_goals', o.args || {});
  const goals = shapeGoals(payload);
  if (!goals.length) {
    const e = new Error(
      'Your goals source is reachable but holds no current goals, so there is nothing to optimise ' +
      'your week against. Set your goals in Agent Board, or tell me what they are and I can pass ' +
      'them in explicitly.');
    e.code = 'goals_empty';
    throw e;
  }
  goals.sort((a, b) => {
    const t = (TIER_ORDER[a.tier] == null ? 9 : TIER_ORDER[a.tier]) - (TIER_ORDER[b.tier] == null ? 9 : TIER_ORDER[b.tier]);
    return t || (b.weight - a.weight);
  });
  return {
    source: 'agent_board_mcp',
    as_of: now.toISOString().slice(0, 10),
    quarter: 'Q' + quarterOf(now) + ' ' + now.getFullYear(),
    goals,
    priorities: shapePriorities(payload),
  };
}

/* Goals supplied by the caller (a voice conversation, or a deployment with no
   Agent Board credentials). Same shape, marked so the output is honest about
   where the goals came from. */
function goalContextFromArg(goals, priorities) {
  const list = (Array.isArray(goals) ? goals : String(goals || '').split('\n'))
    .map((g) => (typeof g === 'string' ? { title: g.trim() } : g))
    .filter((g) => g && g.title);
  if (!list.length) return null;
  return {
    source: 'supplied_by_caller',
    as_of: new Date().toISOString().slice(0, 10),
    goals: list.map((g) => ({
      title: g.title, detail: g.detail || '', area: g.area || '', tier: g.tier || '',
      weight: Number(g.weight || 0), status: g.status || '', pillar: '', target: '', current: '', target_date: '',
    })),
    priorities: {
      milestones: [], quarter_themes: [],
      pillars: (Array.isArray(priorities) ? priorities : String(priorities || '').split('\n'))
        .map((p) => String(p || '').trim()).filter(Boolean).map((p) => ({ name: p, description: '' })),
    },
  };
}

module.exports = { fetchGoalContext, goalContextFromArg, config };
