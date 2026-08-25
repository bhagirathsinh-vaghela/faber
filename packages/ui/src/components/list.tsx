import { type FilteredListProps, useFilteredList } from "@opencode-ai/ui/hooks"
import { createEffect, createMemo, createSignal, For, onCleanup, type JSX, on, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"
import { TextField } from "./text-field"

function findByKey(container: HTMLElement, key: string) {
  const nodes = container.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')
  for (const node of nodes) {
    if (node.getAttribute("data-key") === key) return node
  }
}

export interface ListSearchProps {
  placeholder?: string
  autofocus?: boolean
  hideIcon?: boolean
  class?: string
  action?: JSX.Element
}

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

export interface ListProps<T> extends FilteredListProps<T> {
  class?: string
  children: (item: T) => JSX.Element
  // Per-item interactive controls (toggle, remove, menu). Rendered as a SIBLING
  // of the item button, never nested inside it, so we don't put a <button> or
  // form control inside the item <button> (invalid HTML / broken a11y).
  actions?: (item: T) => JSX.Element
  emptyMessage?: string
  loadingMessage?: string
  onKeyEvent?: (event: KeyboardEvent, item: T | undefined) => void
  onMove?: (item: T | undefined) => void
  onFilter?: (value: string) => void
  activeIcon?: IconProps["name"]
  filter?: string
  search?: ListSearchProps | boolean
  itemWrapper?: (item: T, node: JSX.Element) => JSX.Element
  divider?: boolean
  add?: ListAddProps
}

export interface ListRef {
  onKeyDown: (e: KeyboardEvent) => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  setFilter: (value: string) => void
}

export function List<T>(props: ListProps<T> & { ref?: (ref: ListRef) => void }) {
  const i18n = useI18n()
  const [scrollRef, setScrollRef] = createSignal<HTMLDivElement | undefined>(undefined)
  const [internalFilter, setInternalFilter] = createSignal("")
  let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined

  const scrollIntoView = (container: HTMLDivElement, node: HTMLElement, block: "center" | "nearest") => {
    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    const top = nodeRect.top - containerRect.top + container.scrollTop
    const bottom = top + nodeRect.height
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    const target =
      block === "center"
        ? top - container.clientHeight / 2 + nodeRect.height / 2
        : top < viewTop
          ? top
          : bottom > viewBottom
            ? bottom - container.clientHeight
            : viewTop
    const max = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.max(0, Math.min(target, max))
  }

  const { filter, grouped, flat, active, setActive, hovered, hover, unhover, onKeyDown, onInput, refetch } =
    useFilteredList<T>(props)

  // Rows arrive in chunks, because a list that runs to hundreds of rows (the
  // session overview) otherwise builds every row in the opening click's own
  // task and holds first paint for the whole thing. Only the RENDER is
  // deferred: flat() is complete from the first frame, so arrow keys, Enter
  // and the filter all address the full set while later rows are still
  // pending. content-visibility already spares offscreen rows their layout,
  // but not their construction, which is what this defers.
  // The opening task only has to fill the viewport, so it carries a smaller
  // first chunk than the idle passes that follow it: everything mounted in that
  // task is laid out before the list can paint, and rows past the fold cost the
  // same layout as the visible ones while showing nothing.
  const FIRST = 16
  const CHUNK = 60
  const [budget, setBudget] = createSignal(FIRST)
  createEffect(on(filter, () => setBudget(FIRST), { defer: true }))
  createEffect(() => {
    const total = flat().length
    if (budget() >= total) return
    const grow = () => setBudget((current) => Math.min(total, current + CHUNK))
    // requestIdleCallback yields the rest of the click's frame back to paint;
    // Safari lacks it, where a macrotask still breaks up the work.
    const idle = typeof window.requestIdleCallback === "function"
    const handle = idle ? window.requestIdleCallback(grow, { timeout: 200 }) : setTimeout(grow, 0)
    onCleanup(() => (idle ? window.cancelIdleCallback(handle as number) : clearTimeout(handle as ReturnType<typeof setTimeout>)))
  })
  // A row has to exist before it can be scrolled to or navigated onto, so any
  // row the list points at is mounted at once rather than waiting for the
  // chunk timer to reach it. Navigation outruns that timer whenever a key is
  // held down, and the selected row can sit anywhere in the list.
  const reach = (item: T | undefined) => {
    if (!item) return
    const index = flat().findIndex((candidate) => props.key(candidate) === props.key(item))
    if (index < budget()) return
    setBudget(index + 1)
  }
  createEffect(() => reach(flat().find((item) => props.key(item) === active())))
  createEffect(() => reach(props.current))

  // Where each group starts in the flattened order, so one budget spans the
  // groups instead of each filling independently.
  const offsets = createMemo(() => {
    let start = 0
    return grouped.latest.map((group) => {
      const at = start
      start += group.items.length
      return at
    })
  })

  const searchProps = () => (typeof props.search === "object" ? props.search : {})
  const searchAction = () => searchProps().action
  const addProps = () => props.add
  const showAdd = () => !!addProps()

  const applyFilter = (value: string, options?: { ref?: boolean }) => {
    const prev = filter()
    setInternalFilter(value)
    onInput(value)
    props.onFilter?.(value)

    if (!options?.ref) return

    // Force a refetch even if the value is unchanged.
    // This is important for programmatic changes like Tab completion.
    if (prev === value) {
      refetch()
      return
    }
    queueMicrotask(() => refetch())
  }

  createEffect(() => {
    if (props.filter === undefined) return
    if (props.filter === internalFilter()) return
    setInternalFilter(props.filter)
    onInput(props.filter)
  })

  createEffect(
    on(
      filter,
      () => {
        scrollRef()?.scrollTo(0, 0)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const scroll = scrollRef()
    if (!scroll) return
    if (!props.current) return
    const key = props.key(props.current)
    requestAnimationFrame(() => {
      const element = findByKey(scroll, key)
      if (!element) return
      scrollIntoView(scroll, element, "center")
    })
  })

  createEffect(() => {
    const all = flat()
    if (all.length === 0) return
    const scroll = scrollRef()
    if (!scroll) return
    if (active() === props.key(all[0])) {
      scroll.scrollTo(0, 0)
      return
    }
    const key = active()
    if (!key) return
    const element = findByKey(scroll, key)
    if (!element) return
    scrollIntoView(scroll, element, "center")
  })

  createEffect(() => {
    const all = flat()
    const current = active()
    const item = all.find((x) => props.key(x) === current)
    props.onMove?.(item)
  })

  const handleSelect = (item: T | undefined, index: number) => {
    props.onSelect?.(item, index)
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return

    const all = flat()
    const selected = all.find((x) => props.key(x) === active())
    const index = selected ? all.indexOf(selected) : -1
    props.onKeyEvent?.(e, selected)

    if (e.defaultPrevented) return

    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault()
      if (selected) handleSelect(selected, index)
    } else if (props.search) {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "n" || e.key === "p")) {
        onKeyDown(e)
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        onKeyDown(e)
      }
    } else {
      onKeyDown(e)
    }
  }

  props.ref?.({
    onKeyDown: handleKey,
    setScrollRef,
    setFilter: (value) => applyFilter(value, { ref: true }),
  })

  const renderAdd = () => {
    const add = addProps()
    if (!add) return null
    return (
      <div data-slot="list-item-add" classList={{ [add.class ?? ""]: !!add.class }}>
        {add.render()}
      </div>
    )
  }

  function GroupHeader(groupProps: { category: string }): JSX.Element {
    const [stuck, setStuck] = createSignal(false)
    const [header, setHeader] = createSignal<HTMLDivElement | undefined>(undefined)

    createEffect(() => {
      const scroll = scrollRef()
      const node = header()
      if (!scroll || !node) return

      const handler = () => {
        const rect = node.getBoundingClientRect()
        const scrollRect = scroll.getBoundingClientRect()
        setStuck(rect.top <= scrollRect.top + 1 && scroll.scrollTop > 0)
      }

      scroll.addEventListener("scroll", handler, { passive: true })
      handler()
      onCleanup(() => scroll.removeEventListener("scroll", handler))
    })

    return (
      <div data-slot="list-header" data-stuck={stuck()} ref={setHeader}>
        {groupProps.category}
      </div>
    )
  }

  const emptyMessage = () => {
    if (grouped.loading) return props.loadingMessage ?? i18n.t("ui.list.loading")
    if (props.emptyMessage) return props.emptyMessage

    const query = filter()
    if (!query) return i18n.t("ui.list.empty")

    const suffix = i18n.t("ui.list.emptyWithFilter.suffix")
    return (
      <>
        <span>{i18n.t("ui.list.emptyWithFilter.prefix")}</span>
        <span data-slot="list-filter">&quot;{query}&quot;</span>
        <Show when={suffix}>
          <span>{suffix}</span>
        </Show>
      </>
    )
  }

  return (
    <div data-component="list" classList={{ [props.class ?? ""]: !!props.class }}>
      <Show when={!!props.search}>
        <div data-slot="list-search-wrapper">
          <div
            data-slot="list-search"
            classList={{ [searchProps().class ?? ""]: !!searchProps().class }}
            onMouseDown={(event) => {
              const container = event.currentTarget
              if (!(container instanceof HTMLElement)) return

              const node = container.querySelector("input, textarea")
              const input = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : inputRef
              input?.focus()

              // Prevent global listeners (e.g. dnd sensors) from cancelling focus.
              event.stopPropagation()
            }}
          >
            <div data-slot="list-search-container">
              <Show when={!searchProps().hideIcon}>
                <Icon name="magnifying-glass" />
              </Show>
              <TextField
                autofocus={searchProps().autofocus}
                variant="ghost"
                data-slot="list-search-input"
                type="text"
                ref={(el: HTMLInputElement | HTMLTextAreaElement) => {
                  inputRef = el
                  // Native autofocus only fires on document parse, not on SPA
                  // navigation; focus imperatively so arrow keys reach the list
                  // when the list mounts outside a dialog (e.g. the home page).
                  if (searchProps().autofocus) queueMicrotask(() => el.focus())
                }}
                value={internalFilter()}
                onChange={(value) => applyFilter(value)}
                onKeyDown={handleKey}
                placeholder={searchProps().placeholder}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
            </div>
            <Show when={internalFilter()}>
              <IconButton
                icon="circle-x"
                variant="ghost"
                onClick={() => {
                  setInternalFilter("")
                  queueMicrotask(() => inputRef?.focus())
                }}
                aria-label={i18n.t("ui.list.clearFilter")}
              />
            </Show>
          </div>
          {searchAction()}
        </div>
      </Show>
      <div ref={setScrollRef} data-slot="list-scroll">
        <Show
          when={flat().length > 0 || showAdd() || props.groups?.length}
          fallback={
            <div data-slot="list-empty-state">
              <div data-slot="list-message">{emptyMessage()}</div>
            </div>
          }
        >
          <For each={grouped.latest}>
            {(group, groupIndex) => {
              const isLastGroup = () => groupIndex() === grouped.latest.length - 1
              // Read through the group object on every access: useFilteredList
              // keeps one object per category and swaps its items behind a
              // signal, so a destructured copy would freeze at the first pass.
              const items = () => group.items
              const visible = () => {
                const room = budget() - (offsets()[groupIndex()] ?? 0)
                if (room >= items().length) return items()
                return room <= 0 ? [] : items().slice(0, room)
              }
              return (
                <div data-slot="list-group">
                  <Show when={group.category}>
                    <GroupHeader category={group.category} />
                  </Show>
                  <div data-slot="list-items">
                    <Show when={items().length === 0}>
                      <div data-slot="list-group-empty">{i18n.t("ui.list.empty")}</div>
                    </Show>
                    <For each={visible()}>
                      {(item, i) => {
                        const showDivider = () =>
                          props.divider && (i() !== items().length - 1 || (showAdd() && isLastGroup()))
                        const button = (
                          <button
                            data-slot="list-item"
                            data-key={props.key(item)}
                            data-active={props.key(item) === active()}
                            data-hovered={props.key(item) === hovered()}
                            data-selected={item === props.current}
                            onClick={() => handleSelect(item, i())}
                            onKeyDown={handleKey}
                            type="button"
                            onMouseMove={(event) => hover(event, props.key(item))}
                            onMouseLeave={unhover}
                          >
                            {props.children(item)}
                            <Show when={item === props.current}>
                              <span data-slot="list-item-selected-icon">
                                <Icon name="check-small" />
                              </span>
                            </Show>
                            <Show when={props.activeIcon}>
                              {(icon) => (
                                <span data-slot="list-item-active-icon">
                                  <Icon name={icon()} />
                                </span>
                              )}
                            </Show>
                            <Show when={!props.actions && showDivider()}>
                              <span data-slot="list-item-divider" />
                            </Show>
                          </button>
                        )
                        // Actions render as a SIBLING of the item button, inside
                        // a non-interactive row wrapper, so no interactive
                        // control is nested inside the item <button>.
                        const node = props.actions ? (
                          <div
                            data-slot="list-item-row"
                            data-active={props.key(item) === active()}
                            data-hovered={props.key(item) === hovered()}
                            onMouseMove={(event) => hover(event, props.key(item))}
                            onMouseLeave={unhover}
                          >
                            {button}
                            <div data-slot="list-item-actions">{props.actions(item)}</div>
                            <Show when={showDivider()}>
                              <span data-slot="list-item-divider" />
                            </Show>
                          </div>
                        ) : (
                          button
                        )
                        if (props.itemWrapper) return props.itemWrapper(item, node)
                        return node
                      }}
                    </For>
                    <Show when={showAdd() && isLastGroup()}>{renderAdd()}</Show>
                  </div>
                </div>
              )
            }}
          </For>
          <Show when={grouped.latest.length === 0 && showAdd()}>
            <div data-slot="list-group">
              <div data-slot="list-items">{renderAdd()}</div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
