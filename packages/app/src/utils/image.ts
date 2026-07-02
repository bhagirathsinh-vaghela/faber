// Client-side image compression for message attachments.
//
// Uses the browser-native createImageBitmap -> canvas -> toBlob("image/jpeg")
// pipeline (the same technique libraries like browser-image-compression and
// compressorjs wrap) so screenshots don't blow past the provider's request
// size limit. No dependencies.

const MAX_DIMENSION = 2000 // px, longest edge
const TARGET_BYTES = 1_000_000 // aim for <1MB encoded
const MIN_QUALITY = 0.5
const START_QUALITY = 0.85

export async function compress(file: File) {
  const bitmap = await createImageBitmap(file)

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return file
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  let quality = START_QUALITY
  let blob = await encode(canvas, quality)
  while (blob && blob.size > TARGET_BYTES && quality > MIN_QUALITY) {
    quality -= 0.1
    blob = await encode(canvas, quality)
  }
  if (!blob) return file

  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg"
  return new File([blob], name, { type: "image/jpeg" })
}

function encode(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality))
}
