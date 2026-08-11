import type { LevelDef } from "../../sim/types";
import { importOsm, type OsmFile } from "./import";

/**
 * Every cached area, as a level.
 *
 * These are the areas that ship with the game. Adding one is one command and
 * no code:
 *
 *   node tools/fetchOsm.ts shibuya --address "Shibuya Crossing, Tokyo"
 *
 * Areas the player imports themselves never come through here — they are
 * fetched at runtime and kept in the browser; see `importArea.ts`.
 *
 * The glob picks the new JSON up on the next dev reload. `AREAS` below only
 * exists to give a file a nicer display name or its own traffic settings; an
 * area with no entry still loads, titled from its filename.
 */

type AreaSettings = {
  name?: string;
  /** Cars per second across the whole map. */
  demand?: number;
};

const AREAS: Record<string, AreaSettings> = {
  rogers: { name: "Rogers Avenue", demand: 0.9 },
};

const files = import.meta.glob<OsmFile>("./*.json", { eager: true, import: "default" });

function title(slug: string): string {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const OSM_LEVELS: LevelDef[] = Object.entries(files)
  .map(([path, file]) => {
    const slug = path.replace(/^\.\//, "").replace(/\.json$/, "");
    const settings = AREAS[slug] ?? {};
    return importOsm(file, {
      id: `osm_${slug}`,
      name: settings.name ?? title(slug),
      demand: settings.demand,
    });
  })
  .sort((a, b) => a.id.localeCompare(b.id));
