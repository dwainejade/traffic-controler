import { mulberry32 } from "../render/geometry";
import { reversePoly, roadCentreline, type Pt } from "../sim/centreline";
import { nodeById, roadWidth, type LevelDef, type MapNode, type NodeId, type RoadDef, type ZoneDef } from "../sim/types";
import { islandShoreline, pointInPolygon, waterOutline, wellInside } from "./shoreline";

export type CityOptions = {
  seed: number;
  cols: number;
  rows: number;
  /**
   * Nominal block size, metres between junction centres. `block` sets both
   * axes; `blockX`/`blockZ` override it per axis.
   *
   * Manhattan's blocks are about 80m between cross-streets and 270m between
   * avenues — better than 3:1. That anisotropy is most of what makes the grid
   * legible from above: you read the long avenues running the length of the
   * island and the close-packed street ladder crossing them. Square blocks
   * cannot look like Manhattan however many of them you draw.
   */
  block: number;
  /** Spacing between avenues (the long streets, running the island's length). */
  blockX?: number;
  /** Spacing between cross-streets. */
  blockZ?: number;
  /** 0..1. How much block sizes vary from the nominal. */
  jitter: number;
  /** Fraction of interior links to drop, creating T-junctions and dead ends. */
  thin: number;
  /** Length of the stub connecting a boundary junction to its map-edge source. */
  tail: number;
  /**
   * Bend a share of the streets. `fraction` of long-enough links get a single
   * mid-link waypoint pushed sideways; `maxSag` caps that push as a fraction of
   * the link's length. Sagitta f over chord L gives radius L²/8f, and the
   * generator additionally clamps f ≤ L²/480 so no street ever turns tighter
   * than 60m — well outside the radius at which a lane offset would fold back
   * through itself, and gentle enough that the end tangents stay within ~14°
   * of the chord, which is what keeps turn classification honest.
   */
  curve?: { fraction: number; maxSag: number };
  /**
   * Make the two central north-south streets a one-way couplet running in
   * opposite directions. This is what lets a downtown carry real traffic on one
   * lane per direction: a one-way approach has no opposing left to protect, so
   * the junction needs fewer phases and spends less of its cycle on clearance.
   */
  oneWayCouplet?: boolean;
  /**
   * A great park: a rectangle of the grid, in column/row indices, cleared of
   * streets entirely. Central Park is four avenues wide and fifty streets long,
   * and the hole it puts in the grid is as recognisable as the grid itself —
   * traffic has to go around it, which also makes the avenues flanking it the
   * busiest in the city.
   */
  park?: { col0: number; col1: number; row0: number; row1: number };
  /**
   * Make the avenues alternate one-way, as Manhattan's mostly do. Beyond being
   * authentic this is what a dense grid needs to carry traffic on one lane per
   * direction: a one-way approach has no opposing left turn to protect, so its
   * junctions need fewer phases and lose less of every cycle to clearance.
   */
  oneWayAvenues?: boolean;
  /**
   * Put the city on an island. The grid is generated as usual, rotated by
   * `angle`, then everything that falls in the water — or too close to it — is
   * removed. What is left is a street pattern the grid did not choose: blocks
   * truncated at the shore, avenues that run out partway, and a boundary that
   * is nothing like a rectangle.
   *
   * Traffic then enters over `bridges` crossings rather than all around the
   * edge, which concentrates flow the way a real island's approaches do.
   */
  island?: {
    longHalf: number;
    shortHalf: number;
    angle: number;
    /** Metres of dry land required between a junction and the water. */
    margin: number;
    /** Roughly how many bridge crossings to build. */
    bridges: number;
    /** How much narrower the island gets toward its southern end, 0..1. */
    taper?: number;
    /** Width of the rivers. Bridges span this to reach the far bank. */
    channel?: number;
  };
};

/**
 * Build a city street network from a seed.
 *
 * The generator is deliberately conservative about *removing* things. Dropping a
 * link is what turns a uniform grid into a real-feeling street pattern — you get
 * T-junctions where a street stops, and blocks of differing size — but each
 * removal risks stranding traffic. Two invariants are enforced on every drop:
 *
 *  - every junction keeps at least three arms, so no signalised junction ends up
 *    a pointless two-way straight-through;
 *  - the junction graph stays connected, so every source can still reach every
 *    other one.
 *
 * One lane per direction throughout. It is the only lane pairing that keeps a
 * multi-junction network fully connected without a lane-change model, and it is
 * what a real dense grid mostly looks like anyway.
 */
