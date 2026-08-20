import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  DESTINATION_COLORS,
  DRAFT_LINE,
  DRAFT_NODE,
  DRAFT_NODE_HOT,
  LINE_CASING,
  LINE_COLORS,
  RIDER_GIVING_UP,
  STOP_FACE,
  STOP_RIM,
  riderColor,
} from '../art/transit'
import { junctionSize, type LevelDef, type NodeId } from '../sim/types'
import { viewRadius } from './viewCentre'
import { buildRouteLanes, WALK_RADIUS, type TransitStop } from '../sim/transit'
import type { World } from '../sim/world'
import { LAYER } from './layers'
import { chainPolyline, halfWidthFor, ribbonGeometry, ribbonMaterial } from './ribbon'
import type { DestinationSite } from './destinations'
import {
  extendDraft,
  publishTransit,
  setHover,
  toggleStop,
  transit,
  useTransit,
} from '../ui/transitStore'

/**
 * Everything transit mode draws, and the one place it reads the pointer.
 *
 * Kept as one component tree rather than scattered beside the things it relates
 * to, for the same reason the layer ladder in `layers.ts` is one file: these
 * meshes are all coplanar overlays on the same street and the order between
 * them is the only thing keeping them apart.
 */

/**
 * Width of a drawn line, in *pixels*, and the world-metre range it is allowed
 * to occupy while holding that.
 *
 * Pixels because a line is a diagram: following one across a borough and
 * following one down a block are the same task and want the same stroke. The
 * clamps stop it degenerating at either extreme — thinner than the floor and it
 * disappears among the roads, wider than the ceiling and it swallows the street
 * it is drawn on when the camera comes down to it.
 */
const LINE_PIXELS = 5
const CASING_PIXELS = 9
const LINE_MIN_M = 1.6
const LINE_MAX_M = 6
const CASING_MIN_M = 3
const CASING_MAX_M = 10

/** A stop marker, likewise in pixels. Wider than the line, as on a transit map. */
const STOP_PIXELS = 13
const STOP_MIN_M = 5
const STOP_MAX_M = 14

/** The pin over a destination building. Wider than a stop — it is the goal. */
const MARKER_PIXELS = 20
const MARKER_MIN_M = 8
const MARKER_MAX_M = 26

/** How close the pointer must come to a junction for the draw tool to snap. */
const SNAP_RADIUS = 55

/** A waiting pedestrian, at true size — scaled to the camera when drawn. */
const RIDER_RADIUS = 1.1
const RIDER_HEIGHT = 3.4
const RIDER_PIXELS = 5
const RIDER_MIN_M = 1.1
const RIDER_MAX_M = 7

// ------------------------------------------------------------------ shared

const RIDER_GEOM = new THREE.CylinderGeometry(RIDER_RADIUS, RIDER_RADIUS * 0.8, RIDER_HEIGHT, 6)
RIDER_GEOM.translate(0, RIDER_HEIGHT / 2, 0)

const STOP_GEOM = new THREE.CircleGeometry(2.6, 16).rotateX(-Math.PI / 2)
const STOP_RIM_GEOM = new THREE.CircleGeometry(3.6, 16).rotateX(-Math.PI / 2)
const NODE_GEOM = new THREE.CircleGeometry(6, 20).rotateX(-Math.PI / 2)

/** Destination pin: a unit disc on the ground and a slim stem off the roof. */
const PIN_DISC = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2)
const PIN_STEM_HEIGHT = 30
const PIN_STEM = new THREE.CylinderGeometry(0.6, 0.6, PIN_STEM_HEIGHT, 8)

// ------------------------------------------------------------------- lines

/**
 * The committed lines.
 *
 * Rebuilt whole whenever the network changes rather than diffed. A route is a
 * few thousand vertices and the player adds one every minute or so at most; the
 * bookkeeping to update in place would cost more code than the rebuild costs
 * frames.
 */
