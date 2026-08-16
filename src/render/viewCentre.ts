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
