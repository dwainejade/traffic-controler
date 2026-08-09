import { useCallback, useRef } from "react";
import { SIGNAL } from "../art/palette";

/** Phase block colours, cycled. Distinct enough to track across the bar. */
const PHASE_COLOURS = ["#2D8FD5", "#16A394", "#8B5CF6", "#F0A830", "#E8503A"];

/**
 * The whole signal cycle as one bar.
 *
 * Each phase is a block sized by its green time, separated by amber and all-red
 * slivers drawn to scale. Showing clearance rather than hiding it is the point:
 * every phase change costs ~3.4s of cycle that serves nobody, which is why a
 * short-cycle plan performs so badly — and that has to be visible, not folded
 * into a number.
 *
 * Dragging a divider moves green time between the two phases it separates, so
 * the cycle length holds and the trade-off is direct.
 */
export function SplitBar({
  splits,
  amber,
  allRed,
  phases,
  current,
  onShift,
}: {
  splits: number[];
  amber: number;
  allRed: number;
  phases: string[];
  current: number;
  onShift: (index: number, seconds: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; startX: number } | null>(null);

  const cycle =
    splits.reduce((a, b) => a + b, 0) + splits.length * (amber + allRed);
  const pct = (seconds: number) => `${(seconds / cycle) * 100}%`;

  const onPointerDown = useCallback(
    (index: number) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { index, startX: e.clientX };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const state = drag.current;
      const el = track.current;
      if (!state || !el) return;

      // Convert pixels travelled into seconds of cycle time.
      const perSecond = el.clientWidth / cycle;
      const seconds = (e.clientX - state.startX) / perSecond;
      if (Math.abs(seconds) < 0.05) return;

      onShift(state.index, seconds);
      state.startX = e.clientX;
    },
    [cycle, onShift],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  return (
    <div
      className="splitbar"
      ref={track}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {splits.map((green, i) => (
        <div className="splitbar-group" key={i} style={{ width: pct(green + amber + allRed) }}>
          <div
            className={"splitbar-phase" + (i === current ? " is-current" : "")}
            style={{
              width: `${(green / (green + amber + allRed)) * 100}%`,
              background: PHASE_COLOURS[i % PHASE_COLOURS.length],
            }}
            title={`${phases[i]} — ${green.toFixed(1)}s green`}
          >
            <span className="splitbar-label">{green.toFixed(0)}</span>
          </div>

          {/* Clearance, to scale. This is the cost of every phase change. */}
          <div
            className="splitbar-clear"
            style={{
              width: `${(amber / (green + amber + allRed)) * 100}%`,
              background: SIGNAL.amber,
            }}
          />
          <div
            className="splitbar-clear"
            style={{
              width: `${(allRed / (green + amber + allRed)) * 100}%`,
              background: SIGNAL.red,
            }}
          />

          {i < splits.length - 1 && (
            <div
              className="splitbar-handle"
              onPointerDown={onPointerDown(i)}
              title="Drag to move green time between these phases"
            />
          )}
        </div>
      ))}
    </div>
  );
}

export { PHASE_COLOURS };
