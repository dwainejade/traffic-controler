import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { LevelDef } from "../sim/types";
import { toggleLayer } from "../ui/hudStore";

type Path = {
  /** Point on the map boundary where the flight begins, y = 0. */
  start: THREE.Vector3;
  /** Unit heading in the xz plane. */
  dir: THREE.Vector3;
  /** World units from start to the far boundary. */
  length: number;
  height: number;
  lookAhead: number;
  speed: number;
};

/** Nudge a heading off the axes so the slab intersection below never divides by ~0. */
function safeDir(theta: number): THREE.Vector3 {
  let x = Math.sin(theta);
  let z = Math.cos(theta);
  if (Math.abs(x) < 0.02) x = x < 0 ? -0.02 : 0.02;
  if (Math.abs(z) < 0.02) z = z < 0 ? -0.02 : 0.02;
  return new THREE.Vector3(x, 0, z).normalize();
}

/**
 * A random chord across the level's square, edge to edge, so a flyover
 * always starts and ends at the map boundary rather than clipping a corner —
 * the slab intersection of a random line through a random point against the
 * `[-half, half]` box.
 */
function pickPath(half: number): Path {
  const dir = safeDir(Math.random() * Math.PI * 2);
  const px = (Math.random() * 2 - 1) * half;
  const pz = (Math.random() * 2 - 1) * half;

  const tx1 = (-half - px) / dir.x;
  const tx2 = (half - px) / dir.x;
  const tz1 = (-half - pz) / dir.z;
  const tz2 = (half - pz) / dir.z;

  const tEntry = Math.max(Math.min(tx1, tx2), Math.min(tz1, tz2));
  const tExit = Math.min(Math.max(tx1, tx2), Math.max(tz1, tz2));

  const start = new THREE.Vector3(px + dir.x * tEntry, 0, pz + dir.z * tEntry);
  const length = Math.max(1, tExit - tEntry);

  // Scaled off the map's own size: low enough to read as an aerial shot on a
  // single junction, high enough not to clip buildings on a full city.
  const height =
    THREE.MathUtils.clamp(half * 0.1, 40, 160) * (0.8 + Math.random() * 0.4);
  // A crossing takes roughly 15-25s regardless of map size.
  const speed = THREE.MathUtils.clamp(half / 12, 1, 10);

  return { start, dir, length, height, lookAhead: height * 2.5, speed };
}

function typing(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/**
 * Apple-TV-aerial-screensaver camera: a slow, low, straight flyover of a
 * random chord across the map, edge to edge. Reaching the far edge starts a
 * new random path; C cycles early; any drag/scroll/WASD hands control back
 * to OrbitControls, which is unmounted for the duration (see Controls.tsx)
 * so nothing else is fighting over camera.position.
 */
export function CinematicCamera({ level }: { level: LevelDef }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const path = useRef<Path>(pickPath(level.half));
  const t = useRef(0);
  const lookTarget = useRef(new THREE.Vector3());
  const getRandomHeight = () => Math.random() * (25 - -60) + -60;
  const [randomHeight, setCameraLookTargetHeight] = useState(getRandomHeight());

  // A fresh flight whenever the level changes underneath it.
  useEffect(() => {
    path.current = pickPath(level.half * 0.5);
    t.current = 0;
  }, [level]);

  useEffect(() => {
    const cancel = () => toggleLayer("cinematicCamera");

    const onKeyDown = (e: KeyboardEvent) => {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "c") {
        path.current = pickPath(level.half);
        t.current = 0;
      } else if (k === "w" || k === "a" || k === "s" || k === "d") {
        cancel();
      }
      // get random height for the look target, so the camera doesn't always look at the same height
      setCameraLookTargetHeight(getRandomHeight());
    };

    const el = gl.domElement;
    el.addEventListener("pointerdown", cancel);
    el.addEventListener("wheel", cancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("pointerdown", cancel);
      el.removeEventListener("wheel", cancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [gl, level]);

  useFrame((_, delta) => {
    const p = path.current;
    t.current += delta * p.speed;

    if (t.current >= p.length) {
      path.current = pickPath(level.half);
      t.current = 0;
      return;
    }

    const x = p.start.x + p.dir.x * t.current;
    const z = p.start.z + p.dir.z * t.current;
    camera.position.set(x, p.height, z);

    lookTarget.current.set(
      x + p.dir.x * p.lookAhead,
      randomHeight,
      z + p.dir.z * p.lookAhead,
    );
    camera.lookAt(lookTarget.current);
  });

  return null;
}
