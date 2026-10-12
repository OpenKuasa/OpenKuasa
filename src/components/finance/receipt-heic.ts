'use client';

/**
 * Turns a phone's HEIC or HEIF photo into a JPG in the browser: first with
 * the browser's own decoder (Safari has one; Chrome and Firefox do not), then
 * with a decoder library loaded on demand. Null means "could not": the caller
 * then uploads the original, which is stored as it is and offered as a
 * download, with no preview.
 *
 * Either way the JPG is drawn afresh from the decoded pixels, so it carries
 * none of the photo's metadata (no location, no device).
 */

const JPEG_QUALITY = 0.9;
/** Longest side of the JPG. A 12-megapixel photo is 4032; anything larger is scaled down to this. */
const MAX_SIDE = 4096;

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

/** With the browser's own decoder. */
async function withBrowserDecoder(file: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    bitmap = await createImageBitmap(file);
    if (!(bitmap.width > 0 && bitmap.height > 0)) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const drawing = canvas.getContext('2d');
    if (!drawing) return null;
    // A JPG has no transparency: paint white first.
    drawing.fillStyle = '#ffffff';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas);
  } catch {
    return null;
  } finally {
    bitmap?.close();
    // Let the pixels go now: a queue of large photos would otherwise hold them until the collector runs (Safari caps canvas memory).
    if (canvas) canvas.width = canvas.height = 0;
  }
}

/**
 * With the decoder library, for browsers that have none of their own. It is
 * fetched only here, the first time someone picks a HEIC that the browser
 * could not decode: nobody else downloads it (about 0.8 MB compressed). The
 * `csp` build runs as plain JavaScript, with no WebAssembly and no eval, so
 * it works under the site's Content-Security-Policy as it is.
 */
async function withLibrary(file: Blob): Promise<Blob | null> {
  try {
    const { heicTo } = await import('heic-to/csp');
    return await heicTo({ blob: file, type: 'image/jpeg', quality: JPEG_QUALITY });
  } catch {
    return null;
  }
}

/** A JPG made from a HEIC or HEIF, or null when this browser cannot make one. Never throws. */
export async function heicToJpeg(file: Blob): Promise<Blob | null> {
  const own = await withBrowserDecoder(file);
  if (own && own.size > 0) return own;
  const made = await withLibrary(file);
  return made && made.size > 0 ? made : null;
}
