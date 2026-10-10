import { deflateSync } from "zlib"

type Color = readonly [number, number, number]
type Rect = { x: number; y: number; w: number; h: number; color: Color }

const BG: Color = [0x13, 0x10, 0x10]
const WHITE: Color = [0xff, 0xff, 0xff]

// The F mark (packages/ui/src/assets/favicon/favicon-v3.svg) on its 512 grid.
const LOGO: Rect[] = [
  { x: 128, y: 96, w: 64, h: 320, color: WHITE },
  { x: 128, y: 96, w: 256, h: 64, color: WHITE },
  { x: 128, y: 224, w: 192, h: 64, color: WHITE },
]

// 5x7 pixel font, blocky to match the mark.
const FONT: Record<string, string[]> = {
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  D: ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "#####"],
  J: ["  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "],
  K: ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
  N: ["#   #", "#   #", "##  #", "# # #", "#  ##", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  Q: [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "# # #", "# # #", "# # #", " # # "],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  Y: ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
}

// A choice: the labelled logo shrinks to 3/4 so a 5-letter host name can sit
// under it at 12 units per font pixel, large enough to read in the macOS Dock.
const SCALE = 0.75
const GAP = 40
const PIXEL = 12
const WIDTH = 416

function shapes(label: string): Rect[] {
  const text = [...label.toUpperCase()].map((char) => FONT[char])
  const pixel = Math.min(PIXEL, Math.floor(WIDTH / (text.length * 6 - 1)))
  const top = (512 - (320 * SCALE + GAP + 7 * pixel)) / 2
  const logo = LOGO.map((rect) => ({
    x: 256 - 128 * SCALE + (rect.x - 128) * SCALE,
    y: top + (rect.y - 96) * SCALE,
    w: rect.w * SCALE,
    h: rect.h * SCALE,
    color: rect.color,
  }))
  const left = (512 - (text.length * 6 - 1) * pixel) / 2
  const baseline = top + 320 * SCALE + GAP
  const glyphs = text.flatMap((rows, index) =>
    (rows ?? []).flatMap((row, y) =>
      [...row].flatMap((cell, x) =>
        cell === "#"
          ? [{ x: left + (index * 6 + x) * pixel, y: baseline + y * pixel, w: pixel, h: pixel, color: WHITE }]
          : [],
      ),
    ),
  )
  return [{ x: 0, y: 0, w: 512, h: 512, color: BG }, ...logo, ...glyphs]
}

// Rects are filled on a 4x canvas, then box-filtered down, so edges that fall
// between output pixels antialias instead of snapping.
const SUPERSAMPLE = 4

function raster(size: number, rects: Rect[]) {
  const side = size * SUPERSAMPLE
  const canvas = new Uint8Array(side * side * 3)
  const at = (unit: number) => Math.round((unit * side) / 512)
  for (const rect of rects) {
    for (let y = at(rect.y); y < at(rect.y + rect.h); y++) {
      for (let x = at(rect.x); x < at(rect.x + rect.w); x++) canvas.set(rect.color, (y * side + x) * 3)
    }
  }
  const pixels = new Uint8Array(size * size * 3)
  const area = SUPERSAMPLE * SUPERSAMPLE
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0
        for (let dy = 0; dy < SUPERSAMPLE; dy++) {
          for (let dx = 0; dx < SUPERSAMPLE; dx++)
            sum += canvas[((y * SUPERSAMPLE + dy) * side + x * SUPERSAMPLE + dx) * 3 + channel]
        }
        pixels[(y * size + x) * 3 + channel] = Math.round(sum / area)
      }
    }
  }
  return pixels
}

// PNG layout: https://www.w3.org/TR/png-3/#5Chunk-layout
function chunk(type: string, body: Uint8Array) {
  const out = new Uint8Array(new ArrayBuffer(12 + body.length))
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(body, 8)
  view.setUint32(8 + body.length, Bun.hash.crc32(out.subarray(4, 8 + body.length)))
  return out
}

function encode(size: number, pixels: Uint8Array) {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, size)
  view.setUint32(4, size)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = new Uint8Array(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 3, (y + 1) * size * 3), y * (size * 3 + 1) + 1)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array(0)),
  ]
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((total, part) => total + part.length, 0)))
  parts.reduce((offset, part) => (out.set(part, offset), offset + part.length), 0)
  return out
}

export namespace Icon {
  // The install and home-screen icons. Tab favicons keep the plain mark: at
  // 16-32px a label is unreadable.
  export const files: Record<string, number> = {
    "/web-app-manifest-192x192.png": 192,
    "/web-app-manifest-512x512.png": 512,
    "/apple-touch-icon-v3.png": 180,
  }

  export function png(size: number, label: string) {
    return encode(size, raster(size, shapes(label)))
  }
}
