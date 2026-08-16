import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  PINNED_HOUR,
  SKY,
  dayOfSim,
  emptyDaylight,
  hourOfDay,
  sampleDaylight,
} from "../art/daylight";
import type { LevelDef } from "../sim/types";
import type { World } from "../sim/world";
import { useHud } from "../ui/hudStore";

/**
 * How far out the key light sits. Only the direction matters to the shading —
 * this is a distance, not a position, and it exists so the shadow camera has
 * something to hang off.
 */
const SUN_DISTANCE = 900;

/**
 * The whole light rig, driven by the clock.
 *
 * Everything here is mutated in place rather than re-rendered: React sees one
 * mount and then never hears from this component again, while the colours move
 * every frame. Driving it through props would mean a React render per frame,
 * which costs more than the simulation does.
 */
export function Daylight({ level, world }: { level: LevelDef; world: World }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);

  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as {
    target: THREE.Vector3;
  } | null;

  const cycle = useHud((s) => s.layers.daynight);
  const walk = useHud((s) => s.layers.walkCamera);

  const sample = useMemo(() => emptyDaylight(), []);
  const background = useMemo(() => new THREE.Color(), []);
  const fog = useMemo(() => new THREE.Fog("#FFFFFF", 1, 10000), []);

  // The shadow camera must cover the map, or half the city casts nothing. The
  // sun swings east to west, so the box has to hold the map from any angle.
  const shadowExtent = level.half * 1.35;

  useFrame(() => {
    // With the cycle off the clock is pinned to midday, but the day still is
    // today's — the weather is a property of the day, not of the hour.
    sampleDaylight(
      cycle ? hourOfDay(world.signalClock) : PINNED_HOUR,
      sample,
      dayOfSim(cycle ? world.signalClock : 0),
    );
    // Publish before anything reads it — headlights sample this same frame.
    SKY.sunDir.copy(sample.sunDir);
    SKY.sun.copy(sample.sun);
    SKY.sky.copy(sample.sky);
    SKY.ground.copy(sample.ground);
    SKY.air.copy(sample.air);
    SKY.sunIntensity = sample.sunIntensity;
    SKY.fill = sample.fill;
    SKY.haze = sample.haze;
    SKY.night = sample.night;

    const key = sun.current;
    if (key) {
      key.position.copy(sample.sunDir).multiplyScalar(SUN_DISTANCE);
      key.color.copy(sample.sun);
      key.intensity = sample.sunIntensity;
    }

    const fill = hemi.current;
    if (fill) {
      fill.color.copy(sample.sky);
      fill.groundColor.copy(sample.ground);
      fill.intensity = sample.fill;
    }

    background.copy(sample.air);
    scene.background = background;

    /*
     * Fog, sized to the view rather than to the world.
     *
     * Exponential fog is the usual choice and it is the wrong one here: under an
     * orthographic camera every point on the map is very nearly the same
     * distance away, so density-based fog washes the whole scene by an equal
     * amount and reads as a flat tint. Linear fog anchored to the camera's own
     * distance puts the near edge of the map out of it and the far edge into it,
     * which is the depth cue that was wanted in the first place.
     */
    const target = controls?.target;
    /*
     * How far the eye is working, which is what the fog is sized against.
     * Orbiting, that is the distance to what you are looking at. Walking, the
     * camera is 1.7m from the origin and that fallback would put the far plane
     * at the end of the street, whiting out the whole view — so use the map's
     * own scale, the ground-level equivalent of "as far as you can see".
     */
    const distance = target
      ? camera.position.distanceTo(target)
      : walk
        ? level.half
        : camera.position.length();
    const span = level.half * 0.5;
    fog.color.copy(sample.air);
    // Thick air starts a little closer to the camera as well as ending sooner.
    // Kept gentle: pulling the near plane in hard puts fog on the tile directly
    // under the camera, which reads as a dirty lens rather than as distance.
    fog.near = Math.max(0, distance - span * (1 + sample.haze * 0.45));
    // At haze 0 the far plane is pushed so far back that nothing reaches it.
    fog.far = distance + span * (1 + (1 - sample.haze) * 9);
    scene.fog = fog;
  });

  return (
    <>
      {/*
        The reference has no hard key light. The hemisphere does ~80% of the
        work; the directional exists almost entirely to produce the wide, soft
        contact shadows that make the style look expensive — and, now, to swing
        those shadows across the map as the day goes by.
      */}
      <hemisphereLight ref={hemi} args={["#FFFFFF", "#E8E4DC", 2.1]} />
      <directionalLight
        ref={sun}
        position={[110, 190, 70]}
        intensity={0.55}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.6}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-camera-near={1}
        shadow-camera-far={SUN_DISTANCE * 2.2}
      />
    </>
  );
}
