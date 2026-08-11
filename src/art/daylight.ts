import * as THREE from "three";
import { PALETTE } from "./palette";

/**
 * Time of day, and the sky that goes with it.
 *
 * The clock is real: one simulated second is one second of the day, so at 1x
 * the light matches the wall clock and the level opens at whatever time the
 * player actually started it. That also means a whole cycle at 1x takes a whole
 * day — the sim's own speed control is what turns it into a time-lapse, which
 * is the right handle for it (10x is a comfortable dusk, 100x is a full day in
 * a quarter of an hour).
 */

/** Simulated seconds per second of the day. 1 = real time at 1x. */
export const TIME_SCALE = 25;

/** Seconds since local midnight when the page loaded. */
const START_OF_DAY = (() => {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
})();

/** Where the clock sits when the day/night cycle is switched off. */
export const PINNED_HOUR = 12;

/** Hours past midnight, 0..24, for a point on the simulation clock. */
export function hourOfDay(simSeconds: number): number {
  return ((((START_OF_DAY + simSeconds * TIME_SCALE) / 3600) % 24) + 24) % 24;
}

export function formatHour(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * One keyframe of sky. Everything between them is interpolated, so the whole
 * look of the game at any hour is edited here and nowhere else.
 */
type SkyKey = {
  /** Hours past midnight this key describes. */
  hour: number;
  /** Key light — the sun, or the moon once it is below the horizon. */
  sun: string;
  sunIntensity: number;
  /** Hemisphere fill, which does most of the work in this art direction. */
  sky: string;
  ground: string;
  fill: number;
  /** Backdrop, and the fog that fades the far side of the map into it. */
  air: string;
  /** 0 = clear, 1 = as thick as this style ever gets. */
  haze: number;
  /** Drives everything that switches on after dark: headlights, windows. */
  night: number;
};

/*
 * Daylight keeps the locked palette exactly as it was — noon is the reference
 * the whole game was drawn against. Every other hour is a departure from it,
 * and the departures are what the cycle is for.
 */
const KEYS: SkyKey[] = [
  {
    hour: 0,
    sun: "#A8BEE4",
    sunIntensity: 0.2,
    sky: "#33405F",
    ground: "#1C2331",
    fill: 0.6,
    air: "#1B2233",
    haze: 0.5,
    night: 1,
  },
  {
    hour: 4.6,
    sun: "#A8BEE4",
    sunIntensity: 0.2,
    sky: "#3B4767",
    ground: "#20283A",
    fill: 0.7,
    air: "#26304A",
    haze: 0.62,
    night: 1,
  },
  {
    hour: 6.1,
    sun: "#E09A72",
    sunIntensity: 0.3,
    sky: "#7C7E9C",
    ground: "#5E5560",
    fill: 1.15,
    air: "#8A7E92",
    haze: 0.78,
    night: 0.55,
  },
  {
    hour: 7.1,
    sun: "#FFB98A",
    sunIntensity: 0.55,
    sky: "#C6C4C8",
    ground: "#B0A79E",
    fill: 1.7,
    air: "#D3BCAE",
    haze: 0.55,
    night: 0,
  },
  {
    hour: 9,
    sun: "#FFECD6",
    sunIntensity: 0.55,
    sky: "#FFFFFF",
    ground: "#E8E4DC",
    fill: 2.0,
    air: "#DFDCD6",
    haze: 0.2,
    night: 0,
  },
  {
    hour: 13,
    sun: "#FFFFFF",
    sunIntensity: 0.55,
    sky: "#FFFFFF",
    ground: "#E8E4DC",
    fill: 2.1,
    air: PALETTE.background,
    haze: 0.12,
    night: 0,
  },
  {
    hour: 17,
    sun: "#FFF0DA",
    sunIntensity: 0.56,
    sky: "#FDFBF6",
    ground: "#E6E0D4",
    fill: 2.0,
    air: "#E1DACE",
    haze: 0.22,
    night: 0,
  },
  {
    hour: 19.4,
    sun: "#FFC489",
    sunIntensity: 0.62,
    sky: "#F2DFC9",
    ground: "#D6CBBC",
    fill: 1.55,
    air: "#E3C6AC",
    haze: 0.42,
    night: 0,
  },
  {
    hour: 20.5,
    sun: "#FF8F52",
    sunIntensity: 0.5,
    sky: "#C3ADB4",
    ground: "#84767E",
    fill: 1.1,
    air: "#C2967F",
    haze: 0.72,
    night: 0.25,
  },
  {
    hour: 21.4,
    sun: "#8E8FC4",
    sunIntensity: 0.26,
    sky: "#6A6F94",
    ground: "#3E4258",
    fill: 0.8,
    air: "#6E7089",
    haze: 0.76,
    night: 0.8,
  },
  {
    hour: 22.6,
    sun: "#A8BEE4",
    sunIntensity: 0.2,
    sky: "#33405F",
    ground: "#1C2331",
    fill: 0.6,
    air: "#1B2233",
    haze: 0.5,
    night: 1,
  },
  // Wraps to hour 0. Kept explicit so the interpolation never special-cases
  // midnight.
  {
    hour: 24,
    sun: "#A8BEE4",
    sunIntensity: 0.2,
    sky: "#33405F",
    ground: "#1C2331",
    fill: 0.6,
    air: "#1B2233",
    haze: 0.5,
    night: 1,
  },
];

/** Mutable sample, written every frame. Allocating one of these per frame at
 * 120fps is exactly the kind of garbage that shows up as stutter. */
export type Daylight = {
  sunDir: THREE.Vector3;
  sun: THREE.Color;
  sunIntensity: number;
  sky: THREE.Color;
  ground: THREE.Color;
  fill: number;
  air: THREE.Color;
  haze: number;
  night: number;
};

export function emptyDaylight(): Daylight {
  return {
    sunDir: new THREE.Vector3(0.4, 0.8, 0.45),
    sun: new THREE.Color("#FFFFFF"),
    sunIntensity: 0.55,
    sky: new THREE.Color("#FFFFFF"),
    ground: new THREE.Color("#E8E4DC"),
    fill: 2.1,
    air: new THREE.Color(PALETTE.background),
    haze: 0.12,
    night: 0,
  };
}

/**
 * Shared read-only-ish view of the current sky, for the handful of things that
 * need it outside the light rig — headlights, mostly. Written once per frame by
 * `<Daylight>`; read, never written, by everyone else.
 */
export const SKY: Daylight = emptyDaylight();

const A = new THREE.Color();
const B = new THREE.Color();

/**
 * The key light's direction at a given hour.
 *
 * The sun rises in the east and sets in the west, and once it is down the moon
 * takes over from the opposite side — so the shadows swing right through the
 * day and then jump across at dusk, which is most of what makes the cycle
 * readable at a glance.
 *
 * The elevation is floored well above the horizon. A physically correct sun at
 * 07:00 throws shadows a hundred metres long across the map and buries half the
 * network in them; the point here is a legible model, not an ephemeris.
 */
function sunDirection(hours: number, out: THREE.Vector3): THREE.Vector3 {
  // 0 at sunrise (06:00), π at sunset (18:00), then straight on into the night.
  const t = ((hours - 6) / 12) * Math.PI;
  const elevation = Math.sin(t);
  const up = 0.28 + Math.abs(elevation) * 0.62;
  /*
   * cos(t) runs +1 (east) to -1 (west) across the day, and back again at night,
   * which is the moon travelling the other way. It also passes through zero at
   * noon — a sun directly overhead, casting every shadow straight down under the
   * thing that cast it. The constant southward bias is what keeps a real shadow
   * on the ground at midday, and it is the same lie every architectural render
   * tells.
   */
  return out.set(Math.cos(t), up, 0.75).normalize();
}

/** Sample the sky at `hours` past midnight into `out`. */
export function sampleDaylight(hours: number, out: Daylight): Daylight {
  const h = ((hours % 24) + 24) % 24;

  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].hour <= h) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const span = b.hour - a.hour;
  const k = span > 0 ? THREE.MathUtils.clamp((h - a.hour) / span, 0, 1) : 0;
  // Smoothstep: linear ramps between keys put a visible crease in the sky at
  // every keyframe, and dawn is exactly where that would be most obvious.
  const t = k * k * (3 - 2 * k);

  out.sun.lerpColors(A.set(a.sun), B.set(b.sun), t);
  out.sky.lerpColors(A.set(a.sky), B.set(b.sky), t);
  out.ground.lerpColors(A.set(a.ground), B.set(b.ground), t);
  out.air.lerpColors(A.set(a.air), B.set(b.air), t);
  out.sunIntensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t);
  out.fill = THREE.MathUtils.lerp(a.fill, b.fill, t);
  out.haze = THREE.MathUtils.lerp(a.haze, b.haze, t);
  out.night = THREE.MathUtils.lerp(a.night, b.night, t);
  sunDirection(h, out.sunDir);

  return out;
}
