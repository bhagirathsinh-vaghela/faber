import { marked } from "marked"
import { useI18n } from "../context/i18n"
import { useCodeTheme } from "../context/code-theme"
import { highlightCode, themeColors } from "../context/marked"
import { copyText } from "../util/clipboard"
import { SolidMarkdown, type SolidMarkdownComponents } from "solid-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import remarkMath from "remark-math"
import { directive } from "micromark-extension-directive"
import { directiveFromMarkdown } from "mdast-util-directive"
import remend, { isWithinCodeBlock, type RemendHandler } from "remend"
import { CALLOUTS, scanCalloutDepth, opensCallout, closesCallout } from "@opencode-ai/util/callout"
import { ComponentProps, createEffect, createMemo, createSignal, Index, onCleanup, splitProps, type JSX } from "solid-js"
import { isServer } from "solid-js/web"

// rehype-katex statically pulls the whole KaTeX engine (~280KB) into the initial
// chunk, but most messages carry no math. Load it on demand the first time a
// rendered message actually holds a dollar-delimited math span, then cache it in
// a signal so every later math message reuses it. Until it resolves, remark-math
// still tokenizes the math (it carries no katex), so the raw source shows briefly
// and the KaTeX layout swaps in once the chunk lands. Shiki is lazy the same way.
const [katexPlugin, setKatexPlugin] = createSignal<unknown>()
let katexPending = false
function loadKatex() {
  if (katexPending) return
  katexPending = true
  import("rehype-katex").then((m) => setKatexPlugin(() => m.default)).catch(() => (katexPending = false))
}

// remark-math's inline tokenizer consumes spaces, so with single-dollar math on,
// ANY two dollars on a line pair up and the prose between them becomes a
// non-wrapping KaTeX box that overflows the container ("$10-24/adult, so $40-70").
// Currency beats inline math in chat, so only a double-dollar fence counts.
const MATH_OPTIONS = { singleDollarTextMath: false }

// Cheap pre-check so a math-free message never triggers the import.
const MATH = /\$\$[\s\S]+?\$\$/
function hasMath(text: string) {
  return MATH.test(text)
}

// Callout names and labels live in the shared registry (@opencode-ai/util/callout).

// remark-directive, wired to CONTAINER directives only. Its default also enables
// inline text directives (`:name`), whose `:\w+` pattern false-matches ordinary
// prose — `13:20`, `localhost:8080`, `John 15:13` — silently eating everything
// after the colon and emitting a stray empty <div> (micromark-extension-directive
// issue #33; upstream declines to fix it). We only author `:::name` container
// callouts, so drop the extension's `text` rules and keep flow (leaf + container),
// which require a line-leading run of colons and never fire by accident.
function remarkDirectiveContainerOnly(this: any) {
  const config = this.data()
  const extension = { ...directive() }
  delete extension.text
  ;(config.micromarkExtensions ??= []).push(extension)
  ;(config.fromMarkdownExtensions ??= []).push(directiveFromMarkdown())
}

// A remark transform that turns a `:::fix` / `:::key` / etc. container directive
// into an <aside class="callout NAME"> (or <details> for `check`) carrying a
// label, so remark-rehype emits real elements the CSS can style. An unknown
// `:::name` is left untouched, which drops back to plain rendering rather than
// leaking the raw fence. Written as a bare recursive walk to avoid pulling in
// unist-util-visit for one traversal.
//
// A remark transform that renders the callout directives. Authored as
// `:::name` with a body, and `check` also takes a directive label carrying the
// question: `:::check[the question]`. remark-directive flags that label as the
// directive's first child paragraph (`data.directiveLabel`), which becomes the
// <summary> so the question shows while the answer (the body) folds. Every other
// callout is an <aside> with the name tag prepended.
function remarkCallouts() {
  const strong = (value: string) => ({ type: "strong", children: [{ type: "text", value }] })
  return (tree: any) => {
    const walk = (node: any) => {
      for (const child of node.children ?? []) walk(child)
      if (node.type !== "containerDirective") return
      const label = (CALLOUTS as Record<string, string>)[node.name]
      if (!label) return
      const body = node.children ?? []
      if (node.name === "check") {
        node.data = { ...node.data, hName: "details", hProperties: { className: ["callout", "check"] } }
        const hasLabel = body[0]?.data?.directiveLabel
        const question = hasLabel ? (body[0].children ?? []) : []
        const answer = hasLabel ? body.slice(1) : body
        const summary = { type: "summary", data: { hName: "summary" }, children: [strong(label), ...question] }
        node.children = [summary, ...answer]
        return
      }
      node.data = { ...node.data, hName: "aside", hProperties: { className: ["callout", node.name] } }
      node.children = [strong(label), ...body]
    }
    walk(tree)
  }
}

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

