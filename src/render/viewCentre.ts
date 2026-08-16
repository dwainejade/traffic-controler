import * as THREE from "three";

/**
 * The ground point the map is currently centred on, kept up to date by whichever
 * camera owns the view.
 *
 * It exists for the handover into walk mode, which needs to put you where you
 * were looking and cannot ask the previous camera itself: turning walk mode on
 * can also turn the perspective camera on, and that swap remounts the camera at
 * the level's default framing with the pan already thrown away. By the time the
 * walker's first effect runs, the evidence is gone — so it is written down each
 * frame while it is still true.
 */
export const viewCentre = {
  point: new THREE.Vector3(),
  /** False until some camera has actually written a point. */
  known: false,
};

export function setViewCentre(x: number, z: number): void {
  viewCentre.point.set(x, 0, z);
  viewCentre.known = true;
}

/** Slack over the half-diagonal, for the tilt and for being wrong. */
const TILT_MARGIN = 1.3;

/**
 * Radius of ground the camera can currently see, near enough.
 *
 * Two things size themselves off this and they want opposite kinds of error, so
 * it is deliberately an over-estimate and both cope: the simulated region would
 * rather run a little more network than delete a car somebody can see, and the
 * shadow camera would rather waste a little of its map than end its shadows in
 * a visible straight line across the street.
 *
 * The margin covers the 55° tilt, which lands a circle on screen as an ellipse
 * stretched along the view direction.
 */
export function viewRadius(
  camera: THREE.Camera,
  width: number,
  height: number,
): number {
  if (camera instanceof THREE.OrthographicCamera) {
    const halfW = width / 2 / camera.zoom;
    const halfH = height / 2 / camera.zoom;
    return Math.hypot(halfW, halfH) * TILT_MARGIN;
  }

  if (camera instanceof THREE.PerspectiveCamera) {
    /*
     * How much a perspective camera sees is how far away it is, so measure that
     * against the point it is looking at rather than inferring it from height.
     * That works for the orbiting camera and the walker alike: orbiting, the
     * distance is hundreds of metres; standing in the street it is a few.
     */
    const distance = Math.max(camera.position.distanceTo(viewCentre.point), 1);
    const halfH = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const halfW = halfH * (width / Math.max(height, 1));
    return Math.hypot(halfW, halfH) * TILT_MARGIN;
  }

  return 0;
}
