# Transit mode — state of play

> A second game on the same city: the player draws bus routes and the traffic
> and signals become the environment. Nothing in the driving model changed — a
> bus is an ordinary vehicle, subject to the same IDM following, the same
> conflict points, the same red lights.
>
> **New modules:** `src/sim/transitGraph.ts` (point-to-point Dijkstra over the
> lane graph — `routing.ts` only reaches map-edge destinations, and a drawn
> route is between arbitrary junctions), `src/sim/transit.ts` (routes, stops,
> riders, boarding, score), `src/render/TransitLayer.tsx`,
> `src/render/useTransitLayer.ts`, `src/render/destinations.ts`,
> `src/render/ribbon.ts`, `src/ui/TransitPanel.tsx`, `src/ui/transitStore.ts`,
> `src/art/transit.ts`.
>
> **Measured, on Bay Ridge, headless via `world.step`:** with three drawn lines
> and six buses, 2 hours of service delivered 2612 of 3120 trips on empty
> streets (mean journey 608s, mean wait 195s), and 954 of 2340 with the ambient
> traffic running. The rider ledger balances in both.
>
> Three things are load-bearing and each was a bug first:
>
> - **A lane can carry stops from several lines.** A bus that asked "is there a
>   stop on this lane" got somebody else's, recorded that id as served, then
>   found its own again — and dwelled for ever, five seconds at a time, without
>   moving a metre. `stopFor(routeId, laneId, servedStop)` asks with the route
>   as part of the question. Symptom was every bus full, nothing delivered.
> - **A loop must close onto its first *lane*, not its first junction.**
>   Arriving at the junction the route starts from is not the same as arriving
>   on a lane with a legal movement into it, and `advanceLanes` wraps a looping
>   car straight from the end of its chain to the start. `pathToLane` is what
>   the return leg uses.
> - **Region clipping must exempt bus routes.** The sim is clipped to the
>   camera, which is right for anonymous traffic and wrong for the player's
>   service: it would halt whenever they panned away. Lanes *and* junctions on a
>   route stay active — junctions because `stepJunction` is what advances the
>   signal, so a clipped-out junction has a frozen light.
>
> **Two art-direction facts, both found on screen and neither obvious:**
>
> - **A drawn line has to be sized in pixels, not metres.** At the framing a
>   5km import opens on — which is the framing a route is planned at — a line
>   at a believable five metres is a thread nobody can follow. The ribbon
>   carries its normals as an attribute and takes its width from a uniform the
>   frame loop sets from the camera, clamped at both ends. Stops, pedestrians
>   and destination pins are scaled the same way and for the same reason.
> - **The ribbon must be `DoubleSide`.** It is built by walking a centreline and
>   emitting a vertex either side, so its winding depends on which way the
>   street runs: single-sided, a line drawn north-to-south renders and the same
>   line drawn south-to-north is invisible. This cost an afternoon, because
>   every other symptom — uniforms, colours, layer heights, the bounding sphere
>   — checked out.
>
> **Crash rate is the base sim's, not the buses'.** A/B on the whole unclipped
> map for an hour: 301 collisions with no transit, 322 with three lines and six
> buses. Bay Ridge itself fails phase validation at `j452196762`, which is where
> most of them come from and is a pre-existing level bug.
>
> **Not modelled, deliberately:** transfers (one bus or no bus), a walking
> network (straight lines at 1.3 m/s within 400m), and any economy — buses are
> placed, not bought. Each is a layer that sits cleanly on top of what is here.
>
> **`planTrip` is O(routes x stops^2) per rider** and runs on spawn. Fine at the
> sizes measured; the first thing to index if a big map with a dozen lines gets
> slow.

---

# Traffic controller — state of play