// A still-streaming markdown string renders by COMPLETING its unterminated tail
// rather than withholding it (the streamdown approach). remend closes
// open bold/italic/code/link/image/strikethrough and block math, so a half-typed
// marker renders as its finished form and updates in place instead of popping in
// whole when it closes. inlineKatex stays off to match MATH_OPTIONS (a lone
// dollar is currency, not math). The callout handler extends remend to our
// `:::` containers, which it has no native support for.
export function completeTail(text: string, complete: boolean) {
  if (complete) return text
  return remend(text, { inlineKatex: false, katex: true, handlers: [calloutHandler] })
}

// remend does not know `:::` containers, so a streaming callout would stay an
// open directive that swallows the rest of the message until its closer arrives.
// Append the missing closer(s), one per open depth, so the callout renders as
// its box and fills in while streaming. A `:::` opened inside a fenced code block
// is literal text, so leave it — remend closes the fence instead. Priority 90
// runs after remend's inline markers (0-75) and before its default (100), so a
// `:::check[question]` label is bracket-balanced first.
const calloutHandler: RemendHandler = {
  name: "callout",
  priority: 90,
  handle(text) {
    const scan = scanCalloutDepth(text)
    if (scan.depth === 0) return text
    if (isWithinCodeBlock(text, scan.openOffset)) return text
    const closers = Array(scan.depth).fill(":::").join("\n")
    return text.endsWith("\n") ? text + closers : text + "\n" + closers
  },
}

// Split markdown into top-level blocks so settled blocks freeze and only the
// growing tail re-parses (the O(message) to O(tail) streaming win). Blocks are
// marked's top-level tokens by raw text, EXCEPT a `:::name … :::` region is kept
// as one block: a callout is not a marked token, so left alone its body would
// split across several renders and lose the aside/details wrapper. Invariant:
// splitBlocks(x).join("") equals x.
export function splitBlocks(text: string): string[] {
  const blocks: string[] = []
  let depth = 0
  for (const token of marked.lexer(text)) {
    if (depth > 0) blocks[blocks.length - 1] += token.raw
    else blocks.push(token.raw)
    for (const line of token.raw.split("\n")) {
      if (opensCallout(line)) depth++
      else if (closesCallout(line) && depth > 0) depth--
    }
  }
  return blocks
}

