import type { SiteMeta } from "../types";

/**
 * Local metres → Mars 2000 planetocentric longitude / latitude (degrees, east-positive).  The walk area
 * is an equirectangular projection with lat_ts = 0, so both axes are linear in the corner bounds.
 */
export function toLonLat(site: SiteMeta, x: number, y: number): [number, number] {
  const b = site.boundsLonLat;
  return [b.west + (x / site.sizeM) * (b.east - b.west), b.south + (y / site.sizeM) * (b.north - b.south)];
}
