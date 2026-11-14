import * as THREE from "three";

let flipWorks: Promise<boolean> | null = null;
/** Does this engine honour ImageBitmap's imageOrientation: "flipY"?  (Some ignore it: the map would be upside down.) */
function bitmapFlipWorks(): Promise<boolean> {
  return (flipWorks ??= (async () => {
    try {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 2;
      const g = c.getContext("2d")!;
      g.fillStyle = "#f00";
      g.fillRect(0, 0, 1, 1); // top red
      g.fillStyle = "#00f";
      g.fillRect(0, 1, 1, 1); // bottom blue
      const b = await createImageBitmap(c, { imageOrientation: "flipY" });
      const d = document.createElement("canvas");
      d.width = 1;
      d.height = 2;
      const h = d.getContext("2d")!;
      h.drawImage(b, 0, 0);
      b.close();
      return h.getImageData(0, 0, 1, 1).data[2] > 128; // flipped: blue on top
    } catch {
      return false;
    }
  })());
}

/**
 * Load an image as a texture, decoded off the main thread (ImageBitmap): an 8192 px image decoded
 * through an <img> blocks the page for ~0.7 s when it is first drawn, an ImageBitmap for ~0.08 s.
 * Same pixels: no colour conversion, flipped like TextureLoader's default.  Falls back to <img>.
 */
export async function loadTexture(url: string): Promise<THREE.Texture> {
  if (typeof createImageBitmap === "function" && (await bitmapFlipWorks())) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
    const blob = await res.blob();
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false; // already flipped while decoding
      texture.needsUpdate = true;
      return texture;
    } catch {
      // older engines without ImageBitmap options: fall through to <img>
    }
  }
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`Could not load ${url}`)));
  });
}

