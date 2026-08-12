import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { INDICATOR, VEHICLE_COLORS } from "../art/palette";
import { SKY } from "../art/daylight";
import { VEHICLE, type World } from "../sim/world";
import {
  UNIT_PLANE,
  blobTexture,
  bodyGeometry,
  carBodyGeometry,
  glowTexture,
  truckBodyGeometry,
} from "./vehicleArt";
import { LAYER } from "./layers";
import { useGlow } from "./glow";
import { publishHud, useHud } from "../ui/hudStore";

/** Simulation runs at a fixed 60 Hz of simulated time, whatever the render rate. */
const FIXED_DT = 1 / 120;
/** Never simulate more than this much wall time in one frame after a stall. */
const MAX_CATCHUP = 0.25;
/**
 * Ceiling on steps per rendered frame. The grid sim runs ~165k steps/s, so this
 * is roughly 7ms of budget — enough for 100x time-lapse with headroom, and a
 * hard stop against a death spiral on a slower machine.
 */
const MAX_STEPS_PER_FRAME = 1200;
/**
 * Instance budget for vehicles. A city-sized island carries around 1300 cars at
 * its measured demand ceiling, and any car over this cap simply is not drawn —
 * which reads as traffic mysteriously thinning out in whichever part of the map
 * the iteration reached last. Sized well clear of that, since these are two
 * instanced draw calls either way.
 */
const MAX_CARS = 2400;
/**
 * Instance budgets for trucks and buses, each split into its own mesh so cars
 * don't pay for cabin geometry they don't have and trucks/buses don't pay for
 * cab/box geometry a car has no use for — three draw calls instead of one.
 * Trucks are 7% of spawns and buses trickle in on a 120s headway, so even at
 * `MAX_CARS` demand neither gets close to its cap.
 */
const MAX_TRUCKS = 300;
const MAX_BUSES = 200;

const HUD_INTERVAL = 1 / 6;

/** Indicators flash at roughly 1.5 Hz, as real ones do. */
const BLINK_HZ = 1.5;
/** Two lamps per indicating car, front and rear on the turning side. */
const MAX_INDICATORS = MAX_CARS * 2;

/**
 * A car's own right-hand side is local -X: heading is atan2(dx, dz), so local
 * +Z is forward and rotating +X by that heading lands on the driver's left.
 * Sized as a small corner-mounted lamp, not a strip — it used to be 0.5m deep
 * fore-aft, which read as a body-side trim piece rather than an indicator.
 */
const INDICATOR_GEOM = new THREE.BoxGeometry(0.2, 0.2, 0.18);
/**
 * Where the indicator sits: same height band as the head/tail lamps, and just
 * inboard of them along the body so the two don't overlap at the corner.
 */
const INDICATOR_ALONG = 0.5;
const INDICATOR_HEIGHT = 0.44;

/**
 * Lamps, for after dark. Two at each end of every car, plus one soft pool of
 * light thrown onto the road ahead of it.
 *
 * This is the whole reason the night half of the cycle works: with the
 * environment lit only by a dim moon, a city with unlit traffic reads as a
 * mistake. Headlights also happen to make flow legible in a way the daytime
 * view never manages — a queue at a red light becomes a line of red pairs, and
 * a platoon leaving a junction is a stream of white ones.
 */
const HEADLAMP_GEOM = new THREE.BoxGeometry(0.34, 0.24, 0.24);
/**
 * Where along the body the lamps sit, as a fraction of car length from the
 * centre. Just over the half, so they stand proud of the bodywork — at 0.47 they
 * were technically drawn and entirely buried inside the box.
 */
const LAMP_ALONG = 0.54;
const MAX_LAMPS = MAX_CARS * 2;
/** Below this the lamps are off — dusk should not switch on all at once. */
const LAMPS_ON = 0.08;
const HEADLAMP = "#FFF4DA";
const TAILLAMP = "#FF3A2E";