export function generateCity(opts: CityOptions): LevelDef {
  const rand = mulberry32(opts.seed);
  const { cols, rows, block, jitter, thin, tail } = opts;

  // --- Irregular spacing: blocks vary in size, so the grid never reads as graph paper.
  const spanFor = (n: number, spacing: number) => {
    const gaps: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      gaps.push(spacing * (1 + (rand() * 2 - 1) * jitter));
    }
    const coords = [0];
    for (const g of gaps) coords.push(coords[coords.length - 1] + g);
    const mid = coords[coords.length - 1] / 2;
    return coords.map((c) => c - mid);
  };

  const xs = spanFor(cols, opts.blockX ?? block);
  const zs = spanFor(rows, opts.blockZ ?? block);
  const jid = (r: number, c: number) => `j${r}_${c}`;

  // --- The island, and the rotation its grid sits at.
  const island = opts.island
    ? islandShoreline({
        seed: opts.seed,
        longHalf: opts.island.longHalf,
        shortHalf: opts.island.shortHalf,
        angle: opts.island.angle,
        taper: opts.island.taper,
      })
    : null;

  const channel = opts.island?.channel ?? 220;
  const water = island ? waterOutline(island, channel, opts.seed) : null;

  const gridAngle = opts.island?.angle ?? 0;
  const ca = Math.cos(gridAngle);
  const sa = Math.sin(gridAngle);
  /** Grid coordinates to world, turning the whole grid with the island. */
  const place = (gx: number, gz: number): [number, number] => [
    gx * ca - gz * sa,
    gx * sa + gz * ca,
  ];

  /** Junctions that survive the water. Without an island, all of them. */
  const onLand = (r: number, c: number): boolean => {
    if (!island || !opts.island) return true;
    const [x, z] = place(xs[c], zs[r]);
    return wellInside(x, z, island, opts.island.margin);
  };

  /*
   * The great park. Junctions strictly inside it are removed outright, so the
   * streets stop at its edge and traffic has to go round — which is the whole
   * reason a park changes how a city drives. Junctions exactly on the boundary
   * survive, and become the park's flanking avenues and cross-streets.
   */
  const park = opts.park;
  const inPark = (r: number, c: number): boolean =>
    park !== undefined &&
    c > park.col0 &&
    c < park.col1 &&
    r > park.row0 &&
    r < park.row1;

  const kept = new Set<NodeId>();
  const nodes: MapNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!onLand(r, c) || inPark(r, c)) continue;
      kept.add(jid(r, c));
      nodes.push({ id: jid(r, c), pos: place(xs[c], zs[r]), kind: "junction" });
    }
  }

  // --- Every interior link between two surviving junctions, before thinning.
  // `via` carries interior points a link has picked up by absorbing a junction.
  type Link = { id: string; a: NodeId; b: NodeId; via?: [number, number][] };
  const links: Link[] = [];
  const both = (a: NodeId, b: NodeId) => kept.has(a) && kept.has(b);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c < cols - 1 && both(jid(r, c), jid(r, c + 1))) {
        links.push({ id: `h${r}_${c}`, a: jid(r, c), b: jid(r, c + 1) });
      }
      if (r < rows - 1 && both(jid(r, c), jid(r + 1, c))) {
        links.push({ id: `v${r}_${c}`, a: jid(r, c), b: jid(r + 1, c) });
      }
    }
  }

  /*
   * Clipping a grid to a curved shore leaves stragglers: a junction cut off
   * from the rest, or hanging on a single link. Keep only the largest connected
   * component, then repeatedly drop anything with one link left, so the network
   * that survives is one piece with no dead-end spurs.
   */
  if (island) {
    const adjacency = () => {
      const adj = new Map<NodeId, NodeId[]>();
      for (const l of links) {
        (adj.get(l.a) ?? adj.set(l.a, []).get(l.a)!).push(l.b);
        (adj.get(l.b) ?? adj.set(l.b, []).get(l.b)!).push(l.a);
      }
      return adj;
    };

    // Largest component.
    const adj = adjacency();
    const seen = new Set<NodeId>();
    let best: Set<NodeId> = new Set();
    for (const id of kept) {
      if (seen.has(id)) continue;
      const comp = new Set<NodeId>([id]);
      const queue = [id];
      seen.add(id);
      for (let i = 0; i < queue.length; i++) {
        for (const n of adj.get(queue[i]) ?? []) {
          if (comp.has(n)) continue;
          comp.add(n);
          seen.add(n);
          queue.push(n);
        }
      }
      if (comp.size > best.size) best = comp;
    }
    for (const id of [...kept]) if (!best.has(id)) kept.delete(id);
    let n = links.length;
    while (n-- > 0) {
      const i = links.findIndex((l) => !kept.has(l.a) || !kept.has(l.b));
      if (i < 0) break;
      links.splice(i, 1);
    }

    const posOf = (id: NodeId): [number, number] =>
      nodes.find((n) => n.id === id)!.pos;

    /** A link's interior points, walked from `from` toward its other end. */
    const viaFrom = (l: Link, from: NodeId): [number, number][] => {
      const via = l.via ?? [];
      return l.a === from ? via : [...via].reverse();
    };

    let merged = 0;
    for (;;) {
      const degree = new Map<NodeId, number>();
      for (const l of links) {
        degree.set(l.a, (degree.get(l.a) ?? 0) + 1);
        degree.set(l.b, (degree.get(l.b) ?? 0) + 1);
      }

      // Dangling ends: nothing to do but remove them.
      const doomed = [...kept].filter((id) => (degree.get(id) ?? 0) <= 1);
      if (doomed.length > 0) {
        for (const id of doomed) kept.delete(id);
        for (let i = links.length - 1; i >= 0; i--) {
          if (!kept.has(links[i].a) || !kept.has(links[i].b)) links.splice(i, 1);
        }
        continue;
      }

      /*
       * A two-arm junction is not a junction — it is a bend in a street, and a
       * signal there would control nothing. The grid never produces one, but
       * clipping to a shoreline does, all around the coast.
       *
       * So absorb it: join its two links into a single road that passes
       * through, keeping the old junction's position as an interior waypoint.
       * The street then curves around the shore rather than stopping at it,
       * which is both what a real coastal street does and the thing that most
       * stops the clipped grid looking like a grid with bites taken out.
       */
      /*
       * Two-arm junctions.
       *
       * Where the two streets run straight through each other, the junction is
       * doing nothing and is absorbed — the road simply continues. Where they
       * meet at an angle it is a street corner, which a gridded city clipped to
       * a shoreline is full of, and it is left exactly as it is.
       *
       * Deleting those corners instead is what an earlier version did, and it
       * cascades: removing one drops its neighbour to two arms, which drops the
       * next, and on a narrow island the peel consumes the entire grid.
       * Absorbing preserves both neighbours' arm counts, so it cannot cascade.
       */
      const posDirTo = (from: NodeId, end: NodeId): [number, number] => {
        const p = posOf(from);
        const q = posOf(end);
        const dx = q[0] - p[0];
        const dz = q[1] - p[1];
        const len = Math.hypot(dx, dz) || 1;
        return [dx / len, dz / len];
      };

      const bend = [...kept].find((id) => {
        if ((degree.get(id) ?? 0) !== 2) return false;
        const pair = links.filter((l) => l.a === id || l.b === id);
        if (pair.length !== 2) return false;
        const [ax, az] = posDirTo(id, pair[0].a === id ? pair[0].b : pair[0].a);
        const [bx, bz] = posDirTo(id, pair[1].a === id ? pair[1].b : pair[1].a);
        // Straight through: the two arms point in opposite directions.
        return ax * bx + az * bz < -0.82;
      });
      if (bend === undefined) break;

      const [l1, l2] = links.filter((l) => l.a === bend || l.b === bend);
      const endA = l1.a === bend ? l1.b : l1.a;
      const endB = l2.a === bend ? l2.b : l2.a;

      const duplicate = links.some(
        (l) => (l.a === endA && l.b === endB) || (l.a === endB && l.b === endA),
      );
      if (endA === endB || duplicate) break;

      kept.delete(bend);
      links.splice(links.indexOf(l1), 1);
      links.splice(links.indexOf(l2), 1);
      links.push({
        id: `m${merged++}`,
        a: endA,
        b: endB,
        via: [...viaFrom(l1, endA), posOf(bend), ...viaFrom(l2, bend)],
      });
    }

    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!kept.has(nodes[i].id)) nodes.splice(i, 1);
    }
  }

  const stubs: { id: string; junction: NodeId; source: MapNode }[] = [];

  if (island && opts.island) {
    /*
     * Bridges. Every junction that lost a grid neighbour to the water is a
     * candidate landing; the missing neighbour's direction is the way the
     * bridge runs. Candidates are then thinned to roughly the requested count,
     * spaced around the shore rather than clustered, because a dozen crossings
     * spread around an island is what makes its approaches read — and it
     * concentrates arriving traffic the way real crossings do.
     */
    type Candidate = { junction: NodeId; pos: [number, number]; dir: [number, number]; bearing: number };
    const candidates: Candidate[] = [];

    const posById = (id: NodeId): [number, number] =>
      nodes.find((n) => n.id === id)!.pos;

    /** Direction a link leaves `from`, following its shape, not its chord. */
    const armDir = (l: Link, from: NodeId): [number, number] => {
      const start = posById(from);
      const via = l.via ?? [];
      const oriented = l.a === from ? via : [...via].reverse();
      const next = oriented[0] ?? posById(l.a === from ? l.b : l.a);
      const dx = next[0] - start[0];
      const dz = next[1] - start[1];
      const len = Math.hypot(dx, dz) || 1;
      return [dx / len, dz / len];
    };

    /*
     * A bridge landing head-on into a street that already leaves the junction
     * the same way is not a junction arm at all — the turn between them comes
     * out as a U-turn, which the model does not carry, so the movement simply
     * never exists and every route over that bridge silently dies. Insist on
     * real angular separation from every arm already there.
     */
    const clearOfExistingArms = (junction: NodeId, dir: [number, number]): boolean =>
      links
        .filter((l) => l.a === junction || l.b === junction)
        .every((l) => {
          const d = armDir(l, junction);
          return d[0] * dir[0] + d[1] * dir[1] < 0.6;
        });

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = jid(r, c);
        if (!kept.has(id)) continue;
        const here: [number, number] = [xs[c], zs[r]];

        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = r + dr;
          const nc = c + dc;
          const missing =
            nr < 0 || nr >= rows || nc < 0 || nc >= cols || !kept.has(jid(nr, nc));
          if (!missing) continue;

          // Bridge runs along the grid direction the neighbour would have been.
          const gx = dc !== 0 ? Math.sign(dc) : 0;
          const gz = dr !== 0 ? Math.sign(dr) : 0;
          const world = place(here[0], here[1]);
          const dir = place(gx, gz);
          if (!clearOfExistingArms(id, dir)) continue;
          candidates.push({
            junction: id,
            pos: world,
            dir,
            bearing: Math.atan2(world[1], world[0]),
          });
          break; // one bridge per junction at most
        }
      }
    }

    // Spread the chosen landings evenly by bearing around the island.
    candidates.sort((p, q) => p.bearing - q.bearing);
    const want = Math.min(opts.island.bridges, candidates.length);
    const chosen: Candidate[] = [];
    if (want > 0) {
      const step = candidates.length / want;
      for (let i = 0; i < want; i++) {
        chosen.push(candidates[Math.floor(i * step)]);
      }
    }

    let n = 0;
    for (const cand of chosen) {
      /*
       * Carry the bridge across the water until it makes landfall on the far
       * bank, and a little way inland so its source sits on solid ground. A
       * crossing that stops in the river reads as a street that gave up.
       */
      let span = tail;
      let landed = false;
      for (let probe = 12; probe < channel * 3 + opts.island.shortHalf; probe += 8) {
        const px = cand.pos[0] + cand.dir[0] * probe;
        const pz = cand.pos[1] + cand.dir[1] * probe;
        if (pointInPolygon(px, pz, island)) continue;
        // Off the island and out the far side of the river: dry land again.
        if (water && !pointInPolygon(px, pz, water)) {
          span = probe + 30;
          landed = true;
          break;
        }
      }
      // No far bank in that direction — the crossing would go nowhere.
      if (!landed) continue;
      const id = `src_b_${n}_0`;
      stubs.push({
        id: `rs_b_${n}_0`,
        junction: cand.junction,
        source: {
          id,
          pos: [cand.pos[0] + cand.dir[0] * span, cand.pos[1] + cand.dir[1] * span],
          kind: "source",
        },
      });
      n++;
    }
  } else {
    // --- Perimeter stubs. Every boundary junction gets an outward connection, so
    // traffic enters and leaves all around the city rather than at a few gates.
    const addStub = (r: number, c: number, dx: number, dz: number, name: string) => {
      const id = `src_${name}_${r}_${c}`;
      stubs.push({
        id: `rs_${name}_${r}_${c}`,
        junction: jid(r, c),
        source: { id, pos: [xs[c] + dx * tail, zs[r] + dz * tail], kind: "source" },
      });
    };
    for (let c = 0; c < cols; c++) {
      addStub(0, c, 0, -1, "n");
      addStub(rows - 1, c, 0, 1, "s");
    }
    for (let r = 0; r < rows; r++) {
      addStub(r, 0, -1, 0, "w");
      addStub(r, cols - 1, 1, 0, "e");
    }
  }

  // --- Thinning, with both invariants checked before each removal.
  const armCount = new Map<NodeId, number>();
  const bump = (id: NodeId, by: number) =>
    armCount.set(id, (armCount.get(id) ?? 0) + by);
  for (const l of links) {
    bump(l.a, 1);
    bump(l.b, 1);
  }
  for (const s of stubs) bump(s.junction, 1);

  const alive = new Set(links.map((l) => l.id));
  const connected = (): boolean => {
    const adj = new Map<NodeId, NodeId[]>();
    for (const l of links) {
      if (!alive.has(l.id)) continue;
      (adj.get(l.a) ?? adj.set(l.a, []).get(l.a)!).push(l.b);
      (adj.get(l.b) ?? adj.set(l.b, []).get(l.b)!).push(l.a);
    }
    // Start anywhere that survived — on an island, j0_0 is usually water.
    const start = [...kept][0];
    if (start === undefined) return true;
    const seen = new Set<NodeId>([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const n of adj.get(queue[i]) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return seen.size === kept.size;
  };

  const target = Math.floor(links.length * thin);
  const order = [...links].sort(() => rand() - 0.5);
  let removed = 0;
  for (const l of order) {
    if (removed >= target) break;
    if ((armCount.get(l.a) ?? 0) <= 3 || (armCount.get(l.b) ?? 0) <= 3) continue;

    alive.delete(l.id);
    bump(l.a, -1);
    bump(l.b, -1);

    if (connected()) {
      removed++;
    } else {
      alive.add(l.id);
      bump(l.a, 1);
      bump(l.b, 1);
    }
  }

  // --- One-way couplet: the two middle columns, running opposite ways.
  //
  // Direction alternates by column so the pair forms a circuit rather than two
  // parallel drains, and only *interior* links are turned — a stub touching a
  // source must stay two-way or that source could only ever emit or only ever
  // receive, which strands every OD pair through it.
  const oneWayLinks = new Set<string>();
  const flipped = new Set<string>();

  /*
   * Avenues run the length of the island — they are the `v` links, joining one
   * row to the next within a column. Turning a whole column one-way and
   * alternating the direction column by column gives the classic uptown /
   * downtown pairing, so a driver is never more than one avenue from a road
   * going their way.
   *
   * Some avenues stay two-way. Making every one of them one-way leaves parts of
   * the grid awkward to reach and reads as a maze rather than a city.
   */
  const oneWayColumns = new Map<number, boolean>();
  if (opts.oneWayAvenues && cols >= 4) {
    for (let c = 1; c < cols - 1; c++) {
      if (c % 3 === 0) continue; // every third avenue stays two-way
      oneWayColumns.set(c, c % 2 === 0);
    }
  } else if (opts.oneWayCouplet && cols >= 4) {
    const midLeft = Math.floor((cols - 1) / 2);
    oneWayColumns.set(midLeft, false);
    oneWayColumns.set(midLeft + 1, true);
  }

  /*
   * A junction with only two arms has no spare route: if one of them is a
   * one-way pointing in, the only way out is back down the street you came
   * from, and that is a U-turn, which the driving model does not carry. The
   * movement then simply does not exist and every route through that corner
   * dies silently — this is exactly the failure the validator caught before.
   * So one-ways never touch a two-arm corner.
   */
  const armsAt = new Map<NodeId, number>();
  for (const l of links) {
    if (!alive.has(l.id)) continue;
    armsAt.set(l.a, (armsAt.get(l.a) ?? 0) + 1);
    armsAt.set(l.b, (armsAt.get(l.b) ?? 0) + 1);
  }
  for (const s of stubs) armsAt.set(s.junction, (armsAt.get(s.junction) ?? 0) + 1);

  for (const l of links) {
    if (!alive.has(l.id) || !l.id.startsWith("v")) continue;
    const c = Number(l.id.split("_")[1]);
    const reverse = oneWayColumns.get(c);
    if (reverse === undefined) continue;
    if ((armsAt.get(l.a) ?? 0) < 3 || (armsAt.get(l.b) ?? 0) < 3) continue;
    oneWayLinks.add(l.id);
    // Links are generated top-to-bottom, so `reverse` flips that direction.
    if (reverse) flipped.add(l.id);
  }

  // --- Assemble.
  const roads: RoadDef[] = [];
  for (const l of links) {
    if (!alive.has(l.id)) continue;
    const oneWay = oneWayLinks.has(l.id);
    const reverse = flipped.has(l.id);
    const via = l.via && l.via.length > 0 ? (reverse ? [...l.via].reverse() : l.via) : undefined;
    roads.push({
      id: l.id,
      from: reverse ? l.b : l.a,
      to: reverse ? l.a : l.b,
      lanesPerDir: 1,
      ...(oneWay ? { oneWay: true } : {}),
      ...(via ? { waypoints: via } : {}),
    });
  }
  for (const s of stubs) {
    nodes.push(s.source);
    roads.push({ id: s.id, from: s.junction, to: s.source.id, lanesPerDir: 1 });
  }

  /*
   * A one-way pair is only safe if every junction can still be reached from
   * every other one *following the arrows*. Undirected connectivity — which is
   * all the thinning pass checked — says nothing here: a couplet can leave a
   * corner that traffic can enter and never leave. Both a forward and a reverse
   * sweep must cover the whole graph; if either doesn't, the couplet goes back
   * to two-way rather than shipping a map with unreachable OD pairs.
   */
  if (oneWayLinks.size > 0) {
    const junctionIds = nodes.filter((n) => n.kind === "junction").map((n) => n.id);
    const out = new Map<NodeId, NodeId[]>();
    const inn = new Map<NodeId, NodeId[]>();
    const link = (m: Map<NodeId, NodeId[]>, a: NodeId, b: NodeId) => {
      const list = m.get(a) ?? [];
      list.push(b);
      m.set(a, list);
    };
    for (const r of roads) {
      if (!junctionIds.includes(r.from) || !junctionIds.includes(r.to)) continue;
      link(out, r.from, r.to);
      link(inn, r.to, r.from);
      if (!r.oneWay) {
        link(out, r.to, r.from);
        link(inn, r.from, r.to);
      }
    }
    const reach = (adj: Map<NodeId, NodeId[]>): number => {
      const seen = new Set<NodeId>([junctionIds[0]]);
      const queue = [junctionIds[0]];
      for (let i = 0; i < queue.length; i++) {
        for (const n of adj.get(queue[i]) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          queue.push(n);
        }
      }
      return seen.size;
    };

    if (reach(out) !== junctionIds.length || reach(inn) !== junctionIds.length) {
      for (const r of roads) delete r.oneWay;
      oneWayLinks.clear();
    }
  }

  // --- Curved streets. A waypoint at mid-link pushed perpendicular to the
  // chord bows the street; the sagitta is capped so the radius stays above 60m,
  // which keeps the offset lanes clear of each other and the end tangents close
  // enough to the chord that turns still classify as they look.
  if (opts.curve && opts.curve.fraction > 0) {
    const { fraction, maxSag } = opts.curve;
    for (const road of roads) {
      const a = nodes.find((n) => n.id === road.from)!;
      const b = nodes.find((n) => n.id === road.to)!;
      // Stubs carry the map's entry traffic and are short; leave them straight.
      if (a.kind === "source" || b.kind === "source") continue;
      // A road that already bends around an absorbed junction has its shape.
      if (road.waypoints && road.waypoints.length > 0) continue;
      if (rand() > fraction) continue;

      const dx = b.pos[0] - a.pos[0];
      const dz = b.pos[1] - a.pos[1];
      const len = Math.hypot(dx, dz);
      if (len < 60) continue;

      const sag = Math.min(len * (0.05 + rand() * (maxSag - 0.05)), (len * len) / 480);
      const side = rand() < 0.5 ? 1 : -1;
      road.waypoints = [
        [
          (a.pos[0] + b.pos[0]) / 2 + (-dz / len) * sag * side,
          (a.pos[1] + b.pos[1]) / 2 + (dx / len) * sag * side,
        ],
      ];
    }
  }

  // Frame everything actually placed — on an island the grid's nominal extent
  // means nothing, since most of its corners are underwater.
  // Frame the island and its crossings — never the mainland, which runs far off
  // in every direction and would pull the camera back to a speck of a city.
  const reach = Math.max(
    ...nodes
      .filter((n) => n.kind === "junction")
      .map((n) => Math.max(Math.abs(n.pos[0]), Math.abs(n.pos[1]))),
    ...(island ?? []).map(([x, z]) => Math.max(Math.abs(x), Math.abs(z))),
  );

  const level: LevelDef = {
    id: `city-${opts.seed}`,
    name: "The City",
    half: reach + 40,
    seed: opts.seed,
    quota: 0,
    timeLimit: 0,
    demand: 0,
    ...(island ? { island } : {}),
    ...(water ? { water } : {}),
    nodes,
    roads,
    zones: [],
  };

  // --- Blocks are the faces of the street graph itself, so a removed link
  // merges two blocks and a curved street bounds a curved block.
  level.zones = deriveBlockZones(level, rand);

  return level;
}

// ------------------------------------------------------------- block tracing

type HalfEdge = { roadId: string; from: NodeId; to: NodeId; pts: Pt[] };

/**
 * Trace the faces of the planar street graph and turn each interior face into
 * a block or park zone, inset from the carriageways.
 *
 * Standard half-edge face walk: every interior road contributes two directed
 * edges; at each junction the departures are sorted by bearing, and "next" from
 * a half-edge is the rotational successor of its twin at the head node. Each
 * directed edge belongs to exactly one face, so walking until the start
 * half-edge recurs traces every face once; the one with the largest area is
 * the unbounded outside and is dropped.
 */
function deriveBlockZones(level: LevelDef, rand: () => number): ZoneDef[] {
  const interior = level.roads.filter(
    (r) =>
      nodeById(level, r.from).kind === "junction" &&
      nodeById(level, r.to).kind === "junction",
  );
  if (interior.length === 0) return [];

  const edges = new Map<string, HalfEdge>();
  for (const road of interior) {
    const pts = roadCentreline(level, road);
    edges.set(`${road.id}:F`, { roadId: road.id, from: road.from, to: road.to, pts });
    edges.set(`${road.id}:R`, {
      roadId: road.id,
      from: road.to,
      to: road.from,
      pts: reversePoly(pts),
    });
  }
  const twinOf = (key: string) =>
    key.endsWith(":F") ? `${key.slice(0, -2)}:R` : `${key.slice(0, -2)}:F`;

  // Departing half-edges per node, sorted by initial bearing.
  const departures = new Map<NodeId, string[]>();
  for (const [key, he] of edges) {
    const list = departures.get(he.from) ?? [];
    list.push(key);
    departures.set(he.from, list);
  }
  for (const list of departures.values()) {
    list.sort((p, q) => {
      const a = edges.get(p)!.pts;
      const b = edges.get(q)!.pts;
      return (
        Math.atan2(a[1].z - a[0].z, a[1].x - a[0].x) -
        Math.atan2(b[1].z - b[0].z, b[1].x - b[0].x)
      );
    });
  }

  // Walk every face once.
  const used = new Set<string>();
  const faces: { poly: [number, number][]; area: number; hasSpur: boolean }[] = [];

  for (const start of edges.keys()) {
    if (used.has(start)) continue;

    const cycle: string[] = [];
    let key = start;
    do {
      cycle.push(key);
      used.add(key);
      const at = edges.get(key)!.to;
      const deps = departures.get(at)!;
      const idx = deps.indexOf(twinOf(key));
      key = deps[(idx + 1) % deps.length];
    } while (key !== start);

    const poly: [number, number][] = [];
    const roadsSeen = new Set<string>();
    let hasSpur = false;
    for (const k of cycle) {
      const he = edges.get(k)!;
      if (roadsSeen.has(he.roadId)) hasSpur = true;
      roadsSeen.add(he.roadId);
      for (let i = 0; i < he.pts.length - 1; i++) poly.push([he.pts[i].x, he.pts[i].z]);
    }

    faces.push({ poly, area: Math.abs(shoelace(poly)), hasSpur });
  }

  // The unbounded outer face is traced like any other; it is simply the biggest.
  const outer = faces.reduce((a, b) => (b.area > a.area ? b : a), faces[0]);

  /*
   * Threshold that separates the great park from an ordinary block. The park is
   * a cleared rectangle many blocks across, so it comes out far larger than any
   * real block — sitting the cutoff well above the median interior face
   * distinguishes them without needing to know where the park was put.
   */
  const faceAreas = faces.filter((f) => f !== outer).map((f) => f.area).sort((a, b) => a - b);
  const medianFaceArea = faceAreas[Math.floor(faceAreas.length / 2)] ?? 0;
  const greatParkArea = medianFaceArea * 6;

  const zones: ZoneDef[] = [];
  let n = 0;
  for (const face of faces) {
    if (face === outer) continue;

    const maxRoadHalf = Math.max(...level.roads.map((r) => roadWidth(r) / 2));
    const inset = insetPolygon(face.poly, maxRoadHalf + 9);
    if (inset === null || Math.abs(shoelace(inset)) < 900) continue;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of inset) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    // A slit face (a dead-end street poking into the block) triangulates
    // badly as a park fill — those faces always take buildings instead.
    const parkable = !face.hasSpur && isSimple(inset);

    /*
     * The great park is simply the largest face on the map — clearing a
     * rectangle of junctions leaves a hole in the grid many blocks across, and
     * nothing else comes close to it. Always green, never built on.
     */
    const area = Math.abs(shoelace(inset));
    const isGreatPark = parkable && area > greatParkArea;

    zones.push({
      id: `blk_${n++}`,
      /*
       * Small green squares are sparse on purpose. A dense gridded city is
       * overwhelmingly built — scatter parks through one block in seven and it
       * reads as a garden suburb, however right the street plan is. The great
       * park carries the greenery; these are the occasional square.
       */
      kind: isGreatPark || (parkable && rand() < 0.045) ? "park" : "block",
      centre: [(minX + maxX) / 2, (minZ + maxZ) / 2],
      half: [(maxX - minX) / 2, (maxZ - minZ) / 2],
      polygon: inset,
    });
  }

  return zones;
}

