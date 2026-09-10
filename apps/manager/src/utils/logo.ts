const LOGO_MAX_EDGE_PX = 512;
const LOGO_MAX_DATA_URL_CHARS = 1_500_000;

function canvasToDataUrl(canvas: HTMLCanvasElement, mimeType: string): string {
  return canvas.toDataURL(mimeType, 0.92);
}

/**
 * Decode an image file and re-encode it as a compact `data:` URL that fits in
 * store settings (the settings row — and therefore the logo — syncs to the
 * cloud; rows in the images table do not).
 */
export async function fileToLogoDataUrl(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024)
    throw new Error('Choose an image smaller than 8 MB.');
  if (!/^image\/(png|jpeg|webp|gif|bmp|x-icon|svg\+xml)$/.test(file.type))
    throw new Error('Choose a PNG, JPEG or WebP image.');

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file could not be read as an image.');
  });
  const scale = Math.min(
    1,
    LOGO_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not process that image.');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG keeps transparency; fall back to JPEG if the logo is too detailed.
  let dataUrl = canvasToDataUrl(canvas, 'image/png');
  if (dataUrl.length > LOGO_MAX_DATA_URL_CHARS)
    dataUrl = canvasToDataUrl(canvas, 'image/jpeg');
  if (dataUrl.length > LOGO_MAX_DATA_URL_CHARS)
    throw new Error('That image is too detailed — try a simpler logo.');
  return dataUrl;
}