// A fenced code block: <div box><pre><code/></pre> + copy button. The body
// streams plain, then Shiki-highlights once the block SETTLES — either the part
// completed, or its source stopped growing for one debounce window. The clamp
// upstream only ever hands a CLOSED fence to CodeBlock, so "source stopped
// changing" means "this fence is done", even while later blocks keep streaming.
// That colors each closed block as soon as it settles (responsive) instead of
// waiting for the whole message, and the debounce caps it at one highlight per
// settled block (re-highlighting every ~10Hz append is the O(n^2) trap we avoid;
// the LRU cache in marked.tsx turns the final complete-time pass into a hit).
const SETTLE_MS = 150
function CodeBlock(props: { lang: string; source: string; labels: CopyLabels; theme: string; complete?: boolean }) {
  const [code, setCode] = createSignal<HTMLElement>()

  // Track when this block's source last changed. A block is "settled" once the
  // part completes OR the source has held steady for SETTLE_MS, so a still-open
  // trailing block highlights on the pause after its fence closes rather than
  // hanging plain until the entire part finishes.
  const [settled, setSettled] = createSignal(false)
  createEffect(() => {
    props.source
    if (props.complete) {
      setSettled(true)
      return
    }
    setSettled(false)
    const timer = setTimeout(() => setSettled(true), SETTLE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    const raw = props.source.replace(/\n$/, "")
    const lang = props.lang
    const theme = props.theme
    if (!code() || isServer || !raw || !settled()) return
    let live = true
    onCleanup(() => (live = false))
    highlightCode(raw, lang, theme)
      .then((html) => {
        // Completion flips `complete` and releases the streaming-prefix clamp in
        // the same tick, so SolidMarkdown is reconciling this fence's <code>
        // right now. Writing Shiki nodes into it synchronously races that
        // reconcile and can leave the block blank. Defer the swap to a microtask
        // so reconcile settles first, then re-read the LIVE node (not a captured
        // ref that reconcile may have replaced) and drop the result if inputs
        // moved on (theme toggle, source grew) — Shiki has no abort.
        if (!live) return
        queueMicrotask(() => {
          const el = code()
          if (!live || !el || !el.isConnected) return
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

// A short-lived "Copied" bubble shown at the click point after a copy. It is a
// manual popover, so the browser paints it in the top layer: no ancestor's
// overflow can clip it and no stacking context can occlude it, which a bubble
// positioned inside the scrolling transcript card could not guarantee. It is
// triggered by the click itself, so it behaves identically under a finger and a
// mouse. Positioned at the pointer, fades, and removes itself.
function flashCopied(x: number, y: number, label: string) {
  if (isServer) return
  const bubble = document.createElement("div")
  bubble.setAttribute("popover", "manual")
  bubble.setAttribute("data-slot", "copied-bubble")
  bubble.textContent = label
  bubble.style.left = `${x}px`
  bubble.style.top = `${y}px`
  document.body.appendChild(bubble)
  bubble.showPopover()
  requestAnimationFrame(() => bubble.setAttribute("data-show", ""))
  setTimeout(() => {
    bubble.removeAttribute("data-show")
    setTimeout(() => bubble.remove(), 200)
  }, 900)
}

// An inline <code> pill with click-to-copy. Clicking copies and flashes the
// "Copied" bubble at the pointer.
function InlineCode(props: { children: JSX.Element; text: string; label: string }) {
  const onClick = async (e: MouseEvent) => {
    if (!props.text) return
    await copyText(props.text)
    flashCopied(e.clientX, e.clientY, props.label)
  }
  return (
    <code data-slot="inline-code" onClick={onClick}>
      {props.children}
    </code>
  )
}

function components(labels: CopyLabels, theme: () => string, complete: () => boolean): SolidMarkdownComponents {
  return {
    // Block code is handled by the `pre` override below (remark emits
    // `pre > code`). This `code` override fires for BOTH, so it must only wrap
    // INLINE code (remark sets `inline` when the parent isn't <pre>); block
    // `code` is passed straight through so CodeBlock owns the fence.
    code(props) {
      if (!props.inline) return <code>{props.children}</code>
      const node = props.node as unknown as Hast
      const text = node?.children?.map((c) => c.value ?? "").join("") ?? ""
      return <InlineCode text={text} label={labels.copied} children={props.children} />
    },
    pre(props) {
      // Read props.node inside a memo so reconcile's in-place node mutations
      // (streaming code output that grows line by line) flow through to
      // CodeBlock. Snapshotting once here froze fenced output at its first line.
      const fence = createMemo(() => fenceSource(props.node as unknown as Hast))
      return (
        <CodeBlock lang={fence().lang} source={fence().text} labels={labels} theme={theme()} complete={complete()} />
      )
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

  // A caller that omits `complete` is rendering static, already-settled text
  // (a finished task result, a question label); only the two live-streaming
  // sites pass the real flag. Treat absence as complete so those static fences
  // still highlight (and skip the streaming-prefix clamp).
  const complete = () => local.complete ?? true

  // Tail completion and block splitting live in StreamingMarkdown, which feeds
  // this component one already-settled block at a time. A streaming caller that
  // does not split (passes the whole growing text) still renders it verbatim;
  // remend/blocking is StreamingMarkdown's job, not this leaf renderer's.
  const rendered = createMemo(() => local.text)

  // Only the messages that actually contain math pay for KaTeX. Kick off the
  // lazy import when math first appears; until the plugin resolves the array is
  // empty (remark-math still parsed the nodes, so the source renders and the
  // KaTeX pass applies on the next tick once loaded).
  const rehype = createMemo(() => {
    if (!hasMath(rendered())) return []
    const plugin = katexPlugin()
    if (!plugin) {
      loadKatex()
      return []
    }
    return [plugin]
  })

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

  // Derive the inline-code pill BACKGROUND from the chosen code-block theme, so
  // `inline` code sits in the theme's pill (github-dark -> the GitHub look).
  // Only the background is theme-derived; there is no per-theme token for it.
  // The TEXT color comes from --markdown-inline-code-color, which every theme
  // already defines and the user can override, so it is not set here and the
  // override always wins with no JS race. Re-runs when the theme changes; a
  // stale-guard drops results that resolve after the theme moved on.
  createEffect(() => {
    const container = root()
    const name = theme()
    if (!container || isServer) return
    themeColors(name)
      .then((c) => {
        if (!c || theme() !== name) return
        container.style.setProperty("--markdown-inline-code-syntax-bg", c.bg)
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
        remarkPlugins={[
          remarkGfm,
          [remarkMath, MATH_OPTIONS],
          remarkBreaks,
          remarkDirectiveContainerOnly,
          remarkCallouts,
        ]}
        rehypePlugins={rehype()}
        components={components(labels, theme, complete)}
      >
        {rendered()}
      </SolidMarkdown>
    </div>
  )
}

// The streaming entry point for an assistant text/reasoning part. It completes
// the unterminated tail (remend + callouts), splits into top-level blocks, and
// renders each block through its own Markdown. Settled blocks keep a stable
// value at a stable index, so Index leaves them untouched while only the last
// (growing) block re-parses each tick — no whole-message re-render, and no
// remount of shown content. Every block but the last is complete (full render,
// Shiki highlights on settle); the last carries the caller's real complete flag.
export function StreamingMarkdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    class?: string
    classList?: Record<string, boolean>
    complete?: boolean
  },
) {
  const [local, others] = splitProps(props, ["text", "complete"])
  const blocks = createMemo(() => splitBlocks(completeTail(local.text, local.complete ?? false)))
  return (
    <Index each={blocks()}>
      {(block, index) => (
        <Markdown {...others} text={block()} complete={local.complete || index < blocks().length - 1} />
      )}
    </Index>
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
    // copy is owned by the InlineCode component, not this delegation.)
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
