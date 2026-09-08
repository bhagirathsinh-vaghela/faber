import { DiffLineAnnotation, FileContents, FileDiffOptions, FileOptions, type SelectedLineRange } from "@pierre/diffs"
import { type PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { ComponentProps } from "solid-js"
import { ROOT_SELECTOR } from "../components/diff-marker"

// Pierre parameterizes its option and preload types by <LAnnotation, Caret>.
// Nothing here runs the editor, so Caret is always the class default (undefined)
// and these aliases carry that, keeping the second argument in one place rather
// than at every use.
export type DiffOptions<T> = FileDiffOptions<T, undefined>
export type CodeOptions<T> = FileOptions<T, undefined>
export type FileDiffPreload<T> = PreloadMultiFileDiffResult<T, undefined>

export type DiffProps<T = {}> = DiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

// The root-selector contract lives in diff-marker so the CSS here and the DOM
// walks there cannot disagree about what a diff root is.
const ROOT = ROOT_SELECTOR

// The GitHub palette is scoped to DIFF only, never ROOT. ROOT is
// :is([data-diff], [data-file]) — [data-file] is the plain File viewer that a
// file read and a file preview also render through, and recoloring it would
// leak GitHub's background onto non-diff code. Edit, apply_patch, and Write all
// render through the diff component ([data-diff]), so DIFF covers exactly the
// three surfaces meant to look like GitHub and nothing else.
const DIFF = "[data-diff]"

const unsafeCSS = `
${ROOT} {
  --diffs-bg: light-dark(var(--diffs-light-bg), var(--diffs-dark-bg));
  --diffs-bg-buffer: var(--diffs-bg-buffer-override, light-dark( color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer))));
  --diffs-bg-hover: var(--diffs-bg-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 97%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-mixer))));
  --diffs-bg-context: var(--diffs-bg-context-override, light-dark( color-mix(in lab, var(--diffs-bg) 98.5%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92.5%, var(--diffs-mixer))));
  --diffs-bg-separator: var(--diffs-bg-separator-override, light-dark( color-mix(in lab, var(--diffs-bg) 96%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-mixer))));
  --diffs-fg: light-dark(var(--diffs-light), var(--diffs-dark));
  --diffs-fg-number: var(--diffs-fg-number-override, light-dark(color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg)), color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg))));
  --diffs-deletion-base: var(--syntax-diff-delete);
  --diffs-addition-base: var(--syntax-diff-add);
  --diffs-modified-base: var(--syntax-diff-unknown);
  --diffs-bg-deletion: var(--diffs-bg-deletion-override, light-dark( color-mix(in lab, var(--diffs-bg) 98%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-number: var(--diffs-bg-deletion-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-hover: var(--diffs-bg-deletion-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-emphasis: var(--diffs-bg-deletion-emphasis-override, light-dark(rgb(from var(--diffs-deletion-base) r g b / 0.4), rgb(from var(--diffs-deletion-base) r g b / 0.4)));
  --diffs-bg-addition: var(--diffs-bg-addition-override, light-dark( color-mix(in lab, var(--diffs-bg) 98%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-addition-base))));
  --diffs-bg-addition-number: var(--diffs-bg-addition-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-addition-base))));
  --diffs-bg-addition-hover: var(--diffs-bg-addition-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 70%, var(--diffs-addition-base))));
  --diffs-bg-addition-emphasis: var(--diffs-bg-addition-emphasis-override, light-dark(rgb(from var(--diffs-addition-base) r g b / 0.4), rgb(from var(--diffs-addition-base) r g b / 0.4)));
  --diffs-selection-base: var(--surface-warning-strong);
  --diffs-selection-border: var(--border-warning-base);
  --diffs-selection-number-fg: #1c1917;
  /* Use explicit alpha instead of color-mix(..., transparent) to avoid Safari's non-premultiplied interpolation bugs. */
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--surface-warning-base) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--surface-warning-base) r g b / 0.85)
  );
  --diffs-bg-selection-text: rgb(from var(--surface-warning-strong) r g b / 0.2);
}

:host([data-color-scheme='dark']) ${ROOT} {
  --diffs-selection-number-fg: #fdfbfb;
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--solaris-dark-6) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--solaris-dark-6) r g b / 0.85)
  );
}

${ROOT} ::selection {
  background-color: var(--diffs-bg-selection-text);
}

::highlight(opencode-find) {
  background-color: rgb(from var(--surface-warning-base) r g b / 0.35);
}

::highlight(opencode-find-current) {
  background-color: rgb(from var(--surface-warning-strong) r g b / 0.55);
}

/* pierre marks a commented row on both columns: the content row ([data-line])
   and the gutter item ([data-column-number]). Each carries data-comment-selected
   directly, so the tint targets the marked element, not a descendant. */
${ROOT} [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

${ROOT} [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

${ROOT} [data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

/* pierre sets data-selected-line on the gutter item itself, which is the
   [data-column-number] element — a compound match, not a descendant. */
${ROOT} [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

/* The deletion word-diff emphasis is stronger than additions; soften it while selected so the selection highlight reads consistently. */
${ROOT} [data-line-type='change-deletion'][data-selected-line] {
  --diffs-bg-deletion-emphasis: light-dark(
    rgb(from var(--diffs-deletion-base) r g b / 0.07),
    rgb(from var(--diffs-deletion-base) r g b / 0.1)
  );
}

[data-diffs-header],
${ROOT} {
  [data-separator-wrapper] {
    margin: 0 !important;
    border-radius: 0 !important;
  }
  [data-expand-button] {
    width: 6.5ch !important;
    height: 24px !important;
    justify-content: end !important;
    padding-left: 3ch !important;
    padding-inline: 1ch !important;
  }
  [data-separator-multi-button] {
    grid-template-rows: 10px 10px !important;
    [data-expand-button] {
      height: 12px !important;
    }
  }
  [data-separator-content] {
    height: 24px !important;
  }
  [data-column-number] {
    background-color: var(--background-stronger);
    cursor: default !important;
  }

  &[data-interactive-line-numbers] [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-lines] [data-line] {
    cursor: auto !important;
  }
  [data-code] {
    overflow-x: auto !important;
  }
}

/* GitHub diff palette, hardcoded so diffs render identically in every app
   theme. Values are GitHub's own Primer diff tokens, read live from a GitHub
   dark/light diff. Dark/light is keyed off pierre's own [data-color-scheme]
   host attribute (set from the app theme), NOT light-dark() — light-dark()
   follows the OS color-scheme, which washes out context rows.

   The washes are painted directly on the row cells here rather than through
   pierre's --diffs-bg-*-override vars: pierre does not assign those vars to a
   row's background, so override vars alone leave every change row transparent.
   Addition/deletion lines get GitHub's translucent line color; the gutter
   number cell gets the stronger num color; the word-diff emphasis keeps the
   0.4-alpha word color. A whole new file is rendered as an all-additions diff
   (empty before), so its rows carry change-addition and wash the same way. */
${DIFF},
${DIFF} [data-code] {
  background-color: var(--diffs-gh-bg);
}
${DIFF} {
  --diffs-gh-bg: #ffffff;
  --diffs-gh-add-line: #e6ffec;
  --diffs-gh-add-num: #ccffd8;
  --diffs-gh-add-word: #abf2bc;
  --diffs-gh-del-line: #ffebe9;
  --diffs-gh-del-num: #ffd7d5;
  --diffs-gh-del-word: rgb(255 129 130 / 0.4);
}
:host([data-color-scheme='dark']) ${DIFF} {
  --diffs-gh-bg: #0d1117;
  --diffs-gh-add-line: rgb(46 160 67 / 0.15);
  --diffs-gh-add-num: rgb(63 185 80 / 0.3);
  --diffs-gh-add-word: rgb(46 160 67 / 0.4);
  --diffs-gh-del-line: rgb(248 81 73 / 0.1);
  --diffs-gh-del-num: rgb(248 81 73 / 0.3);
  --diffs-gh-del-word: rgb(248 81 73 / 0.4);
}

${DIFF} [data-line-type='change-addition'] {
  background-color: var(--diffs-gh-add-line);
}
${DIFF} [data-line-type='change-deletion'] {
  background-color: var(--diffs-gh-del-line);
}
${DIFF} [data-column-number][data-line-type='change-addition'] {
  background-color: var(--diffs-gh-add-num);
}
${DIFF} [data-column-number][data-line-type='change-deletion'] {
  background-color: var(--diffs-gh-del-num);
}

${DIFF} {
  --diffs-bg-addition-emphasis: var(--diffs-gh-add-word);
  --diffs-bg-deletion-emphasis: var(--diffs-gh-del-word);
}`

export function createDefaultOptions<T>(style: DiffOptions<T>["diffStyle"], theme = "github-dark") {
  return {
    theme,
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    diffIndicators: "bars",
    disableBackground: false,
    expansionLineCount: 20,
    lineDiffType: "word-alt",
    maxLineDiffLength: 1000,
    disableFileHeader: true,
    unsafeCSS,
    // hunkSeparators(hunkData: HunkData) {
    //   const fragment = document.createDocumentFragment()
    //   const numCol = document.createElement("div")
    //   numCol.innerHTML = `<svg data-slot="diff-hunk-separator-line-number-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.97978 14.0204L8.62623 13.6668L9.33334 12.9597L9.68689 13.3133L9.33333 13.6668L8.97978 14.0204ZM12 16.3335L12.3535 16.6871L12 17.0406L11.6464 16.687L12 16.3335ZM14.3131 13.3133L14.6667 12.9597L15.3738 13.6668L15.0202 14.0204L14.6667 13.6668L14.3131 13.3133ZM12.5 16.0002V16.5002H11.5V16.0002H12H12.5ZM9.33333 13.6668L9.68689 13.3133L12.3535 15.9799L12 16.3335L11.6464 16.687L8.97978 14.0204L9.33333 13.6668ZM12 16.3335L11.6464 15.9799L14.3131 13.3133L14.6667 13.6668L15.0202 14.0204L12.3535 16.6871L12 16.3335ZM6.5 8.00016V7.50016H8.5V8.00016V8.50016H6.5V8.00016ZM9.5 8.00016V7.50016H11.5V8.00016V8.50016H9.5V8.00016ZM12.5 8.00016V7.50016H14.5V8.00016V8.50016H12.5V8.00016ZM15.5 8.00016V7.50016H17.5V8.00016V8.50016H15.5V8.00016ZM12 10.5002H12.5V16.0002H12H11.5V10.5002H12Z" fill="currentColor"/></svg> `
    //   numCol.dataset["slot"] = "diff-hunk-separator-line-number"
    //   fragment.appendChild(numCol)
    //   const contentCol = document.createElement("div")
    //   contentCol.dataset["slot"] = "diff-hunk-separator-content"
    //   const span = document.createElement("span")
    //   span.dataset["slot"] = "diff-hunk-separator-content-span"
    //   span.textContent = `${hunkData.lines} unmodified lines`
    //   contentCol.appendChild(span)
    //   fragment.appendChild(contentCol)
    //   return fragment
    // },
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--markdown-code-block-family)",
  "--diffs-font-size": "var(--font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
}
