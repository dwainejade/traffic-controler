import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { SIGNAL } from "../art/palette";
import { timeToNextGreen } from "../sim/junction";
import { rightOf } from "../sim/network";
import type { LaneId } from "../sim/network";
import {
  STOP_OFFSET,
  junctionSize,
  pavedWidth,
  type LevelDef,
  type NodeId,
} from "../sim/types";
import type { World } from "../sim/world";

/**
 * Signal heads: a pole at the kerb, bent through ninety degrees over the road,
 * carrying a lit panel that shows this approach's colour and the seconds until
 * it changes.
 *
 * The point is legibility rather than decoration. Coloured stop bars painted on
 * the road say what the signal is doing, but not *whose* signal it is — at a
 * five-arm junction you cannot tell which bar belongs to the approach you are
 * looking at. A head standing over its own approach can only mean one thing,
 * and the countdown turns a phase plan from something you infer by watching
 * into something you can read.
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
/** Slim repeater down the pole, so the signal reads from beside it too. */
const STRIP_GEOM = new THREE.BoxGeometry(0.1, 1.6, 0.22);

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
  const strips = useRef<THREE.InstancedMesh>(null);
  type Glyph = THREE.Object3D & { text: string; sync: () => void };
  const digits = useRef<Glyph[]>([]);
  const backs = useRef<Glyph[]>([]);
  const shown = useRef<string[]>([]);

  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    heads.forEach((head, i) => {
      q.setFromAxisAngle(up, head.facing);
      m.compose(head.panel, q, one);
      panels.current?.setMatrixAt(i, m);

      m.compose(new THREE.Vector3(head.foot.x, 2.6, head.foot.z), q, one);
      strips.current?.setMatrixAt(i, m);
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
    if (strips.current) {
      strips.current.instanceMatrix.needsUpdate = true;
      strips.current.computeBoundingSphere();
    }
    shown.current = heads.map(() => "");
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
      strips.current?.setColorAt(i, colour);

      /*
       * Green counts its own time down; red counts down to this approach's next
       * green, not to the end of whatever phase happens to be running. On a
       * four-phase junction those differ by most of a cycle, and the second
       * number is the one a driver — or a player deciding whether this approach
       * is starved — actually wants.
       */
      const seconds =
        state === "green"
          ? junction.timer
          : timeToNextGreen(junction, world.programOf(junction), (p) =>
              junction.phases[p].connectors.some((c) =>
                head.connectors.includes(c),
              ),
            );

      const text = String(Math.max(0, Math.ceil(seconds)));
      if (shown.current[i] !== text) {
        shown.current[i] = text;
        for (const face of [digits.current[i], backs.current[i]]) {
          if (!face) continue;
          face.text = text;
          face.sync();
        }
      }
    });

    if (panels.current?.instanceColor)
      panels.current.instanceColor.needsUpdate = true;
    if (strips.current?.instanceColor)
      strips.current.instanceColor.needsUpdate = true;
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
      <instancedMesh ref={strips} args={[STRIP_GEOM, undefined, heads.length]}>
        <meshBasicMaterial />
      </instancedMesh>

      {/*
        The number is printed on both faces of the panel.

        A real head faces only the traffic it governs, and from a fixed
        three-quarter camera that means roughly half of them are seen from
        behind — where the digits come out mirrored and unreadable. Since the
        whole point of the countdown is that the player can read it without
        first orbiting the map, both faces carry it.
      */}
      {heads.map((head, i) =>
        [1, -1].map((face) => (
          <Text
            key={`${head.key}_${face}`}
            ref={(node) => {
              if (node && face === 1) digits.current[i] = node as never;
              if (node && face === -1) backs.current[i] = node as never;
            }}
            /*
             * Text faces its own +Z, which a Y rotation of `facing` points
             * along the arm at the oncoming drivers. Each copy must therefore
             * sit just *in front of* the panel along that same direction —
             * offsetting the other way buries the readable copy inside the
             * panel and leaves only the reversed one showing, which is how the
             * countdowns came out mirrored.
             */
            position={[
              head.panel.x +
                Math.sin(head.facing) * face * (PANEL_D / 2 + 0.02),
              head.panel.y,
              head.panel.z +
                Math.cos(head.facing) * face * (PANEL_D / 2 + 0.02),
            ]}
            rotation={[0, head.facing + (face === 1 ? 0 : Math.PI), 0]}
            fontSize={PANEL_H * 0.74}
            // Dark digits punched out of the lit panel, as on a real LED matrix
            // head — the panel is what glows, the number is where it does not.
            color="#15181B"
            anchorX="center"
            anchorY="middle"
          >
            {" "}
          </Text>
        )),
      )}
    </group>
  );
}
