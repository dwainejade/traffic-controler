/**
 * Level topology. The renderer and the simulation both build from this — road
 * meshes and lane splines come from the same source, so a stop line drawn on
 * screen sits exactly where the sim thinks the stop line is.
 */

/** Metres. One lane. */
export const LANE_WIDTH = 3.5

/**
 * Stop-line layout, measured outward from the edge of the junction box.
 * Shared by the renderer and the simulation so a painted stop bar always sits
 * exactly where the sim thinks cars must stop.
 */
export const CROSSWALK_GAP = 1.0
export const CROSSWALK_DEPTH = 4.0
export const STOP_BAR_GAP = 0.8
export const STOP_OFFSET = CROSSWALK_GAP + CROSSWALK_DEPTH + STOP_BAR_GAP

export type NodeId = string

export type MapNode = {
  id: NodeId
  /** World position on the ground plane, [x, z]. */
  pos: [number, number]
  /**
   * `junction` — signal-controlled crossing the player operates.
   * `source`   — map edge where cars spawn and despawn.
   */
  kind: 'junction' | 'source'
}

export type RoadDef = {
  id: string
  from: NodeId
  to: NodeId
  /** Lanes in each direction. Total width = lanesPerDir * 2 * LANE_WIDTH. */
  lanesPerDir: number
}

export type ZoneDef = {
  id: string
  kind: 'park' | 'block'
  /** Axis-aligned rect: centre [x, z] plus half-extents [hx, hz]. */
  centre: [number, number]
  half: [number, number]
}

export type LevelDef = {
  id: string
  name: string
  /** Half-extent of the ground card. */
  half: number
  nodes: MapNode[]
  roads: RoadDef[]
  zones: ZoneDef[]
  /** Seed for procedural building/tree scatter, so levels look identical every load. */
  seed: number
  /** Cars that must complete their route to clear the level. */
  quota: number
  /** Seconds available once the level starts. */
  timeLimit: number
  /** Cars per second arriving across all approaches. */
  demand: number
}

export function roadWidth(road: RoadDef): number {
  return road.lanesPerDir * 2 * LANE_WIDTH
}

export function nodeById(level: LevelDef, id: NodeId): MapNode {
  const n = level.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`Unknown node "${id}" in level "${level.id}"`)
  return n
}

/**
 * Extra width the junction box carries beyond the widest road meeting it.
 *
 * A box sized exactly to the carriageway forces turning vehicles onto radii so
 * tight that opposing left-turn paths converge on the centre point and pass
 * through one another. Real junctions with turn lanes are wider than their
 * approaches for the same reason.
 */
export const JUNCTION_MARGIN = 5

/** Widest road meeting at a node, plus margin — sets the size of the junction box. */
export function junctionSize(level: LevelDef, id: NodeId): number {
  const widths = level.roads
    .filter((r) => r.from === id || r.to === id)
    .map(roadWidth)
  return widths.length ? Math.max(...widths) + JUNCTION_MARGIN : 0
}