function TransitLines({ world }: { world: World }) {
  const version = useTransit((s) => s.version)
  const selected = useTransit((s) => s.selected)

  const meshes = useMemo(() => {
    const layer = transit()
    if (!layer) return []

    return layer.routes.map((route) => {
      const points = chainPolyline(world.net, route.lanes)
      return {
        id: route.id,
        line: ribbonGeometry(points, LAYER.line),
        casing: ribbonGeometry(points, LAYER.lineCasing),
        lineMat: ribbonMaterial(LINE_COLORS[route.colour % LINE_COLORS.length], 1),
        casingMat: ribbonMaterial(LINE_CASING, 0.9),
        // All of them, enabled or not: a skipped stop is still a thing the
        // player can click to bring back.
        stops: route.stops,
      }
    })
    // `version` is the dependency that matters — the layer mutates in place and
    // React cannot see it do so.

  }, [world, version])

  useEffect(() => {
    return () => {
      for (const m of meshes) {
        m.line.dispose()
        m.casing.dispose()
        m.lineMat.dispose()
        m.casingMat.dispose()
      }
    }
  }, [meshes])

  /*
   * Width and dimming are driven from the frame loop rather than from React.
   * Both change with the camera, which moves every frame of a gesture, and a
   * re-render per frame of a pan would cost more than everything else this
   * component does put together.
   */
  useFrame((state) => {
    const radius = viewRadius(state.camera, state.size.width, state.size.height)
    const half = halfWidthFor(radius, state.size.height, LINE_PIXELS, LINE_MIN_M, LINE_MAX_M)
    const casing = halfWidthFor(
      radius,
      state.size.height,
      CASING_PIXELS,
      CASING_MIN_M,
      CASING_MAX_M,
    )
    for (const m of meshes) {
      const dim = selected !== null && selected !== m.id
      m.lineMat.uniforms.uHalf.value = half
      m.casingMat.uniforms.uHalf.value = casing
      m.lineMat.uniforms.uOpacity.value = dim ? 0.4 : 1
      m.casingMat.uniforms.uOpacity.value = dim ? 0.35 : 0.9
    }
  })

  return (
    <group>
      {meshes.map((m) => {
        const dim = selected !== null && selected !== m.id
        return (
          <group key={m.id}>
            <mesh geometry={m.casing} material={m.casingMat} />
            <mesh geometry={m.line} material={m.lineMat} />
            <StopMarkers stops={m.stops} dim={dim} />
          </group>
        )
      })}
    </group>
  )
}

/**
 * The stops on one line, as two instanced discs.
 *
 * Sized in pixels like the line they punctuate, and for the same reason: a stop
 * drawn at its real four metres is a speck at the zoom a route is planned at,
 * which is exactly the zoom at which "does this line reach that building" is
 * the question being asked.
 */
function StopMarkers({ stops, dim }: { stops: TransitStop[]; dim: boolean }) {
  const rim = useRef<THREE.InstancedMesh>(null)
  const face = useRef<THREE.InstancedMesh>(null)
  const drawing = useTransit((s) => s.drawing)
  const down = useRef<{ x: number; y: number } | null>(null)

  const scratch = useMemo(
    () => ({
      m: new THREE.Matrix4(),
      q: new THREE.Quaternion(),
      p: new THREE.Vector3(),
      s: new THREE.Vector3(),
      c: new THREE.Color(),
    }),
    [],
  )

  useFrame((state) => {
    if (!rim.current || !face.current) return
    const radius = viewRadius(state.camera, state.size.width, state.size.height)
    // Against the marker geometry's own 2.6m face radius, so the number below
    // reads as "a stop is this many pixels across".
    const scale =
      halfWidthFor(radius, state.size.height, STOP_PIXELS, STOP_MIN_M, STOP_MAX_M) / 2.6

    stops.forEach((stop, i) => {
      /*
       * A skipped stop keeps its ring and loses its face — it collapses to a
       * hole rather than disappearing. Removing it outright would leave the
       * player no way to put it back, and no way to see that the line has a
       * decision sitting on that corner at all.
       */
      const shown = stop.enabled ? scale : scale * 0.9
      scratch.p.set(stop.x, LAYER.stopMarker, stop.z)
      scratch.s.set(shown, 1, shown)
      scratch.m.compose(scratch.p, scratch.q, scratch.s)
      rim.current!.setMatrixAt(i, scratch.m)

      scratch.p.y = LAYER.stopMarker + 0.01
      scratch.s.set(stop.enabled ? shown : 0.001, 1, stop.enabled ? shown : 0.001)
      scratch.m.compose(scratch.p, scratch.q, scratch.s)
      face.current!.setMatrixAt(i, scratch.m)
    })

    rim.current.count = stops.length
    face.current.count = stops.length
    rim.current.instanceMatrix.needsUpdate = true
    face.current.instanceMatrix.needsUpdate = true
  })

  if (stops.length === 0) return null

  /*
   * Clicks land on the rim, which is the larger of the two discs and is present
   * whether the stop is on or off. Gated on not drawing: while a line is being
   * laid, a click near a stop is a click at the junction beside it, and having
   * it mean two things at once would make both unreliable.
   */
  const clickable = !drawing

  return (
    <group>
      <instancedMesh
        ref={rim}
        args={[STOP_RIM_GEOM, undefined, stops.length]}
        frustumCulled={false}
        onPointerDown={
          clickable
            ? (e) => {
                down.current = { x: e.clientX, y: e.clientY }
              }
            : undefined
        }
        onPointerUp={
          clickable
            ? (e) => {
                const from = down.current
                down.current = null
                if (!from) return
                // A pan that happened to start on a stop is not a click on it.
                if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 6) return
                const i = e.instanceId
                if (i === undefined || !stops[i]) return
                e.stopPropagation()
                toggleStop(stops[i].id)
              }
            : undefined
        }
      >
        <meshBasicMaterial color={STOP_RIM} transparent opacity={dim ? 0.3 : 0.85} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={face} args={[STOP_GEOM, undefined, stops.length]} frustumCulled={false}>
        <meshBasicMaterial color={STOP_FACE} transparent opacity={dim ? 0.35 : 1} depthWrite={false} />
      </instancedMesh>
    </group>
  )
}

