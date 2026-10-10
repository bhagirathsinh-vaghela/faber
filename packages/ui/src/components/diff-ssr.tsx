import { DIFFS_TAG_NAME, FileDiff, type SelectedLineRange } from "@pierre/diffs"
import { createEffect, createRenderEffect, onCleanup, onMount, Show, splitProps, untrack } from "solid-js"
import { Dynamic, isServer } from "solid-js/web"
import { createDefaultOptions, styleVariables, type DiffProps, type FileDiffPreload } from "../pierre"
import { useWorkerPool } from "../context/worker-pool"
import { useDiffTheme } from "../context/diff-theme"
import { setDiffTheme } from "../pierre/worker"
import { applyCommentedLines, findRoot, isSplit, rowIndex } from "./diff-marker"

export type SSRDiffProps<T = {}> = DiffProps<T> & {
  preloadedDiff: FileDiffPreload<T>
}

export function Diff<T>(props: SSRDiffProps<T>) {
  let container!: HTMLDivElement
  let fileDiffRef!: HTMLElement
  const [local, others] = splitProps(props, [
    "before",
    "after",
    "class",
    "classList",
    "annotations",
    "selectedLines",
    "commentedLines",
  ])
  const workerPool = useWorkerPool(props.diffStyle)
  const theme = useDiffTheme()

  let fileDiffInstance: FileDiff<T> | undefined
  const cleanupFunctions: Array<() => void> = []

  const getRoot = () => fileDiffRef?.shadowRoot ?? undefined

  const applyScheme = () => {
    const scheme = document.documentElement.dataset.colorScheme
    if (scheme === "dark" || scheme === "light") {
      fileDiffRef.dataset.colorScheme = scheme
      return
    }

    fileDiffRef.removeAttribute("data-color-scheme")
  }

  const fixSelection = (range: SelectedLineRange | null) => {
    if (!range) return range
    const root = getRoot()
    if (!root) return

    const diffs = findRoot(root)
    if (!diffs) return

    const split = isSplit(diffs)

    const start = rowIndex(root, split, range.start, range.side)
    const end = rowIndex(root, split, range.end, range.endSide ?? range.side)

    if (start === undefined || end === undefined) {
      if (root.querySelector("[data-line], [data-alt-line]") == null) return
      return null
    }
    if (start <= end) return range

    const side = range.endSide ?? range.side
    const swapped: SelectedLineRange = {
      start: range.end,
      end: range.start,
    }
    if (side) swapped.side = side
    if (range.endSide && range.side) swapped.endSide = range.side

    return swapped
  }

  const setSelectedLines = (range: SelectedLineRange | null, attempt = 0) => {
    const diff = fileDiffInstance
    if (!diff) return

    const fixed = fixSelection(range)
    if (fixed === undefined) {
      if (attempt >= 120) return
      requestAnimationFrame(() => setSelectedLines(range, attempt + 1))
      return
    }

    diff.setSelectedLines(fixed)
  }

  const commentLines = (ranges: SelectedLineRange[]) => {
    const root = getRoot()
    if (root) applyCommentedLines(root, ranges)
  }

  onMount(() => {
    if (isServer || !props.preloadedDiff) return

    applyScheme()

    if (typeof MutationObserver !== "undefined") {
      const root = document.documentElement
      const monitor = new MutationObserver(() => applyScheme())
      monitor.observe(root, { attributes: true, attributeFilter: ["data-color-scheme"] })
      onCleanup(() => monitor.disconnect())
    }

    createRenderEffect(() => setDiffTheme(theme()))

    fileDiffInstance = new FileDiff<T>(
      {
        ...createDefaultOptions(props.diffStyle, untrack(theme)),
        ...others,
        ...props.preloadedDiff,
      },
      workerPool,
    )
    // @ts-expect-error - fileContainer is private but needed for SSR hydration
    fileDiffInstance.fileContainer = fileDiffRef
    fileDiffInstance.hydrate({
      oldFile: local.before,
      newFile: local.after,
      lineAnnotations: local.annotations,
      fileContainer: fileDiffRef,
      containerWrapper: container,
    })

    setSelectedLines(local.selectedLines ?? null)

    createEffect(() => {
      fileDiffInstance?.setLineAnnotations(local.annotations ?? [])
    })

    createEffect(() => {
      setSelectedLines(local.selectedLines ?? null)
    })

    createEffect(() => {
      const ranges = local.commentedLines ?? []
      requestAnimationFrame(() => commentLines(ranges))
    })

    // Hydrate annotation slots with interactive SolidJS components
    // if (props.annotations.length > 0 && props.renderAnnotation != null) {
    //   for (const annotation of props.annotations) {
    //     const slotName = `annotation-${annotation.side}-${annotation.lineNumber}`;
    //     const slotElement = fileDiffRef.querySelector(
    //       `[slot="${slotName}"]`
    //     ) as HTMLElement;
    //
    //     if (slotElement != null) {
    //       // Clear the static server-rendered content from the slot
    //       slotElement.innerHTML = '';
    //
    //       // Mount a fresh SolidJS component into this slot using render().
    //       // This enables full SolidJS reactivity (signals, effects, etc.)
    //       const dispose = render(
    //         () => props.renderAnnotation!(annotation),
    //         slotElement
    //       );
    //       cleanupFunctions.push(dispose);
    //     }
    //   }
    // }
  })

  onCleanup(() => {
    // Clean up FileDiff event handlers and dispose SolidJS components
    fileDiffInstance?.cleanUp()
    cleanupFunctions.forEach((dispose) => dispose())
  })

  return (
    <div data-component="diff" style={styleVariables} ref={container}>
      <Dynamic component={DIFFS_TAG_NAME} ref={fileDiffRef} id="ssr-diff">
        <Show when={isServer}>
          <template shadowrootmode="open" innerHTML={props.preloadedDiff.prerenderedHTML} />
        </Show>
      </Dynamic>
    </div>
  )
}
