import { useMemo } from 'react'
import { Text } from '@react-three/drei'
import { polyLength, roadCentreline, samplePoly } from '../sim/centreline'
import { roadEdges, type LevelDef, type RoadDef } from '../sim/types'

/**
 * Street names, lying flat on the carriageway the way a map draws them.
 *
 * On the ground rather than floating above it, because the whole art direction
 * reads as a physical model seen from above and a billboarded label hovering in
 * the air breaks that immediately. The cost is that a name is only legible when
 * the street runs across the view, which is the same bargain paper maps make.
 */

/** Metres of street between repeats of the same name on a long road. */
const REPEAT_EVERY = 190

/** Clear of the junction boxes, so a name never sits in a crossing. */
const END_CLEARANCE = 34

const Y_LABEL = 0.06

type Label = {
  key: string
  text: string
  x: number
  z: number
  angle: number
  size: number
}

function labelsFor(level: LevelDef, road: RoadDef): Label[] {
  if (!road.name) return []

  const centre = roadCentreline(level, road)
  const length = polyLength(centre)
  const usable = length - END_CLEARANCE * 2
  if (usable < 30) return []

  // One in the middle of a short street, evenly spaced repeats on a long one.
  const count = Math.max(1, Math.round(usable / REPEAT_EVERY))
  const step = usable / count

  const { left, right } = roadEdges(road)
  // Fit the type to the street: a name should sit within the carriageway, and a
  // residential street is half the width of an avenue.
  const size = Math.min(4.2, Math.max(2.6, (right - left) * 0.34))

  const out: Label[] = []
  for (let i = 0; i < count; i++) {
    const s = END_CLEARANCE + step * (i + 0.5)
    const p = samplePoly(centre, s)

    /*
     * Text runs along the street, and must not come out upside down. The
     * tangent points from `from` to `to`, which is an arbitrary direction — for
     * a one-way it is the direction of travel, for a two-way it is whichever
     * way the importer happened to walk the chain. So the reading direction is
     * chosen from the geometry instead: always left-to-right across the map,
     * flipping the tangent when it points the other way.
     */
    const towardsEast = p.tx >= 0
    const tx = towardsEast ? p.tx : -p.tx
    const tz = towardsEast ? p.tz : -p.tz

    out.push({
      key: `${road.id}_${i}`,
      text: road.name,
      x: p.x,
      z: p.z,
      // Ground-plane text is rotated -90° about X, so its own +Y runs along
      // world -Z; this angle turns it to follow the street.
      angle: Math.atan2(tx, tz) - Math.PI / 2,
      size,
    })
  }
  return out
}

export function StreetLabels({ level }: { level: LevelDef }) {
  const labels = useMemo(
    () => level.roads.flatMap((road) => labelsFor(level, road)),
    [level],
  )

  return (
    <group>
      {labels.map((l) => (
        <Text
          key={l.key}
          position={[l.x, Y_LABEL, l.z]}
          rotation={[-Math.PI / 2, 0, l.angle]}
          fontSize={l.size}
          // Tracked out and pale, so a name reads as printed on the road rather
          // than painted on it — road markings are pure white and this must not
          // compete with them.
          letterSpacing={0.14}
          color="#F2F1EE"
          fillOpacity={0.82}
          outlineWidth={0.06}
          outlineColor="#3F4448"
          outlineOpacity={0.35}
          anchorX="center"
          anchorY="middle"
        >
          {l.text.toUpperCase()}
        </Text>
      ))}
    </group>
  )
}
