import { marked } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import katex from "katex"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { getSharedHighlighter } from "@pierre/diffs"

// Highlighted-HTML cache keyed on (code, lang, theme). A fenced block re-mounts
// on every virtua scroll-in and every theme toggle-back; Shiki's codeToHtml is
// the expensive step, so caching its output skips the re-highlight entirely for
// an already-seen block. Bounded LRU (Map keeps insertion order; re-set on hit
// moves to newest, oldest evicted past the cap) so long sessions can't grow it
// without bound.
const CACHE_MAX = 500
const cache = new Map<string, string>()
function cached(key: string) {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}
function store(key: string, html: string) {
  cache.set(key, html)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

// Shared code highlighter used by both the marked path and the solid-markdown
// renderer. `theme` is any Shiki bundled theme name (github-dark, dracula, …),
// resolved by @pierre/diffs' bundled-theme fallback; defaults to "github-dark".
export async function highlightCode(code: string, lang: string, theme = "github-dark"): Promise<string> {
  const key = `${theme}\u0000${lang || "text"}\u0000${code}`
  const hit = cached(key)
  if (hit !== undefined) return hit
  const highlighter = await getSharedHighlighter({ themes: [theme], langs: [] })
  let language = lang || "text"
  if (!(language in bundledLanguages)) language = "text"
  if (language !== "text" && !highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language as BundledLanguage)
  }
  const html = highlighter.codeToHtml(code, { lang: language, theme, tabindex: false })
  store(key, html)
  return html
}

// Background + foreground of a Shiki bundled theme, used to style inline code so
// it derives from the chosen code-block theme (github-dark -> GitHub's pill,
// dracula -> Dracula's, ...). Returns undefined until the theme is loaded.
export async function themeColors(theme = "github-dark"): Promise<{ bg: string; fg: string } | undefined> {
  const highlighter = await getSharedHighlighter({ themes: [theme], langs: [] })
  const resolved = highlighter.getTheme(theme)
  if (!resolved?.bg || !resolved?.fg) return undefined
  return { bg: resolved.bg, fg: resolved.fg }
}

function renderMathInText(text: string): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: $...$
  const inlineMathRegex = /(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `$${math}$`
    }
  })

  return result
}

function renderMathExpressions(html: string): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part)
    })
    .join("")
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const highlighter = await getSharedHighlighter({ themes: ["github-dark"], langs: [] })

  let result = html
  for (const match of matches) {
    const [fullMatch, lang, escapedCode] = match
    const code = escapedCode
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

    let language = lang || "text"
    if (!(language in bundledLanguages)) {
      language = "text"
    }
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(language as BundledLanguage)
    }

    const highlighted = highlighter.codeToHtml(code, {
      lang: language,
      theme: "github-dark",
      tabindex: false,
    })
    result = result.replace(fullMatch, () => highlighted)
  }

  return result
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => {
    const jsParser = marked.use(
      {
        renderer: {
          link({ href, title, text }) {
            const titleAttr = title ? ` title="${title}"` : ""
            return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
          },
        },
      },
      markedKatex({
        throwOnError: false,
        nonStandard: true,
      }),
      markedShiki({
        async highlight(code, lang) {
          const highlighter = await getSharedHighlighter({ themes: ["github-dark"], langs: [] })
          if (!(lang in bundledLanguages)) {
            lang = "text"
          }
          if (!highlighter.getLoadedLanguages().includes(lang)) {
            await highlighter.loadLanguage(lang as BundledLanguage)
          }
          return highlighter.codeToHtml(code, {
            lang: lang || "text",
            theme: "github-dark",
            tabindex: false,
          })
        },
      }),
    )

    if (props.nativeParser) {
      const nativeParser = props.nativeParser
      return {
        async parse(markdown: string): Promise<string> {
          const html = await nativeParser(markdown)
          const withMath = renderMathExpressions(html)
          return highlightCodeBlocks(withMath)
        },
      }
    }

    return jsParser
  },
})
