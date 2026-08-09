import { useMemo, useState } from "react";
import { LEVEL_1 } from "./levels/level1";
import { LEVEL_2 } from "./levels/level2";
import { Scene } from "./render/Scene";
import { Hud } from "./ui/Hud";
import { useHud } from "./ui/hudStore";
import { World } from "./sim/world";
import "./App.css";

const LEVELS = [LEVEL_1, LEVEL_2];
const WARMUP_SECONDS = 35;

export default function App() {
  const [index, setIndex] = useState(0);
  const level = LEVELS[index];

  // The world lives outside React entirely — React only ever reads a throttled
  // mirror of it. Re-rendering on simulation state would cost more than the sim.
  const world = useMemo(() => {
    const w = new World(level);
    w.warmup(WARMUP_SECONDS);

    // Debug handle: lets the sim be driven and inspected from the console
    // independently of the render loop, which is how the timing plans were tuned.
    if (import.meta.env.DEV) {
      Object.assign(globalThis, { world: w, LEVELS });
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
