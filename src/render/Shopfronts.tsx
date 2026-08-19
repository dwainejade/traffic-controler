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
 * An awning over the street-facing wall, the way a real parade of shops is
 * signed: a band of colour at first-floor height, carried on a canopy that
 * slopes out from the wall. From the model view that reads as what a
 * shopping street actually looks like from above — a run of colour along
 * one side of the block and nothing along the next — and from the pavement
 * it reads as the shops themselves. A corner building gets one awning per
 * street it actually fronts, not one for the whole block.
 *
 * The name goes on the canopy's top, the roomiest surface an awning has, and
 * wraps to a second line rather than squeezing down to nothing when it is
 * long. The valance — the flap at the leading edge — carries the shorter,
 * plainer word for what the place is: BAKERY, not the bakery's name twice.
 * Both are painted on the awning itself, never floated above it as a map
 * pin: a name hovering off the building reads as an annotation of the map
 * rather than as part of the street.
 *
 * The canopies, valances and side panels are cheap and always drawn. The
 * names cost a mesh each, so they are built for the fronts near what the
 * player is looking at, and stop entirely once they would be too small on
 * screen to make out — which on a whole-city view is all of them.
 */

/** Metres. */
const VALANCE_HEIGHT = 0.9;
const VALANCE_DEPTH = 0.18;

/** How far the canopy reaches out from the wall, and how much it drops doing it. */
const CANOPY_PROJECTION = 1.1;
const CANOPY_DROP = 0.5;
const CANOPY_THICKNESS = 0.06;
/** The canopy top's pitch below horizontal, forward and down toward the street. */
const CANOPY_PITCH = Math.atan2(CANOPY_DROP, CANOPY_PROJECTION);

/**
 * Cap heights for the two labels an awning carries.
 *
 * The name gets the canopy top, the roomiest surface there is, so it is
 * lettered bigger than the valance ever had room for. The category is a
 * single short word and only needs to hold its own against the valance's
 * height, not fill it.
 */
const NAME_TEXT_SIZE = 0.7;
const CATEGORY_TEXT_SIZE = 0.36;
const TEXT_MARGIN = 0.5;

/**
 * The single-line squeeze below which a name is wrapped to two lines instead.
 *
 * Below this the letters are packing in tighter than they read comfortably
 * from the model view — better to give a long name the canopy's height in a
 * second line than to keep shrinking it toward illegibility.
 */
const TWO_LINE_BELOW = 0.62;

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

/** Unit valance shared by every front; the instance matrix stretches it to each wall. */
const VALANCE_GEOM = new THREE.BoxGeometry(1, VALANCE_HEIGHT, VALANCE_DEPTH);

/**
 * Unit canopy shared by every front, baked once into its sloped shape so the
 * per-instance transform is the same plain yaw-and-stretch as the valance.
 *
 * Built as a box and then tipped: rotating a box about its width axis and
 * sliding it back into place turns the flat top and bottom into the sloped
 * roof and underside of a canopy, wall-high at the back (local Z 0) and
 * valance-high at the front (local Z CANOPY_PROJECTION) — no per-instance
 * pitch needed.
 */
const CANOPY_GEOM = new THREE.BoxGeometry(
  1,
  CANOPY_THICKNESS,
  Math.hypot(CANOPY_PROJECTION, CANOPY_DROP),
)
  .rotateX(CANOPY_PITCH)
  .translate(0, CANOPY_DROP / 2, CANOPY_PROJECTION / 2);

/**
 * The two quadrilaterals that close the ends of the canopy, so an awning
 * reads as a solid wedge from the side instead of a roof floating clear of
 * its own valance. Each runs the whole height of the awning at the wall —
 * from the roofline down to the valance's foot — out to the same at the
 * valance, in the same local frame the canopy uses, so it takes the
 * identical instance transform.
 */
