import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import {
  offsetPoly,
  polyLength,
  roadCentreline,
  samplePoly,
  type Pt,
} from '../sim/centreline'
import { laneLateralOffset } from '../sim/network'
import {
  CROSSWALK_DEPTH,
  CROSSWALK_GAP,
  LANE_WIDTH,
  PARKING_WIDTH,
  STOP_OFFSET,
  junctionSize,
  nodeById,
  roadEdges,
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

/**
 * All roads' carriageways merged into one flat ribbon mesh. Each road walks its
 * centreline and pushes a pair of mitred edge vertices per sample, so a curved
 * street is exactly as cheap as a straight one: one draw call for every road
 * surface on the map, another for the kerbs beneath them.
 */
/**
 * Merge one geometry per item into a single buffer, each translated into place.
 * The pieces are static, so this trades a rebuild on level load for one draw
 * call instead of hundreds.
 */
function mergeAt<T extends { x: number; z: number }>(
  items: T[],
  make: (item: T) => THREE.BufferGeometry,
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []

  for (const item of items) {
    const g = make(item)
    const pos = g.getAttribute('position')
    const idx = g.getIndex()
    const base = positions.length / 3

    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i) + item.x, pos.getY(i), pos.getZ(i) + item.z)
    }
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(base + idx.getX(i))
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(base + i)
    }
    g.dispose()
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geom.setIndex(indices)
  return geom
}

/**
 * Ribbons are built from a pair of signed lateral offsets rather than a width,
 * because a street is not necessarily symmetric about its centreline: a
 * kerbside bus lane sits on one side only, and the paved surface has to grow on
 * that side alone or the whole street visibly drifts off its own centre.
 */
