import { useMemo, useState } from "react";
import { LEVELS } from "./levels";
import { Scene } from "./render/Scene";
import { Hud } from "./ui/Hud";
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
  // Open on the first imported area. The small junctions are still there to
  // learn on, but a real street is the thing worth looking at, and it should be
  // the thing you land in. By id prefix, not by position — dev builds append a
  // test level after it.
  const [index, setIndex] = useState(() =>
    Math.max(0, LEVELS.findIndex((l) => l.id.startsWith("osm_"))),
  );
  const level = LEVELS[index];

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
        LEVELS,
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

  const goTo = (next: number) => {
    // Selection belongs to the old level's junctions; clear it before switching.
    useHud.setState({ selected: null });
    setIndex(Math.max(0, Math.min(next, LEVELS.length - 1)));
  };

  return (
    <div className="app">
      <Scene key={level.id} level={level} world={world} />
      <div className="panel panel-title">
        <span className="title-name">{level.name}</span>
        <span className="title-levels">
          {LEVELS.map((l, i) => (
            <button
              key={l.id}
              className={"title-level" + (i === index ? " is-current" : "")}
              onClick={() => goTo(i)}
            >
              {i + 1}
            </button>
          ))}
        </span>
      </div>
      <Hud world={world} onAdvance={() => goTo(index + 1)} hasNext={index < LEVELS.length - 1} />
    </div>
  );
}
