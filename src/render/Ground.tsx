import { useMemo } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import type { LevelDef } from '../sim/types'
import { flatRoundedRect, roundedRectShape } from './geometry'

const CARD_THICKNESS = 2.5

/**
 * The level sits as a physical card on a plain backdrop — that's what makes it
 * read as a model rather than a cropped-out piece of a world. The card is
 * genuinely extruded so the key light drops a real soft shadow beneath it.
 */
export function Ground({ level }: { level: LevelDef }) {
  const card = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(
      roundedRectShape(level.half, level.half, 10),
      { depth: CARD_THICKNESS, bevelEnabled: false, curveSegments: 8 },
    )
    // Lay flat. rotateX(-90°) maps (x,y,z) -> (x,z,-y), so the extrusion runs
    // *up* from y=0; shift it down so the card's top surface sits exactly at y=0
    // and everything drawn on the ground plane stays above it.
    g.rotateX(-Math.PI / 2)
    g.translate(0, -CARD_THICKNESS, 0)
    return g
  }, [level.half])

  const parks = useMemo(
    () =>
      level.zones
        .filter((z) => z.kind === 'park')
        .map((z) => ({
          id: z.id,
          geom: flatRoundedRect(z.half[0], z.half[1], 8),
          pos: z.centre,
        })),
    [level.zones],
  )

  return (
    <group>
      {/* Backdrop, purely to catch the card's shadow. */}
      <mesh position={[0, -CARD_THICKNESS - 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[4000, 4000]} />
        <meshLambertMaterial color={PALETTE.background} />
      </mesh>

      <mesh geometry={card} castShadow receiveShadow>
        <meshLambertMaterial color={PALETTE.ground} />
      </mesh>

      {parks.map((p) => (
        <mesh
          key={p.id}
          geometry={p.geom}
          position={[p.pos[0], 0.008, p.pos[1]]}
          receiveShadow
        >
          <meshLambertMaterial color={PALETTE.park} />
        </mesh>
      ))}
    </group>
  )
}
