import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import type { TreeInst } from './scatter'

/**
 * Trees are the texture budget of this art style — in the reference they carry
 * most of the visual interest and keep the near-white world from feeling empty.
 * Faceted low-poly blobs on a short trunk, two instanced draw calls total.
 */
export function Trees({ items }: { items: TreeInst[] }) {
  const foliageRef = useRef<THREE.InstancedMesh>(null)
  const trunkRef = useRef<THREE.InstancedMesh>(null)

  // detail 0 keeps the facets visible, which is what reads as "low-poly blob".
  const foliageGeom = useMemo(() => new THREE.IcosahedronGeometry(1, 0), [])
  const trunkGeom = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.16, 0.22, 1, 6)
    g.translate(0, 0.5, 0)
    return g
  }, [])

  useLayoutEffect(() => {
    const foliage = foliageRef.current
    const trunk = trunkRef.current
    if (!foliage || !trunk) return

    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const c = new THREE.Color()

    items.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot)

      const trunkH = t.scale * 1.15
      // Ground level under this tree — 0 everywhere but on a median, which
      // stands on its kerb.
      const base = t.y ?? 0
      m.compose(
        new THREE.Vector3(t.x, base, t.z),
        q,
        new THREE.Vector3(t.scale * 0.32, trunkH, t.scale * 0.32),
      )
      trunk.setMatrixAt(i, m)

      // Crown sits on top of the trunk, squashed slightly so it reads as a canopy.
      m.compose(
        new THREE.Vector3(t.x, base + trunkH + t.scale * 0.62, t.z),
        q,
        new THREE.Vector3(t.scale, t.scale * 0.85, t.scale),
      )
      foliage.setMatrixAt(i, m)

      c.set(t.dark ? PALETTE.treeFoliageDark : PALETTE.treeFoliage)
      foliage.setColorAt(i, c)
    })

    foliage.instanceMatrix.needsUpdate = true
    trunk.instanceMatrix.needsUpdate = true
    if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true
    foliage.computeBoundingSphere()
    trunk.computeBoundingSphere()
  }, [items])

  if (items.length === 0) return null

  return (
    <group>
      <instancedMesh ref={trunkRef} args={[trunkGeom, undefined, items.length]} castShadow>
        <meshLambertMaterial color={PALETTE.treeTrunk} />
      </instancedMesh>
      <instancedMesh
        ref={foliageRef}
        args={[foliageGeom, undefined, items.length]}
        castShadow
      >
        <meshLambertMaterial vertexColors={false} />
      </instancedMesh>
    </group>
  )
}
