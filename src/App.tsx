import { useEffect, useMemo, useState } from "react";
import { useLevels } from "./levels/registry";
import { Scene } from "./render/Scene";
import { Hud } from "./ui/Hud";
import { LevelSheet } from "./ui/LevelSheet";
import { useHud } from "./ui/hudStore";
import { measure, validateLevel } from "./sim/validate";
import { warmupFor, type LevelDef } from "./sim/types";
import { World } from "./sim/world";
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
      if (!validated.has(level.id)) {
        validated.add(level.id);
        const result = validateLevel(level);
        for (const e of result.errors) console.error(`[validate ${level.id}] ${e}`);
        for (const warning of result.warnings) console.warn(`[validate ${level.id}] ${warning}`);
      }
    }
    return w;
  }, [level]);

  const goTo = (id: string) => {
    // Selection belongs to the old level's junctions; clear it before switching.
    useHud.setState({ selected: null });
    setCurrentId(id);
  };

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
