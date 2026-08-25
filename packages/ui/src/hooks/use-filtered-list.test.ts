import { describe, expect, test } from "bun:test"
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
