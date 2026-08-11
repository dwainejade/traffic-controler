import { useEffect, useRef, useState } from "react";
import {
  importArea,
  validateInput,
  ImportError,
  RADIUS_DEFAULT,
  RADIUS_MAX,
  RADIUS_MIN,
  RADIUS_WARN,
  type ImportPhase,
} from "../levels/osm/importArea";
import { MAX_AREAS, useLevels } from "../levels/registry";

/**
 * Import any square kilometre of the real world.
 *
 * Coordinates and a radius, straight to Overpass and back as a playable level.
 * The wait is ten seconds on a good day and a minute on a bad one, so the form
 * says which mirror it is asking and stays cancellable throughout.
 */

/** What the phase looks like to somebody watching it. */
function phaseLabel(p: ImportPhase): string {
  switch (p.kind) {
    case "fetching":
      return p.retry
        ? `Asking ${p.endpoint} again (${p.index + 1} of ${p.total})…`
        : `Asking ${p.endpoint} (${p.index + 1} of ${p.total})…`;
    case "compiling":
      return "Building the street network…";
    case "checking":
      return "Running a few seconds of traffic…";
    case "saving":
      return "Saving…";
    default:
      return "";
  }
}

export function ImportForm({ onImported }: { onImported: (id: string) => void }) {
  const saved = useLevels((s) => s.saved);
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [radius, setRadius] = useState(String(RADIUS_DEFAULT));
  const [phase, setPhase] = useState<ImportPhase>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);

  const busy = phase.kind !== "idle" && phase.kind !== "error";
  const full = saved.length >= MAX_AREAS;

  /*
   * A running clock, because this can legitimately take a minute or two and
   * "Asking overpass-api.de…" on its own is indistinguishable from a hang. It
   * is also the honest way to make somebody's patience their own decision:
   * there is a Cancel button right beside it.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
    // Only on the transition into a run — not on every phase change, or the
    // clock restarts when the fetch hands over to the compile.
  }, [busy]);

  /*
   * Coordinates get copied out of a map as a pair, not as two numbers, so
   * pasting "40.7033, -73.9881" into the latitude field fills in both rather
   * than being rejected for having a comma in it.
   */
  const onLatInput = (value: string) => {
    const pair = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (pair) {
      setLat(pair[1]);
      setLon(pair[2]);
      return;
    }
    setLat(value);
  };

  const input = {
    name,
    lat: Number(lat),
    lon: Number(lon),
    radius: Number(radius),
  };
  const problem = validateInput(input);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || full || problem) return;

    const controller = new AbortController();
    abort.current = controller;
    try {
      const area = await importArea(input, {
        signal: controller.signal,
        onPhase: setPhase,
      });
      setPhase({ kind: "idle" });
      setName("");
      onImported(area.id);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({
        kind: "error",
        message: err instanceof ImportError ? err.message : "Something went wrong.",
        detail: err instanceof ImportError ? err.detail : String(err),
      });
    } finally {
      abort.current = null;
    }
  };

  return (
    <form className="import-form" onSubmit={submit}>
      <div className="import-row">
        <label className="import-field is-wide">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shibuya Crossing"
            disabled={busy}
          />
        </label>
      </div>

      <div className="import-row">
        <label className="import-field">
          <span>Latitude</span>
          <input
            value={lat}
            onChange={(e) => onLatInput(e.target.value)}
            inputMode="decimal"
            placeholder="40.7033"
            disabled={busy}
          />
        </label>
        <label className="import-field">
          <span>Longitude</span>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            inputMode="decimal"
            placeholder="-73.9881"
            disabled={busy}
          />
        </label>
      </div>

      <label className="import-field is-slider">
        <span>Radius</span>
        <input
          type="range"
          min={RADIUS_MIN}
          max={RADIUS_MAX}
          step={10}
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          disabled={busy}
        />
        <b>{radius}m</b>
      </label>

      <p className="import-note">
        {Number(radius) > RADIUS_WARN
          ? "A box this big takes a minute or more, and plays as a city rather than a junction."
          : `A ${Number(radius) * 2}m square, centred on those coordinates.`}
      </p>

      {phase.kind === "error" && (
        <div className="import-error">
          <p>{phase.message}</p>
          {phase.detail && (
            <details>
              <summary>Details</summary>
              <pre>{phase.detail}</pre>
            </details>
          )}
        </div>
      )}

      {busy ? (
        <div className="import-busy">
          <span className="import-spinner" />
          <span>
            {phaseLabel(phase)} <b>{elapsed}s</b>
          </span>
          <button type="button" className="btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="import-actions">
          <button className="btn is-primary" disabled={full || !!problem}>
            Import area
          </button>
          <span className="import-note">
            {full
              ? `${MAX_AREAS} saved areas is the limit — delete one to add another.`
              : (problem ?? `${saved.length} of ${MAX_AREAS} saved`)}
          </span>
        </div>
      )}
    </form>
  );
}
