import { create } from 'zustand'
import type { NodeId } from '../sim/types'
import type { RouteId, Transit, TransitStats } from '../sim/transit'

/**
 * Transit mode's UI state.
 *
 * Same contract as `hudStore`: the simulation is not in here. What is in here
 * is the player's *intent* — which mode they are in, what they are drawing,
 * which line is selected — plus a throttled mirror of the transit layer's own
 * numbers, published once a frame the same way the HUD's are.
 *
 * The `Transit` instance itself is held as a plain reference rather than as
 * store state. It mutates constantly and nothing about it is worth diffing;
 * components that need to command it call through `transit()` and read the
 * mirror for anything they display.
 */

export type RouteMirror = {
  id: RouteId
  name: string
  colour: number
  /** Buses the player asked for. */
  buses: number
  /** Buses actually on the road, which lags after a tow or a blocked terminus. */
  running: number
  stops: number
  /** Kilometres round the loop. */
  km: number
  /** People standing at this line's stops right now. */
  waiting: number
  /** People on its buses right now. */
  riding: number
}

export type TransitUi = {
  /** Transit mode on. Off, the game is the signal sim exactly as it was. */
  enabled: boolean
  /** Whether a click on the map extends a route or does nothing. */
  drawing: boolean
  /** Junctions clicked so far, in order. */
  draft: NodeId[]
  /** The junction under the pointer, when it is close enough to snap to. */
  hover: NodeId | null
  /** Why the last draw attempt failed, shown next to the draw button. */
  error: string | null
  selected: RouteId | null
  routes: RouteMirror[]
  stats: TransitStats
  /** Bumped by the layer whenever routes change, so meshes rebuild. */
  version: number
}

const EMPTY_STATS: TransitStats = {
  spawned: 0,
  delivered: 0,
  missed: 0,
  waiting: 0,
  riding: 0,
  walking: 0,
  unserved: 0,
  meanJourney: 0,
  meanWait: 0,
}

export const useTransit = create<TransitUi>(() => ({
  enabled: false,
  drawing: false,
  draft: [],
  hover: null,
  error: null,
  selected: null,
  routes: [],
  stats: EMPTY_STATS,
  version: 0,
}))

/**
 * The live layer, outside React.
 *
 * A module-level reference rather than context: the pointer handlers, the
 * simulation loop and the panel all need it, they live in three different
 * trees, and it is one object per world with a lifetime longer than any of them.
 */
let current: Transit | null = null

export function bindTransit(layer: Transit | null): void {
  current = layer
  /*
   * Console handle, in dev only, matching `SIMDEV` and `simWorld`. The transit
   * layer is the half of transit mode with no numeric readout of its own — a
   * route either works or the riders quietly stop appearing — so being able to
   * add a line and read the ledger from the console is how it gets verified.
   */
  if (import.meta.env?.DEV) {
    Object.assign(globalThis, { TRANSIT: layer, transitUi: useTransit })
  }
  useTransit.setState({
    routes: [],
    stats: EMPTY_STATS,
    draft: [],
    selected: null,
    error: null,
    version: 0,
  })
  if (layer) publishTransit(layer)
}

export function transit(): Transit | null {
  return current
}

/** Mirror the layer's state into the store. Called once a frame, throttled. */
export function publishTransit(layer: Transit): void {
  const routes: RouteMirror[] = layer.routes.map((r) => {
    let waiting = 0
    for (const stop of r.stops) waiting += stop.waiting.length
    return {
      id: r.id,
      name: r.name,
      colour: r.colour,
      buses: r.buses,
      running: r.running,
      stops: r.stops.filter((s) => s.enabled).length,
      km: r.length / 1000,
      waiting,
      riding: 0,
    }
  })

  // Riders on board are counted per line by walking the riders once, rather
  // than by asking each route — a rider knows which stop they alight at and the
  // stop knows its route, so one pass answers every line at once.
  const byRoute = new Map<RouteId, number>()
  for (const rider of layer.riders) {
    if (!rider.active || rider.phase !== 'riding') continue
    const stop = layer.stop(rider.alightStop)
    if (!stop) continue
    byRoute.set(stop.routeId, (byRoute.get(stop.routeId) ?? 0) + 1)
  }
  for (const r of routes) r.riding = byRoute.get(r.id) ?? 0

  useTransit.setState({ routes, stats: { ...layer.stats }, version: layer.version })
}

// --------------------------------------------------------------- commands

export function setTransitMode(enabled: boolean): void {
  useTransit.setState({ enabled, drawing: false, draft: [], error: null })
}

export function startDrawing(): void {
  useTransit.setState({ drawing: true, draft: [], error: null, selected: null })
}

export function cancelDrawing(): void {
  useTransit.setState({ drawing: false, draft: [], hover: null, error: null })
}

/**
 * Extend the path being drawn.
 *
 * Clicking the junction you are already at is how a misclick is undone, and
 * clicking the one you came from steps back — both are what a player reaches
 * for before they find the undo button, and neither should add a leg that goes
 * nowhere.
 */
export function extendDraft(node: NodeId): void {
  const { draft } = useTransit.getState()
  const last = draft[draft.length - 1]
  if (last === node) return

  if (draft.length >= 2 && draft[draft.length - 2] === node) {
    useTransit.setState({ draft: draft.slice(0, -1), error: null })
    return
  }

  useTransit.setState({ draft: [...draft, node], error: null })
}

export function undoDraft(): void {
  const { draft } = useTransit.getState()
  useTransit.setState({ draft: draft.slice(0, -1), error: null })
}

export function setHover(node: NodeId | null): void {
  if (useTransit.getState().hover === node) return
  useTransit.setState({ hover: node })
}

/** Turn the drawn path into a running line. */
export function commitDraft(): void {
  const layer = current
  const { draft } = useTransit.getState()
  if (!layer) return

  if (draft.length < 2) {
    useTransit.setState({ error: 'A line needs at least two junctions.' })
    return
  }

  const route = layer.addRoute(draft)
  if (!route) {
    useTransit.setState({
      // The honest cause, near enough: on a one-way grid the failure is almost
      // always that there is no legal way back to the start, and saying "no
      // route" would send the player looking at the leg they just drew.
      error: 'No drivable loop through those junctions — try a parallel street for the return.',
    })
    return
  }

  useTransit.setState({ drawing: false, draft: [], selected: route.id, error: null })
  publishTransit(layer)
}

export function removeRoute(id: RouteId): void {
  const layer = current
  if (!layer) return
  layer.removeRoute(id)
  const { selected } = useTransit.getState()
  useTransit.setState({ selected: selected === id ? null : selected })
  publishTransit(layer)
}

export function setBuses(id: RouteId, count: number): void {
  const layer = current
  if (!layer) return
  layer.setBuses(id, count)
  publishTransit(layer)
}

export function selectRoute(id: RouteId | null): void {
  useTransit.setState({ selected: id })
}
