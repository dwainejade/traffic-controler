import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  DepthOfField,
  EffectComposer,
  SelectiveBloom,
} from "@react-three/postprocessing";
import type { DepthOfFieldEffect } from "postprocessing";
import type { LevelDef } from "../sim/types";
import { Daylight } from "./Daylight";
import { Ground } from "./Ground";
import { Parks } from "./Parks";
import { Medians } from "./Medians";
import { RoadNetwork } from "./RoadNetwork";
import { Buildings } from "./Buildings";
import { Footprints } from "./Footprints";
import { Shopfronts } from "./Shopfronts";
import { Trees } from "./Trees";
import { scatterLevel } from "./scatter";
import { Controls } from "./Controls";
import { CinematicCamera } from "./CinematicCamera";
import { WalkCamera } from "./WalkCamera";
import {
  MAX_ZOOM,
  MIN_DISTANCE,
  farPlane,
  maxDistance,
  minZoom,
  orthoDistance,
} from "./cameraLimits";
import { BusStops } from "./BusStops";
import { ParkedCars } from "./ParkedCars";
import { Simulation } from "./Simulation";
import { CrashFocus } from "./CrashFocus";
import { QueuePressure } from "./QueuePressure";
import { StreetLabels } from "./StreetLabels";
import { StreetSigns } from "./StreetSigns";
import { StreetLights } from "./StreetLights";
import { useGlowing } from "./glow";
import { SignalHeads } from "./SignalHeads";
import type { World } from "../sim/world";
import {
  useHud,
  WALK_FOCUS_DISTANCE_MAX,
  WALK_FOCUS_DISTANCE_MIN,
} from "../ui/hudStore";
import { PerspectiveCamera, Stats } from "@react-three/drei";
import { benchmark } from "./bench";
import { benchLevel } from "../levels/bench";
import { addTransientLevel } from "../levels/registry";

/**
 * Fixed orthographic 3/4 camera. Ortho is doing real work here: it removes the
 * perspective distortion that makes a grid of junctions hard to compare, and it
 * is a large part of why the reference reads as a model rather than a photo.
 *
 * The perspective camera in the layers menu is the opposite trade, and worth
 * having for the same reason: it gives up comparability to put you down among
 * the buildings, which is where the traffic actually looks like traffic.
 */
const ELEVATION = THREE.MathUtils.degToRad(55);
const AZIMUTH = THREE.MathUtils.degToRad(25);

/** Unit vector from the map to the camera, shared by both projections. */
const VIEW_DIR: [number, number, number] = [
  Math.cos(ELEVATION) * Math.sin(AZIMUTH),
  Math.sin(ELEVATION),
  Math.cos(ELEVATION) * Math.cos(AZIMUTH),
];

/** The view direction, at whatever standoff this level's size needs. */
function orthoPos(half: number): [number, number, number] {
  const d = orthoDistance(half);
  return [VIEW_DIR[0] * d, VIEW_DIR[1] * d, VIEW_DIR[2] * d];
}

/** Vertical field of view of the perspective camera, in degrees. */
const FOV = 34;

/**
 * Distance that frames the same amount of map the orthographic view does at its
 * opening zoom, so flipping projection re-frames rather than jumping.
 */
function perspectiveDistance(half: number): number {
  // 0.8 because the perspective view is not trying to show the whole card at
  // once — it is worth being closer in, and the pan limits reach the rest.
  return (
    (half * Math.SQRT2 * 0.8) / Math.tan(THREE.MathUtils.degToRad(FOV / 2))
  );
}

/**
 * Re-frame the camera when the level changes.
 *
 * The `camera` prop is only read when the canvas is created, and the canvas
 * outlives the level, so without this every level after the first inherits the
 * previous one's zoom and pan. Going from the city to a single imported
 * junction left the new map drawn a hundred pixels wide in the corner of an
 * apparently empty screen.
 */
