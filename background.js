// Commute lookups for the SubCentral Job Filter.
// Schools are found with Photon (OpenStreetMap); home address, bike and transit times come from Transitous.
'use strict';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const TRANSITOUS_URL = 'https://api.transitous.org/api';
const NYC_BBOX = '-74.259087,40.477398,-73.70018,40.91618'; // minLon,minLat,maxLon,maxLat
const NYC_CENTER = '40.71,-73.99';
const SAME_CAMPUS_M = 300; // results this close together count as one location
const MAX_HOME_KM = 80;
const MISS_RETRY_MS = 7 * 24 * 3600e3;
const MAX_BIKE_S = 7200; // Transitous drops direct trips longer than this (its default is only 30 minutes)
const settings = { retryDelayMs: 800, photonTimeoutMs: 10000, transitousTimeoutMs: 20000 };

// ---------- storage ----------
const store = {
  async get(key) { const v = await chrome.storage.local.get(key); return v ? v[key] : undefined; },
  set(key, val) { return chrome.storage.local.set({ [key]: val }); },
};
let cache = null, cacheLoading = null;
function loadCache() {
  // one shared load, so parallel lookups on a cold start all write into the same cache object
  if (!cacheLoading) cacheLoading = store.get('commuteCache').then(v => {
    cache = v || {};
    if (cache.version !== 2) cache = { version: 2 }; // older versions cached Google results
    cache.photon = cache.photon || {};
    cache.homes = cache.homes || {};
    cache.routes = cache.routes || {};
    return cache;
  });
  return cacheLoading;
}
const persistCache = () => store.set('commuteCache', cache);
const getCfg = async () => (await store.get('commuteCfg')) || { home: '' };

// ---------- helpers ----------
function distM(a, b) {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return Infinity;
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Which borough an address is in, from its ZIP code (or the borough name).
function boroughFromAddress(addr) {
  const a = addr || '';
  const m = /\b(\d{5})\b/.exec(a);
  if (m) {
    const p = m[1].slice(0, 3);
    if (['100', '101', '102'].includes(p)) return 'Manhattan';
    if (p === '103') return 'Staten Island';
    if (p === '104') return 'Bronx';
    if (p === '112') return 'Brooklyn';
    if (['110', '111', '113', '114', '116'].includes(p)) return 'Queens';
  }
  const w = /\b(Brooklyn|Bronx|Staten Island|Manhattan|Queens)\b/i.exec(a);
  return w ? w[1].replace(/^./, c => c.toUpperCase()) : null;
}

// RFC 3339 time (UTC) for "next weekday at HH:MM New York time" -- transit needs a future time.
function nyParts(date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false });
  const o = {};
  f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
}
function nyToUtc(y, m, d, hh, mm) {
  for (const off of [4, 5]) { // EDT, EST
    const t = new Date(Date.UTC(y, m - 1, d, hh + off, mm));
    const p = nyParts(t);
    if (p.h === hh && p.d === d) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm));
}
function nextWeekdayArrival(hhmm, now = new Date()) {
  const [hh, mm] = (hhmm || '08:00').split(':').map(Number);
  const today = nyParts(now);
  for (let k = 0; k < 10; k++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + k, 12));
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const t = nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
    if (t.getTime() > now.getTime() + 3600e3) return t.toISOString().replace('.000Z', 'Z');
  }
  return new Date(now.getTime() + 24 * 3600e3).toISOString().replace('.000Z', 'Z');
}

// ---------- Transitous calls ----------
// Transitous requires a User-Agent naming the app and a contact. Chrome may drop this header from fetch,
// so transitous_rules.json also sets it with declarativeNetRequest; keep the two in sync.
const TRANSITOUS_UA = 'SubCentralJobFilter/0.7 (+https://github.com/zevezev/Subcentral-Filters-Chrome-Extension)';

// Returns null for requests Transitous can't answer (e.g. no street near a point); throws for anything else.
async function transitousGet(path, params, retries = 1) {
  const url = TRANSITOUS_URL + path + '?' + new URLSearchParams(params);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': TRANSITOUS_UA }, signal: AbortSignal.timeout(settings.transitousTimeoutMs) });
  } catch (e) {
    if (retries > 0) return transitousGet(path, params, retries - 1);
    throw new Error(e.name === 'TimeoutError' ? 'Transitous timed out' : `Transitous unreachable: ${e.message}`);
  }
  if (res.ok) return res.json();
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    await new Promise(r => setTimeout(r, settings.retryDelayMs));
    return transitousGet(path, params, retries - 1);
  }
  if ([400, 404, 422].includes(res.status)) return null;
  let detail = '';
  try { detail = (await res.text()).slice(0, 160); } catch (e) { /* ignore */ }
  throw new Error(`Transitous error (${res.status})${detail ? ': ' + detail : ''}`);
}

const LATLNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
// Home address -> coordinates. Typing "lat,lng" skips the lookup.
async function resolveHome(home) {
  const m = LATLNG.exec(home);
  if (m) return { lat: +m[1], lng: +m[2], label: `${m[1]},${m[2]}` };
  const c = await loadCache();
  const ck = home.toLowerCase();
  if (c.homes[ck]) return c.homes[ck];
  const rows = await transitousGet('/v1/geocode', { text: home, type: 'ADDRESS,PLACE', numResults: '1', place: NYC_CENTER });
  const r = rows && rows[0];
  const [cLat, cLng] = NYC_CENTER.split(',').map(Number);
  // the geocoder always returns its best guess somewhere in the world, so anything far from NYC counts as not found
  if (!r || distM({ lat: r.lat, lng: r.lon }, { lat: cLat, lng: cLng }) > MAX_HOME_KM * 1000) return null;
  const area = (r.areas || []).map(a => a.name).filter(Boolean).pop();
  const out = { lat: r.lat, lng: r.lon, label: [r.name, area].filter(Boolean).join(', ') };
  c.homes[ck] = out;
  await persistCache();
  return out;
}

const inflight = new Map();
const once = (k, fn) => { if (!inflight.has(k)) inflight.set(k, fn().finally(() => inflight.delete(k))); return inflight.get(k); };

async function photonSearch(query, retries = 1) {
  const url = PHOTON_URL + '?' + new URLSearchParams({ q: query, bbox: NYC_BBOX, limit: '10', lang: 'en' });
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(settings.photonTimeoutMs) });
  } catch (e) {
    if (retries > 0) return photonSearch(query, retries - 1);
    throw new Error(e.name === 'TimeoutError' ? 'Photon map search timed out' : `Photon map search failed: ${e.message}`);
  }
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && retries > 0) {
      await new Promise(r => setTimeout(r, settings.retryDelayMs));
      return photonSearch(query, retries - 1);
    }
    throw Object.assign(new Error(`Photon map search error (${res.status}): ${res.statusText || 'request failed'}`), { status: res.status });
  }
  return res.json();
}

function photonPlace(f) {
  const p = f.properties || {};
  const [lng, lat] = (f.geometry && f.geometry.coordinates) || [];
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  return {
    id: `osm:${p.osm_type}${p.osm_id}`, name: p.name || street || 'School',
    address: [street, p.district || p.city, p.postcode].filter(Boolean).join(', '),
    lat, lng,
  };
}

// Find the school on OpenStreetMap (via Photon). "?" cases: no result, or several different locations.
function resolvePlace(query, borough) {
  return once('p|' + query, async () => {
    const c = await loadCache();
    const ck = query.toLowerCase();
    const hit = c.photon[ck];
    // a school that couldn't be matched is looked up again after a while, in case the map data improved
    if (hit && (hit.status === 'ok' || Date.now() - (hit.at || 0) < MISS_RETRY_MS)) return hit;
    let data;
    try {
      data = await photonSearch(query);
    } catch (e) { // not cached, so the next search tries this school again
      return { status: 'none', reason: `${e.message}; search again to retry` };
    }
    let places = (data.features || [])
      .filter(f => f.properties && f.properties.osm_value === 'school')
      .map(photonPlace)
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    // Photon also returns loosely related schools, so when the query has a school number, keep only that number.
    const num = (/\b(?:P\.?S|I\.?S|J\.?H\.?S|M\.?S|H\.?S)\.?\s*(\d{1,3})\b/i.exec(query) || [])[1];
    if (num) places = places.filter(p => new RegExp(`(?<!\\d)${num}(?!\\d)`).test(p.name));
    else places = places.slice(0, 1); // no number to check, so trust Photon's top-ranked school
    let result;
    if (!places.length) {
      result = { status: 'none', reason: 'No school match on the map' };
    } else {
      const inBoro = borough ? places.filter(p => boroughFromAddress(p.address) === borough) : [];
      if (inBoro.length) places = inBoro; // drop same-named schools in other boroughs
      const first = places[0];
      const spread = Math.max(0, ...places.slice(1).map(p => distM(first, p)));
      if (places.length > 1 && spread > SAME_CAMPUS_M) {
        result = { status: 'multiple', reason: `${places.length} different locations on the map (${places.slice(0, 3).map(p => p.name).join('; ')})` };
      } else {
        result = { status: 'ok', place: first };
      }
    }
    if (result.status !== 'ok') result.at = Date.now();
    c.photon[ck] = result;
    await persistCache();
    return result;
  });
}