> **This section reflects the work as built. The task brief below it is kept for
> the measured facts and traps, which still hold.**
>
> Done: curved roads (`waypoints` → Catmull-Rom centrelines, ribbon rendering),
> irregular blocks (street-graph face tracing), one-way streets, directional
> demand with a looping rush profile, and an endless sandbox city on a
> Manhattan-style island.
>
> **New modules:** `src/sim/centreline.ts` (the single source of road geometry —
> trim, offset, sample, radius checks; both sim and renderer use it),
> `src/sim/validate.ts` (`validateLevel` + `measure`), `src/levels/shoreline.ts`.
>
> **Verification:** `validateLevel` runs automatically in dev on level load and
> asserts all six invariants from the brief. `SIMDEV = { World, generateCity,
> validateLevel, measure }` is on `window` in dev. All five levels validate with
> zero errors. It has already paid for itself twice — it caught a one-way that
> left a junction with no legal exit, and a bridge whose approach angle made its
> only turn classify as a U-turn so every route across it silently died.
>
> **The city** (`src/levels/city.ts`): ~370 junctions on a tapered island, 16
> bridges, a great park, one-way avenues alternating direction, `sandbox: true`
> (no clock, no quota, no fail state; crashes are towed). Opens with ~850 cars.
>
> **The grid is rigid, and that is the point.** Manhattan's 1811 plan is a pure
> lattice; every irregularity visible from above comes from something *cutting*
> it — the shoreline, the park, Broadway. So `thin: 0`, `jitter: 0.03`, and no
> street curves at all. An earlier version jittered spacing, dropped links and
> bowed the streets, and the blocks read as arbitrary rather than as a city.
> Curves belong to the shoreline, not the grid.
>
> **Two-arm junctions are absorbed only when collinear.** Clipping a grid to a
> shore produces them constantly. Where the two streets run straight through,
> the junction is absorbed and the road continues; where they meet at a right
> angle it is a street corner and is left alone. Deleting those corners instead
> *cascades* — each removal drops a neighbour to two arms — and on a narrow
> island it consumed the entire grid, generating a level with zero junctions.
>
> **One-ways never touch a two-arm corner** (`armsAt < 3`). A corner whose only
> other arm is a one-way pointing in has no legal exit but a U-turn, which the
> model does not carry, so every route through it dies silently.
>
> Three things about it are load-bearing and were each measured, not guessed:
>
> - **Blocks are anisotropic** (`blockX: 175`, `blockZ: 88`). Manhattan's blocks
>   are better than 3:1 and square blocks cannot read as Manhattan however many
>   you draw — this was the single biggest thing making the city look small.
> - **The grid is generated far larger than the island and then clipped**
>   (21x75 in, ~370 out). Sizing the grid to the island leaves bare land at the
>   edges, because a rectangle's corners never reach an ellipse's sides.
> - **Demand ceiling is 1.5 cars/s**, set by the sixteen crossings, not by the
>   junctions. At 2.5/s, 48% of arrivals are turned away at the kerb. Base is
>   1.08 so the rush peak (x1.38) stays just under. More entry points — the
>   perimeter highways below — is what would raise it.
>
> **Water is drawn inside-out**: the backdrop plane is *land* (the far bank),
> the river is the island's own outline offset outward by `channel`, and the
> island sits on top. Modelling the far banks as slabs at a fixed distance
> fails as soon as the island tapers — the crossings at the narrow end come out
> longer than the island is wide.
>
> **`scatter.ts` has a uniform-grid spatial index.** Without it, placing props
> tests every candidate against every road: 67 seconds for this map, which on a
> page load is indistinguishable from a hang. With it, 41ms.
>
> **Open — read before tuning demand.** The brief says a directional plan should
> beat an even split. Measured, it does not yet, reliably: favouring the arterial
> at every junction came out *worse* (5 seeds, 900s, −1.1 veh-h); restricting it
> to the loaded corridor turned it positive but weak (+0.82 veh-h, SNR 1.10); and
> at 10 seeds × 1800s it went negative again (−1.6 veh-h, SNR 0.61). The likely
> cause is oversaturation — by 1800s the network sits near 90 veh-hours of delay
> and every plan looks alike, exactly as the capacity note below predicts. Try a
> lower base demand and a shorter scored window before concluding anything about
> split shape.
>
> **Not done, and agreed as next:** perimeter highways along both shores (the
> FDR / West Side Highway pair) and a Broadway-style diagonal cutting the grid.
> The highways matter for more than looks — they are the extra intake that would
> lift the 1.5 cars/s ceiling. A diagonal will produce five- and six-arm
> junctions, so check phase counts and clearance cost there before keeping it.
>
> The deferred list below is otherwise untouched.

---

# Task: a believable city — curved roads, irregular blocks, heavy traffic

## What this is

A traffic-signal control game in React Three Fiber. You look down on a city in an
Apple-Maps-style 3/4 orthographic view, and you program the traffic lights —
green splits, cycle length, offsets between junctions — to keep the city moving.
There is no manual "make this light green" control; the whole game is writing
signal *plans* and watching what they do.

The simulation underneath is a real one: IDM car-following, lanes as polylines,
conflict-point detection between turning movements, phases derived by graph
colouring over the conflict graph. It is calibrated against real traffic
engineering figures (see "Measured facts" below).

**The goal of this piece of work: make the map read as a believable city rather
than a grid of crossroads.** Curved streets, irregular blocks, and enough
traffic that congestion is the normal state and the player's job is to find and
fix the worst of it. It does not need to be a real place — a convincing
fictional city is fine, and is the cheaper path.

