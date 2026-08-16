import { useEffect, useState } from "react";
import type { LevelDef } from "../sim/types";
import { LEVELS } from "../levels";
import { ImportError, importStoredArea } from "../levels/osm/importArea";
import { listDbAreas, type DbArea } from "../levels/osm/worldDb";
import { addTransientLevel, MAX_AREAS, removeArea, useLevels } from "../levels/registry";
import { benchLevel } from "../levels/bench";
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

/** Half-extents offered as one-click benchmarks, in metres. */
const BENCH_SIZES = [600, 1000, 1500, 2000, 2500];

/**
 * Areas the local world store has ready, if it is running.
 *
 * A whole borough is sixty-odd of these, so they are *listed* rather than
 * loaded: the list is a few kilobytes, and a compiled cell is megabytes. One is
 * downloaded when somebody picks it, and from then on it is an ordinary saved
 * area — which is what keeps this out of the registry entirely.
 */
function StoreGroup({
  current,
  onPick,
}: {
  current: LevelDef;
  onPick: (id: string) => void;
}) {
  const saved = useLevels((s) => s.saved);
  const [areas, setAreas] = useState<DbArea[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Refreshed on mount rather than once at boot, because the thing that changes
   * this list is the ingest tool running in another terminal — so reopening the
   * level list is the natural way to pick up a borough that has just finished
   * baking.
   */
  useEffect(() => {
    let live = true;
    void listDbAreas().then((list) => live && setAreas(list));
    return () => {
      live = false;
    };
  }, []);

  // No store, or a store with nothing in it: say nothing at all. Most people
  // will never run one, and an empty section is a question they cannot answer.
  if (!areas || areas.length === 0) return null;

  const full = saved.length >= MAX_AREAS;
  /** Store ids already held, so the same cell is not downloaded twice. */
  const held = new Map(saved.filter((a) => a.storeId).map((a) => [a.storeId!, a.id]));

  const take = async (area: DbArea) => {
    const mine = held.get(area.id);
    if (mine) return onPick(mine);
    if (full || busy) return;

    setBusy(area.id);
    setError(null);
    try {
      const added = await importStoredArea(area);
      onPick(added.id);
    } catch (err) {
      setError(err instanceof ImportError ? err.message : "Couldn't load that area.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="level-group">
      <div className="level-head">World store</div>
      {areas.map((a) => {
        const mine = held.get(a.id);
        return (
          <div
            key={a.id}
            className={"level-row" + (mine && mine === current.id ? " is-current" : "")}
          >
            <button
              className="level-pick is-stacked"
              onClick={() => void take(a)}
              disabled={busy !== null || (full && !mine)}
            >
              <span className="level-name">{a.name}</span>
              <span className="level-detail">
                {busy === a.id
                  ? "Loading…"
                  : mine
                    ? "saved"
                    : `${(a.radius * 2) / 1000}km · ${(a.bytes / 1024 / 1024).toFixed(1)} MB`}
              </span>
            </button>
          </div>
        );
      })}
      {error && <p className="level-empty">{error}</p>}
      {full && <p className="level-empty">{MAX_AREAS} saved areas is the limit — delete one to add another.</p>}
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
  const bench = useLevels((s) => s.bench);
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

      {/*
        Above the importer and below your own areas, because that is the order
        of effort: what you already have, then what is a download away, then
        what is a trip to OpenStreetMap away.
      */}
      <StoreGroup current={current} onPick={pick} />

      {/*
        Benchmark cities, dev only. Sizes are offered rather than listed,
        because building one is real work — a 25 km² grid is about half a second
        of geometry — and nothing should pay that on every boot to populate a
        menu. Clicking a size builds it, adds it to the list and switches to it;
        clicking it again is free, because `benchLevel` hands back the same
        object it built the first time.
      */}
      {import.meta.env.DEV && (
        <div className="level-group">
          <div className="level-head">Benchmarks</div>
          <div className="bench-sizes">
            {BENCH_SIZES.map((half) => (
              <button
                key={half}
                className="bench-size"
                onClick={() => {
                  const level = benchLevel(half);
                  addTransientLevel(level);
                  pick(level.id);
                }}
              >
                {(half * 2) / 1000}km
              </button>
            ))}
          </div>
          {bench.map((l) => (
            <div key={l.id} className={"level-row" + (l.id === current.id ? " is-current" : "")}>
              <button className="level-pick" onClick={() => pick(l.id)}>
                <span className="level-name">{l.name}</span>
                <span className="level-detail">
                  {l.nodes.filter((n) => n.kind === "junction").length} junctions
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

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
