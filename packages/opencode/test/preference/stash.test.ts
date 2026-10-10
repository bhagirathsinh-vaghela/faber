import { expect, test } from "bun:test"
import { Stash } from "../../src/preference/stash"

test("concurrent pushes all land", async () => {
  const before = (await Stash.list()).length
  const stamps = [1, 2, 3, 4, 5, 6, 7, 8]
  await Promise.all(stamps.map((timestamp) => Stash.push({ prompt: [], timestamp })))
  const entries = await Stash.list()
  expect(entries.length).toBe(before + stamps.length)
  expect(
    entries
      .slice(before)
      .map((entry) => entry.timestamp)
      .toSorted(),
  ).toEqual(stamps)
})
