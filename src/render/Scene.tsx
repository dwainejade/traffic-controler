import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { PALETTE } from "../art/palette";
import type { LevelDef } from "../sim/types";
import { Ground } from "./Ground";
import { RoadNetwork } from "./RoadNetwork";
import { Buildings } from "./Buildings";
import { Trees } from "./Trees";
import { scatterLevel } from "./scatter";
import { Controls } from "./Controls";
import { Simulation } from "./Simulation";
import { CrashFocus } from "./CrashFocus";
import { JunctionPicker } from "./JunctionPicker";
import { QueuePressure } from "./QueuePressure";
import type { World } from "../sim/world";
import { Stats } from "@react-three/drei";

/**
 * Fixed orthographic 3/4 camera. Ortho is doing real work here: it removes the
 * perspective distortion that makes a grid of junctions hard to compare, and it
 * is a large part of why the reference reads as a model rather than a photo.
 */
const ELEVATION = THREE.MathUtils.degToRad(55);
const AZIMUTH = THREE.MathUtils.degToRad(25);
const DISTANCE = 400;

const CAMERA_POS: [number, number, number] = [
  Math.cos(ELEVATION) * Math.sin(AZIMUTH) * DISTANCE,
  Math.sin(ELEVATION) * DISTANCE,
  Math.cos(ELEVATION) * Math.cos(AZIMUTH) * DISTANCE,
];

export function Scene({ level, world }: { level: LevelDef; world: World }) {
  const { buildings, trees } = useMemo(() => scatterLevel(level), [level]);

  return (
    <Canvas
      orthographic
      shadows={{ type: THREE.PCFSoftShadowMap }}
      camera={{ position: CAMERA_POS, zoom: 3.4, near: 1, far: 1600 }}
      gl={{
        antialias: true,
        // Keep the palette exact — ACES tone mapping would crush these near-whites.
        toneMapping: THREE.NoToneMapping,
      }}
    >
      <Stats />
      <color attach="background" args={[PALETTE.background]} />
      {/*
        The reference has no hard key light. A hemisphere light does ~80% of the
        work; the directional exists almost entirely to produce the wide, soft,
        very light contact shadows that make the style look expensive.
      */}
      <hemisphereLight args={["#FFFFFF", "#E8E4DC", 2.1]} />
      <directionalLight
        position={[110, 190, 70]}
        intensity={0.55}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.6}
        shadow-camera-left={-160}
        shadow-camera-right={160}
        shadow-camera-top={160}
        shadow-camera-bottom={-160}
        shadow-camera-near={1}
        shadow-camera-far={600}
      />

      <Controls half={level.half} />

      <Ground level={level} />
      <RoadNetwork level={level} />
      <Buildings items={buildings} />
      <Trees items={trees} />
      <QueuePressure world={world} />
      <Simulation world={world} />
      <JunctionPicker level={level} world={world} />
      <CrashFocus world={world} />
    </Canvas>
  );
}
