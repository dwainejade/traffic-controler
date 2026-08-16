import { useEffect, useMemo, useState } from "react";
import { useLevels } from "./levels/registry";
import { Scene } from "./render/Scene";
import { Hud } from "./ui/Hud";
import { LevelSheet } from "./ui/LevelSheet";
import { measure, validateLevel } from "./sim/validate";
import { warmupFor, type LevelDef } from "./sim/types";
import { World } from "./sim/world";
import { SIM_RADIUS_FLOOR } from "./sim/region";
import "./App.css";

/** Levels already validated this session — StrictMode mounts everything twice. */
const validated = new Set<string>();

/** Warmed worlds, keyed by level, for the same reason. */
const worldCache = new WeakMap<LevelDef, World>();


export default function App() {
  /*
   * The list grows: saved areas are read from IndexedDB a moment after boot,
   * and imported ones are appended whenever the player adds them. So the
   * current level is held by id — an index would mean "position in a list that
   * changed shape underneath me".
   */
  const levels = useLevels((s) => s.levels);
  const [currentId, setCurrentId] = useState<string | null>(null);

  /*
   * Open on the first imported area. The small junctions are still there to
   * learn on, but a real street is the thing worth looking at, and it should be
   * the thing you land in. By id prefix, not by position — dev builds append a
   * test level after it. The last fallback also covers a saved area being
   * deleted while it was the one on screen.
   */
  const level =
    levels.find((l) => l.id === currentId) ??
    levels.find((l) => l.id.startsWith("osm_")) ??
    levels[0];
  const index = levels.indexOf(level);

  /*
   * Console handle on the level list. Its own effect rather than a line inside
   * the world memo below, which returns early on a cache hit and so would leave
   * this pointing at the list as it was before the saved areas loaded.
   */
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(globalThis, { LEVELS: levels });
  }, [levels]);

  // The world lives outside React entirely — React only ever reads a throttled
  // mirror of it. Re-rendering on simulation state would cost more than the sim.
  const world = useMemo(() => {
    /*
     * StrictMode runs this factory twice, and on a city-sized map the warmup is
     * seconds of work — paying it twice is seconds of blank screen. Hand back
     * the same warmed world for a given level instead.
     */
    const cached = worldCache.get(level);
    if (cached) return cached;

    const w = new World(level);
    /*
     * Clip before warming, not after. The warmup is the single most expensive
     * thing that happens when a level opens — it is seconds of simulation run
     * with nothing on screen — and running it over the whole map only to then
     * confine the live simulation to a corner of it pays the full price for
     * traffic that is immediately thrown away. The origin is where every level
     * frames its camera, so it is where the region wants to start.
     *
     * At the floor, not at whatever the opening zoom will end up wanting: the
     * first frame grows the region to cover the view, and growing seeds the new
     * streets to the density this warmup just established. Warming small and
     * growing is the same picture for a fraction of the work.
     */
    w.setRegion(0, 0, SIM_RADIUS_FLOOR);
    w.warmup(warmupFor(level));
    worldCache.set(level, w);

    // Debug handle: lets the sim be driven and inspected from the console
    // independently of the render loop, which is how the timing plans were tuned.
    if (import.meta.env.DEV) {
      Object.assign(globalThis, {
        world: w,
        SIMDEV: { World, validateLevel, measure },
      });

      // Every map is asserted on load — the worst bugs in this project's
      // history were all invisible on screen and only caught numerically.
      //
      // Except the benchmark cities. Validation checks every origin against
      // every destination, and at the sizes those exist to reach that is a few
      // thousand sources squared: minutes of work to re-prove a generator that
      // the shipped levels already exercise.
      if (!validated.has(level.id) && !level.id.startsWith("bench-")) {
        validated.add(level.id);
        const result = validateLevel(level);
        for (const e of result.errors) console.error(`[validate ${level.id}] ${e}`);
        for (const warning of result.warnings) console.warn(`[validate ${level.id}] ${warning}`);
      }
    }
    return w;
  }, [level]);

  const goTo = (id: string) => setCurrentId(id);

  return (
    <div className="app">
      <Scene key={level.id} level={level} world={world} />
      <LevelSheet current={level} onPick={goTo} />
      <Hud
        world={world}
        onAdvance={() => {
          const next = levels[index + 1];
          if (next) goTo(next.id);
        }}
        hasNext={index < levels.length - 1}
      />
    </div>
  );
}
