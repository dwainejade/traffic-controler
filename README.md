# Traffic Controller

Two games on one city.

**Signal control** — the original: you program the traffic lights and keep the
city moving. **Transit mode** — you draw bus routes through that same city and
carry people from where they live to where they are going, with the traffic and
the signals running themselves as the weather you have to work in. The
simulation underneath is the same one; a bus is an ordinary vehicle in it.

A traffic-signal control game rendered in React Three Fiber. You look down on
a city in an Apple-Maps-style 3/4 orthographic view and program the traffic
lights — green splits, cycle length, offsets between junctions — to keep it
moving. There's no manual "make this light green" control; the whole game is
writing signal _plans_ and watching what they do.

The simulation underneath is a real one: IDM car-following, lanes as
polylines, conflict-point detection between turning movements, and signal
phases derived by graph colouring over the conflict graph. It's calibrated
against real traffic-engineering figures (saturation headway, junction
capacity, green-wave resonance).

## Features

### Signal programming

- Per-junction phase editor — drag a split bar or type exact green times per phase
- Cycle length and offset control, with amber/all-red clearance built in
- Link junctions into a coordinated group sharing one cycle length
- Auto green-wave: offsets each linked junction by its travel time from the first, so a platoon meets green all the way along
- Per-junction subprograms that override a group's shared timing where needed

### Transit mode

- Draw a bus line street by street — click junctions and the path is laid along
  the streets between them, always as a chain of movements the junctions
  actually offer
- Lines are closed loops: the drawn path plus a routed return leg, so a one-way
  avenue comes back down the next one over and no bus ever needs a U-turn
- Stops placed automatically on the far side of each junction, spaced a block
  apart; buses added or removed per line, which is the frequency decision
- Pedestrians spawn at home with a destination building in mind, walk up to
  400m to a stop, board a line that reaches them, and are counted door to door
- Riders are painted the colour of the building they are trying to reach, so a
  crowd on a corner with no line near it is the map telling you where to draw
- Signals run themselves — there is no light to program in this mode
- Click a stop to skip it — every stop a line keeps costs it a dwell each way
  and buys it the corner it stands on, which is the express-versus-local decision
- Scored on delivered against missed, and the two ways a trip fails are shown
  apart because they ask for opposite fixes: giving up at a stop wants another
  bus, no line in walking distance wants a line drawn
- Console harness: `TRANSIT` is the live layer in dev, `TRANSIT.ledgerBalances()`
  asserts no rider has leaked out of the model

### Simulation

- IDM (Intelligent Driver Model) car-following on lane polylines
- Conflict-point detection (segment intersection + closest-approach proximity) between turning movements
- Automatic phase generation via graph colouring over the conflict graph
- One-way streets, protected left turns, curved roads (Catmull-Rom centrelines) and irregular blocks derived from the street graph
- Directional, time-varying demand with a rush-hour profile
- Deterministic at any speed multiplier — the sim can run at up to ~2700× realtime headlessly
- Crash detection with in-scene focus/replay of the collision

### Levels

- Hand-built teaching levels of increasing complexity: T-junction → crossroads → five-way → four linked junctions
- Real-world areas imported live from OpenStreetMap (Overpass API) — enter coordinates and a radius and it builds a playable level from actual streets, lane counts, one-ways and bus lanes
- Imported areas are saved locally (IndexedDB) up to a capacity limit, and persist across sessions
- Objective-based levels (deliver a quota of cars, or stay under a delay budget within a time limit) alongside open-ended sandbox levels with no clock or fail state

### World & rendering

- Day/night cycle with sun/moon and street lighting, tied to simulation time
- Real water bodies from OSM (ponds, rivers, sea coastlines) and roads that rise onto a raised deck for bridges over water and overpasses over other roads
- Toggleable map layers
- Fleet-realistic vehicle colours (matching real-world colour distribution) so intent reads from lane position and indicators, not paint colour
- Buildings, parks, trees, parked cars, bus stops and street labels scattered procedurally with a spatial index for fast placement
- Cinematic camera mode and click-to-focus on any junction
- Apple Maps–style art direction: soft shadows, muted palette, no hard key light, `NoToneMapping` to keep near-whites from crushing
- Selective bloom on the light sources only — signals, street lamps, headlamps and indicators register themselves as emitters, because on a palette this high-key a luminance threshold finds the buildings long before it finds a green light

### UI / UX