## Where the code is

```
src/sim/      types.ts, network.ts, conflicts.ts, junction.ts, routing.ts,
              signals.ts, idm.ts, world.ts
src/render/   Scene.tsx, RoadNetwork.tsx, Ground.tsx, Buildings.tsx, Trees.tsx,
              Simulation.tsx, Controls.tsx, scatter.ts, geometry.ts
src/levels/   tJunction, crossroads, fiveWays, fourCorners, city, cityGen
src/ui/       Hud.tsx, ProgramPanel.tsx, SplitBar.tsx, hudStore.ts
src/art/      palette.ts
```

~5000 lines. Five levels ship today, ordered by complexity; the last is a
generated 25-junction city scored on network delay (vehicle-hours) rather than
throughput.

## Measured facts — do not re-derive these, and do not contradict them

These came out of a headless measurement harness, not from intuition. Several of
them are load-bearing and non-obvious.

| Fact | Value | Why it matters |
|---|---|---|
| Saturation headway | 2.33 s median, 1.92 s p25 | = 1543 veh/h/lane, against a real-world 1700–1900. The sim is in the right band. |
| Junction capacity | ~2300 veh/h | Demand above this drops arrivals at the kerb and the level becomes a lie. |
| Green-wave resonance | Only works at cycle/travel ≈ 2 (−8.6% delay) and ≈ 4 (−9.9%) | Offsets are a real mechanic, but only at resonance. Off-resonance offsets do nothing. |
| **Uniform demand ⇒ even split is near-optimal** | Measured, repeatedly | This is the big one. With uniform demand the player has no interesting split decision to make. **Split shape only becomes a real decision once demand is directional.** |
| City scale | 6×6 = 474× realtime, 0.18 ms/frame at 5× | Performance is not the blocker at 100–200 junctions. |
| Congestion spread | 28× between best and worst junction | The hotspot mechanic works: worst five are all 4-arm, best are all T-junctions. |

## Traps — real bugs that were found and fixed, and will bite again

Every one of these was invisible on screen and only caught by measurement.

1. **Conflict detection needs BOTH tests.** `src/sim/conflicts.ts` must do proper
   segment intersection *and* closest-approach proximity. Intersection alone
   misses antiparallel overlap (two opposing left turns sharing the junction
   centre without ever crossing). Proximity alone misses a mid-segment crossing
   on a 2-point straight connector — measured case: paths intersect at
   (−4.01, −2.76) but closest vertex approach is 5.58 m against a 2.6 m
   threshold. Miss either and cars drive through each other with no crash
   registered.
2. **Connector bezier must use a true circular-arc control distance**
   (`bend = (4/3)·tan(θ/4)·radius`). A flat `0.55 × chord` collapses opposing
   left turns onto the junction centre.
3. **`MIN_JUNCTION_SIZE = 16`.** Opposing lefts need ~7.4 m of half-width to
   clear. A junction box sized to the carriageway is too small, and the lefts
   then register as conflicting — costing two extra clearance intervals a cycle.
4. **Phase generation must seed straights first**, then rights, then lefts.
   Ordering by conflict degree puts lefts first, blocks opposing throughs, and
   yields four phases each serving one arm at half capacity.
5. **Every movement must appear in at least one phase.** Miss one and routes
   through it become impossible; cars queue forever and nothing tells you.
   There is a dev-time assertion — keep it.
6. **Lane pairing preserves lane index.** Left turns feeding outbound lane 0
   creates a left-only pocket a car can never leave; 16/56 OD pairs became
   unreachable. Single lane per direction is the only conflict-free pairing
   without a lane-change model.
7. **Warmup must survive crashes.** A crash sets state to `lost`, after which
   every step returns early — warmup then silently halts and the city opens
   half-populated.

## The work

### 1. Curved roads (the big one)

`RoadDef` gains `waypoints?: [number, number][]`. Centreline becomes a
Catmull-Rom spline through `[from.pos, ...waypoints, to.pos]`; no waypoints
means a two-point straight, behaving exactly as now.

**The simulation is already curve-ready** — lanes are polylines with cumulative
arc-length tables and `sampleLane` handles any vertex count. That is how curved
junction connectors already work. This is a geometry and rendering job, not a
driving-model one.

Two things are easy to miss:

- **Arm `out` vectors must become the curve tangent at the junction end**, not
  the straight line between node positions. `classifyTurn` and the compass
  naming both read it, and both will silently misclassify turns otherwise.
- **Offset curves self-intersect when the centreline radius is tighter than the
  lane offset.** Validate a minimum radius at load and warn in dev, the same way
  illegal phases are caught.

