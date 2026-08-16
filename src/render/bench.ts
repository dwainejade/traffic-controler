import * as THREE from "three";

/**
 * What a frame of this map actually costs.
 *
 * The obvious instrument — count frames per second — is unavailable where this
 * most needs to run: a browser stops `requestAnimationFrame` entirely for a
 * page it considers hidden, which includes embedded panes and headless
 * captures, so the frame counter reads zero however fast the renderer is. The
 * numbers here are all taken from driving the renderer by hand instead.
 *
 * Two different costs, and they fail differently, so both are reported:
 *
 *   - `cpuMs` is the main thread walking the scene graph and submitting draw
 *     calls. This is what grows with the *number* of objects, and it is the one
 *     that tiling is meant to fix.
 *   - `gpuMs` is the card actually drawing them, measured with a real timer
 *     query rather than inferred. This is what grows with triangles and
 *     overdraw, and it can be several times the CPU figure without anything on
 *     the CPU side looking wrong.
 */
export type BenchResult = {
  /** Frames per second implied by the slower of the two costs. */
  fps: number;
  cpuMs: number;
  /** Null where the browser will not hand out timer queries. */
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
  /** Meshes in the graph, split by how they draw. */
  meshes: number;
  instancedMeshes: number;
  /** Instances actually drawn, summed over every instanced mesh. */
  instances: number;
  geometries: number;
  textures: number;
  programs: number;
};

/**
 * A GPU stopwatch, or null where there isn't one.
 *
 * `EXT_disjoint_timer_query_webgl2` is the only honest way to time the card
 * from script: everything else measures how long submission took, which on a
 * pipelined driver is close to unrelated to how long drawing took. It is
 * absent on plenty of configurations — it leaks timing side channels, so
 * browsers withhold it — hence every caller has to cope with null.
 */
function gpuTimer(gl: WebGL2RenderingContext) {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) return null;

  return {
    /** Time `body`, in milliseconds, or null if the driver disowned the result. */
    async time(body: () => void): Promise<number | null> {
      const query = gl.createQuery();
      if (!query) return null;

      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      body();
      gl.endQuery(ext.TIME_ELAPSED_EXT);

      /*
       * The result lands whenever the card gets to it, which is not this frame
       * and not on any schedule worth guessing at. Poll on a timer rather than
       * on rAF — rAF is exactly what is unavailable here.
       */
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;

        // A "disjoint" interval means the GPU was interrupted — a context
        // switch, a power state change — and every timing across it is
        // meaningless rather than merely noisy. Throw it away.
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
        gl.deleteQuery(query);
        return disjoint ? null : ns / 1e6;
      }

      gl.deleteQuery(query);
      return null;
    },
  };
}

/** Draw calls and triangles are the renderer's own tally; the rest is a walk. */
function sceneStats(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  let meshes = 0;
  let instancedMeshes = 0;
  let instances = 0;

  scene.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      instancedMeshes++;
      instances += inst.count;
    } else {
      meshes++;
    }
  });

  return {
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
    meshes,
    instancedMeshes,
    instances,
  };
}

/** Frames per timed batch. Enough to average out scheduling noise, not so many
 * that a slow map takes a visible age to measure. */
const BATCH = 30;
const WARMUP = 5;

/**
 * Render the scene repeatedly and report what it cost.
 *
 * Nothing here advances the simulation or any `useFrame` subscriber: this is
 * the cost of *drawing* the map as it currently stands, which is the thing
 * being optimised. Timing a moving scene would fold the sim's cost into a
 * figure meant to isolate the renderer's.
 */
export async function benchmark(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<BenchResult> {
  const draw = () => renderer.render(scene, camera);

  for (let i = 0; i < WARMUP; i++) draw();

  const timer = gpuTimer(renderer.getContext() as WebGL2RenderingContext);
  const gpuTotal = timer
    ? await timer.time(() => {
        for (let i = 0; i < BATCH; i++) draw();
      })
    : null;

  // Taken separately from the GPU batch: wrapping the same renders in a query
  // makes the driver flush differently, and the wall time then measures the
  // instrumentation as much as the work.
  const t0 = performance.now();
  for (let i = 0; i < BATCH; i++) draw();
  const cpuMs = (performance.now() - t0) / BATCH;

  const gpuMs = gpuTotal === null ? null : gpuTotal / BATCH;
  const stats = sceneStats(renderer, scene);

  // The frame belongs to whichever side is slower — they overlap, so they do
  // not add. Where the GPU could not be measured, CPU is the only floor known.
  const frameMs = Math.max(cpuMs, gpuMs ?? 0);

  return {
    fps: frameMs > 0 ? Math.round(1000 / frameMs) : 0,
    cpuMs: +cpuMs.toFixed(3),
    gpuMs: gpuMs === null ? null : +gpuMs.toFixed(3),
    ...stats,
  };
}
