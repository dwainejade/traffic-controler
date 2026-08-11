import * as THREE from 'three'

/** Deterministic RNG so procedural scatter is identical on every load. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Rounded rectangle in the XY plane, centred on the origin. Rotate -90° on X to lay it flat. */
export function roundedRectShape(hx: number, hz: number, r: number): THREE.Shape {
  const radius = Math.min(r, hx, hz)
  const s = new THREE.Shape()
  s.moveTo(-hx + radius, -hz)
  s.lineTo(hx - radius, -hz)
  s.quadraticCurveTo(hx, -hz, hx, -hz + radius)
  s.lineTo(hx, hz - radius)
  s.quadraticCurveTo(hx, hz, hx - radius, hz)
  s.lineTo(-hx + radius, hz)
  s.quadraticCurveTo(-hx, hz, -hx, hz - radius)
  s.lineTo(-hx, -hz + radius)
  s.quadraticCurveTo(-hx, -hz, -hx + radius, -hz)
  return s
}

/** Flat ground-plane geometry from a rounded rect, already laid out in XZ. */
export function flatRoundedRect(hx: number, hz: number, r: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(roundedRectShape(hx, hz, r), 8)
  g.rotateX(-Math.PI / 2)
  return g
}

/**
 * A unit building box (1x1x1, sitting on y=0) carrying a baked vertical
 * lightness gradient in vertex colors — dark at the base, light at the top.
 * That gradient is most of the Apple Maps look and costs nothing at runtime.
 *
 * The top face is pushed brighter still, which is what the reference's
 * hemisphere lighting does to every roof.
 */
export function buildingGeometry(bevel = 0.04): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1).toNonIndexed()
  g.translate(0, 0.5, 0)

  const pos = g.attributes.position as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const nx = Math.abs(pos.getX(i))
    const nz = Math.abs(pos.getZ(i))

    // Chamfer the top edge so it catches light instead of reading as a hard cut.
    if (y > 0.999) {
      if (nx > 0.499) pos.setX(i, pos.getX(i) * (1 - bevel * 2))
      if (nz > 0.499) pos.setZ(i, pos.getZ(i) * (1 - bevel * 2))
    }

    const isTop = y > 0.95
    // 0.78 at the base -> 1.0 at the top, with roofs brighter again.
    const shade = isTop ? 1.14 : 0.78 + 0.22 * y
    c.setScalar(shade)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  pos.needsUpdate = true
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  return g
}

/**
 * Flat ground-plane geometry from a world-space [x, z] polygon loop. The shape
 * is built in XY and laid flat with rotateX(-90°), which maps shape (x, y) to
 * world (x, -y) — hence the negated z. Mesh position should be [0, y, 0]; the
 * vertices already carry the world offsets.
 */
export function flatPolygon(points: [number, number][]): THREE.BufferGeometry {
  const s = new THREE.Shape()
  s.moveTo(points[0][0], -points[0][1])
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], -points[i][1])
  s.closePath()
  const g = new THREE.ShapeGeometry(s)
  g.rotateX(-Math.PI / 2)
  return g
}

/** Rect overlap test used to keep scatter out of road corridors and other blocks. */
export function rectsOverlap(
  ax: number, az: number, ahx: number, ahz: number,
  bx: number, bz: number, bhx: number, bhz: number,
): boolean {
  return Math.abs(ax - bx) < ahx + bhx && Math.abs(az - bz) < ahz + bhz
}
