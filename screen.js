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
  // Who's where, made readable across a room: on the map each vehicle, or each bunch of vehicles that would overlap at
  // this zoom (within 44 px on screen), is one numbered badge; the list on the right says who each number is and where.
  const BUNCH_PX = 30, AT_BASE_M = 400;
  const fmtMiles = m => m < 10 ? m.toFixed(1) : String(Math.round(m));
  function stateOf(v) {
    const seen = new Date(v.seenAt), age = (Date.now() - seen) / 60000;
    if (age > 30) return { cls: 'old', text: `Last seen ${seen.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}` };
    if (v.ignition && (v.speed || 0) > 3) return { cls: 'moving', text: 'Driving' };
    if (v.ignition) return { cls: 'on', text: 'Engine on' };
    if (v.stopAt && v.stopSeen) return { cls: 'parked', text: `Parked since ${fmtTime.format(new Date(v.stopAt))}` };
    return { cls: 'parked', text: 'Parked' };
  }
  function bunches(vans) {
    const pt = v => map.latLngToContainerPoint([v.lat, v.lon]);
    const out = [];
    // Everyone at the yard is always one group of its own, however far out the map is zoomed
    const home = vans.filter(v => metres(BASE, v) < AT_BASE_M);
    if (home.length) out.push({ p: pt(BASE), at: { lat: BASE.lat, lon: BASE.lon }, vans: home, home: true });
    for (const v of vans.filter(x => metres(BASE, x) >= AT_BASE_M)) {
      const p = pt(v);
      const g = out.find(x => !x.home && Math.hypot(x.p.x - p.x, x.p.y - p.y) < BUNCH_PX);
      if (g) g.vans.push(v); else out.push({ p, at: { lat: v.lat, lon: v.lon }, vans: [v] });
    }
    for (const g of out) {
      g.miles = Math.min(...g.vans.map(v => metres(BASE, v))) / 1609.34;
      g.atBase = !!g.home;
    }
    return out.sort((x, y) => (y.atBase - x.atBase) || x.miles - y.miles).map((g, i) => ({ ...g, n: i + 1 }));
  }
  function badgeIcon(g) {
    const v = g.vans[0], kind = vehKind(v), im = VEH[kind], st = stateOf(v);
    return L.divIcon({ className: `vmark ${st.cls}`, iconSize: [0, 0], html: h('div', null, h('span', { class: 'halo' }),
      im ? h('img', { class: `vimg vk-${kind}`, src: im[1], alt: '' }) : null, h('span', { class: 'num' }, String(g.n))) });
  }
  function list(gs, total) {
    const rows = gs.map(g => h('li', { class: `row${g.atBase ? ' base' : ''}${g.off ? ' off' : ''}` },
      h('span', { class: 'num' }, String(g.n)),
      h('div', { class: 'who' },
        h('div', { class: 'where' }, g.atBase ? `At FLR · B90 4NZ · ${g.vans.length}` : `${fmtMiles(g.miles)} mi from FLR${g.off ? ' · off the map' : ''}`,
          g.vans.length === 1 ? h('span', { class: 'st' }, ` · ${stateOf(g.vans[0]).text}`) : null),
        h('div', { class: 'chips' }, g.vans.map(v => { const st = stateOf(v);
          return h('span', { class: `chip ${st.cls}`, title: st.text }, h('i', { class: 'dot' }), h('b', null, v.who || 'Unassigned'), h('span', { class: 'pl' }, v.plate || v.reg)); })),
      )));
    $('#list').replaceChildren(h('h2', null, 'Who’s where'),
      h('p', { class: 'sub' }, `${total} vehicles · `, h('i', { class: 'dot moving' }), ' driving ', h('i', { class: 'dot parked' }), ' parked'),
      h('ol', null, rows));
    // Everyone has to fit on the TV: if the list is too long, step the text down until it fits
    const ol = $('#list ol');
    $('#list').classList.remove('s1', 's2', 's3');
    for (const step of ['s1', 's2', 's3']) { if (ol.scrollHeight <= ol.clientHeight + 1) break; $('#list').classList.add(step); }
  }

  function draw(d) {
    const M = mapInit();
    if (!M) return;
    layer.clearLayers();
    const radar = h('div', { class: 'radar' }, h('span', { class: 'r-ring r1' }), h('span', { class: 'r-ring r2' }), h('span', { class: 'r-ring r3' }),
      h('span', { class: 'r-sweep' }), h('span', { class: 'r-pulse' }), h('span', { class: 'r-dot' }));
    L.marker([BASE.lat, BASE.lon], { icon: L.divIcon({ className: 'sitemark', html: radar, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: -1000 })
      .bindTooltip('FLR · B90 4NZ', { className: 'nm base', direction: 'bottom', offset: [0, 16], permanent: true }).addTo(layer);
    const vans = (d.vans || []).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon) && !isNaN(new Date(v.seenAt)));
    // Frame B90 4NZ and everyone within 180 miles of it (England and Wales, roughly) in the space left of the list, then
    // bunch at that zoom. Anyone further away (Scotland, say) is still in the list, marked "off the map".
    const near = vans.filter(v => metres(BASE, v) <= FRAME_MI * 1609.34);
    const pts = [[BASE.lat, BASE.lon], ...near.map(v => [v.lat, v.lon])];
    M.invalidateSize();
    M.fitBounds(L.latLngBounds(pts).pad(0.04), { paddingTopLeft: [60, 150], paddingBottomRight: [LIST_W + 60, 40], maxZoom: 11, animate: false });
    const gs = bunches(vans);
    const view = M.getBounds();
    for (const g of gs) g.off = !view.contains([g.at.lat, g.at.lon]);
    for (const g of gs.filter(x => !x.off)) L.marker([g.at.lat, g.at.lon], { icon: badgeIcon(g), interactive: false, keyboard: false, zIndexOffset: 500 - g.n }).addTo(layer);
    list(gs, vans.length);
    const ok = d.fleetviewAt ? new Date(d.fleetviewAt) : null;
    $('#status').textContent = `${vans.length} vehicles · FleetView ${ok ? fmtTime.format(ok) : '—'}`;
    $('#status').classList.toggle('stale', !ok || d.fleetviewFailing || Date.now() - ok > 15 * 60000);
  }
  const LIST_W = 470, FRAME_MI = 180;

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
