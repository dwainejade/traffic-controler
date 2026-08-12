import { useEffect, useSyncExternalStore } from 'react'
import type * as THREE from 'three'

/**
 * The register of things allowed to bloom.
 *
 * Bloom on this map cannot be a brightness threshold, which is the usual way to
 * pick what glows. The palette is a high-key one — the ground is `#F0EEEA` and
 * the buildings are near-white — so every surface on the map is *brighter* than
 * a signal lens: green `#3DDB6B` sits at about 0.70 luminance against a
 * building's 0.93. Any threshold that caught a green light would have already
 * set the entire city on fire, and any threshold that spared the city would
 * never reach a signal.
 *
 * So the bloom is selective, and what glows is a property of the object rather
 * than of its colour: lamps, lenses, headlights, indicators — the things that
 * are actually emitting — put themselves on this list, and `PostFX` hands the
 * list to the effect. Everything else is lit, not luminous, and stays crisp.
 */

const glowing = new Set<THREE.Object3D>()
const listeners = new Set<() => void>()

/**
 * Rebuilt on every change and reused between them: `useSyncExternalStore`
 * compares snapshots by identity and would loop forever on a fresh array.
 */
let snapshot: THREE.Object3D[] = []

function publish(): void {
  snapshot = [...glowing]
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Mark a mesh as a light source for as long as it is mounted.
 *
 * Takes a ref rather than an object because every caller is an instanced mesh
 * whose ref is null on the first render — registering happens in an effect,
 * once three has actually built the thing.
 */
export function useGlow(ref: React.RefObject<THREE.Object3D | null>, enabled = true): void {
  useEffect(() => {
    const object = ref.current
    if (!object || !enabled) return
    glowing.add(object)
    publish()
    return () => {
      glowing.delete(object)
      publish()
    }
  }, [ref, enabled])
}

/** Every registered source, for the bloom pass to select on. */
export function useGlowing(): THREE.Object3D[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}
