import { tangentAt, roadCentreline, type Pt } from '../sim/centreline'
import { junctionSize, roadEdges, type LevelDef, type NodeId } from '../sim/types'

/**
 * The paved outline of a junction, traced arm by arm rather than stamped as a
 * square.
 *
 * A junction used to be drawn as a rounded square the width of `junctionSize`,
 * which is wider than any road meeting it — so at every crossing the asphalt
 * bulged past the kerb lines into the four corners of the block, and the block
 * came to a corner that was cut back on the diagonal. Blocks looked bitten out
 * at every corner, which is the opposite of what a real corner does: the kerb
 * turns through a radius and the block's corner is the convex, rounded thing.
 *
 * So the surface is the union of the arms' own carriageways, and the corner
 * between two arms is filleted with a kerb radius. Nothing here changes
 * `junctionSize`: the box still sets stop lines, turn radii and conflict
 * geometry. This is only the shape that gets painted over them.
 */

export type Arm = {
  /** Unit vector from the junction outward along the road. */
  dir: Pt
  /** Paved half-width on the `+90°` side of `dir`, and on the `-90°` side. */
  plus: number
  minus: number
  /** Name of the road this arm carries, for anything that signs the corner. */
  name?: string
}

/**
 * Kerb radius at a corner, metres.
 *
 * Big enough to read as a turned corner at the scale a city is drawn at, small
 * enough that the vehicle paths through the junction — which are built against
 * `junctionSize`, not against this — stay on the asphalt. `outlineFits` in the
 * tests is what actually holds that second half true.
 */
export const CORNER_RADIUS = 4.5

/** Rotate a unit vector 90° towards increasing bearing. */
function perp(d: Pt): Pt {
  return { x: -d.z, z: d.x }
}

function add(a: Pt, b: Pt, k = 1): Pt {
  return { x: a.x + b.x * k, z: a.z + b.z * k }
}

function cross(a: Pt, b: Pt): number {
  return a.x * b.z - a.z * b.x
}

/** Bearing used to order the arms anticlockwise around the node. */
function bearing(d: Pt): number {
  return Math.atan2(d.z, d.x)
}

/**
 * Where two arms' facing kerb lines would meet if neither were rounded — the
 * sharp point the block would come to. `null` when the arms are opposed and the
 * lines never cross, which is the straight-through case with no corner at all.
 */
function cornerPoint(a: Arm, b: Arm): Pt | null {
  const pa = add({ x: 0, z: 0 }, perp(a.dir), a.plus)
  const pb = add({ x: 0, z: 0 }, perp(b.dir), -b.minus)
  const denom = cross(a.dir, b.dir)
  if (Math.abs(denom) < 1e-6) return null
  const s = cross({ x: pb.x - pa.x, z: pb.z - pa.z }, b.dir) / denom
  return add(pa, a.dir, s)
}

/** Points along the fillet arc, from the `a` side round to the `b` side. */
function fillet(
  corner: Pt,
  a: Arm,
  b: Arm,
  radius: number,
  gap: number,
): { pts: Pt[]; along: number } {
  /*
   * The arc is tangent to both kerb lines and bulges back towards the corner,
   * so the block keeps a rounded nose pointing at the crossing rather than
   * having its point chamfered off. `along` is how far down each arm the
   * tangency sits, which the caller needs because the arm has to reach at
   * least that far to meet it.
   */
  const along = radius / Math.tan(gap / 2)
  const centreDist = radius / Math.sin(gap / 2)
  const bis = { x: a.dir.x + b.dir.x, z: a.dir.z + b.dir.z }
  const bisLen = Math.hypot(bis.x, bis.z) || 1
  const centre = add(corner, { x: bis.x / bisLen, z: bis.z / bisLen }, centreDist)

  const start = Math.atan2(
    corner.z + a.dir.z * along - centre.z,
    corner.x + a.dir.x * along - centre.x,
  )
  const end = Math.atan2(
    corner.z + b.dir.z * along - centre.z,
    corner.x + b.dir.x * along - centre.x,
  )
  // Sweep the short way round: the arc spans π - gap, never the long side.
  let sweep = end - start
  while (sweep > Math.PI) sweep -= Math.PI * 2
  while (sweep < -Math.PI) sweep += Math.PI * 2

  const steps = Math.max(2, Math.round(Math.abs(sweep) / 0.25))
  const pts: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps
    pts.push({ x: centre.x + Math.cos(t) * radius, z: centre.z + Math.sin(t) * radius })
  }
  return { pts, along }
}

/**
 * The radius a corner actually gets.
 *
 * The tangent points of a fillet sit `r / tan(gap/2)` down each arm, so holding
 * `r` fixed as the gap closes throws them tens of metres out of the junction
 * and drags the whole outline after them. Capping the tangency at a fraction of
 * the reach caps the radius instead, and a sliver of block between two arms
 * just gets a tighter nose — which is what a sliver of block looks like.
 */
