import * as THREE from 'three'
import type { Lane, LaneId, Network } from '../sim/network'

/**
 * A flat strip of constant width following a polyline.
 *
 * `RoadNetwork` grows its own ribbons because a carriageway has kerbs, decks
 * and per-road width to carry. This is the plain version: one width, one
 * height, no ends — which is what a drawn transit line is, and what a route
 * preview needs to be able to rebuild every time the pointer moves.
 */
export function ribbonGeometry(
  points: { x: number; z: number }[],
  width: number,
  y: number,
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry()
  if (points.length < 2) return geom

  const half = width / 2
  const position = new Float32Array(points.length * 6)
  const index: number[] = []

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]

    let dx = next.x - prev.x
    let dz = next.z - prev.z
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len

    /*
     * The normal, not a mitre. A mitred join is correct and, at a corner as
     * tight as a bus turning left at a junction, produces a spike several times
     * the line's width — the joint sticks out past the building on the corner.
     * Sampling the lane densely enough that the fan of un-mitred quads closes
     * visually is both cheaper and better behaved.
     */
    const nx = -dz * half
    const nz = dx * half

    const at = i * 6
    position[at] = points[i].x + nx
    position[at + 1] = y
    position[at + 2] = points[i].z + nz
    position[at + 3] = points[i].x - nx
    position[at + 4] = y
    position[at + 5] = points[i].z - nz

    if (i > 0) {
      const a = (i - 1) * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  geom.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geom.setIndex(index)
  geom.computeVertexNormals()
  return geom
}

/**
 * The centre of a chain of lanes as one polyline.
 *
 * Lanes already carry their flattened points, so this is a concatenation with
 * the duplicate join vertices dropped — a connector's first point is the road
 * lane's last, and leaving both in puts a zero-length segment at every junction
 * where the ribbon's normal is undefined.
 */
export function chainPolyline(net: Network, lanes: LaneId[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []

  for (const id of lanes) {
    const lane: Lane = net.lanes[id]
    for (let i = 0; i < lane.pts.length; i += 2) {
      const x = lane.pts[i]
      const z = lane.pts[i + 1]
      const last = out[out.length - 1]
      if (last && Math.hypot(last.x - x, last.z - z) < 0.05) continue
      out.push({ x, z })
    }
  }

  return out
}
