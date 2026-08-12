import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import { SKY } from '../art/daylight'
import { polyLength, roadCentreline, samplePoly } from '../sim/centreline'
import {
  deckHeightAt,
  junctionSize,
  nodeById,
  pavedWidth,
  roadEdges,
  type LevelDef,
  type NodeId,
} from '../sim/types'
import { useGlow } from './glow'

/**
 * Street lights.
 *
 * The night half of the day cycle used to be lit by headlights alone, which
 * makes a city read as a stream of cars crossing an unlit void — the streets
 * themselves disappear and the network you are supposed to be reading goes with
 * them. A lamp every thirty metres puts the roads back.
 *
 * Everything here is instanced and written once. Three meshes cover every lamp
 * on the map — column, housing and lit lens — plus one light for what they do
 * to the city between them. The only per-frame work is switching the lenses on
 * and winding that light up with the clock. A mesh per lamp would have been
 * several thousand draw calls at dusk, for an object nobody looks directly at.
 */

/** Metres. */
const POLE_HEIGHT = 8.4
const POLE_RADIUS = 0.11
const BEND_RADIUS = 1.2
/**
 * How far the lamp hangs over the carriageway.
 *
 * Fixed rather than scaled to the road, because a fixed reach is what lets
 * every column on the map be one instanced geometry. A wide avenue would
 * really carry a longer arm; at the size a lamp appears on screen, the
 * difference is a few pixels and the draw call is not worth it.
 */
const ARM_REACH = 2.8
/** How far back from the kerb the column stands, into the footway. */
const SETBACK = 0.9

/** Metres of street between lamps. */
const SPACING = 32
/**
 * How far past the junction box the outermost lamp on a street stands.
 *
 * Close, deliberately — just far enough to keep a column out of the crossing
 * itself. Lamps belong on corners, and at seven metres every junction on the
 * map had a conspicuous gap in its row of them.
 */
const END_CLEARANCE = 2.5
/**
 * Ceiling on lamps, for an imported area larger than anything that ships. The
 * instancing means the cost of the cap being hit is invisible rather than a
 * hitch, but the buffers still have to be allocated for it.
 */
const MAX_LAMPS = 6000

/** Below this much night the lamps are off. Matches the vehicles' headlamps. */
const LAMPS_ON = 0.08

const LENS_GEOM = new THREE.BoxGeometry(0.62, 0.16, 0.34)
const HOUSING_GEOM = new THREE.BoxGeometry(0.7, 0.22, 0.42)

/**
 * How much fill the lamps add to the city at full night, on top of the sky's
 * own 0.6.
 *
 * Small on purpose. At 0.55 the streets were legible and it was no longer
 * night — the warm cast washed the blue out of the sky fill and the whole map
 * came back up to something near an overcast afternoon. Night has to stay
 * night; the lamps are there to pick the roads out of it, not to end it.
 *
 * This replaced a pool of light painted on the road under every lamp. That was
 * a flat additive disc, and it read as one: a perfect circle of the same size
 * everywhere, laid over the road, the footway, the grass and the front of any
 * building that got in its way, scalloping into its neighbours where they
 * overlapped. Lamps light a city by lighting it, not by drawing a circle.
 */
const STREET_FILL = 0.18

type Lamp = {
  /** Foot of the column. */
  x: number
  y: number
  z: number
  /** Rotation about Y that swings the arm out over the carriageway. */
  angle: number
}

/**
 * The column: straight up, bent through a quarter circle, out over the road.
 * Built once at the origin with its arm along +X, so an instance is a position
 * and a rotation.
 */
function columnGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = []
  const straight = POLE_HEIGHT - BEND_RADIUS

  pts.push(new THREE.Vector3(0, 0, 0))
  pts.push(new THREE.Vector3(0, straight, 0))

  const SEGMENTS = 4
  for (let i = 1; i <= SEGMENTS; i++) {
    const a = (Math.PI / 2) * (i / SEGMENTS)
    pts.push(
      new THREE.Vector3(
        BEND_RADIUS * (1 - Math.cos(a)),
        straight + BEND_RADIUS * Math.sin(a),
        0,
      ),
    )
  }
  pts.push(new THREE.Vector3(ARM_REACH, POLE_HEIGHT, 0))

  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
  return new THREE.TubeGeometry(curve, 14, POLE_RADIUS, 5, false)
}

/** Half a junction box at this node, or zero where the road runs off the map. */
function halfOfNode(level: LevelDef, id: NodeId): number {
  return nodeById(level, id).kind === 'junction' ? junctionSize(level, id) / 2 : 0
}