function filletRadius(gap: number, reach: number, radius: number): number {
  return Math.min(radius, reach * 0.6 * Math.tan(gap / 2))
}

/**
 * Bearing within which two arms are treated as one.
 *
 * Invented junctions have arms that are properly apart. Imported ones have
 * whatever OpenStreetMap's ways happened to do: a node where a service road
 * splits two degrees off its parent, or where nine ways converge on one point.
 * A corner between two arms that close is not a corner of anything, and trying
 * to draw one is what tore these outlines up. Folding such a pair into a single
 * arm as wide as the wider of the two is both simpler and a superset of the
 * asphalt either arm needed.
 */
const MERGE_BEARING = (12 * Math.PI) / 180

function mergeArms(arms: Arm[]): Arm[] {
  const sorted = [...arms].sort((a, b) => bearing(a.dir) - bearing(b.dir))
  const out: Arm[] = []

  for (const arm of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(bearing(arm.dir) - bearing(last.dir)) < MERGE_BEARING) {
      out[out.length - 1] = {
        dir: arm.plus + arm.minus > last.plus + last.minus ? arm.dir : last.dir,
        plus: Math.max(arm.plus, last.plus),
        minus: Math.max(arm.minus, last.minus),
      }
      continue
    }
    out.push(arm)
  }

  // The list is a ring, so the last and first can be neighbours too.
  if (out.length > 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if (bearing(first.dir) + Math.PI * 2 - bearing(last.dir) < MERGE_BEARING) {
      out[0] = {
        dir: last.plus + last.minus > first.plus + first.minus ? last.dir : first.dir,
        plus: Math.max(first.plus, last.plus),
        minus: Math.max(first.minus, last.minus),
      }
      out.pop()
    }
  }

  return out
}

/** Do two non-adjacent edges of a closed polygon cross? */
function selfIntersects(poly: Pt[]): boolean {
  const side = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x))
  const crosses = (a: Pt, b: Pt, c: Pt, d: Pt) =>
    side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)

  for (let i = 0; i < poly.length; i++) {
    for (let k = i + 2; k < poly.length; k++) {
      if (i === 0 && k === poly.length - 1) continue
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const c = poly[k]
      const d = poly[(k + 1) % poly.length]
      if (crosses(a, b, c, d)) return true
    }
  }
  return false
}

/** The old square box, kept as the shape a hopeless node still gets. */
function roundedBox(half: number, radius: number): Pt[] {
  const r = Math.min(radius, half)
  const out: Pt[] = []
  const corners: [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]
  for (const [sx, sz] of corners) {
    const cx = sx * (half - r)
    const cz = sz * (half - r)
    const start = Math.atan2(sz, sx) - Math.PI / 4
    for (let i = 0; i <= 4; i++) {
      const t = start + (Math.PI / 2) * (i / 4)
      out.push({ x: cx + Math.cos(t) * r, z: cz + Math.sin(t) * r })
    }
  }
  return out
}

/**
 * Trace the paved outline, node-local, anticlockwise.
 *
 * `reach` is how far the surface runs down each arm — the junction box's own
 * half-size. A corner whose fillet lands further out than that pushes its two
 * arms out to meet it, since the alternative is a hole in the asphalt where the
 * arc floats free of the carriageway.
 */
export function junctionOutline(arms: Arm[], reach: number, radius: number): Pt[] {
  if (arms.length === 0) return []

  const sorted = mergeArms(arms)
  const n = sorted.length

  /**
   * What happens between arm i and the next one round.
   *
   * A gap under a half-turn is a corner of a block: the two kerb lines close on
   * a point and it gets the radius. A gap over a half-turn is the *outside* of
   * a bend, where the same two lines close on a point behind the junction — it
   * is mitred to that point and left sharp, the way `buildRibbons` mitres a
   * road's edges through every other bend. Cutting it instead left cars on the
   * outside of a kink driving over the grass. Either way `along` is how far
   * down each arm the join sits.
   */
  const corners = sorted.map((arm, i) => {
    const next = sorted[(i + 1) % n]
    let gap = bearing(next.dir) - bearing(arm.dir)
    while (gap <= 0) gap += Math.PI * 2

    const point = cornerPoint(arm, next)
    // Arms close to opposed: the kerb lines are all but collinear and a join
    // straight from one mouth to the other is within millimetres of the truth.
    if (point === null || Math.abs(gap - Math.PI) < 0.03) return null

    if (gap < Math.PI) {
      const arc = fillet(point, arm, next, filletRadius(gap, reach, radius), gap)
      return {
        pts: arc.pts,
        needA: dot(point, arm.dir) + arc.along,
        needB: dot(point, next.dir) + arc.along,
      }
    }

    /*
     * A mitre on a very shallow bend runs away to a spike far outside the
     * junction. Past a couple of box-widths out it is no longer a corner of
     * anything, so the mouths are joined directly instead.
     */
    const needA = dot(point, arm.dir)
    const needB = dot(point, next.dir)
    if (Math.max(needA, needB) > reach * 2.5) return null
    return { pts: [point], needA, needB }
  })

  // An arm's mouth has to sit beyond both of its own joins, or the asphalt
  // stops short of the arc that is supposed to spring from it.
  const reachOf = sorted.map((_, i) => {
    const after = corners[i]
    const before = corners[(i - 1 + n) % n]
    return Math.max(
      reach,
      after ? after.needA + 0.5 : 0,
      before ? before.needB + 0.5 : 0,
    )
  })

  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const arm = sorted[i]
    const p = perp(arm.dir)
    const mouth = add({ x: 0, z: 0 }, arm.dir, reachOf[i])
    out.push(add(mouth, p, -arm.minus))
    out.push(add(mouth, p, arm.plus))
    const corner = corners[i]
    if (corner) out.push(...corner.pts)
  }

  /*
   * Last resort. A node where a dozen imported ways converge can still fold the
   * outline over itself, and a self-overlapping polygon triangulates into a
   * mess of holes and slivers. The old square box was never wrong, only ugly —
   * so a node that defeats the tracing gets one, and the other four hundred get
   * their corners.
   */
  if (selfIntersects(out)) return roundedBox(reach, Math.min(radius, 3))

  return out
}

