# FLR TV

The office screen (AbleSign): a live map of where everyone is, with each person's name above their vehicle and
B90 4NZ marked with a radar. Its own small site, separate from the FLR Hub: https://flrmarketing.github.io/flr-tv/

- It shows nothing without the **private screen link** (`…/flr-tv/#k=<key>`). A Super Admin makes the link in the
  Supabase SQL editor of the main FLR project ("FLRMarketing's Project"): `select public.admin_proximity_screen_link() ->> 'link';`
  Making a new link stops the old one; `select public.admin_proximity_screen_off();` stops it altogether.
- Data: `public.proximity_screen(key)` in the FLR database (migration `20261016600000_flr_nearby_screen.sql`, Nearby 1.2 in the
  Estimator repo). It returns vehicles, plates and who is in each (today's Work Programme booking for the van, else FleetView's
  driver), and nothing else. Positions come from FleetView every 2 minutes, 06:00–21:00.
- The page reads every 2 minutes, reloads every 6 hours, and can't be clicked. Vehicles parked within 250 m share one label.
- Files: `index.html`, `screen.js`, `screen.css`, `config.js` (public keys), `vehicles.js` (Fleet Management's vehicle pictures),
  `leaflet.min.css`, `supabase-2.116.0.js`. Leaflet 1.9.4 from cdnjs (SRI).
- AbleSign: add a **Web page / URL** item with the screen link, full screen.
