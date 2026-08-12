import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import {
  offsetPoly,
  polyLength,
  roadCentreline,
  samplePoly,
  trimPoly,
  type Pt,
} from '../sim/centreline'
import { laneLateralOffset } from '../sim/network'
import {
  CROSSWALK_DEPTH,
  CROSSWALK_GAP,
  LANE_WIDTH,
  PARKING_WIDTH,
  STOP_OFFSET,
  deckHeightAt,
  junctionSize,
  nodeById,
  roadEdges,
  roadWidth,
  type LevelDef,
  type RoadDef,
} from '../sim/types'
import { flatRoundedRect } from './geometry'
import { LAYER } from './layers'


/** `y` is the deck's contribution alone — the layer offset is added on top of it. */
type Rect = { x: number; z: number; angle: number; w: number; l: number; y: number }

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
        new THREE.Vector3(r.x, y + r.y, r.z),
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
 *
 * `deck`, when a road carries one, is read against arc length from the start
 * of `poly` — true for every caller here, since asphalt/curb/bus/parking
 * ribbons all walk the untrimmed centreline starting at `road.from`, exactly
 * where `deck.from`/`deck.to` were measured on import.
 */
function buildRibbons(
  items: { poly: Pt[]; left: number; right: number; deck?: RoadDef['deck'] }[],
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []

  for (const { poly, left: leftOff, right: rightOff, deck } of items) {
    const left = offsetPoly(poly, leftOff)
    const right = offsetPoly(poly, rightOff)
    const base = positions.length / 3

    let s = 0
    for (let i = 0; i < poly.length; i++) {
      if (i > 0) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z)
      const y = deckHeightAt(deck, s)
      positions.push(left[i].x, y, left[i].z, right[i].x, y, right[i].z)
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

/** Width of the painted line marking off the kerbside parking strip. */
const PARKING_LINE = 0.14

/** Width of a lane divider, and the dash pattern of a broken one. */
const LANE_LINE = 0.16
const DASH = 3
const DASH_GAP = 6

/** Half a junction box at this node, or zero where the road runs off the map. */
function halfOfNode(level: LevelDef, id: string): number {
  return nodeById(level, id).kind === 'junction' ? junctionSize(level, id) / 2 : 0
}

export function RoadNetwork({ level }: { level: LevelDef }) {
  const { asphaltGeom, curbGeom, busGeom, parkingGeom, markings, junctions } = useMemo(() => {
    type Ribbon = { poly: Pt[]; left: number; right: number; deck?: RoadDef['deck'] }
    const asphaltItems: Ribbon[] = []
    const curbItems: Ribbon[] = []
    const busItems: Ribbon[] = []
    const parkingItems: Ribbon[] = []
    const dividerItems: Ribbon[] = []
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
      asphaltItems.push({ poly: centre, left: edges.left, right: edges.right, deck: road.deck })
      curbItems.push({
        poly: centre,
        left: edges.left - CURB_LIP,
        right: edges.right + CURB_LIP,
        deck: road.deck,
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

      /*
       * Trimmed to the junction boxes, unlike the asphalt beneath it. The road
       * surface deliberately runs under the box and is covered by it; a marking
       * sits *above* the box, so an untrimmed one paints a lane line straight
       * across the middle of the intersection.
       */
      const trimStart = halfOfNode(level, road.from)
      const painted = trimPoly(centre, trimStart, halfOfNode(level, road.to))
      const paintedLen = polyLength(painted)
      // `deck` shifted into `painted`'s own arc-length frame, for ribbons built
      // on the trimmed line rather than the untrimmed centreline.
      const paintedDeck: RoadDef['deck'] = road.deck && {
        from: road.deck.from - trimStart,
        to: road.deck.to - trimStart,
        kind: road.deck.kind,
      }

      /** Like `mark`, but measured along the trimmed line the dividers use. */
      const markPainted = (s: number, lateral: number, mw: number, ml: number) => {
        const p = samplePoly(painted, s)
        markings.push({
          x: p.x - p.tz * lateral,
          z: p.z + p.tx * lateral,
          angle: Math.atan2(p.tx, p.tz),
          w: mw,
          l: ml,
          // `s` is arc length along `painted`, which starts `trimStart` into
          // `centre` — the frame `deck.from`/`deck.to` were measured in.
          y: deckHeightAt(road.deck, trimStart + s),
        })
      }

      /*
       * Lane dividers.
       *
       * Without these a two-lane carriageway is a single undifferentiated slab
       * of grey, and the street reads as one very wide lane rather than as the
       * two it is. The centreline below separates the *directions*; this
       * separates the lanes within a direction, which is the line a driver
       * actually keeps station against.
       *
       * Dashed between general lanes, because crossing one is allowed. Solid
       * against a bus lane, because it is not — the paint is the rule.
       */
      const divider = (lateral: number, solid: boolean) => {
        if (solid) {
          dividerItems.push({
            poly: painted,
            left: lateral - LANE_LINE / 2,
            right: lateral + LANE_LINE / 2,
            deck: paintedDeck,
          })
          return
        }
        for (let s = DASH_GAP; s < paintedLen - DASH_GAP; s += DASH + DASH_GAP) {
          const seg = Math.min(DASH, paintedLen - DASH_GAP - s)
          if (seg < 0.6) break
          markPainted(s + seg / 2, lateral, LANE_LINE, seg)
        }
      }

      /*
       * The parking strip is marked, not surfaced.
       *
       * It used to be filled in a slightly different grey, which read as a
       * separate piece of road running the whole length of every street — a wide
       * pale band that competed with the carriageway and made the streets look
       * twice as wide as they are. It is the same asphalt as the rest of the
       * road, and in life what tells you where it starts is a painted line. Now
       * that there are actually cars parked on it, the fill was doing no work at
       * all and the line does the job on its own.
       *
       * The bus lane keeps its colour: that is real surface treatment, and the
       * whole point of it is to be unmistakable at a glance.
       */
      if (parkRight > 0) {
        const inner = edges.right - parkRight
        parkingItems.push({
          poly: painted,
          left: inner - PARKING_LINE / 2,
          right: inner + PARKING_LINE / 2,
          deck: paintedDeck,
        })
      }
      if (parkLeft > 0) {
        const inner = edges.left + parkLeft
        parkingItems.push({
          poly: painted,
          left: inner - PARKING_LINE / 2,
          right: inner + PARKING_LINE / 2,
          deck: paintedDeck,
        })
      }
      if (busFwd > 0) {
        const outer = edges.right - parkRight
        busItems.push({ poly: centre, left: outer - busFwd, right: outer, deck: road.deck })
      }
      if (busBwd > 0) {
        const outer = edges.left + parkLeft
        busItems.push({ poly: centre, left: outer, right: outer + busBwd, deck: road.deck })
      }

      /*
       * One boundary per pair of adjacent lanes, in each direction that exists.
       * A one-way's lanes straddle the centreline and a two-way's sit wholly on
       * their own side, but `laneLateralOffset` already knows which — so the
       * boundary is always half a lane inboard of lane k's centre, and the
       * backward carriageway is the mirror of the forward one.
       */
      const busFwdLanes = road.oneWay
        ? (road.busLanes?.forward ?? 0)
        : (road.busLanes?.forward ?? 0)
      const busBwdLanes = road.oneWay ? 0 : (road.busLanes?.backward ?? 0)

      for (const [sign, buses] of [
        [1, busFwdLanes],
        ...(road.oneWay ? [] : [[-1, busBwdLanes] as const]),
      ] as const) {
        const total = road.lanesPerDir + (buses > 0 ? 1 : 0)
        for (let k = 1; k < total; k++) {
          const boundary = laneLateralOffset(road, k) - LANE_WIDTH / 2
          // The last boundary is the one against the bus lane, if there is one.
          divider(sign * boundary, buses > 0 && k === total - 1)
        }
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
          y: deckHeightAt(road.deck, s),
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
      parkingGeom: buildRibbons([...parkingItems, ...dividerItems]),
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
      <mesh geometry={curbGeom} position={[0, LAYER.curb, 0]}>
        <meshLambertMaterial color={PALETTE.curb} />
      </mesh>
      <mesh geometry={junctionCurbGeom} position={[0, LAYER.junctionCurb, 0]}>
        <meshLambertMaterial color={PALETTE.curb} />
      </mesh>

      <mesh geometry={asphaltGeom} position={[0, LAYER.road, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.road} />
      </mesh>
      {/*
        Surface paint, over the asphalt but under the junction boxes and the
        white markings. The order is doing real work: the ribbons run the full
        untrimmed centreline, so the box drawn on top of them is what stops the
        bus lane and the parking bay at the crossing, and the markings drawn
        after keep a stop bar legible where it lies across paint.
      */}
      {/* Painted, so it sits on the marking layer with the lane lines. */}
      <mesh geometry={parkingGeom} position={[0, LAYER.parkingLine, 0]}>
        <meshBasicMaterial color={PALETTE.marking} toneMapped={false} />
      </mesh>
      <mesh geometry={busGeom} position={[0, LAYER.busLane, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.busLane} />
      </mesh>

      <mesh geometry={junctionGeom} position={[0, LAYER.junction, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.road} />
      </mesh>

      <InstancedRects rects={markings} color={PALETTE.marking} y={LAYER.marking} />
    </group>
  )
}
