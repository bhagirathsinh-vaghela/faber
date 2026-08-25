import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  initial?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
  preserveActive?: boolean
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  // A category keeps ONE group object, its items behind a signal. Handing the
  // caller's outer <For> a new object per pass would rekey it and tear down
  // every row beneath, so a single changed row would rebuild the whole list.
  // The signal is what lets the inner <For> still see the new items, since a
  // keyed <For> never re-reads a plain property off the object it was given.
  const cache = new Map<string, { group: Group; set: (items: T[]) => void }>()
  const stabilize = (next: { category: string; items: T[] }[]) => {
    const stable = next.map(({ category, items }) => {
      const existing = cache.get(category)
      if (existing) {
        existing.set(items)
        return existing.group
      }
      const [read, write] = createSignal(items)
      const group = {
        category,
        get items() {
          return read() as [T, ...T[]]
        },
      } as Group
      cache.set(category, { group, set: (value) => write(() => value) })
      return group
    })
    if (cache.size > stable.length) {
      const keep = new Set(stable.map((group) => group.category))
      for (const category of cache.keys()) if (!keep.has(category)) cache.delete(category)
    }
    return stable
  }

  const build = (filter: string, items: T[]) => {
    const needle = (filter ?? "").toLowerCase()
    return pipe(
      items,
      (x) => {
        if (!needle) return x
        if (!props.filterKeys && Array.isArray(x) && x.every((e) => typeof e === "string")) {
          return fuzzysort.go(needle, x).map((x) => x.target) as T[]
        }
        return fuzzysort.go(needle, x, { keys: props.filterKeys! }).map((x) => x.obj)
      },
      groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
      entries(),
      map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
      (result) => (props.sortGroupsBy ? result.sort(props.sortGroupsBy) : result),
      stabilize,
    )
  }

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    // Awaiting a settled value still costs a frame, during which `.latest` keeps
    // serving the previous list — so a synchronous source must not be awaited.
    ({ filter, items }) =>
      items instanceof Promise ? items.then((resolved) => build(filter, resolved || [])) : build(filter, items || []),
    { initialValue: empty },
  )

  const flat = createMemo(() => {
    return pipe(
      grouped.latest || [],
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.initial) return props.key(props.initial)
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  // The row under the pointer, kept apart from the keyboard cursor so hovering
  // marks a row without changing what Enter submits.
  const [hovered, setHovered] = createSignal<string | null>(null)

  // A list scrolling under a still pointer fires mouseenter on whatever lands
  // beneath it, so only real movement counts as hovering.
  const hover = (event: MouseEvent, key: string) => {
    if (event.movementX === 0 && event.movementY === 0) return
    setHovered(key)
  }

  const unhover = () => setHovered(null)

  const reset = () => {
    if (props.preserveActive) {
      const current = list.active()
      if (current && flat().some((x) => props.key(x) === current)) return
    }
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
      const selected = flat()[selectedIndex]
      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
      // Refiltering rebuilds the rows under a pointer that has not moved, so
      // the remembered key would mark a row the cursor is no longer on.
      unhover()
    }),
  )

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
    hovered,
    hover,
    unhover,
  }
}