function buildRibbons(items: { poly: Pt[]; left: number; right: number }[]): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []

  for (const { poly, left: leftOff, right: rightOff } of items) {
    const left = offsetPoly(poly, leftOff)
    const right = offsetPoly(poly, rightOff)
    const base = positions.length / 3

    for (let i = 0; i < poly.length; i++) {
      positions.push(left[i].x, 0, left[i].z, right[i].x, 0, right[i].z)
    }
    for (let i = 0; i < poly.length - 1; i++) {
      // Wound so the face normal points up (+y); a downward winding would be
      // backface-culled and the whole road would simply not draw.
      const a = base + i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geom.setIndex(indices)
  return geom
}

const CURB_LIP = 0.7

export function RoadNetwork({ level }: { level: LevelDef }) {
  const { asphaltGeom, curbGeom, busGeom, parkingGeom, markings, junctions } = useMemo(() => {
    type Ribbon = { poly: Pt[]; left: number; right: number }
    const asphaltItems: Ribbon[] = []
    const curbItems: Ribbon[] = []
    const busItems: Ribbon[] = []
    const parkingItems: Ribbon[] = []
    const markings: Rect[] = []
    const junctions: { x: number; z: number; size: number }[] = []

    for (const node of level.nodes) {
      if (node.kind !== 'junction') continue
      junctions.push({
        x: node.pos[0],
        z: node.pos[1],
        size: junctionSize(level, node.id),
      })
    }

    for (const road of level.roads) {
      const w = roadWidth(road)
      const edges = roadEdges(road)
      const centre = roadCentreline(level, road)
      const len = polyLength(centre)

      // The full, untrimmed centreline: the carriageway tucks under the
      // junction box exactly as the old full-length rect did.
      asphaltItems.push({ poly: centre, left: edges.left, right: edges.right })
      curbItems.push({
        poly: centre,
        left: edges.left - CURB_LIP,
        right: edges.right + CURB_LIP,
      })

      /*
       * Bus lanes and parking are stacked outboard of the moving lanes, on top
       * of the asphalt. Their extents come from the same arithmetic the kerb
       * does, so the painted lane always lands exactly where the road model
       * says it is rather than somewhere close.
       */
      const parking = road.parkingSides ?? 0
      const parkRight = parking >= 1 ? PARKING_WIDTH : 0
      const parkLeft = parking >= 2 ? PARKING_WIDTH : 0
      const busFwd = (road.busLanes?.forward ?? 0) * LANE_WIDTH
      const busBwd = road.oneWay ? 0 : (road.busLanes?.backward ?? 0) * LANE_WIDTH

      if (parkRight > 0) {
        parkingItems.push({ poly: centre, left: edges.right - parkRight, right: edges.right })
      }
      if (parkLeft > 0) {
        parkingItems.push({ poly: centre, left: edges.left, right: edges.left + parkLeft })
      }
      if (busFwd > 0) {
        const outer = edges.right - parkRight
        busItems.push({ poly: centre, left: outer - busFwd, right: outer })
      }
      if (busBwd > 0) {
        const outer = edges.left + parkLeft
        busItems.push({ poly: centre, left: outer, right: outer + busBwd })
      }

      // A marking at arc distance s from the road's start, offset laterally to
      // the driver's right of the from→to direction, aligned with the tangent
      // (plus an optional extra twist, used by the one-way chevrons).
      const mark = (s: number, lateral: number, mw: number, ml: number, twist = 0) => {
        const p = samplePoly(centre, s)
        markings.push({
          x: p.x - p.tz * lateral,
          z: p.z + p.tx * lateral,
          angle: Math.atan2(p.tx, p.tz) + twist,
          w: mw,
          l: ml,
        })
      }

      // A road can meet a junction at both ends; each end is handled
      // independently and the through-markings span whatever is left.
      const ends = [
        { node: nodeById(level, road.from), from: 0, dir: 1 },
        { node: nodeById(level, road.to), from: len, dir: -1 },
      ]

      let markStart = 2
      let markEnd = len - 2

      for (const end of ends) {
        if (end.node.kind !== 'junction') continue
        const half = junctionSize(level, end.node.id) / 2

        // Traffic approaching this end travels against `dir`, so it sits on the
        // opposite lateral side from traffic leaving.
        const approachSide = -end.dir

        // --- Crosswalk: bars parallel to traffic, banded kerb to kerb. It spans
        // the paved width, not the driving width — a pedestrian crosses the
        // parking strip and the bus lane too.
        const stripePitch = 1.6
        const paved = edges.right - edges.left
        const stripes = Math.floor(paved / stripePitch)
        const cwS = end.from + end.dir * (half + CROSSWALK_GAP + CROSSWALK_DEPTH / 2)
        for (let i = 0; i < stripes; i++) {
          const lateral = edges.left + stripePitch / 2 + i * stripePitch
          mark(cwS, lateral, 0.75, CROSSWALK_DEPTH)
        }

        // --- Stop line: spans only the approaching half of the carriageway —
        // or all of it on a one-way, which has no other half and only ever
        // receives traffic at its `to` end.
        const stopS = end.from + end.dir * (half + STOP_OFFSET)
        if (!road.oneWay) {
          mark(stopS, (approachSide * w) / 4, w / 2 - 0.3, 0.7)
        } else if (end.dir === -1) {
          mark(stopS, 0, w - 0.6, 0.7)
        }

        const clear = half + STOP_OFFSET + 3
        if (end.dir > 0) markStart = clear
        else markEnd = len - clear
      }

      if (markEnd - markStart <= 0) continue

      if (road.oneWay) {
        // --- Direction chevrons instead of a centreline: two strokes meeting
        // point-forward, repeated down each lane. Per lane, not per road: on a
        // multi-lane one-way a single chevron on the centreline lands on the
        // lane divider, pointing along the join between two lanes.
        for (let s = markStart + 6; s < markEnd - 4; s += 18) {
          for (let k = 0; k < road.lanesPerDir; k++) {
            const centreOfLane = laneLateralOffset(road, k)
            for (const side of [-1, 1]) {
              mark(s, centreOfLane + side * 0.55, 0.35, 1.45, side * 0.94)
            }
          }
        }
      } else {
        // --- Solid centreline, walked in short segments so it follows the
        // curve. Solid, not dashed, so the two carriageways read as separate
        // directions at a glance.
        const SEG = 2.6
        for (let s = markStart; s < markEnd; s += SEG) {
          const segLen = Math.min(SEG + 0.12, markEnd - s)
          mark(s + segLen / 2, 0, 0.45, segLen)
        }
      }

      /*
       * Lane dividers, dashed, between adjacent moving lanes.
       *
       * The divider positions are taken straight from where the lanes actually
       * are — the boundary between lane k-1 and lane k is the midpoint of their
       * two centres — rather than derived independently from the road width. An
       * earlier version divided the width by the lane count, which happened to
       * agree for two-way roads and was wrong for every multi-lane one-way:
       * a three-lane one-way got four dividers, two of them out in the kerb.
       */
      const dashLen = 3.0
      const dashGap = 4.0
      if (road.lanesPerDir > 1) {
        const sides = road.oneWay ? [1] : [1, -1]
        for (const side of sides) {
          for (let k = 1; k < road.lanesPerDir; k++) {
            const inner = laneLateralOffset(road, k - 1)
            const outer = laneLateralOffset(road, k)
            const lateral = side * ((inner + outer) / 2)
            for (let s = markStart; s < markEnd; s += dashLen + dashGap) {
              mark(s + dashLen / 2, lateral, 0.25, dashLen)
            }
          }
        }
      }
    }

    return {
      asphaltGeom: buildRibbons(asphaltItems),
      curbGeom: buildRibbons(curbItems),
      busGeom: buildRibbons(busItems),
      parkingGeom: buildRibbons(parkingItems),
      markings,
      junctions,
    }
  }, [level])

  /*
   * Junction boxes, merged into one geometry each rather than a mesh apiece.
   *
   * A mesh per junction is fine at four junctions and quietly disastrous at
   * four hundred: every junction was costing two draw calls and two material
   * objects, so the boxes alone were most of the scene's draw calls while the
   * roads, cars, buildings and trees together took under ten. They never move,
   * so there is nothing to gain by keeping them separate.
   */
  const junctionGeom = useMemo(
    () => mergeAt(junctions, (j) => flatRoundedRect(j.size / 2, j.size / 2, 3)),
    [junctions],
  )
  const junctionCurbGeom = useMemo(
    () => mergeAt(junctions, (j) => flatRoundedRect(j.size / 2 + 0.7, j.size / 2 + 0.7, 3.6)),
    [junctions],
  )

  return (
    <group>
      {/* Casing sits just under the asphalt and reads as a curb lip. */}
      <mesh geometry={curbGeom} position={[0, Y_CURB, 0]}>
        <meshLambertMaterial color={PALETTE.curb} />
      </mesh>
      <mesh geometry={junctionCurbGeom} position={[0, Y_CURB + 0.001, 0]}>
        <meshLambertMaterial color={PALETTE.curb} />
      </mesh>

      <mesh geometry={asphaltGeom} position={[0, Y_ROAD, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.road} />
      </mesh>
      {/*
        Surface paint, over the asphalt but under the junction boxes and the
        white markings. The order is doing real work: the ribbons run the full
        untrimmed centreline, so the box drawn on top of them is what stops the
        bus lane and the parking bay at the crossing, and the markings drawn
        after keep a stop bar legible where it lies across paint.
      */}
      <mesh geometry={parkingGeom} position={[0, Y_ROAD + 0.001, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.parking} />
      </mesh>
      <mesh geometry={busGeom} position={[0, Y_ROAD + 0.002, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.busLane} />
      </mesh>

      <mesh geometry={junctionGeom} position={[0, Y_ROAD + 0.003, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.road} />
      </mesh>

      <InstancedRects rects={markings} color={PALETTE.marking} y={Y_MARK} />
    </group>
  )
}
