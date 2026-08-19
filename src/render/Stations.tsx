import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import { PALETTE } from '../art/palette'
import type { LevelDef } from '../sim/types'
import { flatRoundedRect } from './geometry'
import { LAYER } from './layers'

/** Platform footprint, metres — a small paved apron rather than a true survey. */
const HALF_X = 9
const HALF_Z = 3.2
const CORNER = 1.2

const PLATFORM = flatRoundedRect(HALF_X, HALF_Z, CORNER)

/** Entrance kiosk footprint and height, metres — the stair down, boxed in. */
const ENTRANCE_HALF = 0.9
const ENTRANCE_HEIGHT = 1.8

const ENTRANCE_BOX = new THREE.BoxGeometry(
  ENTRANCE_HALF * 2,
  ENTRANCE_HEIGHT,
  ENTRANCE_HALF * 2,
).translate(0, ENTRANCE_HEIGHT / 2, 0)

/**
 * Train stations surveyed from OSM, as a small platform apron with the name
 * lettered flat on it where OSM gave one.
 *
 * A handful of these on any one map, unlike the hundreds of shopfronts or
 * street labels, so this skips the visibility budgeting those use and just
 * draws every one.
 */
export function Stations({ level }: { level: LevelDef }) {
  const stations = level.stations
  const ref = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh || !stations) return
    const m = new THREE.Matrix4()
    stations.forEach((s, i) => {
      m.makeTranslation(s.pos[0], LAYER.station, s.pos[1])
      mesh.setMatrixAt(i, m)
    })
    mesh.count = stations.length
    mesh.instanceMatrix.needsUpdate = true
  }, [stations])

  if (!stations || stations.length === 0) return null

  return (
    <group>
      <instancedMesh ref={ref} args={[PLATFORM, undefined, stations.length]} receiveShadow>
        <meshLambertMaterial color={PALETTE.station} />
      </instancedMesh>
      {stations.map((s, i) =>
        s.name ? (
          <Text
            key={i}
            position={[s.pos[0], LAYER.station + 0.03, s.pos[1]]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={2.6}
            letterSpacing={0.1}
            color="#3F4448"
            fillOpacity={0.85}
            anchorX="center"
            anchorY="middle"
          >
            {s.name.toUpperCase()}
          </Text>
        ) : null,
      )}
    </group>
  )
}

/**
 * Subway entrance stairs surveyed from OSM — a small kiosk box standing where
 * the stair goes down, since that is the only part of an underground station
 * actually on the street.
 */
export function StationEntrances({ level }: { level: LevelDef }) {
  const entrances = level.stationEntrances
  const ref = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh || !entrances) return
    const m = new THREE.Matrix4()
    entrances.forEach((e, i) => {
      m.makeTranslation(e.pos[0], LAYER.station, e.pos[1])
      mesh.setMatrixAt(i, m)
    })
    mesh.count = entrances.length
    mesh.instanceMatrix.needsUpdate = true
  }, [entrances])

  if (!entrances || entrances.length === 0) return null

  return (
    <instancedMesh
      ref={ref}
      args={[ENTRANCE_BOX, undefined, entrances.length]}
      castShadow
      receiveShadow
    >
      <meshLambertMaterial color={PALETTE.signPost} />
    </instancedMesh>
  )
}
