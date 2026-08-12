# Traffic Controller

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

## Where the code is

```text
src/sim/      types.ts, network.ts, conflicts.ts, junction.ts, routing.ts,
              signals.ts, idm.ts, world.ts, centreline.ts, validate.ts, parking.ts
src/render/   Scene.tsx, RoadNetwork.tsx, Ground.tsx, Buildings.tsx, Trees.tsx,
              Simulation.tsx, Controls.tsx, scatter.ts, geometry.ts,
              CinematicCamera.tsx, CrashFocus.tsx, BusStops.tsx, ParkedCars.tsx
src/levels/   tJunction, crossroads, fiveWays, fourCorners, curveTest, osm/
src/ui/       Hud.tsx, ProgramPanel.tsx, SplitBar.tsx, ImportForm.tsx,
              LevelSheet.tsx, hudStore.ts
src/art/      palette.ts, daylight.ts
```

## Getting started

```bash
npm install
npm run dev
```

Other scripts: `npm run build`, `npm run lint`, `npm run preview`,
`npm run fetch:osm`.

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
- [ ] Only show ovehead signals. Remove others
- [ ] Update turn signals
- [ ] Add street signs at corners of block
- [ ] Fix block corners so that they are rounded instead of indented
- [ ] Dynamic fog to make city more moody
- [ ] Add street lights
- [ ] Fix green fields
- [ ] Add more park features like baseball fields, basketball courts
- [ ] Add more detailed buildings
- [ ] Add FPS mode with walking and flying

## Notes for contributors

- The simulation runs outside React; UI reads a throttled mirror of it via
  `zustand`. Don't drive simulation state through React re-renders.
- `validateLevel` and the measurement harness (`src/sim/validate.ts`) exist
  because the worst bugs in this project's history were invisible on screen
  and only caught numerically — prefer measuring to assuming when touching
  the sim.
- See `HANDOFF.md` for the detailed design rationale, measured calibration
  facts, and traps behind the simulation and city-generation code.
