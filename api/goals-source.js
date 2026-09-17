/* =========================================================================
   Project Clarity — goals + priorities source of truth

   optimise_week must optimise time against what Matthew is actually trying
   to achieve, so it reads his goals from Agent Board (the system that owns
   them) rather than being told them on every call:

     goals  →  priorities (milestones / quarter themes / pillars)  →  calendar

   Agent Board's goal tables are behind RLS (is_internal()), so the anon key
   cannot read them. This needs Agent Board's service key, supplied as
   environment variables on the deployment:

     AGENT_BOARD_URL          https://<ref>.supabase.co
     AGENT_BOARD_SERVICE_KEY  its service-role key

   When those are absent, or return nothing usable, we say so plainly. There
   is deliberately NO generic fallback: optimising a week against invented
   goals is worse than refusing.
   ========================================================================= */

const ENV_URL = ['AGENT_BOARD_URL', 'AGENT_BOARD_SUPABASE_URL'];
const ENV_KEY = ['AGENT_BOARD_SERVICE_KEY', 'AGENT_BOARD_SUPABASE_SERVICE_KEY', 'AGENT_BOARD_KEY'];

function pickEnv(names) {
  for (const n of names) { const v = process.env[n]; if (v && String(v).trim()) return String(v).trim(); }
  return '';
}
function config() {
  return { url: pickEnv(ENV_URL).replace(/\/+$/, ''), key: pickEnv(ENV_KEY) };
}

async function getJSON(url, key) {
  const r = await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error('Agent Board read ' + r.status + ' for ' + url.replace(/\?.*$/, ''));
  return r.json();
}

const OPEN_GOAL = "status=not.in.(done,abandoned,cancelled)";
const TIER_ORDER = { north_star: 0, primary: 1, outcome: 2, milestone: 3 };

function quarterOf(d) { return Math.floor(d.getMonth() / 3) + 1; }

/* Current goals and the priorities hanging off them. Throws a message worth
   showing the user when the source cannot be reached or is empty. */
async function fetchGoalContext(opts) {
  const o = opts || {};
  const { url, key } = config();
  if (!url || !key) {
    const e = new Error(
      'Cannot read your goals: Agent Board credentials are not configured for this deployment ' +
      '(set AGENT_BOARD_URL and AGENT_BOARD_SERVICE_KEY). Tell me your current goals and priorities ' +
      'and I can pass them in explicitly instead.');
    e.code = 'goals_unavailable';
    throw e;
  }
  const rest = url + '/rest/v1/';
  const now = o.now instanceof Date ? o.now : new Date();
  const q = quarterOf(now), y = now.getFullYear();

  const [goals, milestones, themes, pillars] = await Promise.all([
    getJSON(rest + 'goals?select=id,title,detail,area,tier,weight,status,target_type,target_value,current_value,unit,target_date,quarter,year,pillar_id,parent_goal_id&deleted_at=is.null&' + OPEN_GOAL, key),
    getJSON(rest + 'milestones?select=id,name,status,quarter,year,due_date,goal_id,pillar_id&deleted_at=is.null&' + OPEN_GOAL, key).catch(() => []),
    getJSON(rest + 'quarter_themes?select=*', key).catch(() => []),
    getJSON(rest + 'pillars?select=id,name,description,status', key).catch(() => []),
  ]);

  const usable = (goals || []).filter((g) => g && g.title);
  if (!usable.length) {
    const e = new Error(
      'Your goals source is reachable but holds no current goals, so there is nothing to optimise ' +
      'your week against. Set your goals in Agent Board, or tell me what they are and I can pass ' +
      'them in explicitly.');
    e.code = 'goals_empty';
    throw e;
  }

  usable.sort((a, b) => {
    const t = (TIER_ORDER[a.tier] == null ? 9 : TIER_ORDER[a.tier]) - (TIER_ORDER[b.tier] == null ? 9 : TIER_ORDER[b.tier]);
    return t || (Number(b.weight || 0) - Number(a.weight || 0));
  });

  const pillarName = {};
  (pillars || []).forEach((p) => { pillarName[p.id] = p.name; });

  return {
    source: 'agent_board',
    as_of: now.toISOString().slice(0, 10),
    quarter: 'Q' + q + ' ' + y,
    goals: usable.map((g) => ({
      id: g.id,
      title: g.title,
      detail: g.detail || '',
      area: g.area || '',
      tier: g.tier || '',
      weight: Number(g.weight || 0),
      status: g.status || '',
      pillar: pillarName[g.pillar_id] || '',
      target: g.target_value ? (g.target_value + (g.unit ? ' ' + g.unit : '')) : '',
      current: g.current_value ? (g.current_value + (g.unit ? ' ' + g.unit : '')) : '',
      target_date: g.target_date || '',
    })),
    priorities: {
      // This quarter first — that is what "current priorities" means.
      milestones: (milestones || [])
        .filter((m) => m && m.name)
        .map((m) => ({ name: m.name, status: m.status || '', due: m.due_date || '', current_quarter: (m.quarter === q && m.year === y) }))
        .sort((a, b) => (b.current_quarter ? 1 : 0) - (a.current_quarter ? 1 : 0)),
      quarter_themes: (themes || [])
        .filter((t) => t && (t.theme || t.title || t.name))
        .map((t) => ({ theme: t.theme || t.title || t.name, quarter: t.quarter, year: t.year })),
      pillars: (pillars || []).filter((p) => p && p.name && p.status !== 'archived')
        .map((p) => ({ name: p.name, description: p.description || '' })),
    },
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
