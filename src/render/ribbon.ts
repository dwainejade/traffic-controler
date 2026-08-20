import * as THREE from 'three'
import type { Lane, LaneId, Network } from '../sim/network'

/**
 * A flat strip of constant width following a polyline.
 *
 * `RoadNetwork` grows its own ribbons because a carriageway has kerbs, decks
 * and per-road width to carry. This is the plain version: one width, one
 * height, no ends — which is what a drawn transit line is, and what a route
 * preview needs to be able to rebuild every time the pointer moves.
 */
export function ribbonGeometry(
  points: { x: number; z: number }[],
  y: number,
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry()
  if (points.length < 2) return geom

  const position = new Float32Array(points.length * 6)
  /**
   * Which way, and how far, each vertex is pushed off the centreline — the unit
   * normal, signed. The width itself is a uniform applied in the shader.
   *
   * Baking the width into the vertices instead is the obvious version and does
   * not work here. A drawn line is a diagram over the city, not paint on the
   * road, so it has to stay the same thickness on screen at every zoom: at a
   * fixed five metres it is a bold corridor at street level and invisible at
   * the framing a 5km map opens on, which is the framing the player plans a
   * route at. Rebuilding the geometry on every wheel tick would cost a few
   * thousand vertices per route per frame of a gesture; a uniform costs nothing.
   */
  const side = new Float32Array(points.length * 4)
  const index: number[] = []

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]

    let dx = next.x - prev.x
    let dz = next.z - prev.z
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len

    /*
     * The normal, not a mitre. A mitred join is correct and, at a corner as
     * tight as a bus turning left at a junction, produces a spike several times
     * the line's width — the joint sticks out past the building on the corner.
     * Sampling the lane densely enough that the fan of un-mitred quads closes
     * visually is both cheaper and better behaved.
     */
    const nx = -dz
    const nz = dx

    const at = i * 6
    position[at] = points[i].x
    position[at + 1] = y
    position[at + 2] = points[i].z
    position[at + 3] = points[i].x
    position[at + 4] = y
    position[at + 5] = points[i].z

    const s = i * 4
    side[s] = nx
    side[s + 1] = nz
    side[s + 2] = -nx
    side[s + 3] = -nz

    if (i > 0) {
      const a = (i - 1) * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  geom.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geom.setAttribute('aSide', new THREE.BufferAttribute(side, 2))
  geom.setIndex(index)
  geom.computeBoundingSphere()
  return geom
}

/**
 * The material a ribbon is drawn with: flat colour, width set per frame.
 *
 * Unlit on purpose. A line is a diagram drawn over the city, and shading it
 * would make it dip into shadow under the buildings it passes — which is
 * exactly where the player most needs to follow it.
 */
export function ribbonMaterial(colour: string, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHalf: { value: 2 },
      uColor: { value: new THREE.Color(colour) },
      uOpacity: { value: opacity },
    },
    vertexShader: `
      attribute vec2 aSide;
      uniform float uHalf;
      void main() {
        vec3 p = position + vec3(aSide.x, 0.0, aSide.y) * uHalf;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() { gl_FragColor = vec4(uColor, uOpacity); }
    `,
    transparent: true,
    depthWrite: false,
    /*
     * Double-sided, and not as a precaution.
     *
     * The strip is built by walking the centreline and emitting a left and a
     * right vertex at each point, so which way its triangles wind depends on
     * which way the street happens to run — a line drawn north-to-south faces
     * up and one drawn south-to-north faces down. Single-sided, half of every
     * route is culled and the other half looks like a rendering bug. Winding
     * the quads consistently would mean knowing a facing the geometry does not
     * have; the plane is flat and has no back worth hiding.
     */
    side: THREE.DoubleSide,
  })
}

/**
 * Half-width, in metres, that draws a line `pixels` wide on screen.
 *
 * Clamped at both ends: a floor so a line stays visible when the whole borough
 * is in frame, and a ceiling so it does not swell into a coloured field when
 * the camera comes down to the street. Between them it is genuinely constant,
 * which is what makes following a line across the map possible.
 */
export function halfWidthFor(
  viewRadius: number,
  screenHeight: number,
  pixels: number,
  min: number,
  max: number,
): number {
  const metresPerPixel = (viewRadius * 2) / Math.max(screenHeight, 1)
  return Math.min(max, Math.max(min, (metresPerPixel * pixels) / 2))
}

/**
 * The centre of a chain of lanes as one polyline.
 *
 * Lanes already carry their flattened points, so this is a concatenation with
 * the duplicate join vertices dropped — a connector's first point is the road
 * lane's last, and leaving both in puts a zero-length segment at every junction
 * where the ribbon's normal is undefined.
 */
export function chainPolyline(net: Network, lanes: LaneId[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []

  for (const id of lanes) {
    const lane: Lane = net.lanes[id]
    for (let i = 0; i < lane.pts.length; i += 2) {
      const x = lane.pts[i]
      const z = lane.pts[i + 1]
      const last = out[out.length - 1]
      if (last && Math.hypot(last.x - x, last.z - z) < 0.05) continue
      out.push({ x, z })
    }
  }

  return out
}
