import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { rightOf } from "../sim/network";
import type { LaneId } from "../sim/network";
import {
  STOP_OFFSET,
  junctionSize,
  pavedWidth,
  type LevelDef,
  type NodeId,
} from "../sim/types";
import { SIGNAL } from "../art/palette";
import type { World } from "../sim/world";
import { useGlow } from "./glow";

/**
 * Signal heads: a pole at the kerb, bent through ninety degrees over the road,
 * carrying a lit panel that shows this approach's colour.
 *
 * This is the only display of signal state. Painting the colour on the road
 * instead said what the signal was doing but not *whose* signal it was — at a
 * five-arm junction you could not tell which mark belonged to the approach you
 * were looking at. A head standing over its own approach can only mean one thing.
 */

/** Metres. */
const POLE_HEIGHT = 6.4;
const POLE_RADIUS = 0.16;
const BEND_RADIUS = 1.1;
const PANEL_W = 2.0;
const PANEL_H = 1.15;
const PANEL_D = 0.14;
/** How far the head sits back from the kerb, into the footway. */
const SETBACK = 1.1;

type Head = {
  key: string;
  junction: NodeId;
  /** Movements this head governs — the connectors leaving this arm. */
  connectors: LaneId[];
  /** Foot of the pole. */
  foot: THREE.Vector3;
  /** Centre of the panel, out over the carriageway. */
  panel: THREE.Vector3;
  /** Rotation about Y that faces the panel back at approaching traffic. */
  facing: number;
  /** Pole path, in world space. */
  path: THREE.Vector3[];
};

/**
 * An L bent through a quarter circle, as a polyline for the tube to follow. A
 * mitred corner reads as two separate sticks at this scale; the curve is what
 * makes it look like one bent pole.
 */
function bentPath(
  foot: THREE.Vector3,
  reach: number,
  dir: THREE.Vector3,
): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const straight = POLE_HEIGHT - BEND_RADIUS;

  pts.push(foot.clone());
  pts.push(foot.clone().setY(foot.y + straight));

  const SEGMENTS = 5;
  for (let i = 1; i <= SEGMENTS; i++) {
    const a = (Math.PI / 2) * (i / SEGMENTS);
    pts.push(
      foot
        .clone()
        .addScaledVector(dir, BEND_RADIUS * (1 - Math.cos(a)))
        .setY(foot.y + straight + BEND_RADIUS * Math.sin(a)),
    );
  }

  pts.push(
    foot
      .clone()
      .addScaledVector(dir, reach)
      .setY(foot.y + POLE_HEIGHT),
  );
  return pts;
}

function buildHeads(level: LevelDef, world: World): Head[] {
  const heads: Head[] = [];

  for (const [nodeId, arms] of world.net.armsByJunction) {
    const node = level.nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    for (const arm of arms) {
      // An arm with nothing arriving on it is an exit, and exits have no signal.
      if (arm.inbound.length === 0) continue;

      const road = level.roads.find((r) => r.id === arm.roadId);
      if (!road) continue;

      /*
       * `arm.out` points from the junction outward along the road, so traffic
       * on this approach travels along -out. The head belongs on the driver's
       * right at the stop line, which is `rightOf` that direction of travel.
       */
      const travel = { x: -arm.out.x, z: -arm.out.z };
      const side = rightOf(travel);
      const half = pavedWidth(road) / 2 + SETBACK;

      // The head stands at the stop line, which is STOP_OFFSET beyond the
      // junction box — the same arithmetic that paints the stop bar, so the
      // pole and the line it governs can never drift apart.
      const setback = junctionSize(level, nodeId) / 2 + STOP_OFFSET;
      const stopLine = new THREE.Vector3(
        node.pos[0] + arm.out.x * setback,
        0,
        node.pos[1] + arm.out.z * setback,
      );

      const foot = new THREE.Vector3(
        stopLine.x + side.x * half,
        0,
        stopLine.z + side.z * half,
      );

      // The arm reaches back across the approach, so the panel hangs over the
      // lanes it governs rather than over the footway.
      const inward = new THREE.Vector3(-side.x, 0, -side.z);
      const reach = Math.min(half + pavedWidth(road) * 0.28, 7.5);
      const path = bentPath(foot, reach, inward);

      const panel = path[path.length - 1]
        .clone()
        .addScaledVector(inward, PANEL_W * 0.1)
        .setY(POLE_HEIGHT - PANEL_H * 0.62);

      heads.push({
        key: `${nodeId}_${arm.roadId}`,
        junction: nodeId,
        connectors: arm.connectorIds,
        foot,
        panel,
        // Face back down the approach, at the drivers waiting on it.
        facing: Math.atan2(-travel.x, -travel.z),
        path,
      });
    }
  }

  return heads;
}

