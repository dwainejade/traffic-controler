import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { PALETTE } from "../art/palette";
import type { LevelDef } from "../sim/types";
import { roundedRectShape } from "./geometry";
import { LAYER } from "./layers";

const CARD_THICKNESS = 2.5;

/**
 * An [x, z] loop as a THREE.Shape. The flat-laying rotation used on every
 * ground mesh maps shape (x, y) -> world (x, -y), so z is negated going in.
 */
function outlineShape(poly: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(poly[0][0], -poly[0][1]);
  for (const [x, z] of poly.slice(1)) s.lineTo(x, -z);
  s.closePath();
  return s;
}

/**
 * The level sits as a physical card on a plain backdrop — that's what makes it
 * read as a model rather than a cropped-out piece of a world. The card is
 * genuinely extruded so the key light drops a real soft shadow beneath it.
 */
/**
 * Real water bodies surveyed from OSM, merged into one geometry.
 *
 * Unlike the single enclosing `level.water` loop, an imported area can carry
 * any number of disconnected features — a river edge clipped by the box, a
 * pond, a pier basin — so this is drawn the way `Parks` draws zones: one
 * shape per polygon, concatenated into a single draw call rather than a mesh
 * apiece.
 */
function buildWaterGeometry(
  bodies: [number, number][][],
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const poly of bodies) {
    try {
      parts.push(new THREE.ShapeGeometry(outlineShape(poly)).toNonIndexed());
    } catch {
      // A self-intersecting ring defeats triangulation; skip rather than fail
      // the whole map over one bad survey.
      continue;
    }
  }

  const merged = new THREE.BufferGeometry();
  if (parts.length === 0) return merged;

  let vertices = 0;
  for (const g of parts) vertices += g.getAttribute("position").count;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);

  let offset = 0;
  for (const g of parts) {
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const o = (offset + i) * 3;
      position[o] = p.getX(i);
      position[o + 1] = p.getY(i);
      position[o + 2] = p.getZ(i);
      normal[o + 1] = 1;
    }
    offset += p.count;
    g.dispose();
  }

  merged.setAttribute("position", new THREE.BufferAttribute(position, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  merged.computeBoundingSphere();
  return merged;
}

export function Ground({ level }: { level: LevelDef }) {
  const waterGeom = useMemo(
    () => buildWaterGeometry(level.waterBodies ?? []),
    [level.waterBodies],
  );
  useEffect(() => () => waterGeom.dispose(), [waterGeom]);

  const card = useMemo(() => {
    /*
     * The landmass. An island is extruded from its own shoreline, so the water
     * cuts the city to a shape the street grid never chose — which is most of
     * what makes it read as a real place seen from above. Without one, the
     * level is the original rounded card.
     */
    const shapes = level.island
      ? [outlineShape(level.island)]
      : [roundedRectShape(level.half, level.half, 10)];

    const g = new THREE.ExtrudeGeometry(shapes, {
      depth: CARD_THICKNESS,
      bevelEnabled: false,
      curveSegments: 8,
    });
    // Lay flat. rotateX(-90°) maps (x,y,z) -> (x,z,-y), so the extrusion runs
    // *up* from y=0; shift it down so the card's top surface sits exactly at y=0
    // and everything drawn on the ground plane stays above it.
    g.rotateX(-Math.PI / 2);
    g.translate(0, -CARD_THICKNESS, 0);
    return g;
  }, [level.half, level.island]);

  return (
    <group>
      {/*
        Backdrop. On an island this is the far bank — the land on the other side
        of both rivers — so the water is a shape laid on top of it rather than
        the other way round. It is also the plane the island casts its shadow
        onto, which is what gives the shore any thickness.
      */}
      <mesh
        position={[0, -CARD_THICKNESS - 0.06, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[9000, 9000]} />
        <meshLambertMaterial
          color={level.island ? PALETTE.ground : PALETTE.background}
        />
      </mesh>

      {/* The rivers, hugging the shore at a near-constant width. */}
      {level.water && (
        <mesh
          position={[0, -CARD_THICKNESS - 0.04, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <shapeGeometry args={[outlineShape(level.water)]} />
          <meshLambertMaterial color={PALETTE.water} />
        </mesh>
      )}

      <mesh geometry={card} castShadow receiveShadow>
        <meshLambertMaterial color={PALETTE.ground} />
      </mesh>

      {/*
        Real water surveyed from OSM — rivers, ponds, a waterfront clipped by
        the import box. Painted on top of the card, the way `Parks` paints
        zones, rather than cut beneath it like `level.water`: there is no
        island shape to cut around here, just a patch of the ground that is
        wet.
      */}
      {level.waterBodies && level.waterBodies.length > 0 && (
        <mesh
          geometry={waterGeom}
          position={[0, LAYER.water, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          {/*
            No `receiveShadow`: open water is one huge near-flat plane, and at
            a low sun angle a plane that size aliases against the shadow map's
            fixed resolution into visible banding across it — the same bias
            tuned for the relief in roads and buildings does not hold up over
            hundreds of metres of dead-flat mesh. Nothing above the water is
            expected to shadow it in this style anyway.
          */}
          <meshLambertMaterial color={PALETTE.water} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