function Reframe({
  level,
  zoom,
  half,
}: {
  level: string;
  zoom: number;
  half: number;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as {
    target: THREE.Vector3;
    update: () => void;
  } | null;

  useEffect(() => {
    if (camera instanceof THREE.OrthographicCamera) {
      camera.position.set(...orthoPos(half));
      camera.zoom = zoom;
      // Both planes have to reach across a card this camera may be standing a
      // long way back from; `far` alone is not enough once the standoff grows.
      camera.near = 1;
      camera.far = farPlane(half) * 2;
    } else {
      // A perspective camera has no zoom to set — distance is the framing.
      const d = perspectiveDistance(half);
      camera.position.set(VIEW_DIR[0] * d, VIEW_DIR[1] * d, VIEW_DIR[2] * d);
    }
    camera.updateProjectionMatrix();
    controls?.target.set(0, 0, 0);
    controls?.update();
    // `level` is the trigger: two levels can want the same zoom and still need
    // the pan reset. `camera` is the other one — swapping projection mid-level
    // hands over a camera sitting wherever it was left when it was last used.
  }, [level, zoom, half, camera, controls]);

  return null;
}

/**
 * Dev-only handle on the renderer, alongside `SIMDEV` and `LEVELS` on `window`.
 *
 * `window.RENDERDEV.frame()` draws one frame synchronously. The animation loop
 * is driven by requestAnimationFrame, which a browser stops entirely when it
 * considers the page hidden — including in embedded panes and headless
 * captures. Without this, screenshots of the map come back as an empty canvas
 * and nothing about the geometry can be checked by eye.
 */
function DevHandle() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const advance = useThree((s) => s.advance);
  const controls = useThree((s) => s.controls) as {
    target: THREE.Vector3;
    update: () => void;
  } | null;

  useEffect(() => {
    let clock = 0;
    Object.assign(globalThis, {
      RENDERDEV: {
        gl,
        scene,
        camera,
        controls,
        /**
         * Look at a point on the ground. The camera cannot simply be moved:
         * OrbitControls recomputes its position from the target on every frame,
         * so a camera moved by hand snaps back the moment anything advances.
         */
        lookAt: (x: number, z: number, zoom?: number) => {
          if (!controls) return;
          const dx = x - controls.target.x;
          const dz = z - controls.target.z;
          controls.target.set(x, 0, z);
          camera.position.x += dx;
          camera.position.z += dz;
          if (
            zoom !== undefined &&
            camera instanceof THREE.OrthographicCamera
          ) {
            camera.zoom = zoom;
            camera.updateProjectionMatrix();
          }
          controls.update();
        },
        /** Draw only. Nothing animated updates — no useFrame callback runs. */
        frame: () => gl.render(scene, camera),
        /**
         * What a frame of the map on screen costs, CPU and GPU. See `bench.ts`
         * for why this cannot simply be a frame counter.
         */
        bench: () => benchmark(gl, scene, camera),
        /**
         * Build a benchmark city of the given half-extent, add it to the level
         * list and return its id — `RENDERDEV.benchLevel(1500)`, then pick it
         * from the level sheet. Building is seconds of work at the large sizes,
         * which is why these are not in the list to begin with.
         */
        benchLevel: (half: number) => {
          const level = benchLevel(half);
          addTransientLevel(level);
          return level.id;
        },
        /**
         * A whole frame, including every useFrame subscriber, so anything
         * driven by the render loop — signal colours, countdowns, the cars
         * themselves — actually advances before it is drawn.
         */
        step: (seconds = 1 / 60) => {
          clock += seconds;
          advance(clock);
        },
      },
    });
  }, [gl, scene, camera, advance, controls]);

  return null;
}

/**
 * Depth of field endpoints, keyed to `t` — how far into the *player's own*
 * zoom range the camera currently sits: 0 at fully zoomed out (the level
 * framed edge to edge, `Controls`' `minZoom`/`maxDistance`), 1 at fully
 * zoomed in (one junction, `Controls`' `maxZoom`/`minDistance`). Sharing
 * those limits, rather than picking new ones here, is what keeps this
 * agreeing with the camera the player actually has rather than a range nobody
 * can reach on a particular level.
 *
 * Zoomed out, a shallow focus band would blur out most of the map a player
 * needs to read, so the band is wide (1000) and the blur barely there (0.1);
 * zoomed in, a wide flat focus stops reading as depth at all, so the band
 * narrows to a close-up (60) and the blur strengthens into the miniature
 * look (2).
 */
