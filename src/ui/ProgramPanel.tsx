import { MIN_PHASE_GREEN, type World } from "../sim/world";
import { TIMING } from "../sim/junction";
import {
  cancelLinking,
  startLinking,
  useHud,
  type JunctionHud,
} from "./hudStore";
import { PHASE_COLOURS, SplitBar } from "./SplitBar";
import "./ProgramPanel.css";

const CLEARANCE = TIMING.amber + TIMING.allRed;

/**
 * The signal programming editor.
 *
 * Everything here edits the world directly — the world lives outside React and
 * the store is only a mirror, so these calls mutate and the next publish tick
 * reflects it.
 */
export function ProgramPanel({
  world,
  junction,
}: {
  world: World;
  junction: JunctionHud;
}) {
  const { junctions, groups, linking, linkSelection } = useHud();
  const group = groups.find((g) => g.id === junction.groupId);
  const minCycle = junction.splits.length * (MIN_PHASE_GREEN + CLEARANCE);

  if (linking) {
    return (
      <div className="panel panel-program is-linking">
        <div className="program-head">
          <span className="program-title">Link junctions</span>
        </div>
        <p className="program-hint">
          Click junctions to add them to the group. They will share one cycle
          length — coordination is impossible without it — but can keep their own
          splits and offsets.
        </p>
        <div className="link-chips">
          {linkSelection.length === 0 && <span className="program-hint">None selected</span>}
          {linkSelection.map((id) => (
            <span className="link-chip" key={id}>
              {id}
            </span>
          ))}
        </div>
        <div className="program-actions">
          <button
            className="btn is-primary"
            disabled={linkSelection.length < 2}
            onClick={() => {
              world.linkJunctions(linkSelection);
              cancelLinking();
            }}
          >
            Link {linkSelection.length > 1 ? `${linkSelection.length} junctions` : ""}
          </button>
          <button className="btn" onClick={cancelLinking}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel panel-program">
      <div className="program-head">
        <span className="program-title">{junction.id}</span>
        {group && (
          <span className="program-badge">
            {group.name}
            {junction.hasOverride && " · subprogram"}
          </span>
        )}
        <span className="program-cycle">{junction.cycle.toFixed(0)}s cycle</span>
      </div>

      <SplitBar
        splits={junction.splits}
        amber={TIMING.amber}
        allRed={TIMING.allRed}
        phases={junction.phases}
        current={junction.current}
        onShift={(i, seconds) => world.shiftSplit(junction.id, i, seconds)}
      />

      {/* Exact entry alongside the bar — dragging is for feel, numbers for precision. */}
      <div className="program-phases">
        {junction.phases.map((name, i) => (
          <label className="program-phase" key={name}>
            <span
              className="program-swatch"
              style={{ background: PHASE_COLOURS[i % PHASE_COLOURS.length] }}
            />
            <span className="program-phase-name">{name}</span>
            <input
              type="number"
              min={MIN_PHASE_GREEN}
              step={1}
              value={Math.round(junction.splits[i])}
              onChange={(e) => world.setSplit(junction.id, i, Number(e.target.value))}
            />
            <span className="program-unit">s</span>
          </label>
        ))}
      </div>

      <div className="program-row">
        <label className="program-field">
          <span>Cycle</span>
          <input
            type="range"
            min={Math.round(minCycle)}
            max={180}
            step={1}
            value={Math.round(junction.cycle)}
            onChange={(e) => world.setCycle(junction.id, Number(e.target.value))}
          />
          <span className="program-value">{junction.cycle.toFixed(0)}s</span>
        </label>
      </div>

      {group && (
        <div className="program-row">
          <label className="program-field">
            <span>Offset</span>
            <input
              type="range"
              min={0}
              max={Math.round(junction.cycle)}
              step={0.5}
              value={junction.offset}
              onChange={(e) => world.setOffset(junction.id, Number(e.target.value))}
            />
            <span className="program-value">{junction.offset.toFixed(1)}s</span>
          </label>
        </div>
      )}

      <div className="program-actions">
        {!group && (
          <button className="btn" onClick={() => startLinking(junction.id)}>
            Link…
          </button>
        )}

        {group && (
          <>
            <button
              className="btn"
              onClick={() => world.autoGreenWave(group.id)}
              title="Offset each junction by its travel time from the first, so a platoon meets green all the way along"
            >
              Auto green wave
            </button>
            <button
              className="btn"
              onClick={() => world.setOverride(junction.id, !junction.hasOverride)}
            >
              {junction.hasOverride ? "Follow parent" : "Subprogram"}
            </button>
            <button className="btn" onClick={() => world.unlinkJunction(junction.id)}>
              Unlink
            </button>
          </>
        )}
      </div>

      {group && (
        <div className="program-members">
          {group.members.map((id) => {
            const member = junctions.find((j) => j.id === id);
            return (
              <span
                key={id}
                className={"member" + (id === junction.id ? " is-current" : "")}
              >
                {id}
                <em>{member ? `${member.offset.toFixed(0)}s` : "—"}</em>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