- Responsive layout with a dedicated mobile UI (bottom sheet, condensed HUD)
- Live HUD: delivered/quota or delay budget, mean wait, cars on map, throughput, collision count
- Hotspot ranking — junctions sorted by queue length so the worst congestion always surfaces first
- Keyboard shortcuts: `Space` play/pause, `[`/`]` speed, `Tab`/`Shift+Tab` cycle junctions, `R` restart, `Esc` back out of selection/linking
- "Observe" mode: drop into a time-lapse to watch flow patterns (platoons, standing queues) after clearing a level

### Dev tooling

- Headless console harness (`window.simWorld`, `window.LEVELS`, `SIMDEV`) for driving and inspecting the sim outside the render loop
- `validateLevel` runs automatically in dev on every level load and asserts core invariants (no illegal phases, every movement reachable, no unreachable OD pairs, no non-finite state, bookkeeping balances)
- `tools/fetchOsm.ts` for pre-fetching OSM areas into the repo
- A local **world store** (`server/`, `tools/ingest.ts`) holding OpenStreetMap on
  disk, so areas load from SQLite instead of Overpass — see below

## Where the code is

```text
src/sim/      types.ts, network.ts, conflicts.ts, junction.ts, routing.ts,
              signals.ts, idm.ts, world.ts, centreline.ts, validate.ts, parking.ts
src/render/   Scene.tsx, RoadNetwork.tsx, junctionShape.ts, Ground.tsx,
              Buildings.tsx, Trees.tsx, Simulation.tsx, Controls.tsx,
              scatter.ts, geometry.ts, glow.ts, CinematicCamera.tsx,
              CrashFocus.tsx, BusStops.tsx, ParkedCars.tsx, StreetSigns.tsx,
              StreetLights.tsx
src/levels/   tJunction, crossroads, fiveWays, fourCorners, curveTest, osm/
src/ui/       Hud.tsx, ProgramPanel.tsx, SplitBar.tsx, ImportForm.tsx,
              LevelSheet.tsx, hudStore.ts
src/sim/      transit.ts, transitGraph.ts       (transit mode)
src/render/   TransitLayer.tsx, useTransitLayer.ts, destinations.ts, ribbon.ts
src/ui/       TransitPanel.tsx, transitStore.ts
src/art/      palette.ts, daylight.ts, transit.ts
server/       db.ts (schema, lattice), worlds.ts (tiles -> level), index.ts (HTTP)
tools/        fetchOsm.ts, ingest.ts, tsResolve.mjs
```

## Getting started

```bash
npm install
npm run dev
```

Other scripts: `npm run build`, `npm run lint`, `npm run preview`,
`npm run fetch:osm`.

## The world store

Importing from Overpass costs a round trip per 1.8km of ground — nine of them and
several minutes for a 5km box — which is fine for a junction and hopeless for a
borough. The world store keeps OpenStreetMap on disk instead, so an area is a
download of a level that is already compiled.

Optional in every sense: it is a local process, the app probes for it and falls
back to Overpass when it is not there, and nothing about the existing import path
changed.

```bash
npm run world:ingest -- --region brooklyn   # fetch and compile a borough (~2h)
npm run world:serve                         # serve it on :8787
npm run world:ingest -- --status            # what is on disk
```

Vite proxies `/api` to the store in development, so `npm run dev` picks it up
with no configuration. Baked areas appear in the level list under **World
store**; ground the store holds also makes the ordinary import form instant.

Two layers, in `data/worlds.db` (gitignored):

- **`tiles`** — raw Overpass output on a fixed lattice. The source of truth, and
  the only thing that survives the importer changing. Roughly 0.25 MB per km².
- **`levels`** — compiled `LevelDef`s keyed by the box that was asked for. What
  the client actually receives, gzipped on disk and served still compressed.

There is deliberately *no* compiled fragment per tile, which is the obvious
design and does not work: `importOsm` merges junction clusters and collapses
degree-2 chains in passes that run over the whole box at once, so a junction
straddling a tile edge would merge on one side and not the other. Tiles are
stored raw and compiled in whatever combination an area asks for.

That split is also what makes the two phases separable — `--fetch` is hours of
somebody else's server and is the part you never want to repeat; `--bake` is
minutes of local CPU and is the part you *will* repeat, every time the importer
changes. Both resume where they stopped.

### Deploying it

A compiled level is immutable for a given box and importer version, so a store
that serves only *baked* areas needs no process at all — it can be a bucket
behind a CDN:

```bash
npm run world:export                          # -> data/export/
aws s3 sync data/export s3://<bucket>/ --delete
VITE_WORLD_DB=https://<your-cdn> npm run build
```

