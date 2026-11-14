import type { TerrainGrid } from "../data/grid";

const tops = new WeakMap<TerrainGrid, number>();
function highest(grid: TerrainGrid): number {
  let z = tops.get(grid);
  if (z === undefined) {
    z = -Infinity;
    for (let i = 0; i < grid.height.length; i++) if (grid.height[i] > z) z = grid.height[i];
    tops.set(grid, z);
  }
  return z;
}

/**
 * Is a point in the shadow of the terrain?  March from the point toward the Sun across the elevation
 * grid (4 m steps, out to 2 km or the edge of the walk area) and look for ground above the sun ray.
 * `eyeM` lifts the start point (a suited person's chest, so pebbles do not count).
 */
export function inTerrainShadow(grid: TerrainGrid, x: number, y: number, elevationDeg: number, azimuthDeg: number, eyeM = 1.2): boolean {
  if (elevationDeg <= 0) return true;
  const az = (azimuthDeg * Math.PI) / 180;
  const dx = Math.sin(az); // azimuth clockwise from north: east = +x, north = +y
  const dy = Math.cos(az);
  const rise = Math.tan((elevationDeg * Math.PI) / 180);
  const z0 = grid.heightAt(x, y) + eyeM;
  const zMax = highest(grid);
  const step = 2 * grid.cell;
  for (let d = step; d <= 2000; d += step) {
    const px = x + dx * d;
    const py = y + dy * d;
    if (!grid.inside(px, py)) return false;
    const ray = z0 + d * rise;
    if (ray > zMax) return false; // above every hill in the area
    if (grid.heightAt(px, py) > ray) return true;
  }
  return false;
}
