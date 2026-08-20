import { useEffect } from 'react'
import { sampleHomes, Transit } from '../sim/transit'
import type { LevelDef } from '../sim/types'
import type { World } from '../sim/world'
import type { DestinationSite } from './destinations'
import { bindTransit, useTransit } from '../ui/transitStore'

/**
 * Attach a transit layer to a world, and keep it attached for that world's life.
 *
 * One layer per world, cached, because the routes the player has drawn are the
 * only thing in this game they cannot get back — remounting the scene, toggling
 * a map layer or switching camera mode must not cost them their network.
 */
const layers = new WeakMap<World, Transit>()

export function useTransitLayer(
  world: World,
  level: LevelDef,
  destinations: DestinationSite[],
): void {
  const enabled = useTransit((s) => s.enabled)

  useEffect(() => {
    if (!enabled) {
      world.transit = null
      world.ambientBuses = true
      bindTransit(null)
      return
    }

    let layer = layers.get(world)
    if (!layer) {
      layer = new Transit(world.transitHost(), level.seed)
      layers.set(world, layer)
    }

    layer.setDestinations(destinations)
    /*
     * Homes are re-sampled whenever the destinations move, because the
     * residential gradient is defined *against* them: the far corners of the
     * map are where people live precisely because that is where the jobs are
     * not. Sampling them once and keeping them would leave the gradient
     * pointing at wherever the first level's downtown happened to be.
     */
    layer.setHomes(
      sampleHomes(world.net, level.nodes, destinations, 260, level.seed),
    )
    // Demand scales with the city. A five-block import and a whole borough
    // should both open at a service load proportional to how much of them
    // there is to serve, not at one number tuned on whichever was tested.
    layer.demand = Math.max(0.3, Math.min(6, level.nodes.length / 90))

    world.transit = layer
    // The scripted bus service is switched off: an unowned bus running the OSM
    // bus lanes beside the player's own line is indistinguishable from a bug in
    // their line.
    world.ambientBuses = false
    bindTransit(layer)

    return () => {
      world.transit = null
      world.ambientBuses = true
    }
  }, [enabled, world, level, destinations])
}
