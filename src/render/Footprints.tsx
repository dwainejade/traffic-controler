import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import type { BuildingFootprint } from '../sim/types'

/**
 * Surveyed buildings, extruded from their real outlines.
 *
 * These cannot be instanced the way the scattered boxes are — every footprint
 * is a different shape — so instead the whole street is merged into a single
 * geometry and drawn once. Eight hundred buildings then cost one draw call,
 * which is what the instanced version cost, and the shading that `instanceColor`
 * used to carry is baked into vertex colours instead.
 */

/** Matches the scattered boxes: 0.78 at the base to 1.0 at the eaves, roofs brighter. */
function shadeAt(y: number, height: number, isRoof: boolean): number {
  if (isRoof) return 1.14
  return 0.78 + 0.22 * (height <= 0 ? 1 : y / height)
}

function buildGeometry(
  items: BuildingFootprint[],
  highlight?: Map<number, string>,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const tint = new THREE.Color()

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]
    if (item.polygon.length < 3) continue

    /*
     * Shapes are built in XY and laid flat afterwards. Extrusion runs along +Z,
     * so rotating -90° about X sends it to +Y — the building stands up — and
     * maps shape (x, y) to world (x, -y), which is why the outline's z is
     * negated going in.
     */
    const shape = new THREE.Shape(
      item.polygon.map(([x, z]) => new THREE.Vector2(x, -z)),
    )

    let geom: THREE.ExtrudeGeometry
    try {
      geom = new THREE.ExtrudeGeometry(shape, {
        depth: item.height,
        bevelEnabled: false,
        curveSegments: 1,
      })
    } catch {
      // A self-intersecting outline can defeat triangulation. One bad building
      // is not worth losing the street over.
      continue
    }
    geom.rotateX(-Math.PI / 2)

    const pos = geom.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    tint.set(
      highlight?.get(itemIndex) ??
        PALETTE.buildingTints[item.tint % PALETTE.buildingTints.length],
    )

    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      const shade = shadeAt(y, item.height, y > item.height - 0.01)
      colors[i * 3] = tint.r * shade
      colors[i * 3 + 1] = tint.g * shade
      colors[i * 3 + 2] = tint.b * shade
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.computeVertexNormals()
    parts.push(geom)
  }

  if (parts.length === 0) return new THREE.BufferGeometry()

  // Merge by hand rather than pulling in BufferGeometryUtils: every part has
  // the same two attributes and no index worth preserving.
  const merged = new THREE.BufferGeometry()
  let vertices = 0
  for (const g of parts) vertices += g.getAttribute('position').count

  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  const color = new Float32Array(vertices * 3)

  let offset = 0
  for (const g of parts) {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    const c = g.getAttribute('color')
    for (let i = 0; i < p.count; i++) {
      const o = (offset + i) * 3
      position[o] = p.getX(i)
      position[o + 1] = p.getY(i)
      position[o + 2] = p.getZ(i)
      normal[o] = n.getX(i)
      normal[o + 1] = n.getY(i)
      normal[o + 2] = n.getZ(i)
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

/**
 * @param highlight Destination buildings, by index into `items`. Baked into the
 * vertex colours like every other tint here — there is no instance colour to
 * override, because the whole street is one merged mesh.
 */
export function Footprints({
  items,
  highlight,
}: {
  items: BuildingFootprint[]
  highlight?: Map<number, string>
}) {
  const geom = useMemo(() => buildGeometry(items, highlight), [items, highlight])
  useEffect(() => () => geom.dispose(), [geom])

  if (items.length === 0) return null

  return (
    <mesh geometry={geom} castShadow receiveShadow>
      <meshLambertMaterial vertexColors />
    </mesh>
  )
}
