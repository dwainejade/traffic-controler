import { polyLength, roadCentreline, samplePoly } from '../sim/centreline'
import { junctionSize, pavedWidth, roadEdges, type LevelDef } from '../sim/types'
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

/** Even-odd point-in-polygon over an [x, z] loop. */
export function pointInPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Area of an [x, z] loop, by the shoelace formula. */
function polygonArea(poly: [number, number][]): number {
  let sum = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  }
  return Math.abs(sum) / 2
}

/**
 * Uniform grid over every obstacle a scattered prop must avoid.
 *
 * Testing each candidate against every road is quadratic in the size of the
 * city, and on a map with hundreds of streets that is genuinely fatal: the
 * naive version took 67 seconds to place a city's buildings and trees, which on
 * a page load looks exactly like a hang. Bucketing the segments first turns it
 * into a handful of tests per candidate.
 *
 * `CELL` must be at least the largest query radius, so the 3x3 neighbourhood of
 * a point's own cell is guaranteed to contain everything close enough to matter.
 */
const CELL_SIZE = 44

type Obstacle = {
  ax: number
  az: number
  bx: number
  bz: number
  /** Clearance this obstacle needs, before the caller's own margin. */
  half: number
  /** Junction boxes are square, and keeping them square matters at the corners. */
  box?: boolean
}

type Index = Map<number, Obstacle[]>

const indexCache = new WeakMap<LevelDef, Index>()

function cellKey(cx: number, cz: number): number {
  // Cantor-ish pairing into a single number; cheaper than a string key.
  return (cx + 32768) * 65536 + (cz + 32768)
}

function buildIndex(level: LevelDef): Index {
  const index: Index = new Map()

  const insert = (o: Obstacle) => {
    const pad = o.half + 12
    const minX = Math.floor((Math.min(o.ax, o.bx) - pad) / CELL_SIZE)
    const maxX = Math.floor((Math.max(o.ax, o.bx) + pad) / CELL_SIZE)
    const minZ = Math.floor((Math.min(o.az, o.bz) - pad) / CELL_SIZE)
    const maxZ = Math.floor((Math.max(o.az, o.bz) + pad) / CELL_SIZE)
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const key = cellKey(cx, cz)
        const list = index.get(key)
        if (list) list.push(o)
        else index.set(key, [o])
      }
    }
  }

  for (const road of level.roads) {
    const poly = roadCentreline(level, road)
    // Kerb to kerb: a building or tree must clear the parking bay and the bus
    // lane, not just the moving lanes.
    const half = pavedWidth(road) / 2
    for (let i = 1; i < poly.length; i++) {
      insert({ ax: poly[i - 1].x, az: poly[i - 1].z, bx: poly[i].x, bz: poly[i].z, half })
    }
  }

  // Junction boxes go in as degenerate segments carrying their own half-size.
  for (const node of level.nodes) {
    if (node.kind !== 'junction') continue
    const half = junctionSize(level, node.id) / 2
    insert({ ax: node.pos[0], az: node.pos[1], bx: node.pos[0], bz: node.pos[1], half, box: true })
  }

  return index
}

/** Distance from a point to a segment, on the ground plane. */
function distToSeg(px: number, pz: number, o: Obstacle): number {
  const dx = o.bx - o.ax
  const dz = o.bz - o.az
  const l2 = dx * dx + dz * dz
  if (l2 === 0) return Math.hypot(px - o.ax, pz - o.az)
  let t = ((px - o.ax) * dx + (pz - o.az) * dz) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (o.ax + t * dx), pz - (o.az + t * dz))
}

