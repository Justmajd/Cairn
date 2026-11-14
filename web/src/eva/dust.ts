/**
 * Dust storms.  The rovers measure how much dust is in the air above them as the optical depth τ ("tau"):
 * their cameras image the Sun and compare its brightness with what it would be through clean air.
 * Light through the whole atmosphere is dimmed by e^(−τ / sin(Sun elevation)).
 *
 * The presets are measured values, not a model:
 *   - Jezero, January 2022: Perseverance's Mastcam-Z saw τ rise from under 0.4 (sol 312) to almost 1.4
 *     (sol 316) as a regional storm passed, and fall back to 0.4 by sol 319.
 *   - Gale, June 2018: during the global dust storm Curiosity's Mastcam measured τ above 8.0 (sol ~2084),
 *     the highest the mission has recorded (NASA/JPL, 2018; Guzewich et al. 2019, GRL).
 *   - Meridiani, June 2018: the same storm reached τ ≈ 10.8 over Opportunity, which then lost power and
 *     never woke again.
 *
 * What CAIRN draws from τ (a rendering model, see the assumptions sheet):
 *   - direct sunlight e^(−Δτ / μ), μ = sine of the Sun's elevation (Δτ above a clear-day τ of 0.5);
 *   - sky light e^(−0.18 Δτ): scattered light holds up better than the direct beam, then dims too;
 *   - horizontal visibility 3.9 / k with k = τ / H, dust well mixed through a scale height H of 11 km.
 * The 3D view then adapts its exposure as an eye or a camera would (it shows about √ of the drop in light).
 */
export interface DustPreset {
  id: string;
  name: string;
  tau: number;
  where: string;
}

export const CLEAR_TAU = 0.5;
export const DUST_SCALE_HEIGHT_M = 11_000;

export const DUST_PRESETS: DustPreset[] = [
  { id: "clear", name: "Clear", tau: 0.4, where: "Jezero, sol 312 (Perseverance Mastcam-Z), a typical clear day" },
  { id: "regional", name: "Regional storm", tau: 1.4, where: "Jezero, sol 316, January 2022 (Perseverance Mastcam-Z)" },
  { id: "global", name: "Global storm", tau: 8, where: "Gale, June 2018 (Curiosity Mastcam: above 8, its highest ever)" },
  { id: "extreme", name: "Opportunity's last", tau: 10.8, where: "Meridiani, June 2018 (Opportunity Pancam), the storm that ended its mission" },
];

export interface DustEffect {
  tau: number;
  /** Direct sunlight relative to a clear day, 0..1. */
  direct: number;
  /** Sky light relative to a clear day, 0..1. */
  diffuse: number;
  /** All the light on level ground relative to a clear day at the same Sun elevation, 0..1. */
  sunlight: number;
  /** Distance at which a dark landmark fades into the haze (2% contrast), metres. */
  visibilityM: number;
  /** Extinction coefficient near the ground, per metre (for the 3D haze). */
  extinction: number;
}

/** What a dust optical depth `tau` does to light and visibility with the Sun `sunElevationDeg` up. */
export function dustEffect(tau: number, sunElevationDeg: number): DustEffect {
  const ex = Math.max(0, tau - CLEAR_TAU);
  const mu = Math.max(0.08, Math.sin((Math.max(0, sunElevationDeg) * Math.PI) / 180));
  const direct = Math.exp(-ex / mu);
  const diffuse = Math.exp(-0.18 * ex);
  // the same weights as the terrain lighting (scene/terrain.ts marsLight): sky 0.36, Sun 0.88 · μ
  const sunlight = (0.36 * diffuse + 0.88 * mu * direct) / (0.36 + 0.88 * mu);
  const extinction = tau / DUST_SCALE_HEIGHT_M;
  return { tau, direct, diffuse, sunlight, visibilityM: 3.912 / extinction, extinction };
}

export function fmtVisibility(m: number): string {
  return m >= 100_000 ? "over 100 km" : m >= 10_000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`;
}
