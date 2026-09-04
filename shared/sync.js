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

  // `unpaintedRemote` is true whenever a remote change has landed in
  // localStorage but the DOM has not been repainted from it yet. While it
  // is set, page-level "flush the whole DOM to localStorage" helpers MUST
  // bail out — otherwise they serialise the stale DOM straight over the
  // change that just arrived and push it back up, silently destroying an
  // edit made on another device.
  window.__planner = { CLIENT_ID, status: 'init', pending: 0, unpaintedRemote: false };

  // ---- 1. Intercept localStorage.setItem to mirror to Supabase -------
  const origSetItem = Storage.prototype.setItem;
  const origRemoveItem = Storage.prototype.removeItem;
  const pendingUpserts = new Map();
  const recentlyWritten = new Map();
  let debounceTimer = null;
  let repaintTimer = null;
  let unpaintedRemote = false;
  let repaintBlocked = false;

  // ---- 0. 3-way merge for dict-blob keys -----------------------------
  // The calendar keeps a whole week/board of content in ONE key (a JSON
  // object of {cellKey: html}). A plain last-write-wins upsert means any
  // save ships this tab's copy of EVERY entry — so if the tab is even
  // slightly behind on some other entry, the write reverts it. Instead,
  // for object-valued keys, we re-fetch the live server object at write
  // time and re-apply only the entries THIS tab actually changed since it
  // last synced (`baseline`). Entries the tab didn't touch keep the
  // server's value, so a stale tab can no longer clobber another device.
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  const baseline = Object.create(null);   // key -> parsed object last known to match the server
  function recordBaseline(key, str) {
    try { const v = JSON.parse(str); baseline[key] = isPlainObject(v) ? v : null; }
    catch (_) { baseline[key] = null; }
  }
  function threeWayMerge(base, local, remote) {
    const out = Object.assign(Object.create(null), remote);
    for (const k in local) { if (!eq(local[k], base ? base[k] : undefined)) out[k] = local[k]; }       // our edits/adds win
    if (base) for (const k in base) { if (!(k in local) && eq(remote[k], base[k])) delete out[k]; }    // our deletions
    let pulled = false;
    for (const k in out) { if (!eq(out[k], local[k])) { pulled = true; break; } }                      // server had newer entries
    return { merged: out, pulled };
  }
  async function fetchRemoteDict(key) {
    const { data, error } = await client.from(TABLE).select('value').eq('client_id', CLIENT_ID).eq('key', key).limit(1);
    if (error) throw error;
    if (!data || !data.length) return null;
    const v = data[0].value;
    const raw = (v && typeof v === 'object' && 'raw' in v) ? v.raw : (typeof v === 'string' ? v : JSON.stringify(v));
    if (raw == null) return null;
    try { const p = JSON.parse(raw); return isPlainObject(p) ? p : null; } catch (_) { return null; }
  }

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

  // ---- 1b. Repainting after a remote change --------------------------
  // Every widget on these pages renders itself from localStorage once at
  // boot, so writing a remote value into localStorage is not enough to
  // make it visible — the page has to re-render. There is no central
  // store to re-render from, so a reload is the only reliable repaint,
  // which is what seed() already does on first load.

  const EDITABLE_SEL = 'input,textarea,[contenteditable="true"]';

  function userIsEditing() {
    const a = document.activeElement;
    if (a && a.matches && a.matches(EDITABLE_SEL)) return true;
    // A collapsed caret still counts — the user may be mid-thought with
    // the window merely unfocused (alt-tabbed to copy something).
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.anchorNode) {
      const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      if (node && node.closest && node.closest('[contenteditable="true"]')) return true;
    }
    return false;
  }

  // Safety valve. An auto-reload driven by remote state could in principle
  // ping-pong (two devices each rewriting a key on boot would reload each
  // other forever). Cap it: after RELOAD_LIMIT sync reloads in RELOAD_WINDOW
  // we stop reloading and just tell the user to refresh. unpaintedRemote
  // stays set either way, so the DOM flushers remain disarmed and nothing
  // gets overwritten — the worst case is a stale view, never lost data.
  const RELOAD_LIMIT  = 3;
  const RELOAD_WINDOW = 60 * 1000;
  const RELOAD_LOG    = '__planner_sync_reloads::' + CLIENT_ID;

  function reloadBudgetLeft() {
    try {
      const now = Date.now();
      const log = JSON.parse(sessionStorage.getItem(RELOAD_LOG) || '[]')
        .filter((t) => now - t < RELOAD_WINDOW);
      if (log.length >= RELOAD_LIMIT) return false;
      log.push(now);
      sessionStorage.setItem(RELOAD_LOG, JSON.stringify(log));
      return true;
    } catch (_) {
      return true; // no sessionStorage — don't block the repaint
    }
  }

  // Reload once the user is idle. Retries rather than giving up, so the
  // repaint always lands eventually; until then unpaintedRemote stays set
  // and the page-level DOM flushers stay disarmed.
  function scheduleRepaint() {
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(function attempt() {
      if (userIsEditing()) {
        repaintTimer = setTimeout(attempt, 2000);
        return;
      }
      if (!reloadBudgetLeft()) {
        repaintBlocked = true;
        updateIndicator();
        return;
      }
      window.__plannerReloadingForSync = true;
      location.reload();
    }, 1200);
  }

  function markUnpainted() {
    unpaintedRemote = true;
    window.__planner.unpaintedRemote = true;
    updateIndicator();
    scheduleRepaint();
  }

  // Widgets paint themselves from localStorage the moment the DOM is ready,
  // which is BEFORE seed() has fetched the authoritative server copy. Any
  // write derived from the DOM in that window pushes possibly-stale content
  // over good server data. `seeded` marks the point where localStorage can
  // be trusted; widgets gate their saves on __planner.canPersist().
  //
  // It is deliberately fail-open: it flips true even when sync is offline or
  // Supabase never loads, so an unreachable network makes the board
  // local-only rather than read-only. Pages that don't load sync.js at all
  // have no window.__planner, and their own guards must default to allowing
  // writes for the same reason.
  function markSeeded() {
    window.__planner.seeded = true;
  }
  window.__planner.seeded = false;
  window.__planner.canPersist = function () {
    return window.__planner.seeded === true && unpaintedRemote === false && staleCheckPending === false;
  };

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
    const entries = [];
    pendingUpserts.forEach((val, key) => entries.push([key, val]));
    pendingUpserts.clear();
    window.__planner.pending = 0;
    window.__planner.status = 'syncing';
    updateIndicator();

    const rows = [];
    const deletes = [];
    let pulledAny = false;
    try {
      for (const [key, val] of entries) {
        if (val === null) { deletes.push(key); recentlyWritten.set(key, Date.now()); continue; }
        let outVal = val;
        // Object-valued keys with a known base → merge against the live
        // server copy so we only overwrite entries THIS tab changed.
        if (baseline[key] && isPlainObject(baseline[key])) {
          let local = null; try { local = JSON.parse(val); } catch (_) {}
          if (isPlainObject(local)) {
            const remote = await fetchRemoteDict(key);      // throws on network error → whole flush retries
            if (isPlainObject(remote)) {
              const { merged, pulled } = threeWayMerge(baseline[key], local, remote);
              outVal = JSON.stringify(merged);
              // Adopt the merge locally so our copy matches the server. (Uses
              // origSetItem so it doesn't re-queue itself.) Baseline is only
              // advanced on confirmed write, below.
              if (outVal !== val) origSetItem.call(window.localStorage, key, outVal);
              if (pulled) pulledAny = true;
            }
          }
        }
        rows.push({ client_id: CLIENT_ID, key, value: { raw: outVal }, updated_at: new Date().toISOString() });
        recentlyWritten.set(key, Date.now());
      }

      if (rows.length) {
        const { error } = await client.from(TABLE).upsert(rows, { onConflict: 'client_id,key' });
        if (error) throw error;
      }
      if (deletes.length) {
        const { error } = await client.from(TABLE).delete().eq('client_id', CLIENT_ID).in('key', deletes);
        if (error) throw error;
      }
      // Confirmed on the server → this is now our synced base.
      rows.forEach((r) => { try { const p = JSON.parse(r.value.raw); if (isPlainObject(p)) baseline[r.key] = p; } catch (_) {} });
      deletes.forEach((k) => { baseline[k] = null; });
      window.__planner.status = 'synced';
      window.__planner.lastSynced = Date.now();
      // A merge pulled another device's entries in → our DOM is stale for
      // them; refresh through the usual (idle-aware) repaint path.
      if (pulledAny) markUnpainted();
    } catch (e) {
      // Re-queue everything we took (unless a newer edit already replaced it)
      // so nothing is lost; retry shortly.
      entries.forEach(([key, val]) => { if (!pendingUpserts.has(key)) pendingUpserts.set(key, val); });
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
        recordBaseline(row.key, remoteStr);           // this server value is now our merge base
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

      window.__planner.status = 'synced';
      markSeeded();

      // Remote differed from local, so every widget is now showing stale
      // content. Hand off to markUnpainted rather than reloading inline:
      // it disarms the page-level DOM flushers immediately and waits for
      // the user to stop typing before reloading, instead of silently
      // skipping the repaint (and leaving the DOM stale) whenever the
      // caret happened to be in an editable. canPersist() stays false the
      // whole time via unpaintedRemote, so nothing can be written back
      // from the stale DOM even if the reload is deferred or capped.
      if (anyChanged) { markUnpainted(); return; }

      updateIndicator();
    } catch (e) {
      window.__planner.status = 'offline';
      markSeeded();
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
              baseline[row.key] = null;
              if (window.localStorage.getItem(row.key) != null) {
                origRemoveItem.call(window.localStorage, row.key);
                try { window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: null })); } catch (_) {}
                markUnpainted();
              }
              return;
            }
            const v = payload.new && payload.new.value;
            const remoteStr = (v && typeof v === 'object' && 'raw' in v)
              ? v.raw
              : (typeof v === 'string' ? v : JSON.stringify(v));
            if (remoteStr == null) return;
            recordBaseline(row.key, remoteStr);           // keep the merge base current
            const localStr = window.localStorage.getItem(row.key);
            if (localStr !== remoteStr) {
              origSetItem.call(window.localStorage, row.key, remoteStr);
              try {
                window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: remoteStr, oldValue: localStr }));
              } catch (_) {}
              markUnpainted();
            }
          })
      .subscribe();
  }

  // ---- 5b. Wake-up freshness check -----------------------------------
  // A tab that sleeps (laptop lid closed, backgrounded overnight) silently
  // loses the realtime socket and misses every change made elsewhere, yet
  // its seeded flag still says localStorage is trustworthy. The first
  // widget save after wake then pushes the whole stale copy over newer
  // server data (this destroyed real edits on 2026-08-30 and 2026-08-31).
  // Detect the sleep via a timer gap plus wake events, disarm canPersist()
  // while the authoritative rows are re-fetched, repaint through the usual
  // markUnpainted path if anything differs, and rebuild the socket.
  // Fail-open like seed(): a network error re-arms writes so an offline
  // board stays editable rather than read-only.
  let staleCheckPending = false;
  let lastAliveAt = Date.now();
  let lastRecheckAt = 0;
  const WAKE_GAP_MS = 45 * 1000;
  const RECHECK_MIN_GAP_MS = 30 * 1000; // don't hammer the API when offline

  setInterval(() => {
    // A gap means the tab's timers were suspended (sleep); a dead channel
    // means the socket died even though the tab stayed awake and focused —
    // both leave localStorage silently stale, so both trigger a recheck.
    const gap = Date.now() - lastAliveAt > WAKE_GAP_MS;
    const dead = window.__planner.seeded && realtimeDead() &&
                 Date.now() - lastRecheckAt > RECHECK_MIN_GAP_MS;
    if (gap || dead) recheckFreshness();
    lastAliveAt = Date.now();
  }, 10 * 1000);

  function realtimeDead() {
    return !realtimeChannel || realtimeChannel.state !== 'joined';
  }

  function maybeRecheck() {
    if (Date.now() - lastAliveAt > WAKE_GAP_MS || realtimeDead()) recheckFreshness();
  }

  async function recheckFreshness() {
    if (!client || staleCheckPending || !window.__planner.seeded) return;
    staleCheckPending = true;
    lastRecheckAt = Date.now();
    window.__planner.status = 'syncing';
    updateIndicator();
    try {
      const { data, error } = await client
        .from(TABLE)
        .select('key,value')
        .eq('client_id', CLIENT_ID);
      if (error) throw error;
      let anyChanged = false;
      (data || []).forEach((row) => {
        const v = row.value;
        const remoteStr = (v && typeof v === 'object' && 'raw' in v)
          ? v.raw
          : (typeof v === 'string' ? v : JSON.stringify(v));
        if (remoteStr == null) return;
        // Our own writes that haven't round-tripped yet stay authoritative.
        const writtenAt = recentlyWritten.get(row.key);
        if (writtenAt && Date.now() - writtenAt < 10000) return;
        if (pendingUpserts.has(row.key)) return;
        recordBaseline(row.key, remoteStr);           // refresh the merge base
        const localStr = window.localStorage.getItem(row.key);
        if (localStr !== remoteStr) {
          anyChanged = true;
          origSetItem.call(window.localStorage, row.key, remoteStr);
          try {
            window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: remoteStr, oldValue: localStr }));
          } catch (_) {}
        }
      });
      window.__planner.status = 'synced';
      if (anyChanged) markUnpainted();
    } catch (_) {
      window.__planner.status = 'offline';
    } finally {
      staleCheckPending = false;
      lastAliveAt = Date.now();
      updateIndicator();
    }
    // The socket rarely survives a sleep; rebuild it if it isn't joined.
    try {
      if (realtimeDead()) {
        if (realtimeChannel) { try { client.removeChannel(realtimeChannel); } catch (_) {} }
        setupRealtime();
      }
    } catch (_) {}
  }

  window.addEventListener('focus', maybeRecheck);
  window.addEventListener('online', () => recheckFreshness());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeRecheck();
  });

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
    if (unpaintedRemote) {
      el.textContent = repaintBlocked
        ? 'Updated elsewhere — refresh to see it'
        : 'Updated elsewhere — refreshing…';
      el.style.color = repaintBlocked ? '#b45309' : '#2960ff';
      el.style.opacity = '1';
      return;
    }
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
      markSeeded();
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

  // ---- 8. Final flush on unload --------------------------------------
  // The normal flushUpserts() path is async and issues a plain fetch, which
  // the browser cancels as the page goes away — so the last edits before a
  // tab close were being dropped, and the next load then pulled the older
  // remote copy back over them. keepalive lets the request outlive the
  // document. It caps the body at 64KB, so fall back to the ordinary path
  // for payloads above that.
  const KEEPALIVE_MAX = 60 * 1024;

  function flushOnUnload() {
    if (pendingUpserts.size === 0) return;
    const rows = [];
    const deletes = [];
    pendingUpserts.forEach((val, key) => {
      if (val === null) deletes.push(key);
      else rows.push({ client_id: CLIENT_ID, key, value: { raw: val }, updated_at: new Date().toISOString() });
    });

    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    };

    // Only drop a key from the queue once the write is confirmed. If the
    // page survives (a tab switch rather than a close) a failed request
    // therefore stays queued for the 5s retry instead of vanishing. Upserts
    // are idempotent, so an overlapping retry is harmless.
    if (rows.length) {
      const body = JSON.stringify(rows);
      if (body.length <= KEEPALIVE_MAX) {
        try {
          fetch(SUPABASE_URL + '/rest/v1/' + TABLE + '?on_conflict=client_id,key',
                { method: 'POST', headers, body, keepalive: true })
            .then((r) => { if (r.ok) rows.forEach((row) => pendingUpserts.delete(row.key)); })
            .catch(() => {});
        } catch (_) { if (client) flushUpserts(); }
      } else if (client) {
        // Too big for keepalive's 64KB cap — best-effort async flush.
        flushUpserts();
      }
    }

    if (deletes.length) {
      const list = '(' + deletes.map((k) => '"' + k.replace(/"/g, '\\"') + '"').join(',') + ')';
      try {
        fetch(SUPABASE_URL + '/rest/v1/' + TABLE +
              '?client_id=eq.' + encodeURIComponent(CLIENT_ID) +
              '&key=in.' + encodeURIComponent(list),
              { method: 'DELETE', headers, keepalive: true })
          .then((r) => { if (r.ok) deletes.forEach((k) => pendingUpserts.delete(k)); })
          .catch(() => {});
      } catch (_) {}
    }
  }

  window.addEventListener('pagehide', flushOnUnload);
  document.addEventListener('visibilitychange', () => {
    // Reliable on mobile, where beforeunload/pagehide often never fire.
    if (document.visibilityState === 'hidden') flushOnUnload();
  });
  window.addEventListener('beforeunload', flushOnUnload);
})();
