import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import { isMedianZone, type ZoneDef } from '../sim/types'

/**
 * The strip down the middle of a dual carriageway, as a kerbed planter.
 *
 * Medians used to be drawn with the parks: a flat green fill on the card, under
 * the asphalt, which at street level read as a lawn someone had painted across
 * the road. A median is not landscape, it is street furniture — a piece of
 * footway left in the middle of the carriageway, standing on a kerb — and the
 * kerb is the whole of the difference. So it is extruded: a low wall in
 * sidewalk tone with a planting bed inset into the top, which is also what puts
 * the trees on it above the traffic instead of level with it.
 *
 * Merged into one geometry for the same reason `Footprints` is: a downtown
 * import brings a few dozen of these and each one is a different shape.
 */

/** Kerb height. A real one is ankle-high; this is that, read from up here. */
export const MEDIAN_HEIGHT = 0.3

/** How far the planting bed sits inside the kerb, and how far below its top. */
const BED_INSET = 0.5
const BED_DROP = 0.05

/**
 * Shrink a closed [x, z] loop by `d`, mitred at the corners.
 *
 * The loop's winding is whatever the surveyor drew, so rather than reason about
 * orientation this offsets both ways and keeps whichever came out smaller —
 * shrinking is the one that loses area. Returns null when the result is not a
 * usable bed: a strip narrower than twice the inset collapses through itself,
 * and a collapsed polygon triangulates into a mess rather than nothing.
 */
function insetPolygon(poly: [number, number][], d: number): [number, number][] | null {
  const n = poly.length
  if (n < 3) return null

  const area = (p: [number, number][]) => {
    let sum = 0
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      sum += p[j][0] * p[i][1] - p[i][0] * p[j][1]
    }
    return Math.abs(sum) / 2
  }

  const offsetBy = (sign: number): [number, number][] => {
    const out: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const prev = poly[(i - 1 + n) % n]
      const cur = poly[i]
      const next = poly[(i + 1) % n]

      const e1 = [cur[0] - prev[0], cur[1] - prev[1]]
      const e2 = [next[0] - cur[0], next[1] - cur[1]]
      const l1 = Math.hypot(e1[0], e1[1]) || 1
      const l2 = Math.hypot(e2[0], e2[1]) || 1
      // Edge normals, both turned the same way round the loop.
      const n1 = [-e1[1] / l1, e1[0] / l1]
      const n2 = [-e2[1] / l2, e2[0] / l2]

      let bx = n1[0] + n2[0]
      let bz = n1[1] + n2[1]
      const bl = Math.hypot(bx, bz)
      if (bl < 1e-6) {
        // A spike, where the two edges double back on each other. Fall back to
        // one edge's normal; the validity test below catches it if it matters.
        bx = n1[0]
        bz = n1[1]
      } else {
        bx /= bl
        bz /= bl
      }

      // Mitre length, clamped so a sharp corner does not shoot off to infinity.
      const cos = Math.max(0.35, bx * n1[0] + bz * n1[1])
      const len = (d / cos) * sign
      out.push([cur[0] + bx * len, cur[1] + bz * len])
    }
    return out
  }

  const a = offsetBy(1)
  const b = offsetBy(-1)
  const inner = area(a) < area(b) ? a : b

  const before = area(poly)
  const after = area(inner)
  // Too much lost and the bed is a sliver; too little and the offset went
  // outward on a shape the area test could not separate.
  if (before <= 0 || after < before * 0.15 || after > before) return null
  return inner
}

