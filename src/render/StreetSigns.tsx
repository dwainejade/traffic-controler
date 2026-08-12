import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import { type LevelDef } from '../sim/types'
import { CORNER_RADIUS, cornerNoses, junctionArms, type Arm } from './junctionShape'

/**
 * Street name signs, standing on the corners.
 *
 * The names are already on the map, lying flat on the carriageway, and that is
 * the map's answer to "what street is this". This is the city's answer to it:
 * a post on the corner with a blade for each street, which is the thing you
 * would actually look for standing at the junction. The two do not compete —
 * one is legible from across the map and unreadable up close, the other the
 * other way round.
 *
 * A blade runs parallel to the street it names and faces the street it does
 * not, exactly as a real one does: you read the cross street's name off a blade
 * mounted square across your own direction of travel.
 */

/** Metres. */
const POST_HEIGHT = 2.9
const POST_WIDTH = 0.11
const BLADE_HEIGHT = 0.52
const BLADE_THICKNESS = 0.07
/** Blades stack rather than intersect, the lower one a blade's height down. */
const BLADE_Y = [2.62, 2.02]
/** How far the post stands clear of the kerb, into the footway. */
const CLEAR = 1.5

/** Blade length from the name it carries, within what a corner can hold. */
function bladeLength(name: string): number {
  return THREE.MathUtils.clamp(name.length * 0.42 + 0.6, 2.4, 6)
}

const TEXT_SIZE = 0.3

/**
 * Text is the expensive half of this — one mesh per blade, against instanced
 * geometry for every post and blade on the map. So it is built only when it
 * would actually be read: when a line of it would land at least this many
 * pixels tall, and only for the corners near what the player is looking at.
 *
 * The test is apparent size rather than zoom position, because the two cameras
 * disagree wildly about it. The 3/4 model view is fully zoomed in at about
 * eight pixels of cap height — a grey smudge on the blade, and a few hundred
 * text meshes to draw it — while the street-level camera goes far past legible.
 */
const MIN_TEXT_PIXELS = 10
const TEXT_RADIUS = 190
const MAX_TEXT_BLADES = 90
/** Seconds between rechecks of which corners are close enough to letter. */
const TEXT_INTERVAL = 0.25

type Blade = {
  key: string
  name: string
  /** Centre of the blade. */
  x: number
  y: number
  z: number
  /** Rotation about Y putting the blade's length along its own street. */
  angle: number
  length: number
}

type Sign = { key: string; x: number; z: number; blades: Blade[] }

function buildSigns(level: LevelDef): Sign[] {
  const signs: Sign[] = []

  for (const junction of junctionArms(level)) {
    const noses = cornerNoses(junction.arms, junction.size / 2, CORNER_RADIUS, CLEAR)

    for (const [i, nose] of noses.entries()) {
      const x = junction.x + nose.x
      const z = junction.z + nose.z
      const named = [nose.a, nose.b].filter((arm) => !!arm.name)
      // Nothing to sign. A corner where both arms are the same street is a
      // bend, not a crossing, and signing it twice says nothing either.
      if (named.length === 0) continue
      const streets =
        named.length === 2 && named[0].name === named[1].name ? [named[0]] : named

      const blades: Blade[] = streets.map((arm, k) => {
        // The blade faces whichever way the *other* street runs, so traffic on
        // that street reads it head-on.
        const other = arm === nose.a ? nose.b : nose.a
        return {
          key: `${junction.id}_${i}_${k}`,
          name: arm.name!,
          x,
          y: BLADE_Y[k] ?? BLADE_Y[BLADE_Y.length - 1],
          z,
          angle: bladeAngle(arm, other),
          length: bladeLength(arm.name!),
        }
      })

      signs.push({ key: `${junction.id}_${i}`, x, z, blades })
    }
  }

  return signs
}

/**
 * Y rotation for a blade lying along `arm`, with its face turned towards the
 * traffic on `other`. A box's own length is +X and its face normal +Z, so the
 * angle is measured to put +X along the arm; the half turn picks which of the
 * two faces carries the name.
 */
function bladeAngle(arm: Arm, other: Arm): number {
  const angle = Math.atan2(-arm.dir.z, arm.dir.x)
  // Half a turn keeps the blade on the same axis and swaps which face is front,
  // so it is free to pick whichever one `other`'s traffic is coming from.
  return faceNormal(angle).x * other.dir.x + faceNormal(angle).z * other.dir.z >= 0
    ? angle
    : angle + Math.PI
}

/** World direction a blade at this rotation faces: its local +Z, turned. */
function faceNormal(angle: number): { x: number; z: number } {
  return { x: Math.sin(angle), z: Math.cos(angle) }
}

