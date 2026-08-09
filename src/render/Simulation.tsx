import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { INDICATOR, SIGNAL, VEHICLE_COLORS } from "../art/palette";
import { CAR_LENGTH, CAR_WIDTH, type World } from "../sim/world";
import { sampleLane } from "../sim/network";
import { LANE_WIDTH } from "../sim/types";
import { publishHud, useHud } from "../ui/hudStore";

/** Simulation runs at a fixed 60 Hz of simulated time, whatever the render rate. */
const FIXED_DT = 1 / 60;
/** Never simulate more than this much wall time in one frame after a stall. */
const MAX_CATCHUP = 0.25;
/**
 * Ceiling on steps per rendered frame. The grid sim runs ~165k steps/s, so this
 * is roughly 7ms of budget — enough for 100x time-lapse with headroom, and a
 * hard stop against a death spiral on a slower machine.
 */
const MAX_STEPS_PER_FRAME = 1200;
const MAX_CARS = 500;

const HUD_INTERVAL = 1 / 6;

/** Body box with a lighter roof, so cars read as objects rather than flat chips. */
function carGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(CAR_WIDTH, 1.4, CAR_LENGTH).toNonIndexed();
  g.translate(0, 0.85, 0);

  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const shade = pos.getY(i) > 1.5 ? 1.16 : 0.88;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Soft blob used as a fake contact shadow — far cheaper than shadow-mapping 200 cars. */
function blobTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(40,44,50,0.34)");
  grad.addColorStop(0.55, "rgba(40,44,50,0.18)");
  grad.addColorStop(1, "rgba(40,44,50,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const UNIT_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** Indicators flash at roughly 1.5 Hz, as real ones do. */
const BLINK_HZ = 1.5;
/** Two lamps per indicating car, front and rear on the turning side. */
const MAX_INDICATORS = MAX_CARS * 2;

/**
 * A car's own right-hand side is local -X: heading is atan2(dx, dz), so local
 * +Z is forward and rotating +X by that heading lands on the driver's left.
 */
const INDICATOR_GEOM = new THREE.BoxGeometry(0.22, 0.26, 0.5);

export function Simulation({ world }: { world: World }) {
  const bodies = useRef<THREE.InstancedMesh>(null);
  const shadows = useRef<THREE.InstancedMesh>(null);
  const bars = useRef<THREE.InstancedMesh>(null);
  const blinkers = useRef<THREE.InstancedMesh>(null);

  const accumulator = useRef(0);
  const hudTimer = useRef(0);
  const speed = useHud((s) => s.speed);

  const geom = useMemo(() => carGeometry(), []);
  const blob = useMemo(() => blobTexture(), []);

  /** Approach lanes carry the stop bars, which are the primary signal display. */
  const approaches = useMemo(
    () => world.net.lanes.filter((l) => l.stopS >= 0),
    [world],
  );

  // Stop bars never move, so their transforms are written once.
  useLayoutEffect(() => {
    const mesh = bars.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = { x: 0, z: 0, angle: 0 };

    approaches.forEach((lane, i) => {
      sampleLane(lane, lane.stopS, p);
      q.setFromAxisAngle(up, p.angle);
      m.compose(
        new THREE.Vector3(p.x, 0.07, p.z),
        q,
        new THREE.Vector3(LANE_WIDTH * 0.86, 1, 0.85),
      );
      mesh.setMatrixAt(i, m);
    });
    mesh.count = approaches.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [approaches, world]);

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
    const body = bodies.current;
    const shadow = shadows.current;
    if (body && shadow) {
      const m = new THREE.Matrix4();
      const sm = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const pos = new THREE.Vector3();
      const one = new THREE.Vector3(1, 1, 1);
      const shadowScale = new THREE.Vector3(CAR_WIDTH * 2.1, 1, CAR_LENGTH * 1.5);
      const colour = new THREE.Color();
      const p = { x: 0, z: 0, angle: 0 };

      const blink = blinkers.current;
      const lamp = new THREE.Matrix4();
      const lampPos = new THREE.Vector3();
      // One shared flash phase would look mechanical; offsetting per car keeps
      // indicators out of lockstep the way real ones drift apart.
      const now = world.stats.elapsed;

      let n = 0;
      let lamps = 0;
      for (const car of world.cars) {
        if (!car.active || n >= MAX_CARS) continue;
        world.pose(car, p);

        q.setFromAxisAngle(up, p.angle);
        pos.set(p.x, 0, p.z);

        m.compose(pos, q, one);
        body.setMatrixAt(n, m);

        pos.y = 0.06;
        sm.compose(pos, q, shadowScale);
        shadow.setMatrixAt(n, sm);

        colour.set(VEHICLE_COLORS[car.colour % VEHICLE_COLORS.length].hex);
        body.setColorAt(n, colour);
        n++;

        if (!blink || lamps + 2 > MAX_INDICATORS) continue;
        const turn = world.turnIntent(car);
        if (!turn) continue;
        const on = ((now * BLINK_HZ + car.id * 0.37) % 1) < 0.55;
        if (!on) continue;

        // Driver's right is local -X.
        const side = (turn === "right" ? -1 : 1) * (CAR_WIDTH / 2);
        const fwd = Math.sin(p.angle);
        const fwdZ = Math.cos(p.angle);
        for (const along of [CAR_LENGTH * 0.42, -CAR_LENGTH * 0.42]) {
          lampPos.set(
            p.x + fwd * along + fwdZ * side,
            0.78,
            p.z + fwdZ * along - fwd * side,
          );
          lamp.compose(lampPos, q, one);
          blink.setMatrixAt(lamps++, lamp);
        }
      }

      body.count = n;
      shadow.count = n;
      body.instanceMatrix.needsUpdate = true;
      shadow.instanceMatrix.needsUpdate = true;
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
      if (blink) {
        blink.count = lamps;
        blink.instanceMatrix.needsUpdate = true;
      }
    }

    // --- Stop bars take the colour of the movement they govern.
    const bar = bars.current;
    if (bar) {
      const colour = new THREE.Color();
      approaches.forEach((lane, i) => {
        const junction = lane.junction ? world.junctions.get(lane.junction) : undefined;
        let state: keyof typeof SIGNAL = "red";
        if (junction) {
          const serving = junction.phases[junction.current].connectors;
          const mine = lane.next.some((c) => serving.includes(c));
          if (mine) state = junction.state === "green" ? "green" : junction.state === "amber" ? "amber" : "red";
        }
        colour.set(SIGNAL[state]);
        bar.setColorAt(i, colour);
      });
      if (bar.instanceColor) bar.instanceColor.needsUpdate = true;
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

      <instancedMesh ref={bodies} args={[geom, undefined, MAX_CARS]} castShadow>
        <meshLambertMaterial vertexColors />
      </instancedMesh>

      {/* Turn indicators. Unlit amber so they read against any body colour. */}
      <instancedMesh ref={blinkers} args={[INDICATOR_GEOM, undefined, MAX_INDICATORS]}>
        <meshBasicMaterial color={INDICATOR} toneMapped={false} />
      </instancedMesh>

      {/* Unlit so signals stay the brightest, most saturated thing on screen. */}
      <instancedMesh ref={bars} args={[UNIT_PLANE, undefined, approaches.length]}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
