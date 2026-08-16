import { useCallback, useEffect, useState } from "react";
import { formatHour } from "../art/daylight";
import type { World } from "../sim/world";
import {
  nudgeSpeed,
  setSpeed,
  sliderForSpeed,
  speedForSlider,
  toggleLayer,
  useHud,
  LAYERS,
} from "./hudStore";
import { useIsMobile } from "./useIsMobile";
import { warmupFor } from "../sim/types";
import { typing } from "./typing";
import "./Hud.css";


function formatClock(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The car in the info button — the same three-quarter silhouette the map uses. */
function CarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M3.4 14.6h17.2M5 14.6l1.6-4.9a2 2 0 0 1 1.9-1.4h7a2 2 0 0 1 1.9 1.4l1.6 4.9M4.2 14.6v2.6a.8.8 0 0 0 .8.8h1.4a.8.8 0 0 0 .8-.8v-.9m12 -1.7v2.6a.8.8 0 0 1-.8.8h-1.4a.8.8 0 0 1-.8-.8v-.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.2 16.4h9.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
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
  const mobile = useIsMobile();
  const [layersOpen, setLayersOpen] = useState(false);
  // The mobile info sheet: everything the bottom bar no longer has room for.
  const [infoOpen, setInfoOpen] = useState(false);
  const sandbox = world.level.sandbox === true;
  // A sandbox never ends, so it never shows a result card.
  const over = hud.state !== "running" && !sandbox;
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
      // Straight in and out of the street-level camera, from anywhere.
      if ((e.key === "v" || e.key === "V") && !e.metaKey && !e.ctrlKey && !e.altKey && !typing()) {
        toggleLayer("walkCamera");
        return;
      }

      if (e.key === "[") return nudgeSpeed(-1);
      if (e.key === "]") return nudgeSpeed(1);

    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [world, over, restart]);

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
  // Sun or moon, on the same threshold the street lighting uses.
  const isDark = hud.timeOfDay < 6.4 || hud.timeOfDay > 20.4;

  /*
   * The blocks below are written once and placed twice: on a wide screen they
   * are floating panels in their own corners, on a narrow one they stack inside
   * the info sheet. Only the container changes.
   */

  const objective = !sandbox && (
    <>
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
    </>
  );

  /* Sandbox has no objective, only a dashboard and a demand dial. */
  const sandboxStats = sandbox && (
    <>
      <div className="objective-row">
        <div className="stat">
          <span className="stat-value">{hud.active}</span>
          <span className="stat-label">on map</span>
        </div>
        <div className="stat">
          <span className="stat-value">{hud.networkDelay.toFixed(0)}s</span>
          <span className="stat-label">avg delay</span>
        </div>
        <div className="stat">
          <span className="stat-value">{throughput.toFixed(0)}</span>
          <span className="stat-label">cars/min</span>
        </div>
      </div>
      <label className="sheet-demand" title="Cars arriving per second">
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
  );

  return (
    <>
      <div className={"drain" + (over ? " is-active" : "")} />

      {/* What the keys do while the camera is yours, since the mouse is captured. */}
      {hud.layers.walkCamera && (
        <div className="walk-badge">
          {"Walk mode — click to look · WASD move · F fly · Shift sprint · Esc frees the mouse, again to exit"}
        </div>
      )}

      {!sandbox && !mobile && (
        <div className="panel panel-objective">{objective}</div>
      )}

      {/*
        Map layers, in the corner, the way every map app puts them. Collapsed to
        a single button by default: these are settings you change once and then
        forget, and they must not compete with the map itself.
      */}
      <div className="layers">
        <button
          className={"icon-button" + (layersOpen ? " is-open" : "")}
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
        The one thing always on screen. On a phone it is only the two controls
        you reach for while watching — time, and what time it is — and the rest
        moves behind the car button beside it.
      */}
      <div className={"panel panel-dock" + (mobile ? " is-mobile" : "")}>
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

        {!mobile && (
          <>
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

                {/*
                  What the simulation is actually covering. Dev only, and only
                  once a map is big enough to be clipped: the whole point of the
                  region is that you cannot tell, so the only way to see it
                  working is to print it.
                */}
                {import.meta.env.DEV && hud.simLanesTotal > 0 && (
                  <div
                    className="dock-stat"
                    title="Lanes being simulated, of the whole map"
                  >
                    <b>
                      {hud.simRadius === null
                        ? "whole map"
                        : `${Math.round(hud.simRadius)}m`}
                    </b>
                    <span>
                      {Math.round((hud.simLanes / hud.simLanesTotal) * 100)}% of{" "}
                      {hud.simLanesTotal} lanes
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="dock-stat">
                <b>{hud.active}</b>
                <span>on map</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* The car: everything the bottom bar gave up, one tap away. */}
      {mobile && (
        <button
          className={"icon-button info-button" + (infoOpen ? " is-open" : "")}
          onClick={() => setInfoOpen(!infoOpen)}
          title="Run details"
          aria-expanded={infoOpen}
        >
          <CarIcon />
        </button>
      )}

      {mobile && infoOpen && (
        <>
          <div className="sheet-scrim" onClick={() => setInfoOpen(false)} />
          <div className="sheet">
            <div className="sheet-grip" />
            <div className="sheet-body">
              {objective}
              {sandboxStats}
            </div>
          </div>
        </>
      )}

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
                  ? "A car was still inside the junction when a crossing movement went green — it had nowhere to go because the road ahead was full. Watch for lanes tinting warm, and don't hold a phase green into a queue that cannot move."
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
