/* =========================================================================
   Project Clarity — automatic calendar backup

   A zero-dependency Vercel serverless function that snapshots the Personal
   planner (client_id 'vpm') into a dated backup row set, keeping the last
   KEEP days. Run daily by a Vercel Cron (see vercel.json). Also callable
   manually with ?k=<TOKEN> to force a backup on demand.

   One backup per calendar day: id `__backup-YYYY-MM-DD-vpm-auto`. Repeat
   calls on the same day are no-ops (so it's safe to hit publicly / by cron
   without a secret), unless ?k=<TOKEN> forces a re-snapshot.
   ========================================================================= */

const SUPABASE_URL = 'https://rqlrpxxkskqxpjgiqyql.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbHJweHhrc2txeHBqZ2lxeXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5Mjc3OTYsImV4cCI6MjA5NTUwMzc5Nn0.RG7fzJxp_SoSMNxHlkfLgrAx7ycupmt0jEDm3q9XHBE';
const SRC_CLIENT = 'vpm';
const KEEP = 14;
const TOKEN = 'vpm-cal-7f3a9c2e5b18d4';
const SUFFIX = '-vpm-auto';

function H(extra) { return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, extra || {}); }
const REST = SUPABASE_URL + '/rest/v1/planner_state';

async function getJSON(url) {
  const r = await fetch(url, { headers: H() });
  if (!r.ok) throw new Error('read ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  try {
    const force = req.query && (req.query.k === TOKEN || req.query.token === TOKEN);
    const today = new Date().toISOString().slice(0, 10);        // YYYY-MM-DD (UTC)
    const backupId = '__backup-' + today + SUFFIX;

    // Already backed up today? (idempotent / self-rate-limit)
    const existing = await getJSON(REST + '?select=key&client_id=eq.' + encodeURIComponent(backupId) + '&limit=1');
    if (existing.length && !force) {
      res.status(200).json({ ok: true, skipped: true, reason: 'already backed up today', backupId });
      return;
    }

    // Snapshot the source client's rows.
    const rows = await getJSON(REST + '?select=key,value&client_id=eq.' + encodeURIComponent(SRC_CLIENT));
    if (!rows.length) { res.status(200).json({ ok: false, reason: 'no source rows' }); return; }
    const now = new Date().toISOString();
    const out = rows.map((r) => ({ client_id: backupId, key: r.key, value: r.value, updated_at: now }));
    const w = await fetch(REST + '?on_conflict=client_id,key', {
      method: 'POST',
      headers: H({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify(out),
    });
    if (!w.ok) throw new Error('write ' + w.status);

    // Prune: keep the newest KEEP daily backups, delete older ones.
    const all = await getJSON(REST + '?select=client_id&client_id=like.' + encodeURIComponent('*' + SUFFIX));
    const ids = Array.from(new Set(all.map((r) => r.client_id))).sort();  // date-sorted by name
    const drop = ids.slice(0, Math.max(0, ids.length - KEEP));
    for (const id of drop) {
      await fetch(REST + '?client_id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: H() });
    }

    res.status(200).json({ ok: true, backupId, rows: out.length, kept: Math.min(ids.length, KEEP), pruned: drop.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
