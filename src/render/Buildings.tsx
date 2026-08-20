import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import { buildingGeometry } from './geometry'
import type { BuildingInst } from './scatter'

/**
 * One instanced draw call for every building. The vertical lightness gradient
 * lives in the geometry's vertex colors; the per-building tint comes from
 * instanceColor. Three multiplies material * vertex * instance color.
 */
/**
 * @param highlight Buildings that are somewhere people are going, by index into
 * `items`, and the colour that says which. Transit mode's one licence to put a
 * saturated colour on an environment surface — the map is unreadable without
 * it, because a destination the player cannot see is a destination they cannot
 * plan a route to.
 */
export function Buildings({
  items,
  highlight,
}: {
  items: BuildingInst[]
  highlight?: Map<number, string>
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geom = useMemo(() => buildingGeometry(), [])

  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return

    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const c = new THREE.Color()

    items.forEach((b, i) => {
      q.setFromAxisAngle(up, b.rot)
      m.compose(
        new THREE.Vector3(b.x, 0, b.z),
        q,
        new THREE.Vector3(b.w, b.h, b.d),
      )
      mesh.setMatrixAt(i, m)
      c.set(
        highlight?.get(i) ?? PALETTE.buildingTints[b.tint % PALETTE.buildingTints.length],
      )
      mesh.setColorAt(i, c)
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [items, highlight])

  if (items.length === 0) return null

  return (
    <instancedMesh
      ref={ref}
      args={[geom, undefined, items.length]}
      castShadow
      receiveShadow
    >
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  )
}
