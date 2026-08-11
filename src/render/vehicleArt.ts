/**
 * Geometry and textures shared by everything with wheels.
 *
 * Moving traffic and parked traffic are drawn by different components on
 * different schedules, but they are the same object and must look identical —
 * a parked car with its own slightly different box or shadow would read as a
 * different kind of thing sitting at the kerb.
 */

import * as THREE from "three";

/**
 * Body box with a lighter roof, so vehicles read as objects rather than flat
 * chips. Used for buses, which really are box-shaped.
 *
 * A *unit* box, scaled per instance by the vehicle's spec. Baking a bus's
 * dimensions into the geometry would need one instanced mesh per kind — more
 * draw calls, more transform loops, more budgets to size — where scaling gets
 * it out of a single call.
 */
export function bodyGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  g.translate(0, 0.5, 0);

  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const shade = pos.getY(i) > 0.85 ? 1.16 : 0.88;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Drops whichever box face has the given normal, by triangle rather than by
 * index order — box faces are flat, so every vertex of a triangle shares one
 * normal, and this doesn't depend on the vertex order `BoxGeometry` happens to
 * emit internally.
 */
function dropFace(geom: THREE.BufferGeometry, normalY: number): THREE.BufferGeometry {
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const norm = geom.attributes.normal as THREE.BufferAttribute;
  const keptPos: number[] = [];
  const keptNorm: number[] = [];
  for (let tri = 0; tri < pos.count / 3; tri++) {
    const base = tri * 3;
    if (Math.abs(norm.getY(base) - normalY) < 0.01) continue;
    for (let v = 0; v < 3; v++) {
      const i = base + v;
      keptPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      keptNorm.push(norm.getX(i), norm.getY(i), norm.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(keptPos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(keptNorm, 3));
  return out;
}

/**
 * One box's worth of geometry plus a rule for shading its vertices, given the
 * vertex's unit-body position and face normal.
 */
type ShadedPart = {
  geom: THREE.BufferGeometry;
  shade: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
};

/**
 * Concatenates several boxes into one non-indexed `BufferGeometry` with baked
 * vertex colour — the shared plumbing behind both `carBodyGeometry` and
 * `truckBodyGeometry`. Still a single unit-scaled geometry, so a multi-box
 * vehicle costs one instanced mesh and one draw call, the same as the plain
 * box: it just has more triangles.
 *
 * Colour is a shade multiplied against the instance's paint colour, not an
 * independent hue — glass and roof caps are just driven far enough from 1.0
 * that they read as themselves under any paint colour.
 */
function mergeShaded(parts: ShadedPart[]): THREE.BufferGeometry {
  let total = 0;
  for (const part of parts) total += (part.geom.attributes.position as THREE.BufferAttribute).count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);

  let o = 0;
  for (const part of parts) {
    const p = part.geom.attributes.position as THREE.BufferAttribute;
    const n = part.geom.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++, o++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const nx = n.getX(i);
      const ny = n.getY(i);
      const nz = n.getZ(i);
      position[o * 3] = x;
      position[o * 3 + 1] = y;
      position[o * 3 + 2] = z;
      normal[o * 3] = nx;
      normal[o * 3 + 1] = ny;
      normal[o * 3 + 2] = nz;

      const shade = part.shade(x, y, z, nx, ny, nz);
      color[o * 3] = shade;
      color[o * 3 + 1] = shade;
      color[o * 3 + 2] = shade;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setAttribute("color", new THREE.BufferAttribute(color, 3));
  return g;
}

/** Where the cabin sits on a car, as fractions of the unit body. */
const CHASSIS_H = 0.56;
const CABIN_INSET = 0.08;
const CABIN_FRONT = 0.3;
const CABIN_REAR = 0.24;

/**
 * A car body with an actual cabin — a low chassis carrying a narrower, shorter
 * greenhouse set back slightly for a longer hood than trunk — rather than the
 * plain box everything else gets. The cabin's underside is dropped before
 * merging: it sits flush on the chassis roof at the same height, and a hidden
 * face left in would z-fight the panel under it.
 */
export function carBodyGeometry(): THREE.BufferGeometry {
  const chassis = new THREE.BoxGeometry(1, CHASSIS_H, 1).toNonIndexed();
  chassis.translate(0, CHASSIS_H / 2, 0);

  const cabinH = 1 - CHASSIS_H;
  const cabinRaw = new THREE.BoxGeometry(
    1 - CABIN_INSET * 2,
    cabinH,
    1 - CABIN_FRONT - CABIN_REAR,
  ).toNonIndexed();
  const cabin = dropFace(cabinRaw, -1);
  cabin.translate(0, CHASSIS_H + cabinH / 2, (CABIN_REAR - CABIN_FRONT) / 2);

  return mergeShaded([
    {
      geom: chassis,
      // Top-facing is the hood/trunk deck; the darker band along the bottom
      // is the rocker panel and bumpers.
      shade: (_x, y, _z, _nx, ny) => (ny > 0.5 ? 1.04 : y < CHASSIS_H * 0.2 ? 0.7 : 0.88),
    },
    {
      geom: cabin,
      // Top-facing is the roof cap; everything else is the greenhouse glass.
      shade: (_x, _y, _z, _nx, ny) => (ny > 0.5 ? 1.18 : 0.32),
    },
  ]);
}

/** Where the cab sits on a truck, as fractions of the unit body. */
const CAB_LENGTH = 0.14;
const CAB_HEIGHT = 0.62;
const CAB_WIDTH = 0.94;
/**
 * How far the cab is buried into the cargo box lengthwise. Without this their
 * adjoining faces sit in the same plane and z-fight under a moving camera;
 * burying the seam a few centimetres inside the box is cheaper than clipping
 * either face to the joint.
 */
const CAB_SEAM_OVERLAP = 0.01;

/**
 * A truck body with a cab up front, shorter and lower than the cargo box
 * behind it — a two-axle box truck's cab-over silhouette, not the flat wall a
 * plain box gives every vehicle the same treatment.
 */
export function truckBodyGeometry(): THREE.BufferGeometry {
  const boxLength = 1 - CAB_LENGTH;
  const cargo = new THREE.BoxGeometry(1, 1, boxLength).toNonIndexed();
  cargo.translate(0, 0.5, -CAB_LENGTH / 2);

  const cabLength = CAB_LENGTH + CAB_SEAM_OVERLAP;
  const cab = new THREE.BoxGeometry(CAB_WIDTH, CAB_HEIGHT, cabLength).toNonIndexed();
  cab.translate(0, CAB_HEIGHT / 2, 0.5 - cabLength / 2);

  return mergeShaded([
    {
      geom: cargo,
      shade: (_x, _y, _z, _nx, ny) => (ny > 0.5 ? 1.05 : 0.85),
    },
    {
      geom: cab,
      // Top-facing is the cab roof; the front face is the windshield, driven
      // dark to read as glass; sides and rear are bodywork.
      shade: (_x, _y, _z, _nx, ny, nz) => (ny > 0.5 ? 1.15 : nz > 0.5 ? 0.3 : 0.92),
    },
  ]);
}

/** Soft blob used as a fake contact shadow — far cheaper than shadow-mapping 200 cars. */
export function blobTexture(): THREE.Texture {
  return radialTexture([
    [0, "rgba(40,44,50,0.34)"],
    [0.55, "rgba(40,44,50,0.18)"],
    [1, "rgba(40,44,50,0)"],
  ]);
}

/**
 * The same falloff as the shadow blob but white, for the pool of light a car
 * throws on the road. It cannot share `blobTexture`: that one's RGB is the dark
 * grey of a shadow, and added to a night road it contributes essentially
 * nothing — a headlight has to bring its own light with it.
 */
export function glowTexture(): THREE.Texture {
  return radialTexture([
    [0, "rgba(255,255,255,0.6)"],
    [0.45, "rgba(255,255,255,0.2)"],
    [1, "rgba(255,255,255,0)"],
  ]);
}

function radialTexture(stops: [number, string][]): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  for (const [at, colour] of stops) grad.addColorStop(at, colour);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A flat unit quad on the ground plane, for shadows and light pools. */
export const UNIT_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
