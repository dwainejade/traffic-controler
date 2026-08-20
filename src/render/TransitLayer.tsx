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
import { buildRouteLanes, sampleHomes, Transit, WALK_RADIUS } from '../sim/transit'
import type { World } from '../sim/world'
import { LAYER } from './layers'
import { chainPolyline, ribbonGeometry } from './ribbon'
import type { DestinationSite } from './destinations'
import {
  bindTransit,
  extendDraft,
  publishTransit,
  setHover,
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

/** Width of a drawn line, metres. Two thirds of a lane — a diagram, not paint. */
const LINE_WIDTH = 2.4
const CASING_WIDTH = 3.6

/** How close the pointer must come to a junction for the draw tool to snap. */
const SNAP_RADIUS = 55

/** A waiting pedestrian, in metres. Legible at map zoom, absurd at street level. */
const RIDER_RADIUS = 1.1
const RIDER_HEIGHT = 3.4

// ------------------------------------------------------------------ shared

const RIDER_GEOM = new THREE.CylinderGeometry(RIDER_RADIUS, RIDER_RADIUS * 0.8, RIDER_HEIGHT, 6)
RIDER_GEOM.translate(0, RIDER_HEIGHT / 2, 0)

const STOP_GEOM = new THREE.CircleGeometry(2.6, 16).rotateX(-Math.PI / 2)
const STOP_RIM_GEOM = new THREE.CircleGeometry(3.6, 16).rotateX(-Math.PI / 2)
const NODE_GEOM = new THREE.CircleGeometry(6, 20).rotateX(-Math.PI / 2)

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
        colour: LINE_COLORS[route.colour % LINE_COLORS.length],
        line: ribbonGeometry(points, LINE_WIDTH, LAYER.line),
        casing: ribbonGeometry(points, CASING_WIDTH, LAYER.lineCasing),
        stops: route.stops.filter((s) => s.enabled),
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
      }
    }
  }, [meshes])

  return (
    <group>
      {meshes.map((m) => {
        const dim = selected !== null && selected !== m.id
        return (
          <group key={m.id}>
            <mesh geometry={m.casing}>
              {/*
                Unlit. A line is a diagram drawn over the city, and shading it
                would make it dip into shadow under the buildings it passes —
                which is exactly where the player most needs to follow it.
              */}
              <meshBasicMaterial
                color={LINE_CASING}
                transparent
                opacity={dim ? 0.35 : 0.9}
                depthWrite={false}
              />
            </mesh>
            <mesh geometry={m.line}>
              <meshBasicMaterial
                color={m.colour}
                transparent
                opacity={dim ? 0.4 : 1}
                depthWrite={false}
              />
            </mesh>
            {m.stops.map((stop) => (
              <group key={stop.id} position={[stop.x, 0, stop.z]}>
                <mesh geometry={STOP_RIM_GEOM} position={[0, LAYER.stopMarker, 0]}>
                  <meshBasicMaterial color={STOP_RIM} transparent opacity={dim ? 0.3 : 0.85} />
                </mesh>
                <mesh geometry={STOP_GEOM} position={[0, LAYER.stopMarker + 0.01, 0]}>
                  <meshBasicMaterial color={STOP_FACE} transparent opacity={dim ? 0.35 : 1} />
                </mesh>
              </group>
            ))}
          </group>
        )
      })}
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

  useFrame(() => {
    const mesh = ref.current
    const layer = transit()
    if (!mesh || !layer) return

    layer.syncRiding()

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
      scratch.scale.set(1, 1 - fading * 0.45, 1)
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
  return (
    <group>
      {sites.map((site, i) => {
        const colour = DESTINATION_COLORS[i % DESTINATION_COLORS.length]
        const top = site.height + 26
        return (
          <group key={i} position={[site.x, 0, site.z]}>
            <mesh position={[0, site.height + 13, 0]}>
              <cylinderGeometry args={[1.1, 1.1, 26, 8]} />
              <meshBasicMaterial color={colour} />
            </mesh>
            <mesh position={[0, top, 0]}>
              <sphereGeometry args={[4.2, 14, 10]} />
              <meshBasicMaterial color={colour} />
            </mesh>
            {/*
              The catchment: everybody inside this ring can reach the building
              on foot from a stop, and everybody outside it cannot. Drawn faint
              and only in draw mode, because it is a rule the player needs while
              they are placing a line and clutter at every other moment.
            */}
            <CatchmentRing colour={colour} />
          </group>
        )
      })}
    </group>
  )
}

function CatchmentRing({ colour }: { colour: string }) {
  const drawing = useTransit((s) => s.drawing)
  const geom = useMemo(
    () => new THREE.RingGeometry(WALK_RADIUS - 4, WALK_RADIUS, 72).rotateX(-Math.PI / 2),
    [],
  )
  if (!drawing) return null
  return (
    <mesh geometry={geom} position={[0, LAYER.draft, 0]}>
      <meshBasicMaterial color={colour} transparent opacity={0.28} depthWrite={false} />
    </mesh>
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
    return ribbonGeometry(points, LINE_WIDTH, LAYER.draft)
  }, [draft, world])

  useEffect(() => () => preview?.dispose(), [preview])

  if (!drawing) return null

  return (
    <group>
      {preview && (
        <mesh geometry={preview}>
          <meshBasicMaterial color={DRAFT_LINE} transparent opacity={0.9} depthWrite={false} />
        </mesh>
      )}
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

/**
 * Attach a transit layer to a world, and keep it attached for that world's life.
 *
 * One layer per world, cached, because the routes the player has drawn are the
 * only thing in this game they cannot get back — remounting the scene, toggling
 * a map layer or switching camera mode must not cost them their network.
 */
const layers = new WeakMap<World, Transit>()

export function useTransitLayer(
  world: World,
  level: LevelDef,
  destinations: DestinationSite[],
): void {
  const enabled = useTransit((s) => s.enabled)

  useEffect(() => {
    if (!enabled) {
      world.transit = null
      world.ambientBuses = true
      bindTransit(null)
      return
    }

    let layer = layers.get(world)
    if (!layer) {
      layer = new Transit(world.transitHost(), level.seed)
      layers.set(world, layer)
    }

    layer.setDestinations(destinations)
    /*
     * Homes are re-sampled whenever the destinations move, because the
     * residential gradient is defined *against* them: the far corners of the
     * map are where people live precisely because that is where the jobs are
     * not. Sampling them once and keeping them would leave the gradient
     * pointing at wherever the first level's downtown happened to be.
     */
    layer.setHomes(
      sampleHomes(world.net, level.nodes, destinations, 260, level.seed),
    )
    // Demand scales with the city. A five-block import and a whole borough
    // should both open at a service load proportional to how much of them
    // there is to serve, not at one number tuned on whichever was tested.
    layer.demand = Math.max(0.3, Math.min(6, level.nodes.length / 90))

    world.transit = layer
    // The scripted bus service is switched off: an unowned bus running the OSM
    // bus lanes beside the player's own line is indistinguishable from a bug in
    // their line.
    world.ambientBuses = false
    bindTransit(layer)

    return () => {
      world.transit = null
      world.ambientBuses = true
    }
  }, [enabled, world, level, destinations])
}
