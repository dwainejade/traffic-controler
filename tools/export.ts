#!/usr/bin/env node
/**
 * Write the world store out as plain files, for a CDN to serve.
 *
 *   npm run world:export                  # -> data/export/
 *   npm run world:export -- --out ./dist-worlds
 *
 * A compiled level is immutable for a given box and importer version — the key
 * says so, and the server already serves it `Cache-Control: immutable`. Nothing
 * about that needs a process running: it is a blob under a name. So a store that
 * only ever serves *baked* areas can be a bucket and a CDN instead of a host, a
 * volume and something to keep alive.
 *
 * What is given up is `/api/level?lat=...`, the on-demand compile for a box
 * nobody baked. Against a static store the app asks, gets a 404 and falls back
 * to OpenStreetMap exactly as it does when no store is running at all.
 *
 * Upload the output directory as-is:
 *
 *   aws s3 sync data/export s3://<bucket>/ --delete
 *   rclone sync data/export r2:<bucket>
 *
 * Deliberately *no* `Content-Encoding: gzip` on the `.json.gz` files, and no
 * instruction to set one. Whether a bucket sets that header is exactly the kind
 * of per-host detail that silently breaks a deploy, so the app sniffs the gzip
 * magic bytes and copes either way — see `worldDb.ts`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { areaById, DB_PATH, listAreas, open, readLevelGzip } from "../server/db.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "usage: node tools/export.ts [--out <dir>]",
      "",
      "  --out <dir>   where to write (default data/export)",
      "",
      `store: ${DB_PATH}`,
    ].join("\n"),
  );
  process.exit(0);
}

const out = resolve(ROOT, flag("--out") ?? "data/export");

open();
const areas = listAreas();

if (areas.length === 0) {
  console.error("nothing baked yet — run: npm run world:ingest");
  process.exit(1);
}

/*
 * Cleared rather than merged. A stale level left behind from a previous export
 * is worse than a missing one: it is not referenced by `areas.json`, so nothing
 * will ever notice it is there, and it will be uploaded and paid for forever.
 */
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "levels"), { recursive: true });

let bytes = 0;
let written = 0;

for (const area of areas) {
  const row = areaById(area.id);
  const blob = row ? readLevelGzip(row.levelKey) : null;
  if (!blob) {
    // `listAreas` already joins against `levels`, so this means the row went
    // away underneath us — a concurrent re-bake. Worth saying, not worth dying.
    console.warn(`  skipped ${area.id}: no compiled level`);
    continue;
  }
  writeFileSync(join(out, "levels", `${area.id}.json.gz`), blob);
  bytes += blob.length;
  written++;
  console.log(`  ${area.id.padEnd(28)} ${mb(blob.length).padStart(9)}`);
}

/*
 * The same shape the server's `/api/areas.json` returns, so the app has one
 * code path and cannot tell a bucket from a host.
 */
writeFileSync(join(out, "areas.json"), JSON.stringify({ areas }, null, 2));

console.log(`\nwrote ${written} level(s), ${mb(bytes)} to ${out}`);
console.log("\nupload with e.g.:");
console.log(`  aws s3 sync ${out} s3://<bucket>/ --delete`);
console.log(`  rclone sync ${out} r2:<bucket>`);
console.log("\nthen build the app against it:");
console.log("  VITE_WORLD_DB=https://<your-cdn> npm run build");

process.exit(0);

function mb(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
