// Commute lookups for the SubCentral Job Filter.
// Runs in the extension's service worker, so the Google API key stays out of the SubCentral page.
'use strict';

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const NYC_RECT = { low: { latitude: 40.477398, longitude: -74.259087 }, high: { latitude: 40.91618, longitude: -73.70018 } };
const SAME_CAMPUS_M = 300; // results this close together count as one location
const settings = { retryDelayMs: 800 };

// ---------- storage ----------
const store = {
  async get(key) { const v = await chrome.storage.local.get(key); return v ? v[key] : undefined; },
  set(key, val) { return chrome.storage.local.set({ [key]: val }); },
};
let cache = null, cacheLoading = null;
function loadCache() {
  // one shared load, so parallel lookups on a cold start all write into the same cache object
  if (!cacheLoading) cacheLoading = store.get('commuteCache').then(v => (cache = v || { places: {}, routes: {} }));
  return cacheLoading;
}
const persistCache = () => store.set('commuteCache', cache);
const getCfg = async () => (await store.get('commuteCfg')) || { home: '', key: '' };

// ---------- monthly usage limits ----------
// Defaults sit a little under Google's free monthly allowances (Text Search Pro: 5,000; Compute Routes Essentials: 10,000).
// Counts every request this extension sends (retries included) and refuses to send more once a limit is hit.
const DEFAULT_LIMITS = { places: 4500, routes: 9000 };
let usage = null, usageLoading = null;
function monthKey(d = new Date()) { // Google Cloud bills by calendar month in Pacific time
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(d).forEach(p => { o[p.type] = p.value; });
  return `${o.year}-${o.month}`;
}
async function loadUsage() {
  if (!usageLoading) usageLoading = store.get('commuteUsage').then(v => { usage = v || {}; });
  await usageLoading;
  const mk = monthKey();
  if (usage.month !== mk) { usage.month = mk; usage.places = 0; usage.routes = 0; } // new month, fresh count
  usage.places = usage.places || 0; usage.routes = usage.routes || 0;
  return usage;
}
const limitsOf = cfg => ({ ...DEFAULT_LIMITS, ...((cfg && cfg.limits) || {}) });
async function reserve(kind) {
  await loadUsage();
  const limit = limitsOf(await getCfg())[kind];
  // no awaits between the check and the increment, so parallel lookups can't slip past the limit
  if (usage[kind] >= limit) {
    throw Object.assign(new Error(`Monthly limit reached (${limit.toLocaleString('en-US')} Google ${kind === 'places' ? 'searches' : 'route lookups'}). Saved results still show; raise the limit in Commute settings to look up more.`), { limit: true });
  }
  usage[kind]++;
  await store.set('commuteUsage', usage);
}

// ---------- helpers ----------
function distM(a, b) {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return Infinity;
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Which borough a Google-formatted address is in, from its ZIP code (or the borough name).
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

// ---------- Google calls ----------
async function googleFetch(label, kind, url, key, mask, body, retries = 1) {
  await reserve(kind);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if ((res.status === 429 || res.status === 503) && retries > 0) {
      await new Promise(r => setTimeout(r, settings.retryDelayMs));
      return googleFetch(label, kind, url, key, mask, body, retries - 1);
    }
    let msg = res.statusText || 'request failed';
    try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { /* ignore */ }
    throw Object.assign(new Error(`Google ${label} error (${res.status}): ${msg}`), { status: res.status });
  }
  return res.json();
}

const inflight = new Map();
const once = (k, fn) => { if (!inflight.has(k)) inflight.set(k, fn().finally(() => inflight.delete(k))); return inflight.get(k); };

