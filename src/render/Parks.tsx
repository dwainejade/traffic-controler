import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import { isGreenZone, type ZoneDef } from '../sim/types'
import { LAYER } from './layers'
import { roundedRectShape } from './geometry'

/**
 * Parks, gardens, ball fields, cemeteries, verges — every green area on the map.
 *
 * Drawn the way `Footprints` draws surveyed buildings, and for the same reason:
 * an imported area brings a couple of hundred of these, each a different shape,
 * so a mesh apiece is a couple of hundred draw calls and as many materials. One
 * merged geometry with the tone in its vertex colours is one draw call.
 */

function buildGeometry(zones: ZoneDef[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const tint = new THREE.Color()

  for (const zone of zones) {
    if (!isGreenZone(zone)) continue

    /*
     * A polygon zone carries world coordinates in its vertices — shapes are
     * built in XY and laid flat with rotateX(-90°), which maps shape (x, y) to
     * world (x, -y), hence the negated z. A rect zone is a unit shape that has
     * to be moved to its centre; the authored levels are all rects.
     */
    let geom: THREE.BufferGeometry
    try {
      const shape = zone.polygon
        ? new THREE.Shape(zone.polygon.map(([x, z]) => new THREE.Vector2(x, -z)))
        : roundedRectShape(zone.half[0], zone.half[1], 8)
      /*
       * Flattened, because ShapeGeometry is indexed — unlike the extrusions
       * `Footprints` merges — and the merge below concatenates raw vertex
       * arrays. Keeping the index would mean rebasing every part's indices;
       * de-indexing a flat fill costs a few hundred vertices and nothing else.
       */
      geom = new THREE.ShapeGeometry(shape).toNonIndexed()
    } catch {
      // A self-intersecting ring defeats triangulation. Surveyed outlines do
      // this often enough that one bad garden must not cost the whole map.
      continue
    }

    geom.rotateX(-Math.PI / 2)
    if (zone.polygon) geom.translate(0, LAYER.green, 0)
    else geom.translate(zone.centre[0], LAYER.green, zone.centre[1])

    const pos = geom.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    tint.set(zone.kind === 'park' ? PALETTE.park : PALETTE.grass)
    for (let i = 0; i < pos.count; i++) {
      colors[i * 3] = tint.r
      colors[i * 3 + 1] = tint.g
      colors[i * 3 + 2] = tint.b
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    parts.push(geom)
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
    const c = g.getAttribute('color')
    for (let i = 0; i < p.count; i++) {
      const o = (offset + i) * 3
      position[o] = p.getX(i)
      position[o + 1] = p.getY(i)
      position[o + 2] = p.getZ(i)
      // Flat on the ground plane, so every normal points straight up. No need
      // to compute what is already known.
      normal[o + 1] = 1
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

export function Parks({ zones }: { zones: ZoneDef[] }) {
  const geom = useMemo(() => buildGeometry(zones), [zones])
  useEffect(() => () => geom.dispose(), [geom])

  if (!zones.some(isGreenZone)) return null

  /*
   * Coplanar paint on the card: it takes the key light, it does not cast.
   *
   * Double-sided because triangulation follows the ring's winding and a
   * surveyed ring is wound whichever way the surveyor drew it — a clockwise
   * park triangulates face-down and vanishes entirely. The normals are forced
   * up above, so lighting is right either way; this is only about culling.
   */
  return (
    <mesh geometry={geom} receiveShadow>
      <meshLambertMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  )
}