export function Simulation({ world }: { world: World }) {
  const carBodies = useRef<THREE.InstancedMesh>(null);
  const truckBodies = useRef<THREE.InstancedMesh>(null);
  const busBodies = useRef<THREE.InstancedMesh>(null);
  const shadows = useRef<THREE.InstancedMesh>(null);
  const blinkers = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const tails = useRef<THREE.InstancedMesh>(null);
  const beams = useRef<THREE.InstancedMesh>(null);

  /*
   * Lamps and indicators bloom; the pool a car throws on the road ahead of it
   * does not. That pool is a soft gradient already, and blooming it turns every
   * car into a comet.
   */
  useGlow(heads);
  useGlow(tails);
  useGlow(blinkers);

  const accumulator = useRef(0);
  const hudTimer = useRef(0);
  const speed = useHud((s) => s.speed);

  const carGeom = useMemo(() => carBodyGeometry(), []);
  const truckGeom = useMemo(() => truckBodyGeometry(), []);
  const busGeom = useMemo(() => bodyGeometry(), []);
  const blob = useMemo(() => blobTexture(), []);
  const glow = useMemo(() => glowTexture(), []);

  useFrame((_, delta) => {
    if (import.meta.env.DEV) {
      (globalThis as unknown as { simWorld: World }).simWorld = world;
    }
    // --- Fixed-timestep simulation, scaled by the player's time multiplier.
    // The step size never changes; only how many of them a frame consumes, so
    // the physics stay identical whether you watch at 1x or 100x.
    accumulator.current += Math.min(delta, MAX_CATCHUP) * speed;

    let steps = 0;
    while (accumulator.current >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      world.step(FIXED_DT);
      accumulator.current -= FIXED_DT;
      steps++;
    }
    // Drop any backlog we could not afford rather than trying to catch up.
    if (steps >= MAX_STEPS_PER_FRAME) accumulator.current = 0;

    // --- Cars.
    const carBody = carBodies.current;
    const truckBody = truckBodies.current;
    const busBody = busBodies.current;
    const shadow = shadows.current;
    if (carBody && truckBody && busBody && shadow) {
      const m = new THREE.Matrix4();
      const sm = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const pos = new THREE.Vector3();
      const one = new THREE.Vector3(1, 1, 1);
      // Reused per car — the unit body is scaled to whatever kind it is.
      const bodyScale = new THREE.Vector3();
      const shadowScale = new THREE.Vector3();
      const colour = new THREE.Color();
      const p = { x: 0, z: 0, angle: 0 };

      const blink = blinkers.current;
      const lamp = new THREE.Matrix4();
      const lampPos = new THREE.Vector3();

      // --- Lamps. One sample of the sky per frame, not per car.
      const night = SKY.night;
      const dark = night > LAMPS_ON;
      const head = heads.current;
      const tail = tails.current;
      const beam = beams.current;
      const beamScale = new THREE.Vector3();
      let lit = 0;

      // One shared flash phase would look mechanical; offsetting per car keeps
      // indicators out of lockstep the way real ones drift apart.
      const now = world.stats.elapsed;

      let n = 0;
      let nCar = 0;
      let nTruck = 0;
      let nBus = 0;
      let lamps = 0;
      for (const car of world.cars) {
        if (!car.active || n >= MAX_CARS) continue;
        world.pose(car, p);

        const spec = VEHICLE[car.kind];

        q.setFromAxisAngle(up, p.angle);
        pos.set(p.x, 0, p.z);

        bodyScale.set(spec.width, spec.height, spec.length);
        m.compose(pos, q, bodyScale);

        // A livery overrides the fleet distribution: a bus is blue because it is
        // a bus, not because the palette rolled that way.
        colour.set(
          spec.colour === "palette"
            ? VEHICLE_COLORS[car.colour % VEHICLE_COLORS.length].hex
            : spec.colour,
        );

        // Each kind has its own mesh — a car's cabin, a truck's cab-and-box,
        // a bus's plain shell — so none pays for geometry it doesn't use.
        if (car.kind === "car") {
          carBody.setMatrixAt(nCar, m);
          carBody.setColorAt(nCar, colour);
          nCar++;
        } else if (car.kind === "truck") {
          if (nTruck < MAX_TRUCKS) {
            truckBody.setMatrixAt(nTruck, m);
            truckBody.setColorAt(nTruck, colour);
            nTruck++;
          }
        } else if (nBus < MAX_BUSES) {
          busBody.setMatrixAt(nBus, m);
          busBody.setColorAt(nBus, colour);
          nBus++;
        }

        pos.y = LAYER.shadow;
        shadowScale.set(spec.width * 2.1, 1, spec.length * 1.5);
        sm.compose(pos, q, shadowScale);
        shadow.setMatrixAt(n, sm);
        n++;

        // Heading, reused by every lamp on this car.
        const fx = Math.sin(p.angle);
        const fz = Math.cos(p.angle);

        if (dark && head && tail && beam && lit + 2 <= MAX_LAMPS) {
          for (const [along, mesh] of [
            [spec.length * LAMP_ALONG, head],
            [-spec.length * LAMP_ALONG, tail],
          ] as const) {
            for (const side of [spec.width * 0.32, -spec.width * 0.32]) {
              // Lamps sit low on a car and high on a bus; a fraction of the
              // body height puts them on the right part of the face either way.
              lampPos.set(
                p.x + fx * along + fz * side,
                spec.height * 0.44,
                p.z + fz * along - fx * side,
              );
              lamp.compose(lampPos, q, one);
              mesh.setMatrixAt(lit + (side > 0 ? 0 : 1), lamp);
            }
          }

          // The pool of light on the road, thrown ahead of the bonnet.
          lampPos.set(
            p.x + fx * spec.length * 0.95,
            LAYER.beam,
            p.z + fz * spec.length * 0.95,
          );
          beamScale.set(spec.width * 2.4, 1, spec.length * 2.4);
          lamp.compose(lampPos, q, beamScale);
          beam.setMatrixAt(lit >> 1, lamp);

          lit += 2;
        }

        if (!blink || lamps + 2 > MAX_INDICATORS) continue;
        const turn = world.turnIntent(car);
        if (!turn) continue;
        const on = (now * BLINK_HZ + car.id * 0.37) % 1 < 0.55;
        if (!on) continue;

        // Driver's right is local -X.
        const side = (turn === "right" ? -1 : 1) * (spec.width / 2);
        for (const along of [
          spec.length * INDICATOR_ALONG,
          -spec.length * INDICATOR_ALONG,
        ]) {
          lampPos.set(
            p.x + fx * along + fz * side,
            spec.height * INDICATOR_HEIGHT,
            p.z + fz * along - fx * side,
          );
          lamp.compose(lampPos, q, one);
          blink.setMatrixAt(lamps++, lamp);
        }
      }

      carBody.count = nCar;
      truckBody.count = nTruck;
      busBody.count = nBus;
      shadow.count = n;
      carBody.instanceMatrix.needsUpdate = true;
      truckBody.instanceMatrix.needsUpdate = true;
      busBody.instanceMatrix.needsUpdate = true;
      shadow.instanceMatrix.needsUpdate = true;
      if (carBody.instanceColor) carBody.instanceColor.needsUpdate = true;
      if (truckBody.instanceColor) truckBody.instanceColor.needsUpdate = true;
      if (busBody.instanceColor) busBody.instanceColor.needsUpdate = true;

      // Sun shadows fade out with the sun, so the fake contact blobs have to go
      // with them — a hard blob under a car at midnight is the tell.
      const blobMat = shadow.material as THREE.MeshBasicMaterial;
      blobMat.opacity = 1 - night * 0.85;

      if (blink) {
        blink.count = lamps;
        blink.instanceMatrix.needsUpdate = true;
      }

      for (const [mesh, count] of [
        [head, lit],
        [tail, lit],
        [beam, lit >> 1],
      ] as const) {
        if (!mesh) continue;
        mesh.visible = dark;
        mesh.count = dark ? count : 0;
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (beam) {
        // Fade the road pools in over dusk rather than snapping them on.
        (beam.material as THREE.MeshBasicMaterial).opacity =
          THREE.MathUtils.clamp((night - LAMPS_ON) * 1.6, 0, 1) * 0.38;
      }
    }

    // --- HUD is throttled; per-frame React updates would cost more than the sim.
    hudTimer.current += delta;
    if (hudTimer.current >= HUD_INTERVAL) {
      hudTimer.current = 0;
      publishHud(world);
    }
  });

  return (
    <group>
      <instancedMesh ref={shadows} args={[UNIT_PLANE, undefined, MAX_CARS]}>
        <meshBasicMaterial map={blob} transparent depthWrite={false} />
      </instancedMesh>

      <instancedMesh ref={carBodies} args={[carGeom, undefined, MAX_CARS]} castShadow>
        <meshLambertMaterial vertexColors />
      </instancedMesh>
      <instancedMesh ref={truckBodies} args={[truckGeom, undefined, MAX_TRUCKS]} castShadow>
        <meshLambertMaterial vertexColors />
      </instancedMesh>
      <instancedMesh ref={busBodies} args={[busGeom, undefined, MAX_BUSES]} castShadow>
        <meshLambertMaterial vertexColors />
      </instancedMesh>

      {/* Headlights, tail lights, and the pool each pair throws on the road. */}
      <instancedMesh
        ref={beams}
        args={[UNIT_PLANE, undefined, MAX_CARS]}
        visible={false}
      >
        <meshBasicMaterial
          map={glow}
          color={HEADLAMP}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh
        ref={heads}
        args={[HEADLAMP_GEOM, undefined, MAX_LAMPS]}
        visible={false}
      >
        <meshBasicMaterial color={HEADLAMP} toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={tails}
        args={[HEADLAMP_GEOM, undefined, MAX_LAMPS]}
        visible={false}
      >
        <meshBasicMaterial color={TAILLAMP} toneMapped={false} />
      </instancedMesh>

      {/* Turn indicators. Unlit amber so they read against any body colour. */}
      <instancedMesh
        ref={blinkers}
        args={[INDICATOR_GEOM, undefined, MAX_INDICATORS]}
      >
        <meshBasicMaterial color={INDICATOR} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
