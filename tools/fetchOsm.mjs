#!/usr/bin/env node
/**
 * Cache a slice of OpenStreetMap as a playable area.
 *
 * Adding an area is this command plus nothing else: the app picks up any JSON
 * in src/levels/osm/ automatically, so a new place is one fetch away.
 *
 *   node tools/fetchOsm.mjs rogers --at 40.65695 -73.95323
 *   node tools/fetchOsm.mjs shibuya --address "Shibuya Crossing, Tokyo"
 *   node tools/fetchOsm.mjs soho --address "Soho, London" --radius 400
 *
 * `--radius` is half the square's side in metres (default 300, so a 600m box).
 * Much past 500 and you are back to watching a city rather than a junction.
 *
 * The response is written to src/levels/osm/<name>.json and committed, so the
 * app is deterministic and works offline. Re-run only to pick up map edits.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "traffic-controler/0.1 (level importer)";

// The main Overpass instance is frequently too busy and answers 504 rather than
// queueing, so try the public mirrors in turn.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const name = argv[0];
const flag = (key) => {
  const i = argv.indexOf(key);
  return i === -1 ? null : argv.slice(i + 1);
};

if (!name || name.startsWith("-")) {
  console.error(`usage:
  node tools/fetchOsm.mjs <name> --at <lat> <lon> [--radius <metres>]
  node tools/fetchOsm.mjs <name> --address "<place>" [--radius <metres>]
  node tools/fetchOsm.mjs <name> --bbox <south> <west> <north> <east>`);
  process.exit(1);
}

const radius = Number(flag("--radius")?.[0] ?? 300);
if (!Number.isFinite(radius) || radius < 50) {
  console.error("--radius must be at least 50 metres");
  process.exit(1);
}

/** Metres per degree at a given latitude. Good to a centimetre at this scale. */
function scaleAt(lat) {
  return {
    perLat: 111132.92 - 559.82 * Math.cos((2 * lat * Math.PI) / 180),
    perLon: 111412.84 * Math.cos((lat * Math.PI) / 180),
  };
}

function boxAround(lat, lon, metres) {
  const { perLat, perLon } = scaleAt(lat);
  return {
    south: lat - metres / perLat,
    north: lat + metres / perLat,
    west: lon - metres / perLon,
    east: lon + metres / perLon,
  };
}

async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const hits = await res.json();
  if (hits.length === 0) throw new Error(`no match for "${query}"`);
  console.log(`  resolved to ${hits[0].display_name}`);
  return { lat: Number(hits[0].lat), lon: Number(hits[0].lon) };
}

let bbox;
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

const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;

// ---------------------------------------------------------------------- query

/*
 * Three sets, one query:
 *   - the driveable street network, with `>` to pull in each way's nodes so we
 *     have coordinates and can spot shared nodes (which is what an intersection
 *     *is* in OSM — ways that share a node, not ways that merely cross);
 *   - traffic signals and crossings, as tagged nodes;
 *   - buildings, water and green space, for real footprints instead of scatter.
 *
 * `way(bbox)` returns whole ways that merely touch the box, so the geometry
 * runs past the edges; the importer clips it and puts sources on the boundary.
 */
const query = `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${box});
);
out body;
>;
out skel qt;

node["highway"~"^(traffic_signals|crossing|stop|give_way)$"](${box});
out body;

(
  way["building"](${box});
  way["natural"="water"](${box});
  way["leisure"~"^(park|pitch|garden)$"](${box});
  way["landuse"~"^(grass|cemetery|recreation_ground)$"](${box});
);
out body;
>;
out skel qt;
`;

// ---------------------------------------------------------------------- fetch

async function ask(endpoint) {
  // Overpass wants the query form-encoded as `data`, and rejects requests with
  // no User-Agent outright (406) rather than serving them anonymously.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

let json;
for (const endpoint of ENDPOINTS) {
  console.log(`fetching ${box} from ${endpoint}`);
  try {
    json = await ask(endpoint);
    break;
  } catch (err) {
    console.warn(`  ${err.message.replace(/\s+/g, " ")}`);
  }
}
if (!json) {
  console.error("every mirror refused; try again shortly");
  process.exit(1);
}

// The importer projects to local metres about the box centre, and nothing else
// in the file says where on earth it is.
json.bbox = bbox;
json.label = addressArg?.[0] ?? name;

const out = resolve(ROOT, "src/levels/osm", `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(json));

const roads = json.elements.filter((e) => e.type === "way" && e.tags?.highway).length;
const buildings = json.elements.filter((e) => e.type === "way" && e.tags?.building).length;
const signals = json.elements.filter(
  (e) => e.type === "node" && e.tags?.highway === "traffic_signals",
).length;
console.log(`wrote ${out}: ${roads} road ways, ${signals} signals, ${buildings} buildings`);
