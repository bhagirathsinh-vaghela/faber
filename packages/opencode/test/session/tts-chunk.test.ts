import { describe, expect, test } from "bun:test"
import { TtsChunk } from "../../src/session/tts-chunk"

const DEPLOY = `About the deploy status.

The rollout is done.
The results compare two services, and both are passing.
The A P I sits at three hundred and forty milliseconds at the ninety fifth percentile, and the worker at one point two seconds.

Next, run the kubectl rollout status command and check that the error rate stays under half a percent.
If it spikes, there's a runbook linked on screen.
`

const LEADINS = `Now, about error handling
The parser throws when the config file is missing, e.g. on a fresh checkout.
Dr. Smith's note says the retry budget is three attempts, i.e. roughly nine seconds in total.
It costs 3.5 dollars per run!
Is that acceptable?

As for the rollback plan,
First, revert the migration.
Second, restart the workers.
Third, confirm the queue drains "cleanly."`

const LONG = [
  "This paragraph is one very long spoken sentence that keeps going without any terminal punctuation for quite a while, because the model decided to narrate a dense explanation of how the cache frontier works, how the system blocks ride the lookback window, how the system prompt carries the only marker, and how the per call message is never marked since it is never sent twice; that means the write premium is paid once per hour at most, while every later call inside that hour reads the prefix at a tenth of the price — which is the whole reason the instructions are long and stable rather than short and varied, and it also explains why the examples stay in the prompt",
  "",
  "Short one after it.",
  Array.from({ length: 90 }, (_, i) => `word${i}`).join(" "),
].join("\n")

const MANY = Array.from(
  { length: 30 },
  (_, i) => `Sentence number ${i} talks about a different part of the change set in plain words.`,
).join("\n")

const TEXTS = { DEPLOY, LEADINS, LONG, MANY }

// Mulberry32: a seeded generator so a failing slicing is reproducible.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    const t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    const u = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((u ^ (u >>> 14)) >>> 0) / 4294967296
  }
}

function feed(slices: string[]) {
  const chunker = TtsChunk.create()
  return [...slices.flatMap((slice) => chunker.push(slice)), ...chunker.end()]
}

function slices(text: string, seed: number) {
  const next = random(seed)
  const out: string[] = []
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(next() * 40)
    out.push(text.slice(at, at + size))
    at += size
  }
  return out
}