const PANEL_GEOM = new THREE.BoxGeometry(PANEL_W, PANEL_H, PANEL_D);

export function SignalHeads({
  level,
  world,
}: {
  level: LevelDef;
  world: World;
}) {
  const heads = useMemo(() => buildHeads(level, world), [level, world]);

  const poleGeom = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    for (const head of heads) {
      const curve = new THREE.CatmullRomCurve3(head.path, false, "centripetal");
      parts.push(new THREE.TubeGeometry(curve, 18, POLE_RADIUS, 6, false));
    }
    if (parts.length === 0) return new THREE.BufferGeometry();

    let count = 0;
    for (const g of parts) count += g.getAttribute("position").count;
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const index: number[] = [];

    let offset = 0;
    for (const g of parts) {
      const p = g.getAttribute("position");
      const n = g.getAttribute("normal");
      const idx = g.getIndex();
      for (let i = 0; i < p.count; i++) {
        const o = (offset + i) * 3;
        position[o] = p.getX(i);
        position[o + 1] = p.getY(i);
        position[o + 2] = p.getZ(i);
        normal[o] = n.getX(i);
        normal[o + 1] = n.getY(i);
        normal[o + 2] = n.getZ(i);
      }
      if (idx)
        for (let i = 0; i < idx.count; i++) index.push(offset + idx.getX(i));
      offset += p.count;
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(position, 3));
    merged.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    merged.setIndex(index);
    merged.computeBoundingSphere();
    return merged;
  }, [heads]);

  const panels = useRef<THREE.InstancedMesh>(null);
  // The lens is a light source, so it is one of the few things that blooms.
  useGlow(panels);

  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    heads.forEach((head, i) => {
      q.setFromAxisAngle(up, head.facing);
      m.compose(head.panel, q, one);
      panels.current?.setMatrixAt(i, m);
    });

    /*
     * The bounding sphere has to be recomputed from the instance matrices. An
     * InstancedMesh builds one at construction, when every instance is still
     * the identity — a sphere at the origin — and frustum culling then throws
     * the whole mesh away as soon as the camera looks anywhere else. The poles
     * stayed visible and their heads vanished, which is a confusing way to find
     * out about it.
     */
    if (panels.current) {
      panels.current.instanceMatrix.needsUpdate = true;
      panels.current.computeBoundingSphere();
    }
  }, [heads]);

  useFrame(() => {
    const colour = new THREE.Color();

    heads.forEach((head, i) => {
      const junction = world.junctions.get(head.junction);
      if (!junction) return;

      /*
       * The head is green only when the phase serves this approach *entirely*.
       * `some` would light it green whenever any one of its movements were
       * running, which is how an approach at a red came to be showing green
       * while only its right turn was served. Phases are whole approaches now,
       * so the two agree — but `every` is the reading that fails safe.
       */
      const serving = junction.phases[junction.current]?.connectors ?? [];
      const mine =
        head.connectors.length > 0 &&
        head.connectors.every((c) => serving.includes(c));
      const state =
        mine && junction.state === "green"
          ? "green"
          : mine && junction.state === "amber"
            ? "amber"
            : "red";

      colour.set(SIGNAL[state]);
      panels.current?.setColorAt(i, colour);
    });

    if (panels.current?.instanceColor)
      panels.current.instanceColor.needsUpdate = true;
  });

  if (heads.length === 0) return null;

  return (
    <group>
      <mesh geometry={poleGeom} castShadow>
        <meshLambertMaterial color="#858b93" />
      </mesh>

      {/* Unlit, so the signal stays the brightest thing on screen. */}
      <instancedMesh
        ref={panels}
        args={[PANEL_GEOM, undefined, heads.length]}
        castShadow
      >
        <meshBasicMaterial />
      </instancedMesh>
    </group>
  );
}