function shoelace(poly: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % poly.length];
    sum += x0 * z1 - x1 * z0;
  }
  return sum / 2;
}

/** Closed miter offset, inward. Returns null when the face degenerates. */
function insetPolygon(poly: [number, number][], d: number): [number, number][] | null {
  const offset = (dist: number): [number, number][] => {
    const n = poly.length;
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const [px0, pz0] = poly[(i - 1 + n) % n];
      const [px1, pz1] = poly[i];
      const [px2, pz2] = poly[(i + 1) % n];

      const l0 = Math.hypot(px1 - px0, pz1 - pz0) || 1;
      const l1 = Math.hypot(px2 - px1, pz2 - pz1) || 1;
      // Right normals of the incoming and outgoing segments.
      const n0x = -(pz1 - pz0) / l0, n0z = (px1 - px0) / l0;
      const n1x = -(pz2 - pz1) / l1, n1z = (px2 - px1) / l1;

      let mx = n0x + n1x, mz = n0z + n1z;
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const cosHalf = Math.sqrt(Math.max(0, (1 + n0x * n1x + n0z * n1z) / 2));
      const s = dist / Math.max(cosHalf, 0.5);
      out.push([px1 + mx * s, pz1 + mz * s]);
    }
    return out;
  };

  // Winding decides which sign points inward; take whichever shrinks the face.
  const a = offset(d);
  const b = offset(-d);
  const areaP = Math.abs(shoelace(poly));
  const inset = Math.abs(shoelace(a)) < Math.abs(shoelace(b)) ? a : b;
  const areaI = Math.abs(shoelace(inset));
  if (areaI < 4 || areaI >= areaP) return null;
  return inset;
}

function isSimple(poly: [number, number][]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the loop
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % n];
      const [cx, cz] = poly[j];
      const [dx, dz] = poly[(j + 1) % n];
      const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
      const denom = rx * sz - rz * sx;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((cx - ax) * sz - (cz - az) * sx) / denom;
      const u = ((cx - ax) * rz - (cz - az) * rx) / denom;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) return false;
    }
  }
  return true;
}
