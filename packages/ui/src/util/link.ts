// Schemes a rendered link may open. Links come from model output and tool
// input, and a javascript: or file: link would run or open what it names when
// clicked. Parsing with URL (not a regex) matters: the URL parser strips tabs,
// newlines and leading control characters, so "jav\tascript:" is javascript:
// to the browser too (WHATWG URL standard, "basic URL parser").
const SCHEMES = new Set(["http:", "https:", "mailto:"])

// A relative href (a path, a #fragment) cannot change scheme and passes as is.
export function safeHref(href?: string) {
  if (!href || !URL.canParse(href)) return href
  return SCHEMES.has(new URL(href).protocol) ? href : undefined
}
