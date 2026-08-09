import { junctionSize, nodeById, roadWidth, type LevelDef } from '../sim/types'
import { mulberry32 } from './geometry'

export type BuildingInst = {
  x: number
  z: number
  w: number
  d: number
  h: number
  rot: number
  tint: number
}

export type TreeInst = {
  x: number
  z: number
  scale: number
  rot: number
  dark: boolean
}

/** Squared distance from point p to segment ab, on the ground plane. */
function distToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  if (l2 === 0) return Math.hypot(px - ax, pz - az)
  let t = ((px - ax) * dx + (pz - az) * dz) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}

/** True if a point is far enough from every carriageway and junction box. */
function isClear(level: LevelDef, x: number, z: number, margin: number): boolean {
  for (const road of level.roads) {
    const a = nodeById(level, road.from)
    const b = nodeById(level, road.to)
    const d = distToSegment(x, z, a.pos[0], a.pos[1], b.pos[0], b.pos[1])
    if (d < roadWidth(road) / 2 + margin) return false
  }
  for (const node of level.nodes) {
    if (node.kind !== 'junction') continue
    const half = junctionSize(level, node.id) / 2
    if (Math.abs(x - node.pos[0]) < half + margin && Math.abs(z - node.pos[1]) < half + margin) {
      return false
    }
  }
  return true
}

/**
 * Procedural building and tree placement. Deterministic from level.seed, so a
 * level looks the same every load without any authored props.
 */
export function scatterLevel(level: LevelDef): {
  buildings: BuildingInst[]
  trees: TreeInst[]
} {
  const rand = mulberry32(level.seed)
  const buildings: BuildingInst[] = []
  const trees: TreeInst[] = []

  // --- Buildings fill 'block' zones on a jittered grid.
  const CELL = 17
  for (const zone of level.zones) {
    if (zone.kind !== 'block') continue
    const [cx, cz] = zone.centre
    const [hx, hz] = zone.half
    const cols = Math.floor((hx * 2) / CELL)
    const rows = Math.floor((hz * 2) / CELL)

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (rand() < 0.12) continue // occasional gap, so blocks aren't uniform
        const bx = cx - hx + CELL / 2 + i * CELL + (rand() - 0.5) * 3
        const bz = cz - hz + CELL / 2 + j * CELL + (rand() - 0.5) * 3
        if (!isClear(level, bx, bz, 9)) continue

        buildings.push({
          x: bx,
          z: bz,
          w: 8 + rand() * 5,
          d: 8 + rand() * 5,
          h: 7 + rand() * rand() * 26, // skewed low, with occasional towers
          rot: (rand() - 0.5) * 0.06,
          tint: Math.floor(rand() * 4),
        })
      }
    }
  }

  // --- Street trees down both sides of every road.
  for (const road of level.roads) {
    const a = nodeById(level, road.from)
    const b = nodeById(level, road.to)
    const dx = b.pos[0] - a.pos[0]
    const dz = b.pos[1] - a.pos[1]
    const len = Math.hypot(dx, dz)
    const ux = dx / len
    const uz = dz / len
    const lx = -uz
    const lz = ux
    const offset = roadWidth(road) / 2 + 3.6

    const PITCH = 9
    for (let d = 6; d < len - 4; d += PITCH) {
      for (const side of [-1, 1]) {
        if (rand() < 0.25) continue
        const jitter = (rand() - 0.5) * 2.5
        const x = a.pos[0] + ux * d + lx * side * (offset + jitter)
        const z = a.pos[1] + uz * d + lz * side * (offset + jitter)
        if (!isClear(level, x, z, 2.5)) continue
        trees.push({
          x,
          z,
          scale: 1.7 + rand() * 1.2,
          rot: rand() * Math.PI * 2,
          dark: rand() < 0.35,
        })
      }
    }
  }

  // --- Dense scatter inside parks.
  for (const zone of level.zones) {
    if (zone.kind !== 'park') continue
    const [cx, cz] = zone.centre
    const [hx, hz] = zone.half
    const count = Math.floor((hx * hz) / 26)
    for (let i = 0; i < count; i++) {
      const x = cx + (rand() * 2 - 1) * (hx - 3)
      const z = cz + (rand() * 2 - 1) * (hz - 3)
      if (!isClear(level, x, z, 3)) continue
      trees.push({
        x,
        z,
        scale: 1.9 + rand() * 1.6,
        rot: rand() * Math.PI * 2,
        dark: rand() < 0.4,
      })
    }
  }

  return { buildings, trees }
}
