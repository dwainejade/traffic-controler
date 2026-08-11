import { useState } from "react";
import type { LevelDef } from "../sim/types";
import { LEVELS } from "../levels";
import { removeArea, useLevels } from "../levels/registry";
import { ImportForm } from "./ImportForm";
import { Sheet } from "./Sheet";
import { useIsMobile } from "./useIsMobile";
import "./LevelSheet.css";

/**
 * The level picker, and the only way into the area importer.
 *
 * A row of numbered buttons was fine for four hand-authored levels. It is not
 * fine once the list is however many places the player has imported, and on a
 * phone it was never fine at all — so the whole thing collapses to one button
 * showing where you are, and opens a list that has room for real names.
 */

function relativeTime(then: number): string {
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The one place a saved area can be deleted, so it asks before it does. */
function SavedRow({
  name,
  detail,
  isCurrent,
  onPick,
  onDelete,
}: {
  name: string;
  detail: string;
  isCurrent: boolean;
  onPick: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={"level-row" + (isCurrent ? " is-current" : "")}>
      {/* Stacked, not inline: "40.7265, -73.9815 · 150m · 1m ago" is longer
          than any name and would squeeze it down to an ellipsis. */}
      <button className="level-pick is-stacked" onClick={onPick}>
        <span className="level-name">{name}</span>
        <span className="level-detail">{detail}</span>
      </button>
      <button
        className={"level-delete" + (confirming ? " is-confirming" : "")}
        onClick={() => (confirming ? onDelete() : setConfirming(true))}
        onBlur={() => setConfirming(false)}
        title={isCurrent ? "Deleting the area you are playing" : "Delete this area"}
      >
        {confirming ? "Delete?" : "×"}
      </button>
    </div>
  );
}

export function LevelSheet({
  current,
  onPick,
}: {
  current: LevelDef;
  onPick: (id: string) => void;
}) {
  const mobile = useIsMobile();
  const saved = useLevels((s) => s.saved);
  const [open, setOpen] = useState(false);

  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
  };

  const body = (
    <>
      <div className="level-group">
        <div className="level-head">Levels</div>
        {LEVELS.map((l) => (
          <div key={l.id} className={"level-row" + (l.id === current.id ? " is-current" : "")}>
            <button className="level-pick" onClick={() => pick(l.id)}>
              <span className="level-name">{l.name}</span>
              {l.sandbox && <span className="level-detail">sandbox</span>}
            </button>
          </div>
        ))}
      </div>

      <div className="level-group">
        <div className="level-head">Your areas</div>
        {saved.length === 0 && (
          <p className="level-empty">
            Nothing saved yet. Import anywhere in the world below.
          </p>
        )}
        {saved.map((a) => (
          <SavedRow
            key={a.id}
            name={a.name}
            detail={`${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} · ${a.radius}m · ${relativeTime(a.savedAt)}`}
            isCurrent={a.id === current.id}
            onPick={() => pick(a.id)}
            onDelete={() => {
              /*
               * Deleting what you are playing is allowed — refusing would mean
               * explaining why. `App` falls back to the first real place when
               * the level it was showing goes away.
               */
              void removeArea(a.id);
            }}
          />
        ))}
      </div>

      <div className="level-group">
        <div className="level-head">Import an area</div>
        <ImportForm onImported={pick} />
      </div>
    </>
  );

  return (
    <div className="levels">
      <button
        className={"panel level-button" + (open ? " is-open" : "")}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M9 4.2 3.5 6.4v13.4L9 17.6l6 2.2 5.5-2.2V4.2L15 6.4 9 4.2Z M9 4.2v13.4 M15 6.4v13.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        <span className="level-button-name">{current.name}</span>
      </button>

      {mobile ? (
        <Sheet open={open} onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      ) : (
        open && <div className="panel level-menu">{body}</div>
      )}
    </div>
  );
}
