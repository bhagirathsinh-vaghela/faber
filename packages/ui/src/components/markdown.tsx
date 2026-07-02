import { useI18n } from "../context/i18n"
import { highlightCode } from "../context/marked"
import * as smd from "streaming-markdown"
import katex from "katex"
import { ComponentProps, createEffect, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

type CopyLabels = {
  copy: string
  copied: string
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "normal")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("title", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

// A code fence tracked while it streams: the <pre> box, its <code>, the raw
// source accumulated so far, and the detected language. On end we swap the
// plain streamed text for Shiki-highlighted HTML — highlight only fires once,
// on the settled block, so streaming stays cheap and never re-touches the DOM.
type Fence = {
  pre: HTMLPreElement
  code: HTMLElement
  raw: string
  lang: string
  done: boolean
}

// Wrap smd's default renderer: reuse its DOM building, but intercept code
// fences (box + copy button + highlight-on-close), equations (KaTeX), and
// links (target=_blank). Append-only, so settled content is never mutated.
function createRenderer(root: HTMLElement, labels: CopyLabels) {
  const base = smd.default_renderer(root)
  const fences: Fence[] = []
  // Stack of the tokens we care about, parallel to smd's node stack depth.
  const stack: (Fence | HTMLElement | null)[] = []

  function highlight(fence: Fence) {
    if (fence.done) return
    fence.done = true
    const raw = fence.raw.replace(/\n$/, "")
    highlightCode(raw, fence.lang)
      .then((html) => {
        // html is <pre class="shiki ..."><code>...</code></pre>; take its inner
        // <code> so we keep our own <pre> (and the surrounding box/button).
        const tmp = document.createElement("div")
        tmp.innerHTML = html
        const shikiCode = tmp.querySelector("code")
        if (!shikiCode) return
        fence.code.replaceChildren(...Array.from(shikiCode.childNodes))
        const shikiPre = tmp.querySelector("pre")
        if (shikiPre) {
          const cls = shikiPre.getAttribute("class")
          if (cls) fence.pre.setAttribute("class", cls)
          const style = shikiPre.getAttribute("style")
          if (style) fence.pre.setAttribute("style", style)
        }
      })
      .catch(() => {})
  }

  return {
    data: base.data,
    add_token(data: unknown, type: number) {
      base.add_token(data as never, type as never)
      const node = base.data.nodes[base.data.index] as HTMLElement
      if (type === smd.CODE_FENCE || type === smd.CODE_BLOCK) {
        // base created <pre><code>; node is the <code>.
        const pre = node.parentElement as HTMLPreElement
        const wrapper = document.createElement("div")
        wrapper.setAttribute("data-component", "markdown-code")
        pre.parentElement?.replaceChild(wrapper, pre)
        wrapper.appendChild(pre)
        wrapper.appendChild(createCopyButton(labels))
        const fence: Fence = { pre, code: node, raw: "", lang: "text", done: false }
        fences.push(fence)
        stack.push(fence)
        return
      }
      if (type === smd.LINK || type === smd.RAW_URL) {
        node.setAttribute("target", "_blank")
        node.setAttribute("rel", "noopener noreferrer")
        node.setAttribute("class", "external-link")
      }
      stack.push(node)
    },
    end_token(data: unknown) {
      const top = stack.pop()
      if (top && "raw" in (top as Fence)) {
        highlight(top as Fence)
      } else if (top instanceof HTMLElement) {
        if (top.tagName === "EQUATION-BLOCK" || top.tagName === "EQUATION-INLINE") {
          const display = top.tagName === "EQUATION-BLOCK"
          try {
            const rendered = katex.renderToString(top.textContent ?? "", {
              displayMode: display,
              throwOnError: false,
            })
            top.innerHTML = rendered
          } catch {}
        }
      }
      base.end_token(data as never)
    },
    add_text(data: unknown, text: string) {
      const top = stack[stack.length - 1]
      if (top && typeof top === "object" && "raw" in top) {
        ;(top as Fence).raw += text
      }
      base.add_text(data as never, text)
    },
    set_attr(data: unknown, type: number, value: string) {
      const top = stack[stack.length - 1]
      if (type === smd.LANG && top && typeof top === "object" && "raw" in top) {
        ;(top as Fence).lang = value
        return // don't emit the class="lang" attr; Shiki sets its own classes
      }
      base.set_attr(data as never, type as never, value)
    },
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "class", "classList"])
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()

  let parser: ReturnType<typeof smd.parser> | undefined
  let fed = ""
  let key: string | undefined
  let copyCleanup: (() => void) | undefined

  function reset(container: HTMLElement) {
    container.replaceChildren()
    parser = smd.parser(
      createRenderer(container, {
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }),
    )
    fed = ""
  }

  createEffect(() => {
    const container = root()
    const text = local.text
    if (!container || isServer) return

    // A different message (cacheKey) or a non-append edit means the old tree is
    // stale — start over. Otherwise feed only the newly appended suffix so the
    // already-rendered DOM is never touched (this is what keeps code blocks
    // from fragmenting mid-stream).
    if (!parser || key !== local.cacheKey || !text.startsWith(fed)) {
      key = local.cacheKey
      reset(container)
    }

    const chunk = text.slice(fed.length)
    if (chunk.length > 0 && parser) {
      smd.parser_write(parser, chunk)
      fed = text
    }
  })

  createEffect(() => {
    const container = root()
    if (!container || isServer) return
    if (copyCleanup) copyCleanup()
    copyCleanup = setupCopy(container)
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function setupCopy(root: HTMLElement) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    button.setAttribute("data-copied", "true")
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => button.removeAttribute("data-copied"), 2000)
    timeouts.set(button, timeout)
  }

  root.addEventListener("click", handleClick)
  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) clearTimeout(timeout)
  }
}