const FOCUS_RANGE_OUT = 1000;
const BOKEH_SCALE_OUT = 0.2;

/**
 * The zoomed-in/close-up end of the band, keyed to the "Focus distance"
 * slider instead of a fixed constant — the miniature-model look (a narrow
 * band, strong blur) is only right at the slider's near setting. A real lens
 * gets *more* forgiving the farther out it focuses, not less, so the band
 * widens and the blur eases as the slider moves out. This end is what the
 * slider governs everywhere: zoomed all the way in on the orbit camera and
 * walking both land here, since both put the "far" end (`FOCUS_RANGE_OUT`,
 * a whole readable map) out of reach.
 */
const FOCUS_RANGE_IN_NEAR = 30;
const FOCUS_RANGE_IN_FAR = 260;
const BOKEH_SCALE_IN_NEAR = 1.4;
const BOKEH_SCALE_IN_FAR = 0.25;

/**
 * Depth of field, focused on whatever the orbit controls are pivoting
 * around — the thing the player is actually looking at stays sharp, and
 * everything nearer or farther falls away.
 *
 * The circle-of-confusion math reconstructs a real view-space distance for
 * either projection (`orthographicDepthToViewZ` under the fixed 3/4 camera,
 * `perspectiveDepthToViewZ` under the street-level one), so the same effect
 * works for both without a separate ortho-only technique.
 */
/**
 * Bloom.
 *
 * Selective, and not by preference — see `glow.ts`. On a high-key palette a
 * luminance threshold picks out the buildings long before it picks out a
 * signal, so what glows is a property of the object instead: the lamps, lenses
 * and indicators that register themselves as light sources.
 *
 * Kept restrained. The whole art direction is a physical model under soft
 * light, and a model does not have a bloom — what it has is a few genuinely
 * bright little things, which at this scale read better slightly blown than
 * pin-sharp. The threshold stays low because the selection has already done
 * the picking; it is only there to keep the unlit face of a lamp housing from
 * contributing.
 */
const BLOOM_INTENSITY = 1.5;
const BLOOM_THRESHOLD = 0.25;
const BLOOM_SMOOTHING = 0.4;