// Find the school on Google Maps. "?" cases: no result, or several different locations.
function resolvePlace(query, borough, key) {
  return once('p|' + query, async () => {
    const c = await loadCache();
    const ck = query.toLowerCase();
    if (c.places[ck]) return c.places[ck];
    const data = await googleFetch('Places', 'places', PLACES_URL, key, 'places.id,places.displayName,places.formattedAddress,places.location', {
      textQuery: query, includedType: 'school', strictTypeFiltering: true, pageSize: 5,
      languageCode: 'en', regionCode: 'US', locationRestriction: { rectangle: NYC_RECT },
    });
    let places = (data.places || []).map(p => ({
      id: p.id, name: p.displayName && p.displayName.text, address: p.formattedAddress,
      lat: p.location && p.location.latitude, lng: p.location && p.location.longitude,
    }));
    let result;
    if (!places.length) {
      result = { status: 'none', reason: 'No match on Google Maps' };
    } else {
      const inBoro = borough ? places.filter(p => boroughFromAddress(p.address) === borough) : [];
      if (inBoro.length) places = inBoro; // drop same-named schools in other boroughs
      const first = places[0];
      const spread = Math.max(0, ...places.slice(1).map(p => distM(first, p)));
      if (places.length > 1 && spread > SAME_CAMPUS_M) {
        result = { status: 'multiple', reason: `${places.length} different locations on Google Maps (${places.slice(0, 3).map(p => p.name).join('; ')})` };
      } else {
        result = { status: 'ok', place: first };
      }
    }
    c.places[ck] = result;
    await persistCache();
    return result;
  });
}

function route(home, place, mode, hhmm, key) {
  const rk = [home.toLowerCase(), place.id, mode, mode === 'TRANSIT' ? hhmm : ''].join('|');
  return once('r|' + rk, async () => {
    const c = await loadCache();
    if (rk in c.routes) return c.routes[rk];
    const body = { origin: { address: home }, destination: { placeId: place.id }, travelMode: mode };
    if (mode === 'TRANSIT') body.arrivalTime = nextWeekdayArrival(hhmm);
    const data = await googleFetch('Routes', 'routes', ROUTES_URL, key, 'routes.duration,routes.distanceMeters', body);
    const r = data.routes && data.routes[0];
    const out = r && r.duration
      ? { min: Math.max(1, Math.round(parseFloat(r.duration) / 60)), mi: Math.round(((r.distanceMeters || 0) / 1609.344) * 10) / 10 }
      : null; // Google found no route
    c.routes[rk] = out;
    await persistCache();
    return out;
  });
}

// ---------- message API (used by the content script) ----------
async function handle(msg, sender) {
  if (msg.type === 'getConfig') {
    const cfg = await getCfg();
    return { home: cfg.home || '', hasKey: !!cfg.key, limits: limitsOf(cfg) }; // never hands the key back
  }
  if (msg.type === 'getUsage') {
    await loadUsage();
    return { month: usage.month, places: usage.places, routes: usage.routes, limits: limitsOf(await getCfg()) };
  }
  if (msg.type === 'setConfig') {
    const cfg = await getCfg();
    if (typeof msg.home === 'string') cfg.home = msg.home.trim();
    if (typeof msg.key === 'string' && msg.key.trim()) cfg.key = msg.key.trim();
    if (msg.limits) {
      cfg.limits = cfg.limits || {};
      ['places', 'routes'].forEach(k => { const n = msg.limits[k]; if (Number.isInteger(n) && n >= 0 && n <= 1e6) cfg.limits[k] = n; });
    }
    await store.set('commuteCfg', cfg);
    return { home: cfg.home || '', hasKey: !!cfg.key, limits: limitsOf(cfg) };
  }
  if (msg.type === 'clearCache') {
    cache = { places: {}, routes: {} };
    cacheLoading = Promise.resolve(cache);
    await persistCache();
    return { ok: true };
  }
  if (msg.type === 'commute') {
    const cfg = await getCfg();
    if (!cfg.home || !cfg.key) return { error: 'Add your home address and Google Maps API key under Commute settings' };
    try {
      const place = await resolvePlace(msg.query, msg.borough, cfg.key);
      if (place.status !== 'ok') return { status: place.status, reason: place.reason };
      const [bike, transit] = await Promise.all([
        route(cfg.home, place.place, 'BICYCLE', msg.hhmm, cfg.key),
        route(cfg.home, place.place, 'TRANSIT', msg.hhmm, cfg.key),
      ]);
      return { status: 'ok', place: { name: place.place.name, address: place.place.address }, bike, transit };
    } catch (e) {
      return { error: e.message, limit: !!e.limit };
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
if (typeof module !== 'undefined') module.exports = { handle, onNotificationClicked, nextWeekdayArrival, boroughFromAddress, settings, _reset: () => { cache = null; cacheLoading = null; usage = null; usageLoading = null; inflight.clear(); } };