// Bike: the direct bike trip. Transit: the quickest trip arriving by the job start on the next weekday.
function route(home, place, mode, hhmm) {
  const from = `${home.lat},${home.lng}`, to = `${place.lat},${place.lng}`;
  const rk = [from, to, mode, mode === 'TRANSIT' ? hhmm : ''].join('|');
  return once('r|' + rk, async () => {
    const c = await loadCache();
    if (rk in c.routes) return c.routes[rk];
    // separate requests per mode, so a fast bike trip can't cut transit trips out of the results
    const params = mode === 'BIKE'
      ? { fromPlace: from, toPlace: to, transitModes: '', directModes: 'BIKE', maxDirectTime: String(MAX_BIKE_S) }
      : { fromPlace: from, toPlace: to, directModes: '', arriveBy: 'true', time: nextWeekdayArrival(hhmm) };
    const data = await transitousGet('/v6/plan', params);
    const trips = data ? (mode === 'BIKE' ? data.direct : data.itineraries) || [] : [];
    const best = Math.min(...trips.map(t => t.duration).filter(Number.isFinite));
    const out = Number.isFinite(best) ? { min: Math.max(1, Math.round(best / 60)) } : null; // no route found
    c.routes[rk] = out;
    await persistCache();
    return out;
  });
}

// ---------- message API (used by the content script) ----------
async function handle(msg, sender) {
  if (msg.type === 'getConfig') {
    const cfg = await getCfg();
    return { home: cfg.home || '' };
  }
  if (msg.type === 'setConfig') {
    const cfg = { home: typeof msg.home === 'string' ? msg.home.trim() : '' };
    await store.set('commuteCfg', cfg);
    if (!cfg.home) return { home: '' };
    try {
      const h = await resolveHome(cfg.home);
      return h ? { home: cfg.home, homeLabel: h.label } : { home: cfg.home, error: 'Saved, but that address wasn’t found on the map. Try adding the ZIP code, or paste "lat,lng".' };
    } catch (e) {
      return { home: cfg.home, error: `Saved, but the address couldn’t be checked: ${e.message}` };
    }
  }
  if (msg.type === 'commute') {
    const cfg = await getCfg();
    if (!cfg.home) return { error: 'Add your home address under Commute settings' };
    try {
      const home = await resolveHome(cfg.home);
      if (!home) return { error: 'Your home address wasn’t found on the map. Edit it under Commute settings (adding the ZIP code helps).' };
      const place = await resolvePlace(msg.query, msg.borough);
      if (place.status !== 'ok') return { status: place.status, reason: place.reason };
      const [bike, transit] = await Promise.all([
        route(home, place.place, 'BIKE', msg.hhmm),
        route(home, place.place, 'TRANSIT', msg.hhmm),
      ]);
      return { status: 'ok', place: { name: place.place.name, address: place.place.address }, bike, transit };
    } catch (e) {
      return { error: e.message };
    }
  }
  if (msg.type === 'notifyReady') {
    const tab = sender && sender.tab;
    if (!tab) return { error: 'no tab to notify about' };
    // tab + window ids ride along in the notification id, so a click can focus the right tab
    // even if this worker was shut down and restarted in the meantime
    const id = `sc-${tab.id}-${tab.windowId}-${Date.now()}`;
    await chrome.notifications.create(id, {
      type: 'basic', iconUrl: 'icon128.png', title: String(msg.title || 'SubCentral'), message: String(msg.message || ''),
      priority: 2, requireInteraction: true,
    });
    return { ok: true, id };
  }
  if (msg.type === 'clearNotify') { // the tab is back in front, so the notification is stale
    const tab = sender && sender.tab;
    if (!tab) return { ok: true };
    const all = (await chrome.notifications.getAll()) || {};
    await Promise.all(Object.keys(all).filter(k => k.startsWith(`sc-${tab.id}-`)).map(k => chrome.notifications.clear(k)));
    return { ok: true };
  }
  return { error: 'unknown message' };
}

// Clicking the notification brings the SubCentral tab (and its window) to the front.
async function onNotificationClicked(id) {
  const m = /^sc-(\d+)-(\d+)-/.exec(id);
  if (!m) return;
  try {
    await chrome.windows.update(+m[2], { focused: true });
    await chrome.tabs.update(+m[1], { active: true });
  } catch (e) { /* the tab was closed */ }
  await chrome.notifications.clear(id);
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg, sender).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true; // keep the channel open for the async reply
  });
}
if (typeof chrome !== 'undefined' && chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(onNotificationClicked);
}
if (typeof module !== 'undefined') module.exports = { handle, onNotificationClicked, nextWeekdayArrival, boroughFromAddress, settings, _reset: () => { cache = null; cacheLoading = null; inflight.clear(); } };
