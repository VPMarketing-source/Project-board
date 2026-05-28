/* =========================================================================
   Project Clarity — Supabase cross-device sync
   Include AFTER the CLIENT_DATA script block in every client HTML:

     <script>window.CLIENT_DATA = { id: 'mlc', ... };</script>
     <script src="../shared/sync.js"></script>

   This intercepts localStorage.setItem from the moment it loads so every
   pc-ops::<client>::* write mirrors up to Supabase, then reads remote state
   on page load so a fresh tab paints with the latest data. Storage keys
   are isolated per client via CLIENT_DATA.id — never share data across
   clients.

   Adding the Supabase CDN tag yourself is NOT required: this file loads
   it dynamically.
   ========================================================================= */
(function bootPlannerSync() {
  const C = window.CLIENT_DATA;
  if (!C || !C.id) {
    console.warn('[sync] window.CLIENT_DATA.id missing — sync disabled.');
    return;
  }

  const CLIENT_ID     = C.id;
  const SUPABASE_URL  = 'https://rqlrpxxkskqxpjgiqyql.supabase.co';
  const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbHJweHhrc2txeHBqZ2lxeXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5Mjc3OTYsImV4cCI6MjA5NTUwMzc5Nn0.RG7fzJxp_SoSMNxHlkfLgrAx7ycupmt0jEDm3q9XHBE';
  const TABLE         = 'planner_state';
  const MIGRATED_KEY  = '__planner_supabase_migrated::' + CLIENT_ID;
  const DEBOUNCE_MS   = 300;
  const SYNC_KEY_RE   = /^(pc-ops::|__keep::)/;

  window.__planner = { CLIENT_ID, status: 'init', pending: 0 };

  // ---- 1. Intercept localStorage.setItem to mirror to Supabase -------
  const origSetItem = Storage.prototype.setItem;
  const origRemoveItem = Storage.prototype.removeItem;
  const pendingUpserts = new Map();
  const recentlyWritten = new Map();
  let debounceTimer = null;

  Storage.prototype.setItem = function (key, value) {
    origSetItem.call(this, key, value);
    if (this === window.localStorage && typeof key === 'string' && SYNC_KEY_RE.test(key)) {
      queueUpsert(key, value);
    }
  };
  Storage.prototype.removeItem = function (key) {
    origRemoveItem.call(this, key);
    if (this === window.localStorage && typeof key === 'string' && SYNC_KEY_RE.test(key)) {
      queueUpsert(key, null);
    }
  };

  function queueUpsert(key, value) {
    pendingUpserts.set(key, value);
    window.__planner.pending = pendingUpserts.size;
    updateIndicator();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushUpserts, DEBOUNCE_MS);
  }

  // ---- 2. Load Supabase CDN dynamically ------------------------------
  let client = null;
  let realtimeChannel = null;

  function loadSupabase() {
    return new Promise((resolve) => {
      if (window.supabase && window.supabase.createClient) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = () => resolve();
      s.onerror = () => resolve(); // fail soft — sync will stay 'offline'
      (document.head || document.documentElement).appendChild(s);
    });
  }

  // ---- 3. Push pending writes ----------------------------------------
  async function flushUpserts() {
    if (!client || pendingUpserts.size === 0) return;
    const rows = [];
    const deletes = [];
    pendingUpserts.forEach((val, key) => {
      if (val === null) deletes.push(key);
      else rows.push({ client_id: CLIENT_ID, key, value: { raw: val }, updated_at: new Date().toISOString() });
      recentlyWritten.set(key, Date.now());
    });
    pendingUpserts.clear();
    window.__planner.pending = 0;
    window.__planner.status = 'syncing';
    updateIndicator();
    try {
      if (rows.length) {
        const { error } = await client.from(TABLE).upsert(rows, { onConflict: 'client_id,key' });
        if (error) throw error;
      }
      if (deletes.length) {
        const { error } = await client.from(TABLE).delete().eq('client_id', CLIENT_ID).in('key', deletes);
        if (error) throw error;
      }
      window.__planner.status = 'synced';
      window.__planner.lastSynced = Date.now();
    } catch (e) {
      rows.forEach((r) => pendingUpserts.set(r.key, r.value.raw));
      deletes.forEach((k) => pendingUpserts.set(k, null));
      window.__planner.pending = pendingUpserts.size;
      window.__planner.status = 'offline';
      setTimeout(flushUpserts, 5000);
    }
    updateIndicator();
  }

  // ---- 4. Seed from Supabase on page load ----------------------------
  async function seed() {
    if (!client) return;
    try {
      const { data, error } = await client
        .from(TABLE)
        .select('key,value,updated_at')
        .eq('client_id', CLIENT_ID);
      if (error) throw error;

      const remoteKeys = new Set();
      let anyChanged = false;
      (data || []).forEach((row) => {
        remoteKeys.add(row.key);
        const remoteStr = (row.value && typeof row.value === 'object' && 'raw' in row.value)
          ? row.value.raw
          : (typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
        if (remoteStr == null) return;
        const localStr = window.localStorage.getItem(row.key);
        if (localStr !== remoteStr) {
          anyChanged = true;
          origSetItem.call(window.localStorage, row.key, remoteStr);
          try {
            window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: remoteStr, oldValue: localStr }));
          } catch (_) {}
        }
      });

      // Migration: first time on a device with existing local data, push
      // every local planner key that Supabase doesn't have yet.
      const migrated = window.localStorage.getItem(MIGRATED_KEY) === '1';
      if (!migrated) {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (!k || !SYNC_KEY_RE.test(k)) continue;
          if (remoteKeys.has(k)) continue;
          const v = window.localStorage.getItem(k);
          if (v == null) continue;
          queueUpsert(k, v);
        }
        origSetItem.call(window.localStorage, MIGRATED_KEY, '1');
      }

      // Reload whenever remote differs from local so every widget repaints
      // from the synced state. Skip if the user is actively typing. Flag
      // the reload so per-page beforeunload flushers don't overwrite the
      // freshly-seeded localStorage with empty values from a not-yet-
      // rendered DOM.
      if (anyChanged &&
          !document.activeElement?.matches('input,textarea,[contenteditable="true"]')) {
        window.__plannerReloadingForSync = true;
        location.reload();
        return;
      }

      window.__planner.status = 'synced';
      updateIndicator();
    } catch (e) {
      window.__planner.status = 'offline';
      updateIndicator();
    }
  }

  // ---- 5. Realtime — apply remote changes to localStorage ------------
  function setupRealtime() {
    if (!client) return;
    realtimeChannel = client
      .channel('planner_state_' + CLIENT_ID)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: TABLE, filter: 'client_id=eq.' + CLIENT_ID },
          (payload) => {
            const row = payload.new || payload.old;
            if (!row || !row.key) return;
            const writtenAt = recentlyWritten.get(row.key);
            if (writtenAt && Date.now() - writtenAt < 3000) return;
            if (payload.eventType === 'DELETE') {
              if (window.localStorage.getItem(row.key) != null) {
                origRemoveItem.call(window.localStorage, row.key);
                try { window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: null })); } catch (_) {}
              }
              return;
            }
            const v = payload.new && payload.new.value;
            const remoteStr = (v && typeof v === 'object' && 'raw' in v)
              ? v.raw
              : (typeof v === 'string' ? v : JSON.stringify(v));
            if (remoteStr == null) return;
            const localStr = window.localStorage.getItem(row.key);
            if (localStr !== remoteStr) {
              origSetItem.call(window.localStorage, row.key, remoteStr);
              try {
                window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: remoteStr, oldValue: localStr }));
              } catch (_) {}
            }
          })
      .subscribe();
  }

  // ---- 6. Tiny sync indicator in the header --------------------------
  function ensureIndicator() {
    let el = document.getElementById('planner-sync-indicator');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'planner-sync-indicator';
    el.style.cssText = 'position:fixed;top:10px;right:14px;z-index:9999;font:500 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:0.04em;color:#5a5f6e;background:rgba(255,255,255,0.85);backdrop-filter:saturate(140%) blur(6px);padding:5px 10px;border:1px solid rgba(17,19,26,0.08);border-radius:999px;pointer-events:none;transition:opacity 180ms ease,color 180ms ease;';
    document.body.appendChild(el);
    return el;
  }
  function updateIndicator() {
    if (document.readyState === 'loading') return;
    const el = ensureIndicator();
    const s = window.__planner.status;
    const p = window.__planner.pending;
    if (s === 'syncing' || p > 0) {
      el.textContent = 'Syncing' + (p > 0 ? ' · ' + p : '') + '…';
      el.style.color = '#2960ff';
      el.style.opacity = '1';
    } else if (s === 'offline') {
      el.textContent = 'Offline' + (p > 0 ? ' · ' + p + ' pending' : '');
      el.style.color = '#c0392b';
      el.style.opacity = '1';
    } else if (s === 'synced') {
      el.textContent = 'Synced ✓';
      el.style.color = '#16a34a';
      el.style.opacity = '1';
      clearTimeout(el.__fade);
      el.__fade = setTimeout(() => { el.style.opacity = '0.4'; }, 1500);
    } else {
      el.textContent = 'Connecting…';
      el.style.color = '#6c6f7a';
      el.style.opacity = '1';
    }
  }
  document.addEventListener('DOMContentLoaded', updateIndicator);

  // ---- 7. Kick off ---------------------------------------------------
  (async () => {
    await loadSupabase();
    if (!window.supabase || !window.supabase.createClient) {
      window.__planner.status = 'offline';
      updateIndicator();
      return;
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    window.__planner.status = 'syncing';
    updateIndicator();
    await seed();
    setupRealtime();
    setInterval(flushUpserts, 5000);
  })();

  // Final flush on unload to catch any in-flight edits.
  window.addEventListener('beforeunload', () => {
    if (pendingUpserts.size > 0 && client) flushUpserts();
  });
})();