function PostFX({
  half,
  depthOfField,
  bloom,
}: {
  half: number;
  depthOfField: boolean;
  bloom: boolean;
}) {
  const controls = useThree(
    (s) => s.controls as unknown as { target: THREE.Vector3 } | null,
  );
  const camera = useThree((s) => s.camera);
  const dof = useRef<DepthOfFieldEffect>(null);
  const glowing = useGlowing();
  const walk = useHud((s) => s.layers.walkCamera);
  const walkFocusDistance = useHud((s) => s.walkFocusDistance);
  const focusPoint = useMemo(() => new THREE.Vector3(), []);

  const zoomMin = useMemo(() => minZoom(half), [half]);
  const distMax = useMemo(() => maxDistance(half), [half]);

  useFrame(() => {
    const effect = dof.current;
    if (!effect) return;
    if (effect.target) {
      if (controls) effect.target.copy(controls.target);
      else if (walk) {
        /*
         * Walking there is no orbit target, and leaving the focus at the world
         * origin would blur everything you actually walked over to look at.
         * Focus a little way down your own eyeline instead.
         */
        camera.getWorldDirection(focusPoint);
        effect.target
          .copy(camera.position)
          .addScaledVector(focusPoint, walkFocusDistance);
      }
    }

    // The slider's own position, 0 at its near end and 1 at its far end —
    // this is what the close-up end of the band reads from, in every mode.
    const sliderT = THREE.MathUtils.clamp(
      (walkFocusDistance - WALK_FOCUS_DISTANCE_MIN) /
        (WALK_FOCUS_DISTANCE_MAX - WALK_FOCUS_DISTANCE_MIN),
      0,
      1,
    );
    const focusRangeIn = THREE.MathUtils.lerp(
      FOCUS_RANGE_IN_NEAR,
      FOCUS_RANGE_IN_FAR,
      sliderT,
    );
    const bokehScaleIn = THREE.MathUtils.lerp(
      BOKEH_SCALE_IN_NEAR,
      BOKEH_SCALE_IN_FAR,
      sliderT,
    );

    if (walk) {
      // Walking is as close in as the map ever gets, so it sits at the
      // close-up end outright rather than blending toward it.
      effect.cocMaterial.focusRange = focusRangeIn;
      effect.bokehScale = bokehScaleIn;
    } else {
      // 0 = fully zoomed out, 1 = fully zoomed in. No orbit target (e.g. the
      // cinematic flyover, which unmounts Controls) reads as zoomed out.
      let t = 0;
      if (camera instanceof THREE.OrthographicCamera) {
        t = (camera.zoom - zoomMin) / (MAX_ZOOM - zoomMin);
      } else if (controls) {
        const distance = camera.position.distanceTo(controls.target);
        t = (distMax - distance) / (distMax - MIN_DISTANCE);
      }
      t = THREE.MathUtils.clamp(t, 0, 1);

      effect.cocMaterial.focusRange = THREE.MathUtils.lerp(
        FOCUS_RANGE_OUT,
        focusRangeIn,
        t,
      );
      effect.bokehScale = THREE.MathUtils.lerp(
        BOKEH_SCALE_OUT,
        bokehScaleIn,
        t,
      );
    }
  });

  return (
    <EffectComposer multisampling={4}>
      {depthOfField ? (
        <DepthOfField
          ref={dof}
          target={[0, 0, 0]}
          focusRange={FOCUS_RANGE_OUT}
          bokehScale={BOKEH_SCALE_OUT}
        />
      ) : (
        <></>
      )}
      {/*
        `lights` is empty on purpose. The effect wants them so that selected
        objects are lit in its own pass, but every light source on this map is
        an unlit `meshBasicMaterial` — a lamp lens is its own colour whatever
        the sky is doing — so there is nothing for a light to contribute.
      */}
      {bloom ? (
        <SelectiveBloom
          selection={glowing}
          lights={EMPTY_LIGHTS}
          intensity={BLOOM_INTENSITY}
          luminanceThreshold={BLOOM_THRESHOLD}
          luminanceSmoothing={BLOOM_SMOOTHING}
          mipmapBlur
        />
      ) : (
        <></>
      )}
    </EffectComposer>
  );
}

/** Stable empty array — a fresh one would re-run the effect's setup each frame. */
const EMPTY_LIGHTS: THREE.Object3D[] = [];

