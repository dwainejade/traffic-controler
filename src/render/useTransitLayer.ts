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
    /*
     * Demand scales with the city, and is set by how much of it has to be
     * *visible*, not by a guess at realism.
     *
     * It was `nodes / 90`, which on a nineteen-junction import is one trip
     * every two and a half seconds — spread over a borough and a ten-minute
     * journey, that is a map with nobody on it. A stop has to grow a crowd
     * within a minute of being watched or none of the colour-coding means
     * anything, and that sets the floor.
     */
    const junctions = level.nodes.filter((n) => n.kind === 'junction').length
    layer.demand = Math.max(1.2, Math.min(8, junctions / 8))

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
