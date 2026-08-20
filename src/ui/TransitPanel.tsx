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
        <Stat label="Missed" value={String(stats.missed)} tone={stats.missed > 0 ? 'bad' : undefined} />
        <Stat label="Served" value={served === null ? '—' : `${served}%`} />
        <Stat label="Waiting" value={String(stats.waiting)} />
        <Stat label="Riding" value={String(stats.riding)} />
        <Stat
          label="Unreached"
          value={String(stats.unserved)}
          tone={stats.unserved > 0 ? 'bad' : undefined}
        />
        <Stat label="Mean trip" value={clock(stats.meanJourney)} />
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
        <button className="transit-new" onClick={startDrawing}>
          Draw a line
        </button>
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className={tone === 'bad' ? 'transit-stat bad' : 'transit-stat'}>
      <span className="transit-stat-value">{value}</span>
      <span className="transit-stat-label">{label}</span>
    </div>
  )
}
