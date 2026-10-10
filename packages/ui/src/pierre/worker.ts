import { WorkerPoolManager } from "@pierre/diffs/worker"
import ShikiWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"

export type WorkerPoolStyle = "unified" | "split"

export function workerFactory(): Worker {
  return new Worker(ShikiWorkerUrl, { type: "module" })
}

// Theme the diff worker pools boot with and re-theme to. Defaults to the same
// stock theme as the fallback context; the app pushes the user's chosen
// diffTheme in via setDiffTheme once settings load.
let theme = "github-dark"
let codeTheme = "github-dark"

// A pool's render-options theme overrides the instance's own `theme` option
// (@pierre/diffs 1.4.1 FileRenderer.getLocalHighlightTheme), so file views
// themed by the code-block setting need a pool of their own.
function createPool(lineDiffType: "word-alt", poolTheme = theme) {
  const pool = new WorkerPoolManager(
    {
      workerFactory,
      // poolSize defaults to 8. More workers = more parallelism but
      // also more memory. Too many can actually slow things down.
      // NOTE: 2 is probably better for Faber, as I think 8 might be
      // a bit overkill, especially because Safari has a significantly slower
      // boot up time for workers
      poolSize: 2,
    },
    {
      theme: poolTheme,
      lineDiffType,
    },
  )

  pool.initialize()
  return pool
}

let unified: WorkerPoolManager | undefined
let split: WorkerPoolManager | undefined
let code: WorkerPoolManager | undefined

export function getCodePool(): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return
  if (!code) code = createPool("word-alt", codeTheme)
  return code
}

export function setCodeTheme(next: string) {
  if (next === codeTheme) return
  codeTheme = next
  code?.setRenderOptions({ theme: codeTheme })
}

export function getWorkerPool(style: WorkerPoolStyle | undefined): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return

  if (style === "split") {
    if (!split) split = createPool("word-alt")
    return split
  }

  if (!unified) unified = createPool("word-alt")
  return unified
}

export function getWorkerPools() {
  return {
    unified: getWorkerPool("unified"),
    split: getWorkerPool("split"),
  }
}

// Re-theme the live worker pools. setRenderOptions pushes the theme to every
// worker and notifies theme subscribers (mounted diffs) to re-render, so a
// theme switch restyles diffs already on screen. New pools boot with `theme`.
export function setDiffTheme(next: string) {
  if (next === theme) return
  theme = next
  unified?.setRenderOptions({ theme })
  split?.setRenderOptions({ theme })
}
