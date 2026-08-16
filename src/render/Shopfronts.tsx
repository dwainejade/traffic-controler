import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import type { Shopfront } from "../sim/types";
import { signColours } from "../art/brands";
import { useTextAnchor } from "./textBudget";

/**
 * The signs over the shops.
 *
 * A fascia board across the street-facing wall, the way a real parade of shops
 * is signed: a band of colour at first-floor height with the name on it. From
 * the model view that reads as what a shopping street actually looks like from
 * above — a run of colour along one side of the block and nothing along the
 * next — and from the pavement it reads as the shops themselves.
 *
 * The name is always lettered on the board itself, never floated above it as a
 * map pin: a shop sign is a painted board, and a name hovering off the building
 * reads as an annotation of the map rather than as part of the street.
 *
 * The boards are cheap and always drawn. The names cost a mesh each, so they
 * are built for the fronts near what the player is looking at, and stop
 * entirely once they would be too small on screen to make out — which on a
 * whole-city view is all of them.
 */

/** Metres. */
const BOARD_HEIGHT = 0.9;
const BOARD_DEPTH = 0.18;
/**
 * Cap height on the board, and the margin left at each end.
 *
 * Nearly the full depth of the band, the way a real fascia is painted — and the
 * bigger the letters, the further out the name still reads. This is the only
 * lever there is on that: the sign is a flat object on a wall, so how legible
 * it is from the model view is decided entirely by how much of the board the
 * lettering fills.
 */
const TEXT_SIZE = 0.62;
const TEXT_MARGIN = 0.5;

/**
 * Cap height below which a name is not drawn at all.
 *
 * Four pixels is small — it is a word you can tell apart from another word
 * rather than one you can comfortably read, which from a model view of a city
 * block is the right ambition. The street-name blades set their own floor at
 * nine because they are competing with the names already painted on the road;
 * a shop sign is competing with nothing.
 */
const MIN_TEXT_PIXELS = 4;

/**
 * How many names are drawn, and how far from the middle of the view they are
 * collected. The radius follows the view rather than being fixed: at street
 * level it is the block you are standing in, from the model view it is roughly
 * what is on screen — otherwise zooming out would letter a coin-sized patch in
 * the middle of the map and nothing else.
 */
const MAX_TEXT_SIGNS = 90;
const MIN_RADIUS = 140;
const MAX_RADIUS = 900;
const TEXT_INTERVAL = 0.25;

/** Unit shared by every board; the instance matrix stretches it to each wall. */
const BOARD_GEOM = new THREE.BoxGeometry(1, BOARD_HEIGHT, BOARD_DEPTH);

/**
 * How much a name has to be squeezed to fit its board.
 *
 * `maxWidth` would wrap it instead, and a wrapped shop name stands taller than
 * the board it is on. Cap height times this is about the average advance of a
 * mixed-case latin word, which is close enough to leave a sensible margin.
 */
const AVERAGE_ADVANCE = 0.52;

function fit(front: Shopfront): number {
  const wanted = front.name.length * TEXT_SIZE * AVERAGE_ADVANCE;
  const room = Math.max(1, front.width - TEXT_MARGIN);
  return Math.min(1, room / wanted);
}

/** Which way a board's face points, for standing the text just proud of it. */
function faceNormal(angle: number): { x: number; z: number } {
  return { x: Math.sin(angle), z: Math.cos(angle) };
}

export function Shopfronts({ fronts }: { fronts: Shopfront[] }) {
  const boards = useRef<THREE.InstancedMesh>(null);

  const colours = useMemo(
    () => fronts.map((f) => signColours(f.brand, f.category)),
    [fronts],
  );

  useLayoutEffect(() => {
    const mesh = boards.current;
    if (!mesh) return;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();

    fronts.forEach((front, i) => {
      q.setFromAxisAngle(up, front.angle);
      const n = faceNormal(front.angle);
      m.compose(
        /*
         * A whole board's depth out from the wall line, not half of one. The
         * anchor is the midpoint of the outline edge, and the building is
         * extruded from that same outline — so a board centred on it is half
         * inside the wall and reads as a slot cut into the facade rather than
         * as a sign hung on it.
         */
        new THREE.Vector3(
          front.pos[0] + n.x * BOARD_DEPTH,
          front.y,
          front.pos[1] + n.z * BOARD_DEPTH,
        ),
        q,
        new THREE.Vector3(front.width, 1, 1),
      );
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, colour.set(colours[i].board));
    });

    // Written after construction, so the identity-at-the-origin bounding sphere
    // has to go or the whole street is culled the moment you look away.
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [fronts, colours]);

  const height = useThree((s) => s.size.height);
  const lettered = useNearbyFronts(fronts, height);

  if (fronts.length === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={boards}
        args={[BOARD_GEOM, undefined, fronts.length]}
        castShadow
      >
        <meshLambertMaterial />
      </instancedMesh>

      {lettered.map(({ front, index }) => {
        const n = faceNormal(front.angle);
        const colour = signColours(front.brand, front.category);

        return (
          <Text
            key={index}
            position={[
              front.pos[0] + n.x * (BOARD_DEPTH * 1.5 + 0.01),
              front.y,
              front.pos[1] + n.z * (BOARD_DEPTH * 1.5 + 0.01),
            ]}
            rotation={[0, front.angle, 0]}
            fontSize={TEXT_SIZE}
            maxWidth={Math.max(1, front.width - TEXT_MARGIN)}
            // One line, however long the name: a shop board is a board, and
            // "Damascus Bread & Bakery Shop" wrapping onto three lines would
            // stand taller than the building it is on. Long names are squeezed
            // to fit instead, which is what a real sign writer does.
            whiteSpace="nowrap"
            scale={[fit(front), 1, 1]}
            letterSpacing={0.02}
            color={colour.ink}
            anchorX="center"
            anchorY="middle"
          >
            {front.name}
          </Text>
        );
      })}
    </group>
  );
}

/**
 * The fronts close enough to letter, rechecked a few times a second rather than
 * every frame — this drives React, and a re-render per frame would cost more
 * than the text it saves.
 */
function useNearbyFronts(
  fronts: Shopfront[],
  height: number,
): { front: Shopfront; index: number }[] {
  const anchor = useTextAnchor();
  const [visible, setVisible] = useState<{ front: Shopfront; index: number }[]>(
    [],
  );
  const timer = useRef(0);
  const signature = useRef("");

  useFrame((_, delta) => {
    timer.current += delta;
    if (timer.current < TEXT_INTERVAL) return;
    timer.current = 0;

    const { x, z, pixelsPerMetre } = anchor();

    let next: { front: Shopfront; index: number }[] = [];
    if (pixelsPerMetre > 0 && TEXT_SIZE * pixelsPerMetre >= MIN_TEXT_PIXELS) {
      // What a screenful covers, so the names follow the view out as it widens
      // instead of clustering on the point in the middle of it.
      const radius = THREE.MathUtils.clamp(
        (height / pixelsPerMetre) * 0.6,
        MIN_RADIUS,
        MAX_RADIUS,
      );
      next = fronts
        .map((front, index) => ({
          front,
          index,
          d: (front.pos[0] - x) ** 2 + (front.pos[1] - z) ** 2,
        }))
        .filter((e) => e.d < radius * radius)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_TEXT_SIGNS)
        .map(({ front, index }) => ({ front, index }));
    }

    const key = next.map((e) => e.index).join("|");
    if (key === signature.current) return;
    signature.current = key;
    setVisible(next);
  });

  return visible;
}
