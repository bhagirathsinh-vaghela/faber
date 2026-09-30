// Turns the read-aloud rewrite's text stream into speakable chunks, emitting a
// chunk only once no later text can change it, so the output depends on the
// full text alone and never on how the stream happened to be sliced.
export namespace TtsChunk {
  // A choice: one chunk is one sidecar render and the sidecar renders one at
  // a time, so CAP bounds how long a skip waits; TARGET and FLOOR pack short
  // sentences to cut per-request overhead, and chunk 1 flushes at FLOOR so it
  // can render while the short chunk 0 plays (not measured). The speech engine
  // splits past 510 phonemes on its own.
  export const CAP = 400
  export const TARGET = 350
  export const FLOOR = 200

  // A choice: abbreviations common in assistant prose whose period does not end a sentence.
  const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "vs", "etc", "st", "jr", "sr", "prof"])
  // Terminal punctuation plus any closing quotes or brackets: the one
  // sentence-end shape, so a closer added here is a closer everywhere.
  const STOP = `[.!?]["')\\]”’]*`
  const END = new RegExp(`${STOP}(?=[ \\t])`, "g")
  const ENDED = new RegExp(`${STOP}$`)
  const CLAUSES = [", ", "; ", ": ", " — ", "— "]
  // A clause mark this early would leave a fragment too short to speak well (a choice, not measured).
  const SHORTEST = 100
  // Markdown a rewrite must have converted (CommonMark 0.31.2: fenced code
  // blocks, code spans, asterisk emphasis, ATX headings, asterisk list items;
  // GFM tables: github.github.com/gfm/#tables-extension-), a link or task-list
  // bracket, or a leaked tag (thinking text, SSML). Probed on the sidecar:
  // "[a]" renders the same audio as "a", so
  // brackets vanish silently and only this check catches an unconverted
  // structure; "a | b" renders the same as "a vertical bar b", so a leaked pipe
  // is also spoken aloud.
  const MARKUP = ["`", "~~~", "|", "[", "]"]
  // Each pattern is shaped so prose passes: a tag is a bracketed name, with
  // any attributes, where a word could start ("List<String>" and "x<y" are
  // prose); emphasis is a pair of asterisk runs around text ("A*", "2*3",
  // "***" are prose; two operators in one chunk, "2*3 and 4*5", read as a pair
  // here as CommonMark renders them, its example 356 being 5*6*78 → 5<em>6</em>78;
  // underscores are identifiers, so "_x_" is not guarded); a
  // heading or an asterisk bullet stands where a line could start, the chunk
  // start or after a sentence end ("Use # for comments" and "2 * 3" are prose).
  const PATTERNS = [
    /(?<=^|[\s"'(“‘])<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>/i,
    /\*+[^\s*](?:[^*]*?[^\s*])?\*+/,
    new RegExp(`(?<=^|${STOP}\\s)(?:#{1,6}|\\*)\\s`),
  ]

  type Unit = { text: string; para: boolean }

  const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

  // Each chunk is its own utterance, and a final period gives it a
  // sentence-final ending: measured, the sidecar renders "Counting down." ~50 ms
  // longer than "Counting down", ~25 ms longer than with a comma. Probed there
  // too: only the comma, colon, semicolon and em dash pause; a hyphen or en
  // dash renders as nothing.
  function terminate(text: string) {
    const open = unclose(text)
    return ENDED.test(open) ? open : `${open}.`
  }

  // Trailing clause marks and dangling dashes, in any order ("items: -",
  // "word -,"), until none is left. A dash (–, or any run of hyphens) dangles
  // only after a space; a word-final hyphen ("re-") is part of the word.
  function unclose(text: string): string {
    const next = text.replace(/\s+(?:-+|–)$/, "").replace(/\s*[,;:—]$/, "")
    return next === text ? text : unclose(next)
  }

  // The markup a rewrite must never leave behind, or undefined when it is clean.
  export function markup(text: string) {
    return (
      MARKUP.find((token) => text.includes(token)) ??
      PATTERNS.map((pattern) => pattern.exec(text)?.[0].trim()).find((found) => found !== undefined)
    )
  }

  // A confirmed sentence end in buf before limit: the index just past the
  // punctuation and any closing quotes, once something has arrived after it.
  function boundary(buf: string, limit: number) {
    const found = [...buf.matchAll(END)].find(
      (mark) =>
        mark.index < limit &&
        /\S/.test(buf.slice(mark.index + mark[0].length)) &&
        !(mark[0][0] === "." && abbreviated(buf.slice(0, mark.index))),
    )
    return found ? found.index + found[0].length : undefined
  }

  // The word before a period, stripped of opening punctuation: a known
  // abbreviation, or a dotted initialism such as U.S or e.g.
  function abbreviated(before: string) {
    const token = (before.split(/\s/).pop() ?? "").replace(/^[(\["'“‘]+/, "").toLowerCase()
    return ABBREVIATIONS.has(token) || /^([a-z]\.)+[a-z]$/.test(token)
  }

  // A sentence over the cap is cut at the last clause mark that fits, then at
  // the last space that fits; a single word longer than the cap stays whole.
  // Measured after `terminate`, whose period can add one character.
  export function split(text: string): string[] {
    if (terminate(text).length <= CAP) return [text]
    const window = text.slice(0, CAP)
    const clause = Math.max(
      ...CLAUSES.map((mark) => {
        const index = window.lastIndexOf(mark)
        return index < 0 ? -1 : index + mark.trimEnd().length
      }),
    )
    const cut = clause >= SHORTEST ? clause : window.lastIndexOf(" ")
    const at = cut > 0 ? cut : text.indexOf(" ", CAP)
    if (at < 0) return [text]
    return [text.slice(0, at).trim(), ...split(text.slice(at).trim())]
  }

  /** start: the index the first chunk will carry; only chunk 0 is emitted alone. */
  export function create(start = 0) {
    const state = {
      buf: "",
      breaks: 0,
      current: [] as string[],
      emitted: start,
    }

    const length = (parts: string[]) => parts.join(" ").length

    function flush(out: string[]) {
      if (state.current.length === 0) return
      out.push(state.current.join(" "))
      state.current = []
      state.emitted++
    }

    function fits(text: string) {
      const combined = length([...state.current, text])
      return combined <= TARGET || (length(state.current) < FLOOR && combined <= CAP)
    }

    function add(unit: Unit, out: string[]) {
      // A piece with no letter or digit (a divider line, a stray dash) has nothing
      // to say, unless it is markup (a bare code fence, a table rule) that the
      // rewrite's markup guard must see in the chunks to reject the attempt.
      const pieces = split(unit.text)
        .map(terminate)
        .filter((piece) => /[\p{L}\p{N}]/u.test(piece) || markup(piece))
      pieces.forEach((piece, index) => {
        const para = index === 0 && unit.para
        if (state.current.length > 0 && (para || !fits(piece))) flush(out)
        state.current.push(piece)
        if (state.emitted === 0 || length(state.current) >= (state.emitted === 1 ? FLOOR : TARGET)) flush(out)
      })
    }

    function drain(final: boolean) {
      const out: string[] = []
      while (true) {
        const lead = state.buf.match(/^\s*/)![0]
        state.breaks += lead.split("\n").length - 1
        state.buf = state.buf.slice(lead.length)
        if (state.breaks >= 2) flush(out)
        if (!state.buf) return out
        const line = state.buf.indexOf("\n")
        const end = boundary(state.buf, line < 0 ? state.buf.length : line) ?? (line < 0 ? undefined : line)
        if (end === undefined && !final) return out
        const cut = end ?? state.buf.length
        const text = collapse(state.buf.slice(0, cut))
        state.buf = state.buf.slice(cut)
        const para = state.breaks >= 2
        state.breaks = 0
        if (text) add({ text, para }, out)
      }
    }

    return {
      /** Feed the next text delta; returns the chunks it confirmed, in order. */
      push(delta: string) {
        state.buf += delta
        return drain(false)
      },
      /** The stream ended: everything left is confirmed. */
      end() {
        const out = drain(true)
        flush(out)
        return out
      },
    }
  }

  /** The chunks for a complete text, as the streaming chunker would emit them. */
  export function all(text: string) {
    const chunker = create()
    return [...chunker.push(text), ...chunker.end()]
  }
}
