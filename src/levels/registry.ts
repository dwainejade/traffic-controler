import { create } from "zustand";
import type { LevelDef } from "../sim/types";
import { LEVELS } from "./index";
import { listAreas, saveArea, deleteArea, MAX_AREAS, type SavedArea } from "./store/areaDb";

/**
 * The level list, which is no longer fixed.
 *
 * `LEVELS` stays exactly what it was — the levels that ship, as a static array
 * built at module evaluation — and this sits on top of it, appending whatever
 * the player has imported. Splitting it that way keeps the Node sim harness and
 * every other consumer of `./index` working unchanged.
 *
 * One rule, and the world cache in `App.tsx` depends on it: never rebuild a
 * `LevelDef`. That cache is a `WeakMap` keyed on object identity, so a level
 * that is mapped or spread into a fresh object is a level whose warmed world is
 * thrown away. Push the objects through; do not copy them.
 */

type LevelsState = {
  /** Built-ins first, then saved areas, oldest first. */
  levels: LevelDef[];
  saved: SavedArea[];
  /** False until the first read of stored areas resolves. */
  loaded: boolean;
};

export const useLevels = create<LevelsState>(() => ({
  // Synchronously the built-ins, so the first paint is exactly what it was
  // before any of this existed. Saved areas append a few milliseconds later.
  levels: LEVELS,
  saved: [],
  loaded: false,
}));

/** Read stored areas into the list. Called once, from `main.tsx`. */
export async function loadSavedAreas(): Promise<void> {
  if (useLevels.getState().loaded) return;
  const saved = await listAreas();
  useLevels.setState({
    levels: [...LEVELS, ...saved.map((a) => a.level)],
    saved,
    loaded: true,
  });
}

/** Persist an imported area and append it to the list. */
export async function addArea(area: SavedArea): Promise<void> {
  await saveArea(area);
  const { saved } = useLevels.getState();
  const next = [...saved.filter((a) => a.id !== area.id), area];
  useLevels.setState({
    levels: [...LEVELS, ...next.map((a) => a.level)],
    saved: next,
  });
}

export async function removeArea(id: string): Promise<void> {
  await deleteArea(id);
  const next = useLevels.getState().saved.filter((a) => a.id !== id);
  useLevels.setState({
    levels: [...LEVELS, ...next.map((a) => a.level)],
    saved: next,
  });
}

export function atCapacity(): boolean {
  return useLevels.getState().saved.length >= MAX_AREAS;
}

/**
 * A level id for a newly imported area.
 *
 * The timestamp makes it unique in practice and ordered by age; the loop makes
 * it unique in fact, because ids are the remount key for the whole scene.
 */
export function newAreaId(name: string, taken: Iterable<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "area";
  const used = new Set(taken);
  const base = `osm_saved_${slug}_${Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

export { MAX_AREAS };
