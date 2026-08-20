import { LINE_COLORS } from '../art/transit'
import {
  cancelDrawing,
  commitDraft,
  removeRoute,
  selectRoute,
  setBuses,
  setTransitMode,
  startDrawing,
  undoDraft,
  useTransit,
} from './transitStore'
import './TransitPanel.css'

/**
 * Transit mode's controls, and its score.
 *
 * Deliberately one panel rather than a HUD row plus an editor. The whole game
 * is three decisions — where a line goes, how many buses run it, and whether it
 * is worth keeping — and putting them beside the numbers they move is what lets
 * a player see that adding a bus emptied a stop.
 */

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function TransitPanel() {
  const enabled = useTransit((s) => s.enabled)
  const drawing = useTransit((s) => s.drawing)
  const draft = useTransit((s) => s.draft)
  const error = useTransit((s) => s.error)
  const routes = useTransit((s) => s.routes)
  const stats = useTransit((s) => s.stats)
  const selected = useTransit((s) => s.selected)

  if (!enabled) {
    return (
      <button className="transit-open" onClick={() => setTransitMode(true)}>
        Transit mode
      </button>
    )
  }

  const served =
    stats.delivered + stats.missed > 0
      ? Math.round((stats.delivered / (stats.delivered + stats.missed)) * 100)
      : null

  return (
    <div className="transit">
      <header className="transit-head">
        <h2>Transit</h2>
        <button className="transit-close" onClick={() => setTransitMode(false)}>
          Exit
        </button>
      </header>

      <div className="transit-score">
        <Stat label="Delivered" value={String(stats.delivered)} />
        <Stat label="Served" value={served === null ? '—' : `${served}%`} />
        <Stat label="Mean trip" value={clock(stats.meanJourney)} />
        <Stat label="Riding" value={String(stats.riding)} />
        <Stat label="Waiting" value={String(stats.waiting)} />
        <Stat label="Walking" value={String(stats.walking)} />
      </div>

      {/*
        The two ways a trip fails, apart, because they ask for opposite fixes:
        somebody who gave up standing at a stop wants more buses on a line that
        exists; somebody with no service wants a line drawn at all.
      */}
      <div className="transit-fail">
        <Fail
          label="gave up waiting"
          value={stats.gaveUp}
          hint="A line reaches them, but not often enough. Add a bus, or skip some of its stops."
        />
        <Fail
          label="no line reaches them"
          value={stats.noService}
          /*
           * Only this row carries a live figure, and only because it has one
           * worth carrying: these are people standing on a corner right now
           * with nowhere to go, and they are on the map to be looked at. The
           * other row's equivalent would be everybody waiting, which is already
           * in the score above and means something quite different.
           */
          live={stats.unserved}
          liveLabel="on the map now"
          hint="Nothing within a 400m walk of both ends of their trip."
        />
      </div>

      {drawing ? (
        <div className="transit-draw">
          <p className="transit-hint">
            Click junctions to lay the line street by street. Two adjacent junctions
            is one block; click further and it takes the shortest legal way there.
          </p>
          <p className="transit-count">
            {draft.length === 0
              ? 'No junctions yet'
              : `${draft.length} junction${draft.length === 1 ? '' : 's'}`}
          </p>
          {error && <p className="transit-error">{error}</p>}
          <div className="transit-row">
            <button onClick={commitDraft} disabled={draft.length < 2}>
              Run this line
            </button>
            <button onClick={undoDraft} disabled={draft.length === 0}>
              Undo
            </button>
            <button onClick={cancelDrawing}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <button className="transit-new" onClick={startDrawing}>
            Draw a line
          </button>
          {routes.length > 0 && (
            <p className="transit-hint transit-tip">
              Click a stop on the map to skip it. Every stop a line keeps costs it
              a dwell each way and buys it the corner it stands on.
            </p>
          )}
        </>
      )}

      <ul className="transit-lines">
        {routes.length === 0 && !drawing && (
          <li className="transit-empty">
            No lines yet. The coloured buildings are where people are trying to get
            to; the pips on the corners are people trying to get there.
          </li>
        )}
        {routes.map((route) => (
          <li
            key={route.id}
            className={route.id === selected ? 'transit-line selected' : 'transit-line'}
            onClick={() => selectRoute(route.id === selected ? null : route.id)}
          >
            <span
              className="transit-swatch"
              style={{ background: LINE_COLORS[route.colour % LINE_COLORS.length] }}
            />
            <div className="transit-line-body">
              <div className="transit-line-head">
                <strong>{route.name}</strong>
                <span className="transit-line-meta">
                  {route.km.toFixed(1)} km · {route.stops} stops
                  {route.skipped > 0 && ` · ${route.skipped} skipped`}
                </span>
              </div>
              <div className="transit-line-stats">
                {route.waiting} waiting · {route.riding} aboard
              </div>
              <div className="transit-row transit-buses">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setBuses(route.id, route.buses - 1)
                  }}
                  disabled={route.buses === 0}
                  aria-label={`One fewer bus on ${route.name}`}
                >
                  −
                </button>
                <span className="transit-bus-count">
                  {route.buses} bus{route.buses === 1 ? '' : 'es'}
                  {route.running < route.buses && (
                    // A bus can be towed, or refused a spawn because the
                    // terminus is occupied. Both are temporary and both are
                    // worth saying, because the line is running short until
                    // they clear.
                    <em title="One is off the road — it will be back">
                      {' '}
                      ({route.running} out)
                    </em>
                  )}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setBuses(route.id, route.buses + 1)
                  }}
                  aria-label={`One more bus on ${route.name}`}
                >
                  +
                </button>
                <button
                  className="transit-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeRoute(route.id)
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Fail({
  label,
  value,
  live,
  liveLabel,
  hint,
}: {
  label: string
  value: number
  /** How many are in this state right now, as opposed to the running total. */
  live?: number
  liveLabel?: string
  hint: string
}) {
  return (
    <div className="transit-fail-row" title={hint}>
      <span className="transit-fail-value">{value}</span>
      <span className="transit-fail-label">{label}</span>
      {live !== undefined && live > 0 && (
        <span className="transit-fail-live">
          {live} {liveLabel}
        </span>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className={tone === 'bad' ? 'transit-stat bad' : 'transit-stat'}>
      <span className="transit-stat-value">{value}</span>
      <span className="transit-stat-label">{label}</span>
    </div>
  )
}
