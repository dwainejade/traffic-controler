import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import {
  CROSSWALK_DEPTH,
  CROSSWALK_GAP,
  STOP_OFFSET,
  junctionSize,
  nodeById,
  roadWidth,
  type LevelDef,
} from '../sim/types'
import { flatRoundedRect } from './geometry'

/** Draw order on the ground plane. Small gaps avoid z-fighting on a flat surface. */
const Y_CURB = 0.012
const Y_ROAD = 0.03
const Y_MARK = 0.05

type Rect = { x: number; z: number; angle: number; w: number; l: number }

const UNIT_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)

/** Flat rects rendered as one instanced draw call. Used for every road marking. */
function InstancedRects({
  rects,
  color,
  y,
}: {
  rects: Rect[]
  color: string
  y: number
}) {
  const ref = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    rects.forEach((r, i) => {
      q.setFromAxisAngle(up, r.angle)
      m.compose(
        new THREE.Vector3(r.x, y, r.z),
        q,
        new THREE.Vector3(r.w, 1, r.l),
      )
      mesh.setMatrixAt(i, m)
    })
    mesh.count = rects.length
    mesh.instanceMatrix.needsUpdate = true
  }, [rects, y])

  if (rects.length === 0) return null

  return (
    <instancedMesh
      ref={ref}
      args={[UNIT_PLANE, undefined, rects.length]}
      receiveShadow
    >
      <meshLambertMaterial color={color} />
    </instancedMesh>
  )
}

export function RoadNetwork({ level }: { level: LevelDef }) {
  const { asphalt, curbs, markings, junctions } = useMemo(() => {
    const asphalt: Rect[] = []
    const curbs: Rect[] = []
    const markings: Rect[] = []
    const junctions: { x: number; z: number; size: number }[] = []

    const CURB_LIP = 0.7

    for (const node of level.nodes) {
      if (node.kind !== 'junction') continue
      junctions.push({
        x: node.pos[0],
        z: node.pos[1],
        size: junctionSize(level, node.id),
      })
    }

    for (const road of level.roads) {
      const a = nodeById(level, road.from)
      const b = nodeById(level, road.to)
      const w = roadWidth(road)

      const dx = b.pos[0] - a.pos[0]
      const dz = b.pos[1] - a.pos[1]
      const len = Math.hypot(dx, dz)
      const angle = Math.atan2(dx, dz)
      const ux = dx / len
      const uz = dz / len
      // Lateral unit vector, perpendicular to the road.
      const lx = -uz
      const lz = ux

      const mx = (a.pos[0] + b.pos[0]) / 2
      const mz = (a.pos[1] + b.pos[1]) / 2

      asphalt.push({ x: mx, z: mz, angle, w, l: len })
      curbs.push({ x: mx, z: mz, angle, w: w + CURB_LIP * 2, l: len })

      // Distance measured from node `a` toward node `b`.
      const at = (dist: number, lateral: number) => ({
        x: a.pos[0] + ux * dist + lx * lateral,
        z: a.pos[1] + uz * dist + lz * lateral,
      })

      // On a grid a road can meet a junction at both ends, so each end is
      // handled independently and the through-markings span whatever is left.
      const ends = [
        { node: a, from: 0, dir: 1 },
        { node: b, from: len, dir: -1 },
      ]

      let markStart = 2
      let markEnd = len - 2

      for (const end of ends) {
        if (end.node.kind !== 'junction') continue
        const half = junctionSize(level, end.node.id) / 2

        // Traffic approaching this end travels against `dir`, so it sits on the
        // opposite lateral side from traffic leaving.
        const approachSide = -end.dir

        // --- Crosswalk: bars parallel to traffic, banded across the carriageway.
        const stripePitch = 1.6
        const stripes = Math.floor(w / stripePitch)
        const cwD = end.from + end.dir * (half + CROSSWALK_GAP + CROSSWALK_DEPTH / 2)
        for (let i = 0; i < stripes; i++) {
          const lateral = -w / 2 + stripePitch / 2 + i * stripePitch
          const p = at(cwD, lateral)
          markings.push({ x: p.x, z: p.z, angle, w: 0.75, l: CROSSWALK_DEPTH })
        }

        // --- Stop line: spans only the approaching half of the carriageway.
        const stopD = end.from + end.dir * (half + STOP_OFFSET)
        const stopP = at(stopD, (approachSide * w) / 4)
        markings.push({ x: stopP.x, z: stopP.z, angle, w: w / 2 - 0.3, l: 0.7 })

        const clear = half + STOP_OFFSET + 3
        if (end.dir > 0) markStart = clear
        else markEnd = len - clear
      }

      const span = markEnd - markStart
      if (span <= 0) continue

      // --- Solid centreline. Solid, not dashed, so the two carriageways read as
      // separate directions at a glance rather than as four identical lanes.
      const cp = at(markStart + span / 2, 0)
      markings.push({ x: cp.x, z: cp.z, angle, w: 0.45, l: span })

      // --- Lane dividers, dashed, one per direction per extra lane.
      const dashLen = 3.0
      const dashGap = 4.0
      if (road.lanesPerDir > 1) {
        for (const side of [-1, 1]) {
          for (let k = 1; k < road.lanesPerDir; k++) {
            const lateral = side * (k * (w / (road.lanesPerDir * 2)))
            let dd = markStart
            while (dd < markEnd) {
              const p = at(dd + dashLen / 2, lateral)
              markings.push({ x: p.x, z: p.z, angle, w: 0.25, l: dashLen })
              dd += dashLen + dashGap
            }
          }
        }
      }
    }

    return { asphalt, curbs, markings, junctions }
  }, [level])

  const junctionGeoms = useMemo(
    () => junctions.map((j) => flatRoundedRect(j.size / 2, j.size / 2, 3)),
    [junctions],
  )
  const junctionCurbGeoms = useMemo(
    () => junctions.map((j) => flatRoundedRect(j.size / 2 + 0.7, j.size / 2 + 0.7, 3.6)),
    [junctions],
  )

  return (
    <group>
      {/* Casing sits just under the asphalt and reads as a curb lip. */}
      <InstancedRects rects={curbs} color={PALETTE.curb} y={Y_CURB} />
      {junctions.map((j, i) => (
        <mesh
          key={`jc-${i}`}
          geometry={junctionCurbGeoms[i]}
          position={[j.x, Y_CURB + 0.001, j.z]}
        >
          <meshLambertMaterial color={PALETTE.curb} />
        </mesh>
      ))}

      <InstancedRects rects={asphalt} color={PALETTE.road} y={Y_ROAD} />
      {junctions.map((j, i) => (
        <mesh
          key={`ja-${i}`}
          geometry={junctionGeoms[i]}
          position={[j.x, Y_ROAD + 0.001, j.z]}
          receiveShadow
        >
          <meshLambertMaterial color={PALETTE.road} />
        </mesh>
      ))}

      <InstancedRects rects={markings} color={PALETTE.marking} y={Y_MARK} />
    </group>
  )
}
