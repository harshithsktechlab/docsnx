/**
 * Turn an already-drawable image by quarter turns, for the preview pane.
 *
 * Done on a canvas rather than with a CSS transform so the result is simply a
 * different image: `max-h-full max-w-full object-contain` then fits a sideways
 * scan exactly as it fits an upright one. A transform leaves the layout box at
 * the unrotated size and a portrait page turned landscape spills out of the
 * dialog.
 *
 * Loaded through an <img> and not fetch(): the page already draws these blob
 * URLs, so img-src is known to allow them, and nothing here widens connect-src.
 *
 * `degrees` is clockwise and a multiple of 90. Resolves a NEW blob URL the
 * caller must revoke; rejects when the browser cannot decode or encode the
 * image (a canvas has a size ceiling on phones), in which case the caller
 * keeps showing the original.
 */
export function rotateImageUrl(src: string, degrees: number): Promise<string> {
  const turns = (((Math.round(degrees / 90) % 4) + 4) % 4);
  if (turns === 0) return Promise.resolve(src);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const sideways = turns % 2 === 1;
        const canvas = document.createElement('canvas');
        canvas.width = sideways ? img.naturalHeight : img.naturalWidth;
        canvas.height = sideways ? img.naturalWidth : img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No 2d canvas');
        // JPEG has no alpha; a transparent PNG would otherwise turn black.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((turns * Math.PI) / 2);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
        canvas.toBlob((blob) => {
          if (blob) resolve(URL.createObjectURL(blob));
          else reject(new Error('Could not encode the rotated image'));
        }, 'image/jpeg', 0.92);
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => reject(new Error('Could not decode the image'));
    img.src = src;
  });
}
