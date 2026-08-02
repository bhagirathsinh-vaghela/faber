// Client-side image normalization for message attachments.
//
// Uses the browser-native createImageBitmap -> canvas -> toBlob("image/jpeg")
// pipeline (the same technique libraries like browser-image-compression and
// compressorjs wrap). No dependencies.
//
// Mirrors the server's clamp so the upload is small too. The server re-checks
// and no-ops on anything already compliant.

// Above 20 images per request the provider caps every image at 2000px on its
// long edge, and visual tokens are a function of dimensions alone.
const MAX_DIMENSION = 2000
// Re-encoding costs the model nothing and buys only wire bytes, so quality is
// set at the measured knee for screenshot text rather than to hit a byte
// target: below it glyph edges smear faster than bytes fall.
const QUALITY = 0.92

export async function compress(file: File) {
  const bitmap = await createImageBitmap(file)

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    bitmap.close()
    return file
  }
  // JPEG has no alpha channel, so transparent source pixels composite against
  // the canvas default (transparent black) and render black. Paint white first.
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const blob = await encode(canvas, QUALITY)
  if (!blob) return file
  // A tiny source can encode larger as JPEG than it arrived; keeping the
  // original is both smaller and lossless, and the server clamps either way.
  if (scale === 1 && blob.size >= file.size) return file

  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg"
  return new File([blob], name, { type: "image/jpeg" })
}

function encode(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality))
}
