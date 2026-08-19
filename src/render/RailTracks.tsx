import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../art/palette'
import { offsetPoly, type Pt } from '../sim/centreline'
import type { LevelDef } from '../sim/types'
import { LAYER } from './layers'

/** Half the width of the ballast bed, metres — enough for a double track. */
const BALLAST_HALF = 2.4
/** How far each rail sits from the centreline. */
const RAIL_OFFSET = 0.85
const RAIL_HALF = 0.07

/**
 * `lines`, each turned into a flat ribbon of the given half-width and merged
 * into one buffer — the same construction `RoadNetwork`'s `buildRibbons` uses
 * for the carriageway, minus the deck height a track never needs.
 */
function buildRibbons(lines: Pt[][], half: number): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []

  for (const poly of lines) {
    if (poly.length < 2) continue
    const left = offsetPoly(poly, -half)
    const right = offsetPoly(poly, half)
    const base = positions.length / 3
    for (let i = 0; i < poly.length; i++) {
      positions.push(left[i].x, 0, left[i].z, right[i].x, 0, right[i].z)
    }
    for (let i = 0; i < poly.length - 1; i++) {
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

/**
 * Rail lines surveyed from OSM, drawn as a ballast bed with two rails down it.
 *
 * Scenery only, the way `Ground`'s water bodies are: nothing runs on these
 * yet, and the two thin rails are there so a straight stretch of track doesn't
 * read as a bike path.
 */
export function RailTracks({ level }: { level: LevelDef }) {
  const lines = level.railLines

  const { ballastGeom, railGeom } = useMemo(() => {
    const polys = (lines ?? []).map((l) => l.points.map(([x, z]) => ({ x, z })))
    return {
      ballastGeom: buildRibbons(polys, BALLAST_HALF),
      railGeom: buildRibbons(
        polys.flatMap((p) => [offsetPoly(p, -RAIL_OFFSET), offsetPoly(p, RAIL_OFFSET)]),
        RAIL_HALF,
      ),
    }
  }, [lines])

  useEffect(
    () => () => {
      ballastGeom.dispose()
      railGeom.dispose()
    },
    [ballastGeom, railGeom],
  )

  if (!lines || lines.length === 0) return null

  return (
    <group>
      <mesh geometry={ballastGeom} position={[0, LAYER.rail, 0]} receiveShadow>
        <meshLambertMaterial color={PALETTE.rail} />
      </mesh>
      <mesh geometry={railGeom} position={[0, LAYER.rail + 0.01, 0]}>
        <meshLambertMaterial color={PALETTE.railTrack} />
      </mesh>
    </group>
  )
}
