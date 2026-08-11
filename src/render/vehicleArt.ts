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
 * chips.
 *
 * A *unit* box, scaled per instance by the vehicle's spec. Baking a car's
 * dimensions into the geometry would need one instanced mesh per kind — three
 * draw calls, three transform loops, three budgets to size — where scaling gets
 * cars, trucks and buses out of a single call.
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
