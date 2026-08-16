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
import { viewCentre, viewRadius } from "./viewCentre";

/**
 * How far out the key light sits. Only the direction matters to the shading —
 * this is a distance, not a position, and it exists so the shadow camera has
 * something to hang off.
 */
const SUN_DISTANCE = 900;

/** Resolution of the shadow map, one side. */
const SHADOW_MAP = 2048;

/**
 * How much ground the shadow camera covers, as a multiple of what the player can
 * see, and the range that is clamped to.
 *
 * Sized to the *view* rather than to the map, which is the whole fix. A shadow
 * map is a fixed number of texels however much ground it is asked to cover, so
 * spreading it over the level meant its resolution fell as maps grew: at Dumbo's
 * 636m half-extent it was already down to 0.84m per texel, and a 5km import took
 * it to 3.3m — a texel wider than the street, which is not a soft shadow, it is
 * no shadow at all.
 *
 * Following the view instead makes the useful quantity — shadow texels per
 * *screen* pixel — very nearly constant at every zoom and on every map, because
 * both sides of that ratio now scale together. Zoomed in on a junction the
 * shadows are sharper than they have ever been; zoomed out they are as soft as
 * they were, on a map forty times the size.
 */
const SHADOW_VIEW_MULTIPLE = 1.15;
const SHADOW_EXTENT_MIN = 60;
const SHADOW_EXTENT_MAX = 1800;

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
  const sunTarget = useMemo(() => new THREE.Object3D(), []);

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

  const size = useThree((st) => st.size);

  /*
   * Working vectors for the shadow fit, allocated once. This runs every frame,
   * and a fresh `Vector3` per frame per axis is exactly the kind of garbage that
   * turns into a stutter every few seconds.
   */
  const fit = useMemo(
    () => ({
      centre: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      worldUp: new THREE.Vector3(0, 1, 0),
    }),
    [],
  );

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
      key.color.copy(sample.sun);
      key.intensity = sample.sunIntensity;

      /*
       * Point the whole light rig at what the player is looking at, and size its
       * shadow box to how much of the map that is.
       *
       * The light has to *move* for this, not just its camera: a directional
       * light's shadow camera is positioned by the light and aimed at its
       * target, so leaving both at the origin would slide the shadow box off the
       * far side of a city the moment anybody panned.
       */
      /*
       * The box has to cover what is visible *and* what exists, so it is sized
       * to whichever is smaller. Framing a small level fills the screen with
       * ground that runs off the edge of the card, and sizing the shadows to
       * that view alone spent half the map on empty space either side — Bay
       * Ridge went from 0.57m per texel to 1.46m, which is the exact problem
       * this is meant to fix, arriving from the other direction.
       *
       * The map term is what it always was: the level's half-extent with room
       * for the sun to swing east to west across it.
       */
      const extent = THREE.MathUtils.clamp(
        Math.min(
          viewRadius(camera, size.width, size.height) * SHADOW_VIEW_MULTIPLE,
          level.half * 1.35,
        ),
        SHADOW_EXTENT_MIN,
        SHADOW_EXTENT_MAX,
      );

      /*
       * Snap the centre to whole shadow texels.
       *
       * Without this the shadow map is re-rasterised from a slightly different
       * origin every frame, and every shadow edge on screen crawls and fizzes as
       * the map is panned — the more visibly the coarser the texels, which is
       * exactly the case this is all for. Rounding the box's centre to texel
       * increments along the light's own axes means the samples land on the same
       * world positions from frame to frame and the edges sit still.
       */
      fit.forward.copy(sample.sunDir).normalize();
      fit.right.crossVectors(fit.worldUp, fit.forward);
      // Sun directly overhead: any horizontal basis will do.
      if (fit.right.lengthSq() < 1e-6) fit.right.set(1, 0, 0);
      fit.right.normalize();
      fit.up.crossVectors(fit.forward, fit.right).normalize();

      const texel = (extent * 2) / SHADOW_MAP;
      fit.centre.copy(viewCentre.point);
      const alongRight = Math.round(fit.centre.dot(fit.right) / texel) * texel;
      const alongUp = Math.round(fit.centre.dot(fit.up) / texel) * texel;
      const alongFwd = fit.centre.dot(fit.forward);
      fit.centre
        .copy(fit.right)
        .multiplyScalar(alongRight)
        .addScaledVector(fit.up, alongUp)
        .addScaledVector(fit.forward, alongFwd);

      key.target = sunTarget;
      sunTarget.position.copy(fit.centre);
      sunTarget.updateMatrixWorld();
      key.position.copy(fit.centre).addScaledVector(fit.forward, SUN_DISTANCE);

      const shadowCam = key.shadow.camera;
      if (shadowCam.right !== extent) {
        shadowCam.left = -extent;
        shadowCam.right = extent;
        shadowCam.top = extent;
        shadowCam.bottom = -extent;
        /*
         * Deep enough for the tallest thing the importer will build. A 600m
         * tower stands well above a light that hangs 900m out along a low sun,
         * and a near plane at the light would clip its own caster away.
         */
        shadowCam.near = 1;
        shadowCam.far = SUN_DISTANCE * 2 + extent * 2;
        shadowCam.updateProjectionMatrix();
      }
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
        shadow-mapSize={[SHADOW_MAP, SHADOW_MAP]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.6}
      />
      {/*
        The light aims at its target object, and three.js only includes a target
        in the scene graph if something puts it there. Without this the target
        stays at the origin however the rig is moved, and the shadow box never
        leaves the middle of the map.
      */}
      <primitive object={sunTarget} />
    </>
  );
}