// ------------------------------------------------------------------ riders

/**
 * People, as instanced pips.
 *
 * Not animated beyond their position — a walk cycle at this camera height is
 * three pixels of effort nobody sees. What does have to read is *colour*: a pip
 * is painted the colour of the building its owner is trying to reach, and a
 * crowd of one colour on a corner with no line near it is the entire feedback
 * loop of the game.
 */
function Riders() {
  const ref = useRef<THREE.InstancedMesh>(null)
  const enabled = useTransit((s) => s.enabled)

  /*
   * Capacity, not count. The instanced mesh is allocated once at a size no
   * plausible city exceeds and its `count` is moved every frame; reallocating
   * as the crowd grows would drop a frame every time a rush hour started.
   */
  const capacity = 4000

  const scratch = useMemo(
    () => ({
      m: new THREE.Matrix4(),
      q: new THREE.Quaternion(),
      pos: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
      colour: new THREE.Color(),
    }),
    [],
  )

  useFrame((state) => {
    const mesh = ref.current
    const layer = transit()
    if (!mesh || !layer) return

    layer.syncRiding()

    /*
     * A person is 1.1m across, which at the zoom a whole borough fits in is a
     * fifth of a pixel. Pips are scaled to the camera like the lines and the
     * stops are, and for the same reason: the crowd on a corner with no line
     * near it is the game's only picture of unserved demand, and it has to be
     * visible at the zoom the player plans routes at. Clamped hard at the top
     * so walking down the street does not put giants on the pavement.
     */
    const radius = viewRadius(state.camera, state.size.width, state.size.height)
    const grow =
      halfWidthFor(radius, state.size.height, RIDER_PIXELS, RIDER_MIN_M, RIDER_MAX_M) /
      RIDER_RADIUS

    let n = 0
    for (const rider of layer.riders) {
      if (!rider.active || n >= capacity) continue
      // On board is drawn by the bus, not by a pip inside it.
      if (rider.phase === 'riding') continue

      scratch.pos.set(rider.x, 0, rider.z)
      /*
       * Somebody who has been standing a long time shrinks toward the pavement
       * and greys out. It is the only animation here and it earns its place:
       * "this stop is failing" has to be visible before the riders vanish, or
       * the missed count goes up with nothing on screen having explained it.
       */
      const fading = rider.phase === 'waiting' ? Math.min(1, rider.waited / 600) : 0
      scratch.scale.set(grow, grow * (1 - fading * 0.45), grow)
      scratch.m.compose(scratch.pos, scratch.q, scratch.scale)
      mesh.setMatrixAt(n, scratch.m)

      scratch.colour.set(
        rider.phase === 'unserved' || fading > 0.75
          ? RIDER_GIVING_UP
          : riderColor(rider.destination),
      )
      mesh.setColorAt(n, scratch.colour)
      n++
    }

    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  if (!enabled) return null

  return (
    <instancedMesh ref={ref} args={[RIDER_GEOM, undefined, capacity]} castShadow frustumCulled={false}>
      <meshLambertMaterial />
    </instancedMesh>
  )
}

// ----------------------------------------------------------- destinations

/**
 * A marker over each destination building.
 *
 * The building itself is tinted too — that is what `Buildings` and `Footprints`
 * do with the highlight map — but a tint alone is invisible the moment the
 * building is behind a taller one, which on a real skyline is most of them. The
 * marker is a column of the same colour standing clear of the roof, so the
 * place is findable from anywhere on the map.
 */
function Destinations({ sites }: { sites: DestinationSite[] }) {
  const pins = useRef<THREE.Group>(null)

  /*
   * Only the pins take the camera scaling — not the catchment rings under them,
   * which are a real 400m on the ground and mean nothing at any other size. An
   * earlier version scaled the whole site group and pushed every ring out to
   * two kilometres, which put them off the map entirely: the rings looked like
   * they had stopped working, and the bug was in the pins.
   *
   * Width only, and the stem's height is left alone: a marker that grew taller
   * as the camera pulled back would climb off the roof it is standing on.
   */
  useFrame((state) => {
    if (!pins.current) return
    const radius = viewRadius(state.camera, state.size.width, state.size.height)
    const wide = halfWidthFor(
      radius,
      state.size.height,
      MARKER_PIXELS,
      MARKER_MIN_M,
      MARKER_MAX_M,
    )
    for (const pin of pins.current.children) {
      // The disc is authored at a 1m radius and the stem at 0.6m, so the scale
      // is the half-width itself and reads as "this many pixels across".
      pin.scale.set(wide, 1, wide)
    }
  })

  return (
    <group>
      <group ref={pins}>
        {sites.map((site, i) => {
          const colour = DESTINATION_COLORS[i % DESTINATION_COLORS.length]
          return (
            <group key={i} position={[site.x, 0, site.z]}>
              {/*
                A disc on the ground, like a stop marker, rather than a ball in
                the air. The camera is a 3/4 top-down one and a mark on the
                ground is what it reads best; a floating sphere at map zoom is
                a blob with no obvious footing.
              */}
              <mesh geometry={PIN_DISC} position={[0, LAYER.stopMarker + 0.02, 0]}>
                <meshBasicMaterial color={colour} transparent opacity={0.9} depthWrite={false} />
              </mesh>
              {/*
                And a stem off the roof, because a mark on the ground is exactly
                what a taller building next door hides — which on a real skyline
                is most of them.
              */}
              <mesh geometry={PIN_STEM} position={[0, site.height + PIN_STEM_HEIGHT / 2, 0]}>
                <meshBasicMaterial color={colour} />
              </mesh>
            </group>
          )
        })}
      </group>

      {/*
        The catchment: everybody inside this ring can reach the building on foot
        from a stop, and everybody outside it cannot. Drawn faint and only in
        draw mode, because it is a rule the player needs while they are placing
        a line and clutter at every other moment.
      */}
      <CatchmentRings sites={sites} />
    </group>
  )
}

function CatchmentRings({ sites }: { sites: DestinationSite[] }) {
  const drawing = useTransit((s) => s.drawing)
  const geom = useMemo(
    () => new THREE.RingGeometry(WALK_RADIUS - 6, WALK_RADIUS, 72).rotateX(-Math.PI / 2),
    [],
  )
  useEffect(() => () => geom.dispose(), [geom])

  if (!drawing) return null

  return (
    <group>
      {sites.map((site, i) => (
        <mesh
          key={i}
          geometry={geom}
          position={[site.x, LAYER.draft, site.z]}
        >
          <meshBasicMaterial
            color={DESTINATION_COLORS[i % DESTINATION_COLORS.length]}
            transparent
            opacity={0.3}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  )
}

// ------------------------------------------------------------------- draft

/**
 * The draw tool: junction picking, the path preview, and the pointer.
 *
 * The pointer work is here rather than on the meshes because the things being
 * clicked are junctions, and a junction is not an object in the scene — it is a
 * gap between road meshes. So the ground plane is raycast and the nearest node
 * within `SNAP_RADIUS` wins, which also gives the tool a forgiving hit area
 * without drawing an invisible disc at every corner of the city.
 */
function RouteDraft({ level, world }: { level: LevelDef; world: World }) {
  const drawing = useTransit((s) => s.drawing)
  const draft = useTransit((s) => s.draft)
  const hover = useTransit((s) => s.hover)

  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)

  /** Junctions a bus could actually be routed through. */
  const nodes = useMemo(
    () => level.nodes.filter((n) => n.kind === 'junction'),
    [level],
  )

  useEffect(() => {
    if (!drawing) return
    const el = gl.domElement
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = new THREE.Vector3()
    let downAt: { x: number; y: number } | null = null

    const nearest = (x: number, y: number): NodeId | null => {
      const rect = el.getBoundingClientRect()
      ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      if (!raycaster.ray.intersectPlane(plane, hit)) return null

      let best: NodeId | null = null
      let bestDist = SNAP_RADIUS
      for (const node of nodes) {
        const d = Math.hypot(node.pos[0] - hit.x, node.pos[1] - hit.z)
        if (d < bestDist) {
          bestDist = d
          best = node.id
        }
      }
      return best
    }

    const onMove = (e: PointerEvent) => setHover(nearest(e.clientX, e.clientY))

    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY }
    }

    /*
     * A click, not a drag. The same gesture pans the camera, and on a map this
     * size the player pans constantly while drawing — treating every pointerup
     * as a click would append a junction every time they moved the view.
     */
    const onUp = (e: PointerEvent) => {
      if (!downAt) return
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
      downAt = null
      if (moved > 6) return

      const node = nearest(e.clientX, e.clientY)
      if (node) extendDraft(node)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      setHover(null)
    }
  }, [drawing, gl, camera, nodes])

  /**
   * The path so far, resolved through the same routing the finished line will
   * use — so what is previewed is what will be built, including the street the
   * router picks when the player clicks two junctions that are not neighbours.
   */
  const preview = useMemo(() => {
    if (draft.length < 2) return null
    // Deliberately without the return leg: the loop closes only on commit, and
    // showing it during drawing makes every two-click path look like a circuit.
    const built = buildRouteLanes(world.net, draft)
    if (!built) return null
    const points = chainPolyline(world.net, built.lanes.slice(0, built.returnAt))
    return {
      geom: ribbonGeometry(points, LAYER.draft),
      mat: ribbonMaterial(DRAFT_LINE, 0.9),
    }
  }, [draft, world])

  useEffect(
    () => () => {
      preview?.geom.dispose()
      preview?.mat.dispose()
    },
    [preview],
  )

  // The draft is drawn a shade heavier than a committed line, so a path laid
  // over one the player already has is the one they can see themselves moving.
  useFrame((state) => {
    if (!preview) return
    const radius = viewRadius(state.camera, state.size.width, state.size.height)
    preview.mat.uniforms.uHalf.value = halfWidthFor(
      radius,
      state.size.height,
      LINE_PIXELS + 2,
      LINE_MIN_M,
      LINE_MAX_M + 2,
    )
  })

  if (!drawing) return null

  return (
    <group>
      {preview && <mesh geometry={preview.geom} material={preview.mat} />}
      {nodes.map((node) => {
        const isHover = hover === node.id
        const onPath = draft.includes(node.id)
        if (!isHover && !onPath) return null
        const r = Math.max(6, junctionSize(level, node.id) / 2)
        return (
          <mesh
            key={node.id}
            geometry={NODE_GEOM}
            position={[node.pos[0], LAYER.draft + 0.01, node.pos[1]]}
            scale={[r / 6, 1, r / 6]}
          >
            <meshBasicMaterial
              color={isHover ? DRAFT_NODE_HOT : DRAFT_NODE}
              transparent
              opacity={isHover ? 0.95 : 0.7}
              depthWrite={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}

// ------------------------------------------------------------------ mirror

/** Push the layer's numbers into the store, a few times a second. */
function TransitMirror() {
  const since = useRef(0)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  // Console handle on the rendered scene, next to `simWorld` and `TRANSIT`.
  // This layer is almost entirely geometry, and "it is not on screen" has at
  // least four causes that look identical from the outside.
  useEffect(() => {
    if (import.meta.env?.DEV) Object.assign(globalThis, { TRANSIT_SCENE: { scene, camera } })
  }, [scene, camera])

  useFrame((_, dt) => {
    const layer = transit()
    if (!layer) return
    since.current += dt
    if (since.current < 0.25) return
    since.current = 0
    publishTransit(layer)
  })
  return null
}

// -------------------------------------------------------------------- root

export function TransitLayer({
  level,
  world,
  destinations,
}: {
  level: LevelDef
  world: World
  destinations: DestinationSite[]
}) {
  const enabled = useTransit((s) => s.enabled)
  if (!enabled) return null

  return (
    <group>
      <Destinations sites={destinations} />
      <TransitLines world={world} />
      <RouteDraft level={level} world={world} />
      <Riders />
      <TransitMirror />
    </group>
  )
}
