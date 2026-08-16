import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { polyLength, roadCentreline, samplePoly } from '../sim/centreline'
import { roadEdges, type LevelDef, type RoadDef } from '../sim/types'
import { useTextAnchor } from './textBudget'

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

/**
 * How many names may be drawn at once.
 *
 * Every label is its own mesh and so its own draw call — that is what lettering
 * costs, here and in `StreetSigns` and `Shopfronts`, both of which have been
 * budgeted from the start. This one was not, because at Dumbo's two hundred and
 * sixty roads it never needed to be.
 *
 * Then a 3.6km import of Brooklyn arrived with 1,381 roads, and the labels alone
 * were 850 of the frame's 1,538 draw calls: 14.8ms of submission against 6.6ms
 * of actual drawing, and 55fps on a map the GPU was barely troubled by. A name
 * you cannot read is worth nothing, and the nearest hundred are all anyone can
 * read at once.
 */
const MAX_LABELS = 110

/**
 * How far from what you are looking at a name is worth drawing, and how small it
 * may get before it stops being a word. Both looser than the street signs' —
 * these lie flat on the carriageway and are set several times larger, so they
 * stay legible much further out.
 */
const LABEL_RADIUS = 900
const MIN_LABEL_PIXELS = 5

/** Seconds between re-picks. This drives React, so not every frame. */
const LABEL_INTERVAL = 0.25

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

/**
 * The nearest names, re-picked a few times a second.
 *
 * Deliberately the same shape as `StreetSigns`' own budget, down to the
 * signature check that keeps an unchanged selection from re-rendering: the two
 * are solving the same problem and there is no reason for them to differ.
 */
function useNearbyLabels(labels: Label[]): Label[] {
  const anchor = useTextAnchor()
  const [visible, setVisible] = useState<Label[]>([])
  const timer = useRef(0)
  const signature = useRef('')

  useFrame((_, delta) => {
    timer.current += delta
    if (timer.current < LABEL_INTERVAL) return
    timer.current = 0

    const { x, z, pixelsPerMetre } = anchor()

    let next: Label[] = []
    // Sized per street, so the smallest is the one that decides legibility.
    if (2.6 * pixelsPerMetre >= MIN_LABEL_PIXELS) {
      next = labels
        .map((label) => ({ label, d: (label.x - x) ** 2 + (label.z - z) ** 2 }))
        .filter((e) => e.d < LABEL_RADIUS * LABEL_RADIUS)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_LABELS)
        .map((e) => e.label)
    }

    const key = next.map((l) => l.key).join('|')
    if (key === signature.current) return
    signature.current = key
    setVisible(next)
  })

  return visible
}

export function StreetLabels({ level }: { level: LevelDef }) {
  const all = useMemo(
    () => level.roads.flatMap((road) => labelsFor(level, road)),
    [level],
  )
  const labels = useNearbyLabels(all)

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
