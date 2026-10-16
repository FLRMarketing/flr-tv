/* ============================================================================
   FLR TV: the office screen (AbleSign), a site of its own (not part of the FLR Hub). The live map only: every vehicle where FleetView last saw it, with who
   is in it above it, and B90 4NZ with the radar. Made for a TV: nothing to click, it frames everyone, and it keeps
   itself up to date.

   The data: public.proximity_screen(p_key) (Estimator repo 20261016600000_flr_nearby_screen.sql). The key is the
   private screen link's (…/flr-tv/#k=<key>), made by a Super Admin with admin_proximity_screen_link(). It
   answers {fleetviewAt, fleetviewFailing, vans: [{reg, plate, who, make, model, lat, lon, ignition, speed, seenAt,
   stopAt, stopSeen}]}, and nothing else (no bookings, addresses, jobs or photos).
   Every 2 minutes it reads again (FleetView positions change every 2 minutes, 06:00–21:00); every 6 hours it reloads
   the page, so a screen left on for weeks picks up updates.
   ========================================================================== */
(function () {
  'use strict';
  const cfg = window.FLR_CONFIG || {};
  const $ = s => document.querySelector(s);
  const READ_MS = 2 * 60 * 1000, RELOAD_MS = 6 * 60 * 60 * 1000;
  const BASE = { lat: 52.395708, lon: -1.7956, label: 'FLR · B90 4NZ' };
  const GROUP_M = 250;   // vehicles closer than this share one label (e.g. everyone at B90 4NZ)

  const key = (() => {
    const m = /(?:^|[#&?])k=([0-9a-f]{64})\b/.exec(location.hash + '&' + location.search);
    return m ? m[1] : '';
  })();

  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else n.setAttribute(k, String(v)); }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false && k !== '') n.append(k instanceof Node ? k : String(k));
    return n;
  }
  const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  function message(title, text) { $('#msgTitle').textContent = title; $('#msgText').textContent = text; $('#message').hidden = false; }

  // The clock, top right
  const tick = () => { $('#clock').textContent = new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }); };
  tick(); setInterval(tick, 15000);

  /* ---------------------------------------------------------------- the map: Fleet Management's satellite view */
  const ESRI_KEY = String(window.FLR_MAP_KEY || '').trim();
  const tok = ESRI_KEY ? `?token=${encodeURIComponent(ESRI_KEY)}` : '';
  const esri = path => ESRI_KEY ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/${path}/MapServer/tile/{z}/{y}/{x}${tok}`
    : `https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`;
  const esriStyle = style => `https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/${style}/static/tile/{z}/{y}/{x}${tok}`;
  let map = null, layer = null;
  function mapInit() {
    if (map || !window.L) return map;
    map = L.map($('#map'), { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.25 });
    map.attributionControl.setPrefix('Leaflet');
    const credit = 'Tiles © Esri — Esri, Maxar, Earthstar Geographics, HERE, Garmin, © OpenStreetMap contributors';
    if (ESRI_KEY) {
      L.tileLayer(esri('World_Imagery'), { maxZoom: 19, crossOrigin: true, attribution: credit }).addTo(map);
      L.tileLayer(esriStyle('arcgis/imagery/labels'), { tileSize: 512, zoomOffset: -1, maxZoom: 19, crossOrigin: true }).addTo(map);
    } else {
      L.tileLayer(esri('World_Imagery'), { maxZoom: 19, crossOrigin: true, attribution: credit }).addTo(map);
      L.tileLayer(esri('Reference/World_Boundaries_and_Places'), { maxZoom: 19, crossOrigin: true }).addTo(map);
    }
    layer = L.layerGroup().addTo(map);
    map.fitBounds([[49.85, -6.6], [58.75, 1.9]]);
    return map;
  }

  /* ---------------------------------------------------------------- vehicles */
  const VEH = window.FLR_VEH_IMG || {};
  function vehKind(v) {   // as Fleet Management's vehKind(): from the FLR - Fleet make and model
    const t = `${v.make || ''} ${v.model || ''}`.toLowerCase();
    if (/dispatch/.test(t)) return 'dispatch';
    if (/crafter|relay|transit|sprinter|vivaro|trafic/.test(t)) return 'van';
    if (/bmw/.test(t)) return /ix3/.test(t) ? 'bmw-ix3' : /\bi4\b/.test(t) ? 'bmw-i4' : /x5/.test(t) ? 'bmw-x5' : /x1|\b1\d\d\b/.test(t) ? 'bmw-x1' : /5 series|\b5\d\de?\b/.test(t) ? 'bmw-530e' : 'bmw-330e';
    return 'van';
  }
  function metres(a, b) {
    const rad = x => x * Math.PI / 180, q = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(q));
  }
  // Vehicles within 250 m of each other become one group with one label ("Dan Byrne · Mark Kenyon +4")
  function groups(vans) {
    const out = [];
    for (const v of vans) {
      const g = out.find(x => metres(x.at, v) < GROUP_M);
      if (g) g.vans.push(v); else out.push({ at: { lat: v.lat, lon: v.lon }, vans: [v] });
    }
    return out;
  }
  function vehicleIcon(v, count) {
    const kind = vehKind(v), im = VEH[kind];
    const age = (Date.now() - new Date(v.seenAt)) / 60000, moving = v.ignition && (v.speed || 0) > 3;
    const cls = ['vmark', moving ? 'moving' : 'parked', age > 30 ? 'old' : ''].filter(Boolean).join(' ');
    return L.divIcon({ className: cls, iconSize: [0, 0], html: h('div', null, h('span', { class: 'halo' }),
      im ? h('img', { class: `vimg vk-${kind}`, src: im[1], alt: '' }) : null, count > 1 ? h('span', { class: 'count' }, String(count)) : null) });
  }
  function label(g) {
    const named = g.vans.map(v => ({ who: v.who || 'Unassigned', plate: v.plate || v.reg }));
    const el = h('div', null);
    const first = named.slice(0, g.vans.length > 3 ? 2 : 3);
    first.forEach((n, i) => { if (i) el.append(' · '); el.append(n.who, h('span', { class: 'pl' }, n.plate)); });
    if (named.length > first.length) el.append(h('span', { class: 'more' }, `+${named.length - first.length} more: ${named.slice(first.length).map(n => n.who).join(', ')}`));
    return el;
  }

  function draw(d) {
    const M = mapInit();
    if (!M) return;
    layer.clearLayers();
    const radar = h('div', { class: 'radar' }, h('span', { class: 'r-ring r1' }), h('span', { class: 'r-ring r2' }), h('span', { class: 'r-ring r3' }),
      h('span', { class: 'r-sweep' }), h('span', { class: 'r-pulse' }), h('span', { class: 'r-dot' }));
    L.marker([BASE.lat, BASE.lon], { icon: L.divIcon({ className: 'sitemark', html: radar, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: -1000 })
      .bindTooltip(BASE.label, { className: 'nm base', direction: 'bottom', offset: [0, 14], permanent: true }).addTo(layer);
    const vans = (d.vans || []).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon) && !isNaN(new Date(v.seenAt)));
    const pts = [[BASE.lat, BASE.lon]];
    for (const g of groups(vans)) {
      L.marker([g.at.lat, g.at.lon], { icon: vehicleIcon(g.vans[0], g.vans.length), interactive: false, keyboard: false })
        .bindTooltip(label(g), { className: 'nm', direction: 'top', offset: [0, -24], permanent: true }).addTo(layer);
      pts.push([g.at.lat, g.at.lon]);
    }
    // Frame everyone (and B90 4NZ), leaving room for the bar at the top
    M.invalidateSize();
    M.fitBounds(L.latLngBounds(pts).pad(0.08), { paddingTopLeft: [60, 130], paddingBottomRight: [60, 60], maxZoom: 11, animate: false });
    const ok = d.fleetviewAt ? new Date(d.fleetviewAt) : null;
    $('#status').textContent = `${vans.length} vehicles · FleetView ${ok ? fmtTime.format(ok) : '—'}`;
    $('#status').classList.toggle('stale', !ok || d.fleetviewFailing || Date.now() - ok > 15 * 60000);
  }

  /* ---------------------------------------------------------------- reading */
  let sb = null, failures = 0;
  async function read() {
    try {
      if (!sb) sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await sb.rpc('proximity_screen', { p_key: key });
      if (error) {
        if (/FLR_FORBIDDEN/.test(`${error.message} ${error.details || ''}`)) return message('This screen link isn’t valid', 'It may have been replaced or switched off. A Super Admin can make a new one for this screen.');
        throw error;
      }
      failures = 0; $('#message').hidden = true;
      draw(data || {});
    } catch (e) {
      failures++;
      $('#status').textContent = 'Can’t reach the FLR server: trying again';
      $('#status').classList.add('stale');
    }
  }

  function start() {
    if (!key) return message('This screen needs its link', 'Open it with the private screen link a Super Admin made (it ends in #k=…).');
    if (!window.L || !window.supabase || !cfg.supabaseUrl) return setTimeout(start, 500);
    read();
    setInterval(read, READ_MS);
    setTimeout(() => location.reload(), RELOAD_MS);
    addEventListener('resize', () => { if (map) map.invalidateSize(); });
  }
  start();
})();