function buildLamps(level: LevelDef): Lamp[] {
  const lamps: Lamp[] = []

  for (const road of level.roads) {
    const centre = roadCentreline(level, road)
    const length = polyLength(centre)
    const from = halfOfNode(level, road.from) + END_CLEARANCE
    const to = length - halfOfNode(level, road.to) - END_CLEARANCE
    const usable = to - from
    if (usable < 6) continue

    const edges = roadEdges(road)
    /*
     * A street wide enough to need light from both sides gets staggered
     * columns; a narrow one is lit from one kerb, which is what a residential
     * street actually looks like and half the poles.
     */
    const stagger = pavedWidth(road) > 15

    /*
     * Lamps land on both ends of the block and divide the rest evenly, rather
     * than being strung from a half-step in. That half step was worth about
     * sixteen metres, which is exactly enough to leave every junction on the
     * map in a hole while the middle of each block was lit twice over.
     */
    const spans = Math.max(1, Math.round(usable / SPACING))
    const step = usable / spans

    for (let i = 0; i <= spans && lamps.length < MAX_LAMPS; i++) {
      const s = from + step * i
      const p = samplePoly(centre, s)
      // Positive lateral is 90° left of the tangent, matching the road paint.
      const right = !stagger || i % 2 === 0
      const lateral = right ? edges.right + SETBACK : edges.left - SETBACK

      // The arm reaches back across the road, so the lamp is over the traffic
      // rather than over the footway the column stands on.
      const inward = right
        ? { x: p.tz, z: -p.tx }
        : { x: -p.tz, z: p.tx }

      lamps.push({
        x: p.x - p.tz * lateral,
        y: deckHeightAt(road.deck, s),
        z: p.z + p.tx * lateral,
        // Local +X maps to (cos, -sin) in world XZ under a Y rotation.
        angle: Math.atan2(-inward.z, inward.x),
      })
    }
  }

  return lamps
}

export function StreetLights({ level }: { level: LevelDef }) {
  const lamps = useMemo(() => buildLamps(level), [level])
  const column = useMemo(columnGeometry, [])

  const columns = useRef<THREE.InstancedMesh>(null)
  const housings = useRef<THREE.InstancedMesh>(null)
  const lenses = useRef<THREE.InstancedMesh>(null)
  const fill = useRef<THREE.HemisphereLight>(null)

  /*
   * The lens blooms; the pool it throws does not. The pool is already a soft
   * additive gradient, and blurring a blur only produces haze — the lamp stops
   * reading as a point of light and the street goes milky.
   */
  useGlow(lenses)

  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const one = new THREE.Vector3(1, 1, 1)
    const pos = new THREE.Vector3()

    lamps.forEach((lamp, i) => {
      q.setFromAxisAngle(up, lamp.angle)

      pos.set(lamp.x, lamp.y, lamp.z)
      m.compose(pos, q, one)
      columns.current?.setMatrixAt(i, m)

      // The lamp itself, at the far end of the arm.
      const cos = Math.cos(lamp.angle)
      const sin = Math.sin(lamp.angle)
      const headX = lamp.x + cos * ARM_REACH
      const headZ = lamp.z - sin * ARM_REACH

      pos.set(headX, lamp.y + POLE_HEIGHT, headZ)
      m.compose(pos, q, one)
      housings.current?.setMatrixAt(i, m)

      // The lens sits under the housing, which is the only part that lights up.
      pos.set(headX, lamp.y + POLE_HEIGHT - 0.16, headZ)
      m.compose(pos, q, one)
      lenses.current?.setMatrixAt(i, m)

    })

    /*
     * Instance matrices are written after construction, so every bounding
     * sphere here was built from the identity — a sphere at the origin, which
     * frustum culling throws away the moment the camera looks anywhere else.
     */
    for (const mesh of [columns.current, housings.current, lenses.current]) {
      if (!mesh) continue
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
    }
  }, [lamps])

  useFrame(() => {
    // One sample of the sky per frame, and nothing per lamp: after dusk the
    // only things that change are one material's visibility and one intensity.
    const night = SKY.night
    const lit = night > LAMPS_ON
    const strength = THREE.MathUtils.clamp((night - LAMPS_ON) * 1.8, 0, 1)

    const lens = lenses.current
    if (lens) {
      lens.visible = lit
      lens.count = lit ? lamps.length : 0
    }
    if (fill.current) fill.current.intensity = strength * STREET_FILL
  })

  if (lamps.length === 0) return null

  return (
    <group>
      <instancedMesh ref={columns} args={[column, undefined, lamps.length]} castShadow>
        <meshLambertMaterial color={PALETTE.signPost} />
      </instancedMesh>
      <instancedMesh ref={housings} args={[HOUSING_GEOM, undefined, lamps.length]} castShadow>
        <meshLambertMaterial color={PALETTE.curb} />
      </instancedMesh>

      {/* Unlit and untone-mapped, so a lamp reads as a source rather than a
          pale grey box that happens to be brighter than its surroundings. */}
      <instancedMesh ref={lenses} args={[LENS_GEOM, undefined, lamps.length]} visible={false}>
        <meshBasicMaterial color={LAMP_COLOR} toneMapped={false} />
      </instancedMesh>
      {/*
        What the lamps actually do to the city, as light rather than as a decal.
        Warm, from above, and nothing from below — a street lamp lights the road
        and the tops of things, not the undersides.
      */}
      <hemisphereLight ref={fill} args={[LAMP_COLOR, '#1B2028', 0]} />
    </group>
  )
}

/** Warm sodium-ish white, a shade warmer than a headlamp. */
const LAMP_COLOR = '#FFE2AE'
