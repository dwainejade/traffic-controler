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

/** Local calendar day the page loaded on, as a day number. Seeds the weather. */
const START_DAY = (() => {
  const now = new Date();
  return Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000,
  );
})();

/** Where the clock sits when the day/night cycle is switched off. */
export const PINNED_HOUR = 12;

/** Hours past midnight, 0..24, for a point on the simulation clock. */
export function hourOfDay(simSeconds: number): number {
  return ((((START_OF_DAY + simSeconds * TIME_SCALE) / 3600) % 24) + 24) % 24;
}

/** Which day of the cycle a point on the simulation clock falls on. */
export function dayOfSim(simSeconds: number): number {
  return START_DAY + Math.floor((START_OF_DAY + simSeconds * TIME_SCALE) / 86400);
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
 * The colours track what the sky actually does over a day rather than tinting
 * the locked palette: the moonlit night is a near-black navy, dawn and dusk pass
 * through a cold blue hour on either side of a warm, saturated sun, and full
 * daylight is a pale desaturated blue — hazy horizon blue, not white, because
 * the backdrop is the far horizon and that is the colour it takes. `air` is the
 * backdrop and the fog; `sky`/`ground` are the hemisphere fill, so they carry
 * the blue skylight and the warm bounce off the ground.
 */
const NIGHT_SUN = "#9FB4D8"; // Moonlight: sunlight, twice reflected and cold.
const NIGHT_SKY = "#28344E";
const NIGHT_GROUND = "#121926";
const NIGHT_AIR = "#0D1424";

const KEYS: SkyKey[] = [
  {
    hour: 0,
    sun: NIGHT_SUN,
    sunIntensity: 0.17,
    sky: NIGHT_SKY,
    ground: NIGHT_GROUND,
    fill: 0.5,
    air: NIGHT_AIR,
    haze: 0.42,
    night: 1,
  },
  {
    hour: 3.4,
    sun: "#93A9CE",
    sunIntensity: 0.15,
    sky: "#232F47",
    ground: "#0F1622",
    fill: 0.46,
    air: "#0A111E",
    haze: 0.46,
    night: 1,
  },
  // Astronomical dawn: the east lifts off black before anything else changes.
  {
    hour: 4.9,
    sun: "#93A9CE",
    sunIntensity: 0.18,
    sky: "#33456B",
    ground: "#1A2331",
    fill: 0.62,
    air: "#1B2A46",
    haze: 0.58,
    night: 1,
  },
  // Blue hour. The sun is still under the horizon, so the only light is the
  // scattered blue overhead — the coldest, most saturated moment of the day.
  {
    hour: 5.7,
    sun: "#7C8FC9",
    sunIntensity: 0.24,
    sky: "#52709E",
    ground: "#323F59",
    fill: 0.98,
    air: "#3F5F8C",
    haze: 0.7,
    night: 0.7,
  },
  // Sunrise. Long path through the atmosphere, so the direct light is orange
  // and the horizon behind it is peach while the sky above stays blue.
  {
    hour: 6.4,
    sun: "#FF9152",
    sunIntensity: 0.44,
    sky: "#8FA6C6",
    ground: "#6C6470",
    fill: 1.35,
    air: "#D69A79",
    haze: 0.78,
    night: 0.28,
  },
  {
    hour: 7.3,
    sun: "#FFC48F",
    sunIntensity: 0.55,
    sky: "#BFD2E8",
    ground: "#ACA79E",
    fill: 1.72,
    air: "#D8CFC8",
    haze: 0.55,
    night: 0,
  },
  {
    hour: 9,
    sun: "#FFEBD2",
    sunIntensity: 0.56,
    sky: "#D8E7F7",
    ground: "#E2DED5",
    fill: 2.0,
    air: "#CCDAE7",
    haze: 0.26,
    night: 0,
  },
  // Midday. Zenith blue is far stronger than this, but the backdrop is the
  // horizon, where scattering has washed most of the colour back out.
  {
    hour: 13,
    sun: "#FFFDF7",
    sunIntensity: 0.58,
    sky: "#CFE0F5",
    ground: PALETTE.background,
    fill: 2.1,
    air: "#CEDCE8",
    haze: 0.15,
    night: 0,
  },
  {
    hour: 17,
    sun: "#FFF3DF",
    sunIntensity: 0.56,
    sky: "#D4E1F0",
    ground: "#E4DED2",
    fill: 2.0,
    air: "#D2DBE2",
    haze: 0.24,
    night: 0,
  },
  // Golden hour.
  {
    hour: 19.2,
    sun: "#FFC178",
    sunIntensity: 0.62,
    sky: "#E9D9C6",
    ground: "#D3C7B6",
    fill: 1.6,
    air: "#E6C69C",
    haze: 0.42,
    night: 0,
  },
  {
    hour: 20.3,
    sun: "#FF7A3C",
    sunIntensity: 0.5,
    sky: "#C29CA6",
    ground: "#7E7078",
    fill: 1.1,
    air: "#DA8A5C",
    haze: 0.68,
    night: 0.22,
  },
  // Afterglow: the sun is down, the underside of the air is still lit, and the
  // magenta band sits between the warm west and the blue east.
  {
    hour: 21.1,
    sun: "#B0779C",
    sunIntensity: 0.3,
    sky: "#7A7BA4",
    ground: "#444962",
    fill: 0.85,
    air: "#8A6E86",
    haze: 0.74,
    night: 0.6,
  },
  {
    hour: 21.9,
    sun: "#7C8FC9",
    sunIntensity: 0.22,
    sky: "#47598A",
    ground: "#293148",
    fill: 0.62,
    air: "#35476E",
    haze: 0.64,
    night: 0.9,
  },
  {
    hour: 23,
    sun: NIGHT_SUN,
    sunIntensity: 0.17,
    sky: NIGHT_SKY,
    ground: NIGHT_GROUND,
    fill: 0.5,
    air: NIGHT_AIR,
    haze: 0.42,
    night: 1,
  },
  // Wraps to hour 0. Kept explicit so the interpolation never special-cases
  // midnight.
  {
    hour: 24,
    sun: NIGHT_SUN,
    sunIntensity: 0.17,
    sky: NIGHT_SKY,
    ground: NIGHT_GROUND,
    fill: 0.5,
    air: NIGHT_AIR,
    haze: 0.42,
    night: 1,
  },
];

/**
 * Weather, one draw per day.
 *
 * The keyframes above describe a fair day. Real air does not repeat: some
 * mornings the map sits in fog until nine, some days are glass-clear to the
 * horizon, and most are somewhere in between. Everything here is a pure function
 * of the day number, so the same day always looks the same — the player can be
 * told "it's foggy today" and have that stay true — while each new day redraws.
 */
export type Weather = {
  /** Multiplier on the day's base haze. Below 1 is a clear day. */
  hazeScale: number;
  /** Radiation fog that pools overnight and burns off after sunrise, 0..1. */
  morningFog: number;
  /** Moisture that thickens as the ground cools again after sunset, 0..1. */
  eveningHaze: number;
  /** Phase of the slow within-day drift, so no two days breathe together. */
  drift: number;
};

/** Deterministic 0..1 from an integer. Cheap hash, not a real PRNG. */
function hash01(n: number, salt: number): number {
  const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

let cachedDay = Number.NaN;
let cachedWeather: Weather = {
  hazeScale: 1,
  morningFog: 0,
  eveningHaze: 0,
  drift: 0,
};

export function weatherForDay(day: number): Weather {
  if (day === cachedDay) return cachedWeather;

  const clarity = hash01(day, 1);
  const damp = hash01(day, 2);
  const evening = hash01(day, 3);

  cachedDay = day;
  cachedWeather = {
    // Skewed low: most days are clearer than the keyframes, and the thick ones
    // are rare enough to still be an event when they land. The ceiling stays
    // near 1 — above that the map stops reading and the fog is all you see.
    hazeScale: 0.5 + clarity * clarity * 0.8,
    // Only the damper third of days fog over at all, and then by degrees.
    morningFog: damp > 0.62 ? ((damp - 0.62) / 0.38) ** 0.8 : 0,
    eveningHaze: evening > 0.5 ? (evening - 0.5) * 1.1 : 0,
    drift: hash01(day, 4) * Math.PI * 2,
  };
  return cachedWeather;
}

/** Bell centred on `peak`, ~1 at the peak and ~0 `width` hours either side. */
function bell(hours: number, peak: number, width: number): number {
  const d = (hours - peak) / width;
  return Math.exp(-d * d);
}

/**
 * The haze at an hour on a given day: the keyframed base, scaled by how clear
 * the day is, wobbled slowly so it is never quite still, then banked up at the
 * two times of day when real fog actually forms.
 */
function hazeAt(base: number, hours: number, weather: Weather): number {
  const drift = 1 + 0.1 * Math.sin(hours * 0.9 + weather.drift);
  // Thickest just before sunrise, gone by mid-morning — the asymmetry is the
  // whole character of it, so it is two half-bells rather than one.
  const dawn =
    hours < 6.4 ? bell(hours, 6.4, 3.6) : bell(hours, 6.4, 1.9);
  const dusk = bell(hours, 21.5, 2.6);
  return THREE.MathUtils.clamp(
    base * weather.hazeScale * drift +
      dawn * weather.morningFog * 0.28 +
      dusk * weather.eveningHaze * 0.15,
    0.02,
    0.9,
  );
}

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

/**
 * The colour thick fog takes: it is lit by the whole sky at once, so it loses
 * the sky's saturation and pulls everything towards a flat grey.
 */
const FOG_TINT = new THREE.Color("#C3C7CB");
const NIGHT_FOG_TINT = new THREE.Color("#2A3242");
const TINT = new THREE.Color();

/**
 * Sample the sky at `hours` past midnight into `out`. `day` picks the weather —
 * pass the day number from `dayOfSim` so the fog changes from one day to the
 * next.
 */
export function sampleDaylight(
  hours: number,
  out: Daylight,
  day = 0,
): Daylight {
  const h = ((hours % 24) + 24) % 24;
  const weather = weatherForDay(day);

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
  out.night = THREE.MathUtils.lerp(a.night, b.night, t);

  const base = THREE.MathUtils.lerp(a.haze, b.haze, t);
  out.haze = hazeAt(base, h, weather);
  /*
   * Push the backdrop towards fog grey by however much thicker the air is than
   * the keyframe expected. A clear day is left exactly as authored; a fogged-in
   * morning goes flat and colourless, which is what sells it as fog rather than
   * as a tinted background.
   */
  const excess = THREE.MathUtils.clamp(out.haze - base, 0, 0.6) / 0.6;
  if (excess > 0) {
    TINT.copy(NIGHT_FOG_TINT).lerp(FOG_TINT, 1 - out.night);
    out.air.lerp(TINT, excess * 0.55);
  }

  sunDirection(h, out.sunDir);

  return out;
}