// Every chunk word is its source word, or that word with a period appended or
// replacing a trailing , ; : or — (the check does not pin these to a unit
// end). Right after a unit
// end, source words with no letter or digit may be dropped: a dangling dash,
// or a unit that is only a divider, never markup. Whitespace collapses.
// Returns the first violation.
function unfaithful(source: string, chunks: string[]) {
  const words = source.split(/\s+/).filter(Boolean)
  const said = chunks.join(" ").split(" ")
  const walk = { at: 0 }
  const ended = (word: string | undefined) => word === undefined || /[.!?]["')\]”’]*$/.test(word)
  const silent = (word: string) => !/[\p{L}\p{N}]/u.test(word) && !TtsChunk.markup(word)
  const skip = (next: string | undefined) => {
    while (walk.at < words.length && words[walk.at] !== next && silent(words[walk.at])) walk.at++
  }
  const bad = said.find((word, index) => {
    if (ended(said[index - 1])) skip(word)
    const src = words[walk.at] ?? ""
    const step =
      word === src || word === `${src}.` || (/[,;:—]$/.test(src) && word === `${src.slice(0, -1)}.`) ? 1 : 0
    walk.at += step
    return step === 0
  })
  if (bad !== undefined) return `"${bad}" is not "${words[walk.at]}" or a documented edit of it`
  if (ended(said.at(-1))) skip(undefined)
  if (walk.at !== words.length) return `source words from ${walk.at} ("${words[walk.at]}") were dropped`
  return undefined
}

describe("TtsChunk", () => {
  for (const [name, text] of Object.entries(TEXTS)) {
    test(`${name}: every slicing yields the same chunks and loses no text`, () => {
      const whole = TtsChunk.all(text)
      expect(feed([...text])).toEqual(whole)
      for (const seed of [1, 2, 3, 42, 1337]) expect(feed(slices(text, seed))).toEqual(whole)

      expect(unfaithful(text, whole)).toBeUndefined()
      for (const chunk of whole) {
        expect(chunk).toBe(chunk.replace(/\s+/g, " ").trim())
        expect(chunk).toMatch(/[\p{L}\p{N}]/u)
        expect(chunk).toMatch(/[.!?]["')\]”’]*$/)
      }
    })
  }

  test("the first chunk is the first sentence alone and paragraphs never share a chunk", () => {
    expect(TtsChunk.all(DEPLOY)).toEqual([
      "About the deploy status.",
      "The rollout is done. The results compare two services, and both are passing. The A P I sits at three hundred and forty milliseconds at the ninety fifth percentile, and the worker at one point two seconds.",
      "Next, run the kubectl rollout status command and check that the error rate stays under half a percent. If it spikes, there's a runbook linked on screen.",
    ])
  })

  test("abbreviations and decimals do not end a sentence; open lead-ins are closed", () => {
    expect(TtsChunk.all(LEADINS)).toEqual([
      "Now, about error handling.",
      "The parser throws when the config file is missing, e.g. on a fresh checkout. Dr. Smith's note says the retry budget is three attempts, i.e. roughly nine seconds in total. It costs 3.5 dollars per run!",
      "Is that acceptable?",
      'As for the rollback plan. First, revert the migration. Second, restart the workers. Third, confirm the queue drains "cleanly."',
    ])
  })

  test("a line over the cap splits at clause marks, then at words, never mid-word", () => {
    const chunks = TtsChunk.all(LONG)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TtsChunk.CAP)
    expect(chunks[0]).toEndWith("and how the per call message is never marked since it is never sent twice.")
    const words = chunks.join(" ").split(" ")
    for (const word of words.filter((w) => w.startsWith("word"))) expect(word).toMatch(/^word\d+\.?$/)
  })

  test("packed chunks aim for the target and never pass the cap", () => {
    const chunks = TtsChunk.all(MANY)
    expect(chunks[0]).toBe("Sentence number 0 talks about a different part of the change set in plain words.")
    for (const chunk of chunks.slice(1, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(TtsChunk.FLOOR)
      expect(chunk.length).toBeLessThanOrEqual(TtsChunk.CAP)
    }
  })

  test("a sentence end is confirmed only once the next character arrives", () => {
    const chunker = TtsChunk.create()
    expect(chunker.push("Hello there. ")).toEqual([])
    expect(chunker.push("N")).toEqual(["Hello there."])
    expect(chunker.push("ext line")).toEqual([])
    expect(chunker.end()).toEqual(["Next line."])
  })

  test("markup the rewrite must not leave behind is named", () => {
    expect(TtsChunk.markup("plain spoken words.")).toBeUndefined()
    expect(TtsChunk.markup("<thinking>hmm")).toBe("<thinking>")
    expect(TtsChunk.markup("<think>I should rewrite this.")).toBe("<think>")
    expect(TtsChunk.markup("<speak>Hello there.")).toBe("<speak>")
    expect(TtsChunk.markup("a </b> tag")).toBe("</b>")
    expect(TtsChunk.markup('he said "<thinking>" aloud')).toBe("<thinking>")
    expect(TtsChunk.markup("he said “<thinking>” aloud")).toBe("<thinking>")
    expect(TtsChunk.markup("he said ‘<thinking>’ aloud")).toBe("<thinking>")
    expect(TtsChunk.markup("(<thinking>hmm)")).toBe("<thinking>")
    expect(TtsChunk.markup("a <br/> break")).toBe("<br/>")
    expect(TtsChunk.markup("a <br /> break")).toBe("<br />")
    expect(TtsChunk.markup('The rollout is done. <break time="1s"/> Next, check the rate.')).toBe('<break time="1s"/>')
    expect(TtsChunk.markup('<prosody rate="slow">slowly</prosody>')).toBe('<prosody rate="slow">')
    expect(TtsChunk.markup('see <a href="x">link</a> here')).toBe('<a href="x">')
    expect(TtsChunk.markup("```ts")).toBe("`")
    expect(TtsChunk.markup("run `ls` now")).toBe("`")
    expect(TtsChunk.markup("~~~")).toBe("~~~")
    expect(TtsChunk.markup("---")).toBeUndefined()
    expect(TtsChunk.markup("a | b")).toBe("|")
    expect(TtsChunk.markup("say [Kokoro](/kˈOkəɹO/)")).toBe("[")
    expect(TtsChunk.markup("a lone [ bracket")).toBe("[")
    expect(TtsChunk.markup("a lone ] bracket")).toBe("]")
    expect(TtsChunk.markup("It's **done** now.")).toBe("**done**")
    expect(TtsChunk.markup("an *aside* here")).toBe("*aside*")
    expect(TtsChunk.markup("## Next steps.")).toBe("##")
    expect(TtsChunk.markup("Done. # Title.")).toBe("#")
    expect(TtsChunk.markup("The rollout is done (finally.) # Next steps. Revert the migration.")).toBe("#")
    expect(TtsChunk.markup('He said "done." ## Next steps.')).toBe("##")
    expect(TtsChunk.markup("He said “done.” # Next steps.")).toBe("#")
    expect(TtsChunk.markup("He said ‘done.’ # Next steps.")).toBe("#")
    expect(TtsChunk.markup("He said 'done.' # Next steps.")).toBe("#")
    expect(TtsChunk.markup("Steps. * Revert the migration. * Restart the workers.")).toBe("*")
    expect(TtsChunk.markup("Steps (two.) * Revert the migration.")).toBe("*")
    expect(TtsChunk.markup("2*3 and 4*5 are products.")).toBe("*3 and 4*")
  })

  test("prose that only looks like markup is clean", () => {
    const prose = [
      "C# is fine.",
      "a < b and b > c.",
      "issue #1 is open.",
      "2 * 3 is six.",
      "***",
      "List<String> is fine.",
      "Map<String, List<Integer>> is fine.",
      "the “List<String>” type.",
      "x<y holds.",
      "x < y and z > w.",
      "the A* algorithm.",
      "2*3 is six.",
      "see the note* below.",
      "*nix systems.",
      "Use # for comments.",
      "press the # key.",
      "_emphasis_ is an identifier here.",
    ]
    expect(prose.map((text) => TtsChunk.markup(text))).toEqual(prose.map(() => undefined))
  })

  test("a cut at the last space leaves room for the added period", () => {
    const line = "a" + "abcdefghi ".repeat(40) + "and the end of the line"
    expect(line[400]).toBe(" ")
    const chunks = TtsChunk.all(`Intro.\n${line}`)
    expect(chunks.map((chunk) => chunk.length <= TtsChunk.CAP)).toEqual(chunks.map(() => true))
    expect(unfaithful(`Intro.\n${line}`, chunks)).toBeUndefined()
  })

  test("the chunk after the first flushes once it reaches the floor, later ones pack toward the target", () => {
    // 80-character sentences: chunk 1 stops at three (242), later chunks take
    // four, the most that fit under the cap.
    expect(TtsChunk.all(MANY).map((chunk) => chunk.length)).toEqual([80, 242, 323, 325, 327, 327, 327, 327, 163])
  })

  const EDGES = {
    CRLF: ["First line.\r\nSecond line.\r\n\r\nNew paragraph.\r\n", ["First line.", "Second line.", "New paragraph."]],
    MULTIBYTE: [
      "Done ✅ with café.\nNext 🚀 step, über schnell!",
      ["Done ✅ with café.", "Next 🚀 step, über schnell!"],
    ],
    CLOSERS: [
      'He asked "why?" Then he left. (Really!) Fine by me.',
      ['He asked "why?"', "Then he left. (Really!) Fine by me."],
    ],
    PARENTHESISED: [
      "Use a flag (e.g. this one) to test. Done now.",
      ["Use a flag (e.g. this one) to test.", "Done now."],
    ],
    INITIALISM: [
      "The U.S. policy changed. The U.K. one did not.",
      ["The U.S. policy changed.", "The U.K. one did not."],
    ],
    BARE: ["just some words with no punctuation at all", ["just some words with no punctuation at all."]],
    TRAILING: [
      "Pick one of these —\nCounting down -\nA range –\nThey said pre-\nThe list;",
      ["Pick one of these.", "Counting down. A range. They said pre-. The list."],
    ],
    DIVIDER: [
      "First paragraph here.\n\n—\n\nSecond paragraph here.\n\n***\n\nThird one.",
      ["First paragraph here.", "Second paragraph here.", "Third one."],
    ],
    LONE_DASH: ["Start here.\n-\nThen this.\nAnd that.", ["Start here.", "Then this. And that."]],
    DANGLING_AFTER_MARK: ["items: -\none, –", ["items.", "one."]],
    MARK_AFTER_DANGLING: ["word -,\nlast – ;", ["word.", "last."]],
    DOUBLE_DASH: ["Counting down --\nNext one.", ["Counting down.", "Next one."]],
    TRIPLE_DASH: ["Counting down ---\nNext one.", ["Counting down.", "Next one."]],
    RULE_LINE: ["Above the rule.\n\n---\n\nBelow the rule.", ["Above the rule.", "Below the rule."]],
    TILDE_FENCE: ["Here is the code.\n~~~\nconst x = 1\n~~~\nDone.", ["Here is the code.", "~~~. const x = 1. ~~~. Done."]],
    BARE_FENCE: ["Here is the code.\n```\nconst x = 1\n```\nDone.", ["Here is the code.", "```. const x = 1. ```. Done."]],
    TABLE_RULE: ["Intro line.\n|---|---|\nMore.", ["Intro line.", "|---|---|. More."]],
  } as const

  for (const [name, [text, chunks]] of Object.entries(EDGES)) {
    test(`${name}: exact chunks under every slicing`, () => {
      expect(TtsChunk.all(text)).toEqual([...chunks])
      expect(feed([...text])).toEqual([...chunks])
      for (const seed of [1, 7, 99]) expect(feed(slices(text, seed))).toEqual([...chunks])
      expect(unfaithful(text, [...chunks])).toBeUndefined()
    })
  }
})
