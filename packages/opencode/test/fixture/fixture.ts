import { $ } from "bun"
import { afterAll, beforeAll } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { Config } from "../../src/config/config"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

// For a file whose tests resolve the default model, which needs a connected
// provider. A key connects the models.dev fixture's `opencode` provider.
export function connected() {
  const previous = process.env["OPENCODE_API_KEY"]
  beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key"
  })
  afterAll(() => {
    if (previous === undefined) delete process.env["OPENCODE_API_KEY"]
    if (previous !== undefined) process.env["OPENCODE_API_KEY"] = previous
  })
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...options.config,
      }),
    )
  }
  const extra = await options?.init?.(dirpath)
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dirpath)
      // await fs.rm(dirpath, { recursive: true, force: true })
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}
