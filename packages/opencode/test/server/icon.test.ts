import { describe, expect, test } from "bun:test"
import os from "os"
import { inflateSync } from "zlib"
import { Icon } from "../../src/server/icon"
import { Web } from "../../src/server/web"

function decode(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset)
  const size = view.getUint32(16)
  const idat = png.subarray(33 + 8, 33 + 8 + view.getUint32(33))
  const rows = inflateSync(idat)
  return (x: number, y: number) => [...rows.subarray(y * (size * 3 + 1) + 1 + x * 3).subarray(0, 3)]
}

describe("Icon.png", () => {
  test("encodes an RGB PNG of the requested size", () => {
    const png = Icon.png(180, "laptop")
    const view = new DataView(png.buffer, png.byteOffset)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR")
    expect(view.getUint32(16)).toBe(180)
    expect(view.getUint32(20)).toBe(180)
    expect([...png.subarray(24, 29)]).toEqual([8, 2, 0, 0, 0])
  })

  test("draws the label under the F mark", () => {
    const pixel = decode(Icon.png(512, "laptop"))
    expect(pixel(196, 360)).toEqual([0xff, 0xff, 0xff])
    expect(pixel(170, 200)).toEqual([0xff, 0xff, 0xff])
    expect(pixel(340, 100)).toEqual([0xff, 0xff, 0xff])
    expect(pixel(280, 200)).toEqual([0xff, 0xff, 0xff])
    expect(pixel(330, 250)).toEqual([0x13, 0x10, 0x10])
    expect(pixel(256, 250)).toEqual([0x13, 0x10, 0x10])
    expect(pixel(256, 500)).toEqual([0x13, 0x10, 0x10])
  })

  test("differs per label", () => {
    expect(Icon.png(192, "laptop")).not.toEqual(Icon.png(192, "desktop"))
  })
})

describe("Web.serve install icons", () => {
  test("serves hostname-labelled icons under hash-versioned manifest URLs", async () => {
    const encode = (text: string) => Buffer.from(text).toString("base64")
    const icons = [
      { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png" },
    ]
    Web.load({
      "/index.html": { type: "text/html; charset=utf-8", body: encode("<!doctype html>") },
      "/site.webmanifest": { type: "application/manifest+json", body: encode(JSON.stringify({ icons })) },
    })
    const label = os.hostname().split(".")[0]
    const manifest = await Web.serve("/site.webmanifest")!.json()
    const srcs: string[] = manifest.icons.map((icon: { src: string }) => icon.src)
    expect(srcs.every((src) => /^\/web-app-manifest-(192x192|512x512)\.png\?v=[0-9a-z]+$/.test(src))).toBe(true)
    const icon = Web.serve("/web-app-manifest-512x512.png")!
    expect(icon.headers.get("Content-Type")).toBe("image/png")
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(Icon.png(512, label))
    const touch = Web.serve("/apple-touch-icon-v3.png")!
    expect(new Uint8Array(await touch.arrayBuffer())).toEqual(Icon.png(180, label))
  })
})
