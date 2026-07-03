import { useI18n } from "../context/i18n"
import { useCodeTheme } from "../context/code-theme"
import { highlightCode, themeColors } from "../context/marked"
import { copyText } from "../util/clipboard"
import { SolidMarkdown, type SolidMarkdownComponents } from "solid-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { ComponentProps, createEffect, createSignal, onCleanup, splitProps, type JSX } from "solid-js"
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

// Read the raw source and language from a HAST `pre` node. remark produces
// `pre > code.language-xxx > text`, so the fence body is the code element's
// text child and the language is its className. Reading the node (not the
// rendered children, which are Solid components) is what gives us the literal
// source to hand to Shiki.
type Hast = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Hast[] }
function fenceSource(node: Hast) {
  const code = node.children?.find((c) => c.tagName === "code")
  const text = (code?.children ?? []).map((c) => c.value ?? "").join("")
  const cls = code?.properties?.className
  const list = Array.isArray(cls) ? cls.map(String) : []
  const lang = list.map((c) => /^language-(\w+)/.exec(c)?.[1]).find(Boolean)
  return { text, lang: lang ?? "text" }
}

// A fenced code block: <div box><pre><code/></pre> + copy button. The body is
// streamed plain first, then Shiki-highlighted once the block settles. Because
// reconcile only re-runs this component's owner when the node's text changes,
// re-highlight fires on append; a per-render guard skips redundant work.
function CodeBlock(props: { lang: string; source: string; labels: CopyLabels; theme: string }) {
  const [code, setCode] = createSignal<HTMLElement>()

  createEffect(() => {
    const el = code()
    const raw = props.source.replace(/\n$/, "")
    if (!el || isServer || !raw) return
    highlightCode(raw, props.lang, props.theme)
      .then((html) => {
        const tmp = document.createElement("div")
        tmp.innerHTML = html
        const shiki = tmp.querySelector("code")
        if (!shiki) return
        el.replaceChildren(...Array.from(shiki.childNodes))
        const pre = el.parentElement
        const shikiPre = tmp.querySelector("pre")
        if (pre && shikiPre) {
          const cls = shikiPre.getAttribute("class")
          if (cls) pre.setAttribute("class", cls)
          const style = shikiPre.getAttribute("style")
          if (style) pre.setAttribute("style", style)
        }
      })
      .catch(() => {})
  })

  return (
    <div data-component="markdown-code">
      <pre>
        <code ref={setCode}>{props.source}</code>
      </pre>
      <CopyButton labels={props.labels} />
    </div>
  )
}

function CopyButton(props: { labels: CopyLabels }) {
  return (
    <button
      type="button"
      data-component="icon-button"
      data-variant="secondary"
      data-size="normal"
      data-slot="markdown-copy-button"
      aria-label={props.labels.copy}
      title={props.labels.copy}
      ref={(el) => {
        el.appendChild(createIcon(iconPaths.copy, "copy-icon"))
        el.appendChild(createIcon(iconPaths.check, "check-icon"))
      }}
    />
  )
}

// An inline <code> pill with click-to-copy. NO wrapper element — the pill is a
// bare inline <code>, so it keeps the exact GitHub-style pill layout and takes
// the click directly. The hover hint is a CSS-only bubble driven by the
// `data-tooltip` attribute (see markdown.css); on click the pill copies and the
// hint flips to "Copied" briefly. The pill's own text NEVER changes.
function InlineCode(props: { children: JSX.Element; text: string; labels: CopyLabels }) {
  const [done, setDone] = createSignal(false)
  const onClick = async () => {
    if (!props.text) return
    await copyText(props.text)
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <code data-slot="inline-code" data-tooltip={done() ? props.labels.copied : props.labels.copy} onClick={onClick}>
      {props.children}
    </code>
  )
}

function components(labels: CopyLabels, theme: () => string): SolidMarkdownComponents {
  return {
    // Block code is handled by the `pre` override below (remark emits
    // `pre > code`). This `code` override fires for BOTH, so it must only wrap
    // INLINE code (remark sets `inline` when the parent isn't <pre>); block
    // `code` is passed straight through so CodeBlock owns the fence.
    code(props) {
      if (!props.inline) return <code>{props.children}</code>
      const node = props.node as unknown as Hast
      const text = node?.children?.map((c) => c.value ?? "").join("") ?? ""
      return <InlineCode text={text} labels={labels} children={props.children} />
    },
    pre(props) {
      const fence = fenceSource(props.node as unknown as Hast)
      return <CodeBlock lang={fence.lang} source={fence.text} labels={labels} theme={theme()} />
    },
    a(props) {
      return (
        <a href={props.href} target="_blank" rel="noopener noreferrer" class="external-link">
          {props.children}
        </a>
      )
    },
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    class?: string
    classList?: Record<string, boolean>
    complete?: boolean
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "class", "classList", "complete"])
  const i18n = useI18n()
  const theme = useCodeTheme()
  const [root, setRoot] = createSignal<HTMLDivElement>()

  const labels = { copy: i18n.t("ui.message.copy"), copied: i18n.t("ui.message.copied") }

  let copyCleanup: (() => void) | undefined
  createEffect(() => {
    const container = root()
    if (!container || isServer) return
    if (copyCleanup) copyCleanup()
    copyCleanup = setupCopy(container)
  })
  onCleanup(() => {
    if (copyCleanup) copyCleanup()
  })

  // Derive inline-code colors from the chosen code-block theme, so `inline`
  // code shares the theme's pill background + text color (github-dark -> the
  // GitHub look). Re-runs when the theme changes; a stale-guard drops results
  // that resolve after the theme moved on.
  createEffect(() => {
    const container = root()
    const name = theme()
    if (!container || isServer) return
    themeColors(name)
      .then((c) => {
        if (!c || theme() !== name) return
        container.style.setProperty("--markdown-inline-bg", c.bg)
        container.style.setProperty("--markdown-inline-fg", c.fg)
      })
      .catch(() => {})
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
    >
      <SolidMarkdown
        renderingStrategy="reconcile"
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components(labels, theme)}
      >
        {local.text}
      </SolidMarkdown>
    </div>
  )
}

function setupCopy(root: HTMLElement) {
  const timeouts = new Map<Element, ReturnType<typeof setTimeout>>()

  const flash = async (el: Element, content: string) => {
    const clipboard = navigator?.clipboard
    if (!content || !clipboard) return
    await clipboard.writeText(content)
    el.setAttribute("data-copied", "true")
    const existing = timeouts.get(el)
    if (existing) clearTimeout(existing)
    timeouts.set(
      el,
      setTimeout(() => el.removeAttribute("data-copied"), 2000),
    )
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    // Block code: the dedicated copy button copies the fence body. (Inline code
    // copy is owned by the InlineCode component + Tooltip, not this delegation.)
    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (button instanceof HTMLButtonElement) {
      const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
      await flash(button, code?.textContent ?? "")
    }
  }

  root.addEventListener("click", handleClick)
  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) clearTimeout(timeout)
  }
}