export function Scene({ level, world }: { level: LevelDef; world: World }) {
  const { buildings, trees } = useMemo(() => scatterLevel(level), [level]);
  const showTraffic = useHud((s) => s.layers.traffic);
  const showLabels = useHud((s) => s.layers.labels);
  const showStreetSigns = useHud((s) => s.layers.streetSigns);
  const showStreetLights = useHud((s) => s.layers.streetLights);
  const showShops = useHud((s) => s.layers.shopSigns);
  const showSignals = useHud((s) => s.layers.signals);
  const showParking = useHud((s) => s.layers.parking);
  const perspective = useHud((s) => s.layers.perspective);
  const depthOfField = useHud((s) => s.layers.depthOfField);
  const bloom = useHud((s) => s.layers.bloom);
  const cinematic = useHud((s) => s.layers.cinematicCamera);
  const walk = useHud((s) => s.layers.walkCamera);

  /*
   * Frame the whole map whatever its size, so a 49-junction city opens showing
   * the city rather than one corner of it. The card is viewed corner-on at 25°,
   * so what has to fit is its diagonal, not its width — hence the √2.
   */
  const zoom = 700 / (level.half * Math.SQRT2);

  return (
    <Canvas
      orthographic
      dpr={[1, 2]}
      shadows={{ type: THREE.PCFShadowMap }}
      camera={{
        position: orthoPos(level.half),
        zoom,
        near: 1,
        far: farPlane(level.half) * 2,
      }}
      gl={{
        antialias: false,
        // Keep the palette exact — ACES tone mapping would crush these near-whites.
        toneMapping: THREE.NoToneMapping,
        /*
         * Dev only, and purely so the map can be captured. The drawing buffer is
         * cleared once composited, so a screenshot taken outside the animation
         * loop — which is any screenshot, when the page is considered hidden and
         * requestAnimationFrame is therefore stopped — comes back empty.
         */
        preserveDrawingBuffer: import.meta.env.DEV,
      }}
    >
      {import.meta.env.DEV && <Stats />}
      {import.meta.env.DEV && <DevHandle />}
      {/*
        Only mounted when asked for. `makeDefault` hands it to everything that
        reads `state.camera` — the controls, the picker's raycaster, the crash
        push-in — and unmounting hands the orthographic one back.
      */}
      {perspective && (
        <PerspectiveCamera
          makeDefault
          fov={FOV}
          /*
           * A tight near plane, because depth precision is what keeps the road
           * markings from tearing.
           *
           * Perspective depth is distributed as 1/z, so the near plane sets
           * almost the whole budget: at near=1 and far=20000 the first metre in
           * front of the lens consumed as much of the depth buffer as the entire
           * rest of the map, and the ground layers — kerb, asphalt, paint, all
           * within a few centimetres of each other and several hundred metres
           * away — landed on the same depth value and z-fought.
           *
           * The camera orbits hundreds of metres out and the controls never let
           * it closer than the map's own framing distance, so nothing is ever
           * within 20m of it to clip. Trading a near plane that could never see
           * anything for a usable depth buffer is free.
           *
           * Walk mode is the one exception: standing in the street, a 20m near
           * plane clips away everything you came to look at. It pays the price
           * back in depth precision — expect the road markings to z-fight at a
           * distance while walking.
           */
          near={walk ? 0.3 : 20}
          far={farPlane(level.half)}
          position={orthoPos(level.half)}
        />
      )}
      <Reframe level={level.id} zoom={zoom} half={level.half} />
      <Daylight level={level} world={world} />

      <Controls level={level} />
      {cinematic && <CinematicCamera level={level} />}
      {walk && <WalkCamera level={level} />}

      <Ground level={level} />
      <Parks zones={level.zones} />
      <RoadNetwork level={level} />
      {/* Over the road: a median stands on a kerb above the carriageway. */}
      <Medians zones={level.zones} />
      {showLabels && <StreetLabels level={level} />}
      {showStreetSigns && <StreetSigns level={level} />}
      {showStreetLights && <StreetLights level={level} />}
      {/* Surveyed outlines where the level has them, scattered boxes otherwise. */}
      {level.footprints?.length ? (
        <Footprints items={level.footprints} />
      ) : (
        <Buildings items={buildings} />
      )}
      {showShops && level.shopfronts?.length ? (
        <Shopfronts fronts={level.shopfronts} />
      ) : null}
      <Trees items={trees} />
      {/*
        The three components that exist because traffic is moving, gated
        together. `Simulation` owns the fixed-timestep loop, so unmounting it is
        what actually stops the physics; the other two only read the result, but
        both walk the network every frame to do it and neither has anything to
        show once the cars are gone.

        Parked cars are deliberately *not* in here. They are scenery that
        happens to be car-shaped — static, already on their own layer, and
        exactly what somebody looking at an empty street still wants to see.
      */}
      {showTraffic && <QueuePressure world={world} />}
      {showSignals && <SignalHeads level={level} world={world} />}
      <BusStops world={world} />
      {showParking && <ParkedCars world={world} />}
      {showTraffic && <Simulation world={world} />}
      {showTraffic && <CrashFocus world={world} />}
      {/* Nothing to composite if both effects are off — skip the whole pass. */}
      {(depthOfField || bloom) && (
        <PostFX half={level.half} depthOfField={depthOfField} bloom={bloom} />
      )}
    </Canvas>
  );
}