function buildGeometry(zones: ZoneDef[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const kerb = new THREE.Color(PALETTE.medianKerb)
  const bed = new THREE.Color(PALETTE.grass)

  const paint = (geom: THREE.BufferGeometry, colour: (y: number, up: boolean) => THREE.Color) => {
    const pos = geom.getAttribute('position')
    const normal = geom.getAttribute('normal')
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const c = colour(pos.getY(i), normal.getY(i) > 0.5)
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }

  const shaded = new THREE.Color()

  for (const zone of zones) {
    if (!isMedianZone(zone) || !zone.polygon || zone.polygon.length < 3) continue

    /*
     * Built in XY and laid flat afterwards, the way `Footprints` builds a
     * building: extrusion runs along +Z, so rotating -90° about X stands it up
     * and maps shape (x, y) to world (x, -y) — hence the negated z going in.
     */
    const shape = new THREE.Shape(
      zone.polygon.map(([x, z]) => new THREE.Vector2(x, -z)),
    )

    let kerbGeom: THREE.ExtrudeGeometry
    try {
      kerbGeom = new THREE.ExtrudeGeometry(shape, {
        depth: MEDIAN_HEIGHT,
        bevelEnabled: false,
        curveSegments: 1,
      })
    } catch {
      // A self-intersecting ring defeats triangulation. One bad median must not
      // cost the street the rest of them.
      continue
    }
    kerbGeom.rotateX(-Math.PI / 2)
    kerbGeom.computeVertexNormals()
    // The top of the kerb catches the sky, the sides fall away from it. Same
    // trick as the buildings, and the only thing that makes a 30cm wall read.
    paint(kerbGeom, (_y, up) => shaded.copy(kerb).multiplyScalar(up ? 1.0 : 0.82))
    parts.push(kerbGeom)

    const inner = insetPolygon(zone.polygon, BED_INSET)
    if (!inner) continue

    let bedGeom: THREE.BufferGeometry
    try {
      const bedShape = new THREE.Shape(
        inner.map(([x, z]) => new THREE.Vector2(x, -z)),
      )
      bedGeom = new THREE.ShapeGeometry(bedShape).toNonIndexed()
    } catch {
      continue
    }
    bedGeom.rotateX(-Math.PI / 2)
    bedGeom.translate(0, MEDIAN_HEIGHT - BED_DROP, 0)
    // ShapeGeometry's normals follow the shape plane before it was laid flat;
    // the fill is horizontal by construction, so they are simply up.
    const count = bedGeom.getAttribute('position').count
    const up = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) up[i * 3 + 1] = 1
    bedGeom.setAttribute('normal', new THREE.BufferAttribute(up, 3))
    paint(bedGeom, () => bed)
    parts.push(bedGeom)
  }

  const merged = new THREE.BufferGeometry()
  if (parts.length === 0) return merged

  let vertices = 0
  for (const g of parts) vertices += g.getAttribute('position').count

  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  const color = new Float32Array(vertices * 3)

  let offset = 0
  for (const g of parts) {
    const p = g.getAttribute('position')
    const nrm = g.getAttribute('normal')
    const c = g.getAttribute('color')
    for (let i = 0; i < p.count; i++) {
      const o = (offset + i) * 3
      position[o] = p.getX(i)
      position[o + 1] = p.getY(i)
      position[o + 2] = p.getZ(i)
      normal[o] = nrm.getX(i)
      normal[o + 1] = nrm.getY(i)
      normal[o + 2] = nrm.getZ(i)
      color[o] = c.getX(i)
      color[o + 1] = c.getY(i)
      color[o + 2] = c.getZ(i)
    }
    offset += p.count
    g.dispose()
  }

  merged.setAttribute('position', new THREE.BufferAttribute(position, 3))
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3))
  merged.computeBoundingSphere()
  return merged
}

export function Medians({ zones }: { zones: ZoneDef[] }) {
  const geom = useMemo(() => buildGeometry(zones), [zones])
  useEffect(() => () => geom.dispose(), [geom])

  if (!zones.some(isMedianZone)) return null

  /*
   * Double-sided: the bed fill triangulates to whichever winding the surveyed
   * ring was drawn in, and a clockwise one faces down and vanishes. Its normals
   * are forced up above, so the lighting is right either way.
   */
  return (
    <mesh geometry={geom} castShadow receiveShadow>
      <meshLambertMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  )
}
