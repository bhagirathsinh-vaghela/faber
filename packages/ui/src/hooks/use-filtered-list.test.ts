import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { createRoot } from "solid-js"
import { useFilteredList } from "./use-filtered-list"

type Command = { id: string; trigger: string; title: string; description: string }

const commands: Command[] = [
  { id: "compact", trigger: "compact", title: "Compact session", description: "Compact the conversation" },
  { id: "custom.compact-x", trigger: "compact-x", title: "compact-x", description: "" },
  { id: "share", trigger: "share", title: "Share", description: "Create a shareable link" },
  { id: "unshare", trigger: "unshare", title: "Unshare", description: "Remove the share link" },
]

const keys = ["trigger", "title", "description"]

function ranked(filter: string, weights?: number[]) {
  return createRoot((dispose) => {
    const list = useFilteredList<Command>({
      items: commands,
      key: (x) => x.id,
      filterKeys: keys,
      filterWeights: weights,
    })
    list.onInput(filter)
    const order = list.flat().map((x) => x.trigger)
    dispose()
    return order
  })
}

describe("filterWeights", () => {
  // A custom command sets title to its own name, so trigger and title hold the
  // same text and fuzzysort's multiple-keys bonus lifts it over a better match
  // that only scores on one key. Weighting collapses the ranking to one field.
  test("an exact prefix outranks a longer name that repeats itself across keys", () => {
    expect(ranked("comp")).toEqual(["compact-x", "compact"])
    expect(ranked("comp", [1, 0.6, 0.5])).toEqual(["compact", "compact-x"])
  })

  test("weighting leaves an already-correct ranking alone", () => {
    expect(ranked("compact", [1, 0.6, 0.5])).toEqual(["compact", "compact-x"])
    expect(ranked("share", [1, 0.6, 0.5])).toEqual(["share", "unshare"])
  })

  // Weights lower a key's score, never exclude it, so text that appears only in
  // a description still finds its command.
  test("a description-only match is still reachable", () => {
    expect(ranked("link", [1, 0.6, 0.5])).toEqual(["unshare", "share"])
  })

  test("an empty filter keeps the source order", () => {
    expect(ranked("", [1, 0.6, 0.5])).toEqual(["compact", "compact-x", "share", "unshare"])
  })
})

type Row = { id: string; title: string; section: "live" | "recent" }

const LIVE = "Live"
const RECENT = "Recent"

const rows: Row[] = [
  { id: "a", title: "alpha deployment stuff", section: "live" },
  { id: "b", title: "deploy", section: "recent" },
]

function sections(filter: string, groups?: string[]) {
  return createRoot((dispose) => {
    const list = useFilteredList<Row>({
      items: rows,
      key: (x) => x.id,
      filterKeys: ["title"],
      groupBy: (x) => (x.section === "live" ? LIVE : RECENT),
      groups,
    })
    list.onInput(filter)
    const shape = list.grouped.latest.map((group) => `${group.category}(${group.items.length})`)
    dispose()
    return shape
  })
}

describe("groups", () => {
  test("a filter cannot reorder the sections", () => {
    expect(sections("deploy")).toEqual([`${RECENT}(1)`, `${LIVE}(1)`])
    expect(sections("deploy", [LIVE, RECENT])).toEqual([`${LIVE}(1)`, `${RECENT}(1)`])
  })

  test("a section with no match keeps its place", () => {
    expect(sections("alpha", [LIVE, RECENT])).toEqual([`${LIVE}(1)`, `${RECENT}(0)`])
  })

  test("every section survives a filter that matches nothing", () => {
    expect(sections("zzz", [LIVE, RECENT])).toEqual([`${LIVE}(0)`, `${RECENT}(0)`])
  })

  test("an unfiltered list keeps the pinned order", () => {
    expect(sections("", [LIVE, RECENT])).toEqual([`${LIVE}(1)`, `${RECENT}(1)`])
  })
})

function withList<T>(run: (list: ReturnType<typeof useFilteredList<Command>>) => T) {
  return createRoot((dispose) => {
    const list = useFilteredList<Command>({ items: commands, key: (x) => x.id, filterKeys: keys })
    const outcome = run(list)
    dispose()
    return outcome
  })
}

const move = { movementX: 4, movementY: 0 } as MouseEvent
const still = { movementX: 0, movementY: 0 } as MouseEvent

describe("hover", () => {
  test("hovering leaves the keyboard cursor alone", () => {
    const state = withList((list) => {
      const before = list.active()
      list.hover(move, "share")
      return { before, after: list.active(), hovered: list.hovered() }
    })
    expect(state.hovered).toBe("share")
    expect(state.after).toBe(state.before)
  })

  test("the cursor and the pointer mark different rows at once", () => {
    const state = withList((list) => {
      list.setActive("compact")
      list.hover(move, "unshare")
      return { active: list.active(), hovered: list.hovered() }
    })
    expect(state.active).toBe("compact")
    expect(state.hovered).toBe("unshare")
  })

  test("a pointer that has not moved does not hover", () => {
    expect(withList((list) => (list.hover(still, "share"), list.hovered()))).toBeNull()
  })

  test("leaving clears the mark", () => {
    expect(
      withList((list) => {
        list.hover(move, "share")
        list.unhover()
        return list.hovered()
      }),
    ).toBeNull()
  })
})

test("only useFilteredList decides what counts as a hover", async () => {
  const root = new URL("../..", import.meta.url).pathname
  const owners: string[] = []
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(root)) {
    if (file.includes(".test.")) continue
    const source = await Bun.file(`${root}${file}`).text()
    if (source.includes("movementX")) owners.push(file)
  }
  expect(owners).toEqual(["src/hooks/use-filtered-list.tsx"])
})
