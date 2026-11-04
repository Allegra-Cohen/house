// ---------------------------------------------------------------------------
// imageCrop — find the opaque content bounds of a (transparent-margined) PNG,
// so off-center drawings can be rendered centered, both on the canvas and as
// toolbar thumbnails.
// ---------------------------------------------------------------------------

// The content bounding box of a drawing, in the image's own pixels.
export type ContentBox = { sx: number; sy: number; sw: number; sh: number };

/** Find the opaque content bounds of an image by probing a downscaled copy. */
export function measureContentBox(img: HTMLImageElement): ContentBox | null {
  const S = 256; // a few source pixels of slop is plenty for centering
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, S, S);
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(0, 0, S, S).data;
  } catch {
    return null; // tainted canvas (won't happen for same-origin images)
  }
  let minX = S, minY = S, maxX = -1, maxY = -1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (data[(y * S + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent
  const kx = img.naturalWidth / S;
  const ky = img.naturalHeight / S;
  return { sx: minX * kx, sy: minY * ky, sw: (maxX - minX + 1) * kx, sh: (maxY - minY + 1) * ky };
}
