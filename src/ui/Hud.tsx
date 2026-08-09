import { useCallback, useEffect } from "react";
import { SIGNAL } from "../art/palette";
import type { World } from "../sim/world";
import {
  SPEEDS,
  cancelLinking,
  nudgeSpeed,
  selectJunction,
  setSpeed,
  useHud,
} from "./hudStore";
import { ProgramPanel } from "./ProgramPanel";
import "./Hud.css";

const SIGNAL_LABEL = {
  green: "Running",
  amber: "Clearing",
  allRed: "All red",
} as const;

const WARMUP_SECONDS = 35;

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
  const over = hud.state !== "running";
  const junction = hud.junctions.find((j) => j.id === hud.selected) ?? hud.junctions[0];

  const restart = useCallback(() => {
    world.reset();
    world.warmup(WARMUP_SECONDS);
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

      if (e.key === "Escape") cancelLinking();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [world, junction, hud.junctions, hud.selected, over, restart]);

  const progress = hud.quota > 0 ? Math.min(1, hud.delivered / hud.quota) : 0;
  const urgent = hud.timeLeft <= 15;
  const throughput = hud.elapsed > 0 ? (hud.delivered / hud.elapsed) * 60 : 0;
  const dotFor = (signal: keyof typeof SIGNAL_LABEL) =>
    signal === "green" ? SIGNAL.green : signal === "amber" ? SIGNAL.amber : SIGNAL.red;

  return (
    <>
      <div className={"drain" + (over ? " is-active" : "")} />

      <div className="panel panel-objective">
        {hud.observing && <div className="observe-badge">Observing</div>}
        <div className="objective-row">
          <div className="stat">
            <span className="stat-value">
              {hud.delivered}
              {!hud.observing && <span className="stat-quota">/{hud.quota}</span>}
            </span>
            <span className="stat-label">delivered</span>
          </div>
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
            <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>

      {/* Time controls. The sim is deterministic at any multiple — only how many
          fixed steps a frame consumes changes. */}
      <div className="panel panel-speed">
        {hud.observing && (
          <label className="demand" title="Cars arriving per second">
            <span className="demand-label">traffic</span>
            <input
              type="range"
              min={0.2}
              max={2.6}
              step={0.1}
              value={hud.demand}
              onChange={(e) => {
                world.demand = Number(e.target.value);
              }}
            />
            <span className="demand-value">{hud.demand.toFixed(1)}/s</span>
          </label>
        )}
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={"speed" + (hud.speed === s ? " is-current" : "")}
            onClick={() => setSpeed(s)}
            title={s === 0 ? "Pause (Space)" : `${s}x speed`}
          >
            {s === 0 ? "❚❚" : `${s}×`}
          </button>
        ))}
      </div>

      {/* One chip per junction: its signal state and how much traffic is waiting. */}
      {hud.junctions.length > 1 && (
        <div className="panel panel-junctions">
          {hud.junctions.map((j) => (
            <button
              key={j.id}
              className={"jchip" + (j.id === hud.selected ? " is-selected" : "")}
              onClick={() => selectJunction(j.id)}
            >
              <span className="jchip-dot" style={{ background: dotFor(j.signal) }} />
              <span className="jchip-id">{j.id}</span>
              <span className="jchip-queue">{j.queue}</span>
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