const POST_GEOM = new THREE.BoxGeometry(POST_WIDTH, POST_HEIGHT, POST_WIDTH)
/** Unit length in X, so an instance's scale sets how long its blade is. */
const BLADE_GEOM = new THREE.BoxGeometry(1, BLADE_HEIGHT, BLADE_THICKNESS)

export function StreetSigns({ level }: { level: LevelDef }) {
  const signs = useMemo(() => buildSigns(level), [level])
  const blades = useMemo(() => signs.flatMap((s) => s.blades), [signs])

  const posts = useRef<THREE.InstancedMesh>(null)
  const plates = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const one = new THREE.Vector3(1, 1, 1)

    signs.forEach((sign, i) => {
      m.compose(new THREE.Vector3(sign.x, POST_HEIGHT / 2, sign.z), new THREE.Quaternion(), one)
      posts.current?.setMatrixAt(i, m)
    })
    blades.forEach((blade, i) => {
      q.setFromAxisAngle(up, blade.angle)
      m.compose(
        new THREE.Vector3(blade.x, blade.y, blade.z),
        q,
        new THREE.Vector3(blade.length, 1, 1),
      )
      plates.current?.setMatrixAt(i, m)
    })

    // Instance matrices are written after construction, so the bounding spheres
    // built from the identity at the origin have to be thrown away — otherwise
    // frustum culling drops the lot the moment the camera looks elsewhere.
    if (posts.current) {
      posts.current.instanceMatrix.needsUpdate = true
      posts.current.computeBoundingSphere()
    }
    if (plates.current) {
      plates.current.instanceMatrix.needsUpdate = true
      plates.current.computeBoundingSphere()
    }
  }, [signs, blades])

  const lettered = useNearbyBlades(blades)

  if (signs.length === 0) return null

  return (
    <group>
      <instancedMesh ref={posts} args={[POST_GEOM, undefined, signs.length]} castShadow>
        <meshLambertMaterial color={PALETTE.signPost} />
      </instancedMesh>
      <instancedMesh ref={plates} args={[BLADE_GEOM, undefined, blades.length]} castShadow>
        <meshLambertMaterial color={PALETTE.signBlade} />
      </instancedMesh>

      {lettered.map((blade) => (
        <Text
          key={blade.key}
          // Just proud of the blade's face, on the side the name is read from.
          position={[
            blade.x + faceNormal(blade.angle).x * (BLADE_THICKNESS / 2 + 0.01),
            blade.y,
            blade.z + faceNormal(blade.angle).z * (BLADE_THICKNESS / 2 + 0.01),
          ]}
          rotation={[0, blade.angle, 0]}
          fontSize={TEXT_SIZE}
          maxWidth={blade.length - 0.3}
          letterSpacing={0.06}
          color="#F4F3F0"
          anchorX="center"
          anchorY="middle"
        >
          {blade.name.toUpperCase()}
        </Text>
      ))}
    </group>
  )
}

/**
 * The blades close enough to the player's view to be worth lettering, rechecked
 * a few times a second rather than every frame — this drives React, and a
 * re-render per frame would cost more than the text it is trying to save.
 */
function useNearbyBlades(blades: Blade[]): Blade[] {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3 } | null)
  const height = useThree((s) => s.size.height)
  const [visible, setVisible] = useState<Blade[]>([])
  const timer = useRef(0)
  const signature = useRef('')

  useFrame((_, delta) => {
    timer.current += delta
    if (timer.current < TEXT_INTERVAL) return
    timer.current = 0

    // Pixels a metre at the target covers. An orthographic zoom is exactly
    // that already; a perspective one has to be reconstructed from the frustum
    // at the distance the player is actually looking.
    let pixelsPerMetre = 0
    if (camera instanceof THREE.OrthographicCamera) {
      pixelsPerMetre = camera.zoom
    } else if (camera instanceof THREE.PerspectiveCamera && controls) {
      const distance = camera.position.distanceTo(controls.target)
      const frustum = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance
      pixelsPerMetre = height / frustum
    }

    let next: Blade[] = []
    if (TEXT_SIZE * pixelsPerMetre >= MIN_TEXT_PIXELS && controls) {
      const { x, z } = controls.target
      next = blades
        .map((blade) => ({ blade, d: (blade.x - x) ** 2 + (blade.z - z) ** 2 }))
        .filter((e) => e.d < TEXT_RADIUS * TEXT_RADIUS)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_TEXT_BLADES)
        .map((e) => e.blade)
    }

    const key = next.map((b) => b.key).join('|')
    if (key === signature.current) return
    signature.current = key
    setVisible(next)
  })

  return visible
}
