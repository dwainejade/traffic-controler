import { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { LevelDef } from "../sim/types";
import { Daylight } from "./Daylight";
import { Ground } from "./Ground";
import { RoadNetwork } from "./RoadNetwork";
import { Buildings } from "./Buildings";
import { Footprints } from "./Footprints";
import { Trees } from "./Trees";
import { scatterLevel } from "./scatter";
import { Controls } from "./Controls";
import { Simulation } from "./Simulation";
import { CrashFocus } from "./CrashFocus";
import { JunctionPicker } from "./JunctionPicker";
import { QueuePressure } from "./QueuePressure";
import { StreetLabels } from "./StreetLabels";
import { SignalHeads } from "./SignalHeads";
import type { World } from "../sim/world";
import { clearSelection, useHud } from "../ui/hudStore";
import { PerspectiveCamera, Stats } from "@react-three/drei";

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
const DISTANCE = 1200;

/** Unit vector from the map to the camera, shared by both projections. */
const VIEW_DIR: [number, number, number] = [
  Math.cos(ELEVATION) * Math.sin(AZIMUTH),
  Math.sin(ELEVATION),
  Math.cos(ELEVATION) * Math.cos(AZIMUTH),
];

const CAMERA_POS: [number, number, number] = [
  VIEW_DIR[0] * DISTANCE,
  VIEW_DIR[1] * DISTANCE,
  VIEW_DIR[2] * DISTANCE,
];

/** Vertical field of view of the perspective camera, in degrees. */
const FOV = 32;

/**
 * Distance that frames the same amount of map the orthographic view does at its
 * opening zoom, so flipping projection re-frames rather than jumping.
 */
function perspectiveDistance(half: number): number {
  // 0.8 because the perspective view is not trying to show the whole card at
  // once — it is worth being closer in, and the pan limits reach the rest.
  return (half * Math.SQRT2 * 0.8) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
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
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;

  useEffect(() => {
    if (camera instanceof THREE.OrthographicCamera) {
      camera.position.set(...CAMERA_POS);
      camera.zoom = zoom;
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
          if (zoom !== undefined && camera instanceof THREE.OrthographicCamera) {
            camera.zoom = zoom;
            camera.updateProjectionMatrix();
          }
          controls.update();
        },
        /** Draw only. Nothing animated updates — no useFrame callback runs. */
        frame: () => gl.render(scene, camera),
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

export function Scene({ level, world }: { level: LevelDef; world: World }) {
  const { buildings, trees } = useMemo(() => scatterLevel(level), [level]);
  const showLabels = useHud((s) => s.layers.labels);
  const showSignals = useHud((s) => s.layers.signals);
  const perspective = useHud((s) => s.layers.perspective);

  /*
   * Frame the whole map whatever its size, so a 49-junction city opens showing
   * the city rather than one corner of it. The card is viewed corner-on at 25°,
   * so what has to fit is its diagonal, not its width — hence the √2.
   */
  const zoom = 700 / (level.half * Math.SQRT2);

  return (
    <Canvas
      orthographic
      shadows={{ type: THREE.PCFSoftShadowMap }}
      camera={{ position: CAMERA_POS, zoom, near: 1, far: 10000 }}
      gl={{
        antialias: true,
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
      // Clicking anywhere that isn't a junction puts the editors away.
      onPointerMissed={() => clearSelection()}
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
          near={1}
          far={20000}
          position={CAMERA_POS}
        />
      )}
      <Reframe level={level.id} zoom={zoom} half={level.half} />
      <Daylight level={level} world={world} />

      <Controls level={level} />

      <Ground level={level} />
      <RoadNetwork level={level} />
      {showLabels && <StreetLabels level={level} />}
      {/* Surveyed outlines where the level has them, scattered boxes otherwise. */}
      {level.footprints?.length ? (
        <Footprints items={level.footprints} />
      ) : (
        <Buildings items={buildings} />
      )}
      <Trees items={trees} />
      <QueuePressure world={world} />
      {showSignals && <SignalHeads level={level} world={world} />}
      <Simulation world={world} />
      <JunctionPicker level={level} world={world} />
      <CrashFocus world={world} />
    </Canvas>
  );
}