Rendering (`src/render/RoadNetwork.tsx`) is the bulk of the effort: roads are one
quad each today and become ribbon meshes — walk the centreline, emit edge
vertices at ±width/2, build a triangle strip, and the same one wider for the
kerb. Markings already place by arc length so they port over. `scatter.ts` needs
`distToSegment` to become distance-to-polyline.

### 2. Irregular blocks

`ZoneDef` is rectangle-bound. Add optional `polygon: [number, number][]`, use
point-in-polygon for building scatter and `THREE.Shape` for park fills —
`flatRoundedRect` in `src/render/geometry.ts` shows the existing pattern. Derive
block polygons from the street graph's faces rather than from grid cells, so
curved streets produce curved blocks.

### 3. One-way streets

`RoadDef` gains `oneWay?: boolean`; `buildNetwork` emits lanes for one direction
only. The graph parts need no changes — `buildRouting` works over whatever lanes
exist. The care is in arm assembly: an arm may now have **only** inbound or
**only** outbound lanes, so connector generation must tolerate empty arrays.
Rendering drops the centreline and adds direction arrows.

One-ways are worth doing here rather than later: they are what makes a dense
downtown carry heavy traffic without needing multi-lane approaches, and they
create the asymmetry that makes offsets matter.

### 4. Directional demand — this is what makes "lots of traffic" a game

**Read the measured fact above: with uniform demand, an even split is
near-optimal and the player has nothing to decide.** Heavy traffic on uniform
demand produces gridlock everywhere, which is noise, not a puzzle.

What is needed is demand with structure: origin-destination pairs weighted
toward a downtown core, an arterial that carries several times the flow of the
side streets it crosses, and a rush-hour profile that ramps. Then a plan that
favours the arterial genuinely beats an even split, offsets along the arterial
genuinely beat no offsets, and the congestion hotspot list points at something
the player can actually fix.

Be honest about the ceiling: **~2300 veh/h per junction, 1543 veh/h/lane.** With
one lane per direction, "lots of traffic" means a *dense network* carrying a lot
in total, not a single road carrying more than it physically can. Pushing demand
above capacity drops arrivals at the kerb and quietly invalidates the level.
Multi-lane approaches would raise the ceiling but require a lane-change model
first — that is a separate, substantial piece of work, and trap #6 explains what
happens if you add lanes without it.

## How to verify — this matters more than anything above

**The preview tab runs `hidden`, so rAF is throttled and the HUD rarely
publishes. Visual checking is unreliable. Verify numerically.**

There is a headless console harness. The sim runs ~2700× realtime, and
`window.simWorld`, `window.LEVELS`, `window.hudStore` are exposed in dev. Note
`window.world` is a *different* instance under StrictMode — always probe
`simWorld`.

Assert, for every generated map:

1. Zero illegal phases (no phase contains a conflicting movement pair).
2. Every movement covered by at least one phase.
3. Zero unreachable OD pairs (`buildRouting` cost finite between all sources).
4. Lane polylines monotonic in arc length; no lane self-intersects; a curved
   road's lane length matches its centreline length within tolerance.
5. A 90 s run completes with no crash, and bookkeeping balances
   (spawned = delivered + retired + active).
6. No non-finite state anywhere.

Then measure, don't guess: run the level, look at delay distribution, confirm
that a directional plan beats an even split by more than seed noise. Level
tuning was once dominated by luck — a plan effect of 3.7 cars against 4.9 cars of
seed noise, SNR 0.76. Lengthen runs until the effect clears the noise.

## Art direction

Apple Maps 3D driving view: near-white ground, black roads, muted green parks,
flat-extruded pale buildings, soft wide contact shadows. No hard key light — a
hemisphere light does ~80% of the work. `NoToneMapping` in the renderer, because
ACES would crush the near-whites. Vehicles are Mini-Motorways-simple boxes but
in **real fleet colours** (24% white, 19% black, 15% grey, 12% silver…) so you
cannot read a driver's intent from colour — only from which turning lane they
are in and their indicator. `src/art/palette.ts` holds all of it.

Curved streets and irregular blocks should make this look *better*, not
different — the style is built for organic geometry and has only ever been shown
a grid.

## Deferred — do not start these

- Gap acceptance and give-way junctions
- Roundabouts
- Night mode with light trails
- Lane changing (the honest prerequisite for multi-lane approaches)

## Working style

Build in the order above; stages 1–3 are geometry and can be verified
independently before demand realism goes in. Prefer measuring to assuming — the
three worst bugs in this project's history all looked completely fine on screen.