const SIDE_GEOM = (() => {
  // [Y, Z]: roofline at the wall, roofline at the valance, valance's foot —
  // at the wall and again out at the valance.
  const wallTop: [number, number] = [CANOPY_DROP, 0];
  const frontTop: [number, number] = [0, CANOPY_PROJECTION];
  const frontFoot: [number, number] = [-VALANCE_HEIGHT, CANOPY_PROJECTION];
  const wallFoot: [number, number] = [-VALANCE_HEIGHT, 0];

  // Fan-triangulated from wallTop, wound so the cross product faces outward
  // on each side — away from the awning's centreline, the way the roof and
  // valance faces already do.
  const positions = new Float32Array([
    0.5, wallTop[0], wallTop[1],
    0.5, frontTop[0], frontTop[1],
    0.5, frontFoot[0], frontFoot[1],

    0.5, wallTop[0], wallTop[1],
    0.5, frontFoot[0], frontFoot[1],
    0.5, wallFoot[0], wallFoot[1],

    -0.5, wallTop[0], wallTop[1],
    -0.5, frontFoot[0], frontFoot[1],
    -0.5, frontTop[0], frontTop[1],

    -0.5, wallTop[0], wallTop[1],
    -0.5, wallFoot[0], wallFoot[1],
    -0.5, frontFoot[0], frontFoot[1],
  ]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
})();

/**
 * How much a label has to be squeezed to fit the given width.
 *
 * `maxWidth` would wrap it instead, and a wrapped single-line label stands
 * taller than the band it is on. Cap height times this is about the average
 * advance of a mixed-case latin word, which is close enough to leave a
 * sensible margin.
 */
const AVERAGE_ADVANCE = 0.52;

function fitText(text: string, width: number, textSize: number): number {
  const wanted = text.length * textSize * AVERAGE_ADVANCE;
  const room = Math.max(1, width - TEXT_MARGIN);
  return Math.min(1, room / wanted);
}

/** Splits a name near its middle, on a word boundary, for a two-line roof label. */
function splitTwoLines(name: string): [string, string] {
  const words = name.split(" ");
  if (words.length < 2) return [name, ""];

  let bestSplit = 1;
  let bestGap = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length;
    const b = words.slice(i).join(" ").length;
    const gap = Math.abs(a - b);
    if (gap < bestGap) {
      bestGap = gap;
      bestSplit = i;
    }
  }
  return [words.slice(0, bestSplit).join(" "), words.slice(bestSplit).join(" ")];
}

/** The name as it goes on the canopy top: one line, or two if it needs the room. */
function roofLabel(front: Shopfront): { text: string; scale: number } {
  const single = fitText(front.name, front.width, NAME_TEXT_SIZE);
  if (single >= TWO_LINE_BELOW || !front.name.includes(" ")) {
    return { text: front.name, scale: single };
  }

  const [a, b] = splitTwoLines(front.name);
  const longer = Math.max(a.length, b.length || a.length);
  const wanted = longer * NAME_TEXT_SIZE * AVERAGE_ADVANCE;
  const room = Math.max(1, front.width - TEXT_MARGIN);
  return { text: `${a}\n${b}`, scale: Math.min(1, room / wanted) };
}

/** The business type as it goes on the valance: short, plain, shouted. */
function categoryLabel(category: string): string {
  return category.replace(/_/g, " ").toUpperCase();
}

/** Which way an awning's face points, for standing the text just proud of it. */
function faceNormal(angle: number): { x: number; z: number } {
  return { x: Math.sin(angle), z: Math.cos(angle) };
}