/** True if a point is far enough from every carriageway and junction box. */
function isClear(level: LevelDef, x: number, z: number, margin: number): boolean {
  let index = indexCache.get(level)
  if (!index) {
    index = buildIndex(level)
    indexCache.set(level, index)
  }

  const cx = Math.floor(x / CELL_SIZE)
  const cz = Math.floor(z / CELL_SIZE)

  for (let ix = cx - 1; ix <= cx + 1; ix++) {
    for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const list = index.get(cellKey(ix, iz))
      if (!list) continue
      for (const o of list) {
        if (o.box) {
          if (Math.abs(x - o.ax) < o.half + margin && Math.abs(z - o.az) < o.half + margin) {
            return false
          }
        } else if (distToSeg(x, z, o) < o.half + margin) {
          return false
        }
      }
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
        // Polygon blocks scan their bounding box; only cells truly inside count.
        if (zone.polygon && !pointInPolygon(bx, bz, zone.polygon)) continue
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

  /*
   * Street trees down both sides of every road, following its curve.
   *
   * Each side is offset from its own kerb rather than from a shared half-width,
   * because a street is not necessarily symmetric: put both rows at half the
   * paved width and the row on the side carrying the bus lane ends up planted
   * in the road.
   */
  /*
   * On a level with surveyed buildings the verge is not empty space — the
   * footprints often come right up to the kerb, and a tree planted at a fixed
   * offset ends up standing inside somebody's front room. Bounding boxes first,
   * which rejects all but a handful before the polygon test runs at all.
   */
  const footprints = (level.footprints ?? []).map((f) => {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const [x, z] of f.polygon) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    return { poly: f.polygon, minX, maxX, minZ, maxZ }
  })

  const insideBuilding = (x: number, z: number): boolean => {
    for (const f of footprints) {
      if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue
      if (pointInPolygon(x, z, f.poly)) return true
    }
    return false
  }

  for (const road of level.roads) {
    const centre = roadCentreline(level, road)
    const len = polyLength(centre)
    const edges = roadEdges(road)
    const VERGE = 3.6

    const PITCH = 9
    for (let d = 6; d < len - 4; d += PITCH) {
      const p = samplePoly(centre, d)
      for (const side of [-1, 1]) {
        if (rand() < 0.25) continue
        const jitter = (rand() - 0.5) * 2.5
        // `side` is +1 on the road's left, and the lateral convention here is
        // positive to the right, hence the sign flip on the right-hand kerb.
        const kerb = side > 0 ? -edges.left : edges.right
        const offset = kerb + VERGE
        const x = p.x - p.tz * side * (offset + jitter)
        const z = p.z + p.tx * side * (offset + jitter)
        if (!isClear(level, x, z, 2.5)) continue
        if (insideBuilding(x, z)) continue
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

  /*
   * --- Dense scatter inside parks. Not grass: that tone is meant to read as
   * open ground, and planting it would make every verge a wood.
   */
  for (const zone of level.zones) {
    if (zone.kind !== 'park') continue
    const [cx, cz] = zone.centre
    const [hx, hz] = zone.half

    if (zone.polygon) {
      /*
       * A surveyed park is nothing like an authored rect. An import brings a
       * hundred and sixty of them, most thin strips laid diagonally along a
       * street, whose bounding boxes are several times their area — so the
       * count comes from the true area, and the sampling gets an attempt cap
       * so a sliver with a 10% acceptance rate still terminates.
       */
      const area = polygonArea(zone.polygon)
      if (area < 90) continue // smaller than this is a planter
      const count = Math.min(120, Math.round(area / 42))
      let placed = 0
      for (let i = 0; i < count * 6 && placed < count; i++) {
        const x = cx + (rand() * 2 - 1) * hx
        const z = cz + (rand() * 2 - 1) * hz
        if (!pointInPolygon(x, z, zone.polygon)) continue
        if (!isClear(level, x, z, 3)) continue
        placed++
        trees.push({
          x,
          z,
          scale: 1.9 + rand() * 1.6,
          rot: rand() * Math.PI * 2,
          dark: rand() < 0.4,
        })
      }
      continue
    }

    // Authored rects keep the density they were tuned at.
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
