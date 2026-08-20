import { mulberry32 } from './geometry'
import type { BuildingInst } from './scatter'
import type { BuildingFootprint, LevelDef } from '../sim/types'

/**
 * Which buildings are the places people are going.
 *
 * Picked in the renderer, not the simulation, because a destination has to be a
 * building you can *see*: the whole read of the game is a coloured building
 * across the map and a knot of matching pedestrians on a corner, and that only
 * works if the thing the sim routes people to and the thing the renderer paints
 * are the same object. Which buildings exist is the scatter's business, so this
 * is where the choice belongs.
 *
 * Chosen for separation rather than at random. Six destinations clustered in
 * one district give the player one route to draw and nothing to weigh; six
 * spread across the map are six competing pulls, which is the decision.
 */

export type DestinationSite = {
  x: number
  z: number
  /** Index into whichever building list is being drawn. */
  building: number
  /** Roughly how big the building is, so the marker above it can be scaled. */
  size: number
  /** Height to the roof, for the marker. */
  height: number
}

/** Centroid and rough radius of a surveyed outline. */
function footprintCentre(f: BuildingFootprint): { x: number; z: number; size: number } {
  let x = 0
  let z = 0
  for (const [px, pz] of f.polygon) {
    x += px
    z += pz
  }
  x /= f.polygon.length
  z /= f.polygon.length

  let size = 0
  for (const [px, pz] of f.polygon) size = Math.max(size, Math.hypot(px - x, pz - z))
  return { x, z, size }
}

/**
 * @param count How many destinations to pick.
 *
 * The candidate pool is filtered to buildings big enough to read as a
 * destination from the map's default zoom. A coloured garden shed is a coloured
 * pixel, and the player would never find it.
 */
export function pickDestinations(
  level: LevelDef,
  buildings: BuildingInst[],
  count = 6,
): DestinationSite[] {
  const candidates: DestinationSite[] = []

  if (level.footprints?.length) {
    level.footprints.forEach((f, i) => {
      if (f.polygon.length < 3) return
      const c = footprintCentre(f)
      if (c.size < 9) return
      candidates.push({ x: c.x, z: c.z, building: i, size: c.size, height: f.height })
    })
  } else {
    buildings.forEach((b, i) => {
      const size = Math.max(b.w, b.d) / 2
      if (size < 7) return
      candidates.push({ x: b.x, z: b.z, building: i, size, height: b.h })
    })
  }

  if (candidates.length === 0) return []

  /*
   * Farthest-point sampling, seeded from the biggest building near the middle.
   *
   * The first destination is the downtown core — `Transit` gives it the heaviest
   * attraction weight — so it should be the largest thing centrally placed, and
   * every one after it should be as far from all the ones already chosen as the
   * map allows. That produces a set that covers the city instead of one that
   * describes wherever the scatter happened to put its tall buildings.
   */
  const rand = mulberry32(level.seed ^ 0xd35)

  let seed = candidates[0]
  let bestScore = -Infinity
  for (const c of candidates) {
    const fromCentre = Math.hypot(c.x, c.z)
    const score = c.size * 3 + c.height - fromCentre / 40
    if (score > bestScore) {
      bestScore = score
      seed = c
    }
  }

  const chosen: DestinationSite[] = [seed]
  const pool = candidates.filter((c) => c !== seed)

  while (chosen.length < count && pool.length > 0) {
    let bestAt = 0
    let best = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      let nearest = Infinity
      for (const picked of chosen) {
        nearest = Math.min(nearest, Math.hypot(c.x - picked.x, c.z - picked.z))
      }
      // Distance decides; size and a little noise break the ties, which on a
      // regular grid are otherwise resolved by array order and put every
      // destination along one edge.
      const score = nearest + c.size * 2 + rand() * 40
      if (score > best) {
        best = score
        bestAt = i
      }
    }
    chosen.push(pool.splice(bestAt, 1)[0])
  }

  return chosen
}
