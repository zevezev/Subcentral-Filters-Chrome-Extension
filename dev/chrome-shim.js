// Stands in for the Chrome extension APIs so background.js and content.js can run in a normal browser tab.
// Loaded by dev/preview-server.js before those two files; never shipped with the extension.
(() => {
  'use strict';

  // ---------- chrome.storage.local, kept in localStorage ----------
  const PREFIX = 'scjf-preview:';
  const read = k => { const v = localStorage.getItem(PREFIX + k); return v == null ? undefined : JSON.parse(v); };
  // background.js awaits a promise; content.js passes a callback
  const get = (keys, cb) => {
    const out = {};
    [].concat(keys).forEach(k => { const v = read(k); if (v !== undefined) out[k] = v; });
    if (cb) { setTimeout(() => cb(out)); return undefined; }
    return Promise.resolve(out);
  };
  const set = (obj, cb) => {
    Object.entries(obj).forEach(([k, v]) => localStorage.setItem(PREFIX + k, JSON.stringify(v)));
    if (cb) { setTimeout(cb); return undefined; }
    return Promise.resolve();
  };

  // ---------- notifications, shown as an in-page toast ----------
  function toast(title, message) {
    const el = document.createElement('div');
    el.textContent = `🔔 ${title} — ${message}`;
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#1a4073;color:#fff;padding:10px 14px;border-radius:6px;font:14px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  const tab = { id: 1, windowId: 1 };
  window.chrome = {
    storage: { local: { get, set } },
    runtime: {
      lastError: undefined,
      // background.js is a classic script, so its top-level handle() is a global
      sendMessage(msg, cb) {
        handle(msg, { tab }).then(r => cb && cb(r), e => cb && cb({ error: e.message }));
      },
    },
    notifications: {
      async create(id, opts) { console.log('[notification]', opts.title, '—', opts.message); toast(opts.title, opts.message); return id; },
      async getAll() { return {}; },
      async clear() { return true; },
    },
  };

  // ---------- Photon fallback ----------
  // If Photon can't be reached, answer for the schools on the sample saved page so the commute columns can still be checked.
  const SAMPLE_SCHOOLS = {
    'PS 71 FOREST Queens NY': ['P.S. 71Q - Forest Elementary School', '62-85 Forest Avenue', '11385', 40.71159, -73.904432],
    'PS 102 BAYVIEW Queens NY': ['P.S. / I.S. 102Q', '55-24 Van Horn Street', '11373', 40.733351, -73.877893],
    'PS 89 CYPRESS HILLS Brooklyn NY': ['P.S. 89 - Cypress Hills Community School', '265 Warwick Street', '11207', 40.677633, -73.886504],
    'PS 102 JACQUES CARTIER Manhattan NY': ['P.S. 102 - Jacques Cartier School', '315 East 113th Street', '10029', 40.79494, -73.938028],
    'PS 5 ELLEN LURIE Manhattan NY': ['P.S. 5 - Ellen Lurie School', '3703 10th Avenue', '10040', 40.859012, -73.922258],
    'PS 161 PEDRO ALBIZU CAMPOS Manhattan NY': ['P.S. / M.S. 161 - Don Pedro Albizu Campos School', '499 West 133rd Street', '10031', 40.81776, -73.952053],
    'PS 235 LENOX Brooklyn NY': ['P.S. 235 - Janice Marie Knight School', '525 Lenox Road', '11203', 40.65554, -73.941271],
    'PS 282 PARK SLOPE Brooklyn NY': ['P.S. 282 - Park Slope Elementary School', '180 6th Avenue', '11217', 40.676679, -73.977321],
    'JHS 88 PETER ROUGET Brooklyn NY': ['M.S. 88', '544 7th Avenue', '11215', 40.660605, -73.988595],
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://photon.komoot.io/')) return realFetch(url, opts);
    try {
      const res = await realFetch(url, opts);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      const q = new URL(String(url)).searchParams.get('q');
      const s = SAMPLE_SCHOOLS[q];
      if (!s) throw e;
      console.warn(`[preview] Photon unavailable (${e.message}); using sample location for "${q}"`);
      const [name, street, postcode, lat, lng] = s;
      const [housenumber, ...rest] = street.split(' ');
      const feature = {
        geometry: { coordinates: [lng, lat] },
        properties: { osm_type: 'S', osm_id: q, osm_value: 'school', name, housenumber, street: rest.join(' '), postcode, city: 'New York' },
      };
      return new Response(JSON.stringify({ features: [feature] }), { headers: { 'Content-Type': 'application/json' } });
    }
  };
})();
