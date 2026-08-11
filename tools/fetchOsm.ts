#!/usr/bin/env node
/**
 * Cache a slice of OpenStreetMap as a playable area.
 *
 * Adding an area is this command plus nothing else: the app picks up any JSON
 * in src/levels/osm/ automatically, so a new place is one fetch away.
 *
 *   npm run fetch:osm -- rogers --at 40.65695 -73.95323
 *   npm run fetch:osm -- shibuya --address "Shibuya Crossing, Tokyo"
 *   npm run fetch:osm -- soho --address "Soho, London" --radius 400
 *
 * Or `node tools/fetchOsm.ts <same args>` — the script only exists so the path
 * is one less thing to remember.
 *
 * `--radius` is half the square's side in metres (default 300, so a 600m box).
 * Much past 500 and you are back to watching a city rather than a junction.
 *
 * The response is written to src/levels/osm/<name>.json and committed, so the
 * app is deterministic and works offline. Re-run only to pick up map edits.
 *
 * The app can also import an area at runtime and keep it in the browser — see
 * `src/levels/osm/importArea.ts`. This command is for areas that should ship
 * with the game; the query and the mirror list are shared between the two.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boxAround, fetchOverpass, type Bbox } from "../src/levels/osm/overpass.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "traffic-controler/0.1 (level importer)";

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const name = argv[0];
const flag = (key: string): string[] | null => {
  const i = argv.indexOf(key);
  return i === -1 ? null : argv.slice(i + 1);
};

if (!name || name.startsWith("-")) {
  console.error(`usage:
  node tools/fetchOsm.ts <name> --at <lat> <lon> [--radius <metres>]
  node tools/fetchOsm.ts <name> --address "<place>" [--radius <metres>]
  node tools/fetchOsm.ts <name> --bbox <south> <west> <north> <east>`);
  process.exit(1);
}

const radius = Number(flag("--radius")?.[0] ?? 300);
if (!Number.isFinite(radius) || radius < 50) {
  console.error("--radius must be at least 50 metres");
  process.exit(1);
}

async function geocode(query: string): Promise<{ lat: number; lon: number }> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (hits.length === 0) throw new Error(`no match for "${query}"`);
  console.log(`  resolved to ${hits[0].display_name}`);
  return { lat: Number(hits[0].lat), lon: Number(hits[0].lon) };
}

let bbox: Bbox;
const atArg = flag("--at");
const addressArg = flag("--address");
const bboxArg = flag("--bbox");

if (atArg) {
  bbox = boxAround(Number(atArg[0]), Number(atArg[1]), radius);
} else if (addressArg) {
  console.log(`geocoding "${addressArg[0]}"`);
  const { lat, lon } = await geocode(addressArg[0]);
  bbox = boxAround(lat, lon, radius);
} else if (bboxArg) {
  const [south, west, north, east] = bboxArg.slice(0, 4).map(Number);
  bbox = { south, west, north, east };
} else {
  console.error("give one of --at, --address or --bbox");
  process.exit(1);
}

for (const [key, value] of Object.entries(bbox)) {
  if (!Number.isFinite(value)) {
    console.error(`bad ${key} in bounding box`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------- fetch

const json = await fetchOverpass(bbox, {
  userAgent: UA,
  onProgress: (p) => {
    if (p.phase === "trying") console.log(`fetching from ${p.endpoint}`);
    if (p.phase === "failed") console.warn(`  ${p.error}`);
  },
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// `bbox` is set by fetchOverpass; the label is this command's own.
(json as { label?: string }).label = addressArg?.[0] ?? name;

const out = resolve(ROOT, "src/levels/osm", `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(json));

const roads = json.elements.filter((e) => e.type === "way" && e.tags?.highway).length;
const buildings = json.elements.filter((e) => e.type === "way" && e.tags?.building).length;
const signals = json.elements.filter(
  (e) => e.type === "node" && e.tags?.highway === "traffic_signals",
).length;
console.log(`wrote ${out}: ${roads} road ways, ${signals} signals, ${buildings} buildings`);
