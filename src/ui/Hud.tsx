import { useCallback, useEffect, useState } from "react";
import { SIGNAL } from "../art/palette";
import { formatHour } from "../art/daylight";
import type { World } from "../sim/world";
import {
  clearSelection,
  cancelLinking,
  focusJunction,
  nudgeSpeed,
  selectJunction,
  setSpeed,
  sliderForSpeed,
  speedForSlider,
  toggleLayer,
  useHud,
  LAYERS,
} from "./hudStore";
import { ProgramPanel } from "./ProgramPanel";
import { warmupFor } from "../sim/types";
import "./Hud.css";

const SIGNAL_LABEL = {
  green: "Running",
  amber: "Clearing",
  allRed: "All red",
} as const;


function formatClock(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Hud({
  world,
  onAdvance,
  hasNext,
}: {
  world: World;
  onAdvance: () => void;
  hasNext: boolean;
}) {
  const hud = useHud();
  const [layersOpen, setLayersOpen] = useState(false);
  const sandbox = world.level.sandbox === true;
  // A sandbox never ends, so it never shows a result card.
  const over = hud.state !== "running" && !sandbox;
  // No fallback to the first junction: nothing selected means nothing to edit.
  const junction = hud.junctions.find((j) => j.id === hud.selected) ?? null;

  const restart = useCallback(() => {
    world.reset();
    world.warmup(warmupFor(world.level));
    setSpeed(1);
  }, [world]);

  const observe = useCallback(() => {
    world.startObserving();
    // Drop straight into a gentle time-lapse — the point is to watch flow, and
    // patterns like platoons and standing queues only read above real time.
    setSpeed(5);
  }, [world]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" || e.key === "R") {
        restart();
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        setSpeed(useHud.getState().speed === 0 ? 1 : 0);
        return;
      }
      if (e.key === "[") return nudgeSpeed(-1);
      if (e.key === "]") return nudgeSpeed(1);

      // Tab cycles junctions — on a grid, switching attention fast matters more
      // than any single phase call.
      if (e.key === "Tab" && hud.junctions.length > 1) {
        e.preventDefault();
        const i = hud.junctions.findIndex((j) => j.id === hud.selected);
        const next = hud.junctions[(i + (e.shiftKey ? -1 : 1) + hud.junctions.length) % hud.junctions.length];
        if (next) selectJunction(next.id);
        return;
      }

      if (e.key === "Escape") {
        // Back out one layer at a time: the link being built, then the
        // selection, so Escape always means "less UI".
        if (useHud.getState().linking) cancelLinking();
        else clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [world, junction, hud.junctions, hud.selected, over, restart]);

  const progress =
    hud.delayBudget !== null
      ? Math.min(1, hud.delayHours / hud.delayBudget)
      : hud.quota > 0
        ? Math.min(1, hud.delivered / hud.quota)
        : 0;
  // On a delay budget the bar is a threat, not an achievement.
  const barIsThreat = hud.delayBudget !== null;
  const urgent = hud.timeLeft <= 15;
  const throughput = hud.elapsed > 0 ? (hud.delivered / hud.elapsed) * 60 : 0;
  // Beyond about six junctions a flat list stops being scannable, so rank them.
  const crowded = hud.junctions.length > 6;
  const hotspots = crowded
    ? [...hud.junctions].sort((a, b) => b.queue - a.queue).slice(0, 6)
    : hud.junctions;

  // Sun or moon, on the same threshold the street lighting uses.
  const isDark = hud.timeOfDay < 6.4 || hud.timeOfDay > 20.4;

  const dotFor = (signal: keyof typeof SIGNAL_LABEL) =>
    signal === "green" ? SIGNAL.green : signal === "amber" ? SIGNAL.amber : SIGNAL.red;

  return (
    <>
      <div className={"drain" + (over ? " is-active" : "")} />

      {!sandbox && (
      <div className="panel panel-objective">
        {hud.observing && <div className="observe-badge">Observing</div>}
        <div className="objective-row">
          {hud.delayBudget !== null ? (
            <div className="stat">
              <span
                className={
                  "stat-value" +
                  (hud.delayHours > hud.delayBudget * 0.85 ? " is-urgent" : "")
                }
              >
                {hud.delayHours.toFixed(1)}
                {!hud.observing && (
                  <span className="stat-quota">/{hud.delayBudget.toFixed(1)}</span>
                )}
              </span>
              <span className="stat-label">delay hrs</span>
            </div>
          ) : (
            <div className="stat">
              <span className="stat-value">
                {hud.delivered}
                {!hud.observing && <span className="stat-quota">/{hud.quota}</span>}
              </span>
              <span className="stat-label">delivered</span>
            </div>
          )}
          <div className="stat">
            <span className={"stat-value" + (urgent && !hud.observing ? " is-urgent" : "")}>
              {formatClock(hud.observing ? hud.elapsed : hud.timeLeft)}
            </span>
            <span className="stat-label">{hud.observing ? "elapsed" : "remaining"}</span>
          </div>
          <div className="stat">
            <span className="stat-value">{hud.meanWait.toFixed(0)}s</span>
            <span className="stat-label">mean wait</span>
          </div>
          <div className="stat">
            <span className="stat-value">{hud.active}</span>
            <span className="stat-label">on map</span>
          </div>
          {hud.observing && (
            <>
              <div className="stat">
                <span className="stat-value">{throughput.toFixed(0)}</span>
                <span className="stat-label">cars/min</span>
              </div>
              <div className="stat">
                <span className={"stat-value" + (hud.collisions > 0 ? " is-urgent" : "")}>
                  {hud.collisions}
                </span>
                <span className="stat-label">collisions</span>
              </div>
            </>
          )}
        </div>
        {!hud.observing && (
          <div className="progress">
            <div
              className={"progress-fill" + (barIsThreat ? " is-threat" : "")}
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}
      </div>
      )}

      {/*
        Map layers, in the corner, the way every map app puts them. Collapsed to
        a single button by default: these are settings you change once and then
        forget, and they must not compete with the junction you are re-timing.
      */}
      <div className="layers">
        <button
          className={"layers-button" + (layersOpen ? " is-open" : "")}
          onClick={() => setLayersOpen(!layersOpen)}
          title="Map layers"
          aria-expanded={layersOpen}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path
              d="M12 3.5 2.8 8.2l9.2 4.7 9.2-4.7L12 3.5Z M3.6 12.4 12 16.7l8.4-4.3 M3.6 16 12 20.3l8.4-4.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {layersOpen && (
          <div className="panel layers-menu">
            {LAYERS.map((layer) => (
              <label key={layer.name} className="layers-row" title={layer.hint}>
                <input
                  type="checkbox"
                  checked={hud.layers[layer.name]}
                  onChange={() => toggleLayer(layer.name)}
                />
                <span>{layer.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/*
        The one thing always on screen. Everything else — the junction list, the
        program editor — waits until you actually pick a junction, so a city you
        just want to watch stays a city you can see.
      */}
      <div className="panel panel-dock">
        <button
          className={"dock-play" + (hud.speed === 0 ? " is-paused" : "")}
          onClick={() => setSpeed(hud.speed === 0 ? 1 : 0)}
          title={hud.speed === 0 ? "Play (Space)" : "Pause (Space)"}
        >
          {hud.speed === 0 ? "▶" : "❚❚"}
        </button>

        {/* Time controls. The sim is deterministic at any multiple — only how
            many fixed steps a frame consumes changes. */}
        <label className="dock-speed" title="Simulation speed">
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={sliderForSpeed(hud.speed)}
            onChange={(e) => setSpeed(speedForSlider(Number(e.target.value)))}
          />
          <span className="dock-speed-value">
            {hud.speed === 0 ? "paused" : `${hud.speed}×`}
          </span>
        </label>

        <span className="dock-sep" />

        {/*
          The map's own clock. It runs at the simulation's speed, so it doubles
          as a readout of how much of a day the time-lapse is covering — the
          only place that is visible as a number rather than as light.
        */}
        <div
          className="dock-stat dock-clock"
          title={
            hud.layers.daynight
              ? "Time on the map. Real time at 1×; the speed control winds it on"
              : "Day & night is off — the map is held at midday"
          }
        >
          <b>
            {isDark ? "☾" : "☀"} {formatHour(hud.timeOfDay)}
          </b>
          <span>{hud.layers.daynight ? "map time" : "held"}</span>
        </div>

        <span className="dock-sep" />

        {sandbox ? (
          <>
            <div className="dock-stat">
              <b>{hud.active}</b>
              <span>on map</span>
            </div>
            <div className="dock-stat">
              <b>{hud.networkDelay.toFixed(0)}s</b>
              <span>avg delay</span>
            </div>
            <div className="dock-stat">
              <b>{throughput.toFixed(0)}</b>
              <span>cars/min</span>
            </div>
            <label className="dock-demand" title="Cars arriving per second">
              <span>traffic</span>
              <input
                type="range"
                min={0.2}
                max={1.6}
                step={0.02}
                value={hud.demand}
                onChange={(e) => {
                  world.demand = Number(e.target.value);
                }}
              />
              <b>{hud.demand.toFixed(2)}/s</b>
            </label>
          </>
        ) : (
          <div className="dock-stat">
            <b>{hud.active}</b>
            <span>on map</span>
          </div>
        )}

        <span className="dock-sep" />
        <span className="dock-hint">
          {junction ? `editing ${junction.id}` : "click a junction to re-time it"}
        </span>
      </div>

      {/*
        Junctions ranked by how much traffic is waiting at them.
        Past a handful of junctions you cannot scan a flat list, and you should
        not have to — the whole skill is noticing where the city is struggling,
        so the list sorts itself and puts the worst at the top.
      */}
      {hud.junctions.length > 1 && junction && (
        <div className="panel panel-junctions">
          {hotspots.length > 0 && (
            <div className="hotspot-head">
              {crowded ? "Most congested" : "Junctions"}
            </div>
          )}
          {hotspots.map((j) => (
            <button
              key={j.id}
              className={"jchip" + (j.id === hud.selected ? " is-selected" : "")}
              onClick={() => focusJunction(j.id)}
              title={crowded ? "Jump to this junction" : undefined}
            >
              <span className="jchip-dot" style={{ background: dotFor(j.signal) }} />
              <span className="jchip-id">{j.id}</span>
              <span
                className={"jchip-queue" + (j.queue >= 8 ? " is-hot" : "")}
              >
                {j.queue}
              </span>
            </button>
          ))}
        </div>
      )}

      {junction && <ProgramPanel world={world} junction={junction} />}

      {over && (
        <div className="result">
          <div className="result-card">
            <h1 className={hud.state === "won" ? "is-won" : "is-lost"}>
              {hud.state === "won"
                ? "Cleared"
                : hud.failReason === "crash"
                  ? "Collision"
                  : "Out of time"}
            </h1>
            <p>
              {hud.state === "won"
                ? `${hud.delivered} cars through, ${hud.meanWait.toFixed(0)}s average wait.`
                : hud.failReason === "crash"
                  ? "A car was still inside the junction when a crossing movement went green \u2014 it had nowhere to go because the road ahead was full. Watch for lanes tinting warm, and don't hold a phase green into a queue that cannot move."
                  : `${hud.delivered} of ${hud.quota} cars made it through.`}
            </p>
            <div className="result-actions">
              {hud.state === "won" && (
                <button className="result-button" onClick={observe}>
                  Keep watching
                </button>
              )}
              {hud.state === "won" && hasNext && (
                <button className="result-button is-secondary" onClick={onAdvance}>
                  Next level
                </button>
              )}
              <button
                className={
                  "result-button" +
                  (hud.state === "won" ? " is-secondary" : "")
                }
                onClick={restart}
              >
                Try again <kbd>R</kbd>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