export function Shopfronts({ fronts }: { fronts: Shopfront[] }) {
  const canopies = useRef<THREE.InstancedMesh>(null);
  const sides = useRef<THREE.InstancedMesh>(null);
  const valances = useRef<THREE.InstancedMesh>(null);

  const colours = useMemo(
    () => fronts.map((f) => signColours(f.brand, f.category)),
    [fronts],
  );

  useLayoutEffect(() => {
    const canopyMesh = canopies.current;
    const sideMesh = sides.current;
    const valanceMesh = valances.current;
    if (!canopyMesh || !sideMesh || !valanceMesh) return;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();

    fronts.forEach((front, i) => {
      q.setFromAxisAngle(up, front.angle);
      const n = faceNormal(front.angle);
      colour.set(colours[i].board);

      // The canopy's own geometry already carries the slope out from the
      // wall, so its instance transform is just the wall anchor, the yaw,
      // and the width stretch — no depth offset to add.
      m.compose(
        new THREE.Vector3(front.pos[0], front.y + VALANCE_HEIGHT / 2, front.pos[1]),
        q,
        new THREE.Vector3(front.width, 1, 1),
      );
      canopyMesh.setMatrixAt(i, m);
      canopyMesh.setColorAt(i, colour);
      // The side panels sit in the same local frame as the canopy — same
      // wall anchor, yaw, and width stretch — so they take its matrix as-is.
      sideMesh.setMatrixAt(i, m);
      sideMesh.setColorAt(i, colour);

      m.compose(
        /*
         * Out past the canopy's leading edge, not flush with the wall: an
         * awning's valance hangs at the front of the roof, not against the
         * facade it is mounted to. The anchor is the midpoint of the outline
         * edge, and the building is extruded from that same outline — so a
         * valance centred on it would be half inside the wall.
         */
        new THREE.Vector3(
          front.pos[0] + n.x * (CANOPY_PROJECTION + VALANCE_DEPTH / 2),
          front.y,
          front.pos[1] + n.z * (CANOPY_PROJECTION + VALANCE_DEPTH / 2),
        ),
        q,
        new THREE.Vector3(front.width, 1, 1),
      );
      valanceMesh.setMatrixAt(i, m);
      valanceMesh.setColorAt(i, colour);
    });

    // Written after construction, so the identity-at-the-origin bounding sphere
    // has to go or the whole street is culled the moment you look away.
    canopyMesh.instanceMatrix.needsUpdate = true;
    sideMesh.instanceMatrix.needsUpdate = true;
    valanceMesh.instanceMatrix.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    if (sideMesh.instanceColor) sideMesh.instanceColor.needsUpdate = true;
    if (valanceMesh.instanceColor) valanceMesh.instanceColor.needsUpdate = true;
    canopyMesh.computeBoundingSphere();
    sideMesh.computeBoundingSphere();
    valanceMesh.computeBoundingSphere();
  }, [fronts, colours]);

  const height = useThree((s) => s.size.height);
  const lettered = useNearbyFronts(fronts, height);

  if (fronts.length === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={canopies}
        args={[CANOPY_GEOM, undefined, fronts.length]}
        castShadow
      >
        <meshLambertMaterial />
      </instancedMesh>

      <instancedMesh
        ref={sides}
        args={[SIDE_GEOM, undefined, fronts.length]}
        castShadow
      >
        <meshLambertMaterial side={THREE.DoubleSide} />
      </instancedMesh>

      <instancedMesh
        ref={valances}
        args={[VALANCE_GEOM, undefined, fronts.length]}
        castShadow
      >
        <meshLambertMaterial />
      </instancedMesh>

      {lettered.map(({ front, index }) => {
        const n = faceNormal(front.angle);
        const colour = signColours(front.brand, front.category);
        const roof = roofLabel(front);

        // The roof midpoint in the canopy's own local frame, nudged a hair
        // off the surface along its own normal — belt to `depthOffset`'s
        // braces, since a world-space nudge this small can still lose to
        // depth-buffer precision at range while the two stay coplanar-ish.
        const eps = 0.05;
        const roofOut = CANOPY_PROJECTION / 2 + eps * Math.sin(CANOPY_PITCH);
        const roofUp =
          front.y + VALANCE_HEIGHT / 2 + CANOPY_DROP / 2 + eps * Math.cos(CANOPY_PITCH);

        return (
          <group key={index}>
            <Text
              position={[
                front.pos[0] + n.x * roofOut,
                roofUp,
                front.pos[1] + n.z * roofOut,
              ]}
              // Tipped flat onto the sloped roof (about the awning's own
              // width axis) and then turned to face out along the wall,
              // same as the roof panel itself — pitch first, then yaw.
              rotation={[CANOPY_PITCH - Math.PI / 2, front.angle, 0, "YXZ"]}
              fontSize={NAME_TEXT_SIZE}
              maxWidth={Math.max(1, front.width - TEXT_MARGIN)}
              textAlign="center"
              scale={[roof.scale, 1, 1]}
              letterSpacing={0.02}
              color={colour.ink}
              anchorX="center"
              anchorY="middle"
              depthOffset={-1}
            >
              {roof.text}
            </Text>

            <Text
              position={[
                front.pos[0] + n.x * (CANOPY_PROJECTION + VALANCE_DEPTH + 0.01),
                front.y,
                front.pos[1] + n.z * (CANOPY_PROJECTION + VALANCE_DEPTH + 0.01),
              ]}
              rotation={[0, front.angle, 0]}
              fontSize={CATEGORY_TEXT_SIZE}
              maxWidth={Math.max(1, front.width - TEXT_MARGIN)}
              whiteSpace="nowrap"
              scale={[
                fitText(categoryLabel(front.category), front.width, CATEGORY_TEXT_SIZE),
                1,
                1,
              ]}
              letterSpacing={0.06}
              color={colour.ink}
              anchorX="center"
              anchorY="middle"
              depthOffset={-1}
            >
              {categoryLabel(front.category)}
            </Text>
          </group>
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
    if (pixelsPerMetre > 0 && NAME_TEXT_SIZE * pixelsPerMetre >= MIN_TEXT_PIXELS) {
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