function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.z * b.z
}

/** A rounded block corner: where its nose is, and the two streets that make it. */
export type CornerNose = {
  /** Node-local position, `clear` metres out from the kerb along the bisector. */
  x: number
  z: number
  /** The two arms, in the order the outline walks them. */
  a: Arm
  b: Arm
}

/**
 * The block corners a junction turns, node-local.
 *
 * Reads the same merged arms and the same clamped radius the outline is drawn
 * with, so a thing placed on a nose here lands on the nose that got drawn.
 * `clear` is how far past the kerb to sit — the tip of the block's nose is
 * exactly on the kerb line, and nothing wants to stand in the gutter.
 */
export function cornerNoses(arms: Arm[], reach: number, radius: number, clear: number): CornerNose[] {
  const sorted = mergeArms(arms)
  const n = sorted.length
  if (n < 2) return []

  const out: CornerNose[] = []
  for (let i = 0; i < n; i++) {
    const arm = sorted[i]
    const next = sorted[(i + 1) % n]
    let gap = bearing(next.dir) - bearing(arm.dir)
    while (gap <= 0) gap += Math.PI * 2
    // Only the corners the outline rounds: an opposed pair has no corner, and a
    // gap past a half-turn is the outside of a bend, where there is no block.
    if (gap >= Math.PI - 0.03 || gap < 0.25) continue

    const point = cornerPoint(arm, next)
    if (point === null) continue

    /*
     * The nose is where the fillet arc crosses the bisector: the arc's centre
     * sits `r / sin(gap/2)` out from the sharp corner, and the arc itself is
     * `r` back from that towards the junction.
     */
    const r = filletRadius(gap, reach, radius)
    const bis = { x: arm.dir.x + next.dir.x, z: arm.dir.z + next.dir.z }
    const len = Math.hypot(bis.x, bis.z) || 1
    const along = r / Math.sin(gap / 2) - r + clear
    out.push({
      x: point.x + (bis.x / len) * along,
      z: point.z + (bis.z / len) * along,
      a: arm,
      b: next,
    })
  }
  return out
}

/**
 * Every junction on the level, with the arms meeting it, ready to outline.
 *
 * An arm's two half-widths come from `roadEdges`, which measures from the
 * centreline in the road's own direction — so an arm arriving at its road's
 * `to` end has those two sides swapped relative to the direction it points.
 * Getting this backwards puts a bus lane on the wrong side of the crossing.
 */
export function junctionArms(level: LevelDef): { id: NodeId; x: number; z: number; size: number; arms: Arm[] }[] {
  const out: { id: NodeId; x: number; z: number; size: number; arms: Arm[] }[] = []

  for (const node of level.nodes) {
    if (node.kind !== 'junction') continue
    const arms: Arm[] = []

    for (const road of level.roads) {
      if (road.from !== node.id && road.to !== node.id) continue
      const centre = roadCentreline(level, road)
      const edges = roadEdges(road)
      if (road.from === node.id) {
        const t = tangentAt(centre, 'start')
        arms.push({ dir: t, plus: edges.right, minus: -edges.left, name: road.name })
      } else {
        const t = tangentAt(centre, 'end')
        arms.push({
          dir: { x: -t.x, z: -t.z },
          plus: -edges.left,
          minus: edges.right,
          name: road.name,
        })
      }
    }

    out.push({ id: node.id, x: node.pos[0], z: node.pos[1], size: junctionSize(level, node.id), arms })
  }

  return out
}