The server answers the same URL shape the export writes — `areas.json` and
`levels/<id>.json.gz` — so the app has one code path and cannot tell a CDN from
a host. That is deliberate: giving the two stores different endpoints would mean
the CDN path was never exercised in development.

What a static store gives up is `/api/level?lat=…`, the on-demand compile for a
box nobody baked. The app asks, is refused, and falls back to OpenStreetMap
exactly as it does when no store is running.

The exported `.json.gz` files carry no `Content-Encoding` header, and none needs
setting: the app sniffs the gzip magic bytes and decompresses whatever it is
handed, so a bucket that sets the header and one that does not both work.

To run it as a service instead, any host with a persistent disk will do (Fly.io
with a volume, or a plain VPS) — `WORLD_DB`, `WORLD_PORT` and `WORLD_ORIGINS`
are the knobs, and Node 22.5+ is required for `node:sqlite`. Serverless and edge
runtimes will not work unmodified, because SQLite needs a real filesystem.

Note that tiles are OpenStreetMap-derived, so anything public is subject to
**ODbL** — visible "© OpenStreetMap contributors" attribution, and share-alike
on the derived database.

Bumping `QUERY_VERSION` in `server/db.ts` invalidates tiles (the query changed);
bumping `IMPORTER_VERSION` invalidates only compiled levels (the importer
changed), which is a re-bake and not a re-fetch.

Measured on a 600m area: **36ms** via the store against ~11s via Overpass. The
road network compiles identically either way; the store additionally picks up the
30m ring of buildings outside the box that `importOsm` wants (`halfX + margin`)
and a box-sized Overpass query never returns.

## Future improvements

Carried over from the project's working notes — not started, in rough
priority order:

- [ ] **Broadway-style diagonal** cutting the grid — will produce 5–6 arm
      junctions; needs phase-count and clearance-cost checks before keeping
- [ ] **Lane changing** — the honest prerequisite for multi-lane approaches;
      needed to raise the ~2300 veh/h per-junction capacity ceiling
- [ ] **Multi-lane approaches** (depends on lane changing above)
- [ ] **Gap acceptance and give-way (unsignalled) junctions**
- [ ] **Roundabouts**
- [ ] **Night mode with light trails**
- [x] Add more terrain features like overpasses, bridges, bodies of water —
      OSM-imported levels now render real water bodies (closed ponds/rivers
      and open sea coastlines) and raise bridge/overpass road spans off the
      ground plane; tunnels and interchange ramp geometry are still open
- [ ] Make sky similar to realworld
- [ ] Optimizing for larger maps
- [x] Only show overhead signals. Remove others — the mast-arm head is the sole
      display of signal colour now; the pole repeater strip and the coloured
      stop bars on the road are gone, and the layer is on by default
- [ ] Update turn signals
- [x] Add street signs at corners of block — a post on every corner of every
      junction, with a blade per street lying parallel to the street it names;
      instanced geometry throughout, lettered only when the text would be big
      enough on screen to read
- [x] Fix block corners so that they are rounded outward instead of indented —
      a junction is paved to the shape of the arms that meet it, with a kerb
      radius turned at each corner, instead of being stamped with a square box
      wider than any road on it
- [ ] Dynamic fog to make city more moody
- [x] Add street lights — a lamp column every 32m and at both ends of every
      block, with a warm fill that winds up after dusk. Three instanced meshes
      and one light for the whole map, written once
- [ ] Fix green fields
- [ ] Add more park features like baseball fields, basketball courts
- [ ] Add more detailed buildings
- [ ] Add FPS mode with walking and flying
- [ ] Add trains — the transit layer is written so a mode is a vehicle with a
      route and a set of stops; a train is that on rails it lays itself
- [ ] Stream in terrain live
- [x] remove traffic light controls — the phase editor is gone, and transit
      mode is what replaced it as the thing the player does
- [ ] improve car simulation
  - [ ] make some streets more busy
  - [ ] dynamic traffic patterns based on time of day
  - [ ] improve collision avoidance
  - [ ] improve driver IQ so that it tries to find best route off map to destination
  - [ ] add driver personalities so that cars travel at different speeds and different level of risk
  - [ ] add lane switching

## Notes for contributors

- The simulation runs outside React; UI reads a throttled mirror of it via
  `zustand`. Don't drive simulation state through React re-renders.
- `validateLevel` and the measurement harness (`src/sim/validate.ts`) exist
  because the worst bugs in this project's history were invisible on screen
  and only caught numerically — prefer measuring to assuming when touching
  the sim.
- See `HANDOFF.md` for the detailed design rationale, measured calibration
  facts, and traps behind the simulation and city-generation code.
