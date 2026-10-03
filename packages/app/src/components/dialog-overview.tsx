import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { CountdownRing } from "@opencode-ai/ui/countdown-ring"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DateTime } from "luxon"
import { useRecent, type OverviewRow } from "@/context/recent"
import { useMru } from "@/context/mru"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { isStopKey, useStopSession } from "@/hooks/use-stop-session"
import {
  DialogDeleteSession,
  DialogRenameSession,
  useSessionActions,
  type SessionRef,
} from "@/hooks/use-session-actions"
import { formatKeybind, matchKeybind, parseKeybind } from "@/context/command"
import { attention, busy, flat } from "@/utils/attention"
import { busyDelay } from "@opencode-ai/ui/util/busy-tint"
import { isAlive } from "@opencode-ai/util/session"

function stoppable(row: OverviewRow) {
  return isAlive(row)
}

function getFilename(dir: string) {
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

type Section = "attention" | "recent"
type Entry = OverviewRow & { section: Section }
type Item = OverviewRow & { section: Section | "archived" }

const ORDER: Record<Item["section"], number> = { attention: 0, recent: 1, archived: 2 }
const DELETE_KEYBIND = "mod+backspace,mod+delete"
const deleteKeys = parseKeybind(DELETE_KEYBIND)

// An archived session is out of the recent hub, which is what carries the live
// flags, so the row shows none. Whether it is still running is asked of the
// server when it matters: the delete confirm refuses a running one.
function archivedRow(session: Session): Item {
  return {
    sessionID: session.id,
    directory: session.directory,
    title: session.title,
    updated: session.time.archived ?? session.time.updated,
    turn: false,
    subagents: 0,
    jobs: 0,
    unseen: false,
    question: false,
    permission: false,
    error: false,
    interacted: session.time.archived ?? session.time.updated,
    starred: session.starred === true,
    section: "archived",
  }
}

// The overview freezes item ORDER at open so keyboard navigation can't land on
// the wrong session when the server reorders the live list underneath. Content
// (busy/unseen/countdown/title) stays live per row; only positions and section
// membership are held. A row keeps its slot until the session leaves the recent
// hub entirely. Reopening reseeds the order.
//
// Where an arrival lands depends on the direction, because the two sections are
// read for different things. A row falling into Recent stopped working just now,
// which makes it the newest thing there and the one the user is looking for, so
// it goes to the FRONT. A row rising into Live goes to the BACK: Live is ranked
// by what THIS screen viewed last, and a session that woke while the view was
// open was started somewhere else, so it is unviewed here and belongs behind
// everything the user is actually cycling. Slotting either by the server's rank
// is not on offer — held rows have drifted from that order by then.
//
// The one exception is a session the user just unarchived. That is not new
// activity, so it goes back where its own last interaction ranks among the held
// rows. `restore` marks the id before the unarchive request, since the server
// republishes the hub before it answers.
function useFrozen() {
  const recent = useRecent()

  // Preserve row identity across frames so <For> does not remount every row's
  // DOM. Section is read off a map this memo has already refreshed, so it needs
  // no reactivity of its own — every consumer re-reads it through live().
  const sections = new Map<string, Section>()
  const entries = new Map<string, Entry>()
  const entry = (row: OverviewRow, section: Section) => {
    sections.set(row.sessionID, section)
    const cached = entries.get(row.sessionID)
    if (cached) return cached
    const created = Object.create(row, {
      section: { get: () => sections.get(row.sessionID) ?? "recent", enumerable: true },
    }) as Entry
    entries.set(row.sessionID, created)
    return created
  }

  const live = createMemo(() => {
    const map = new Map<string, Entry>()
    for (const row of recent.attention()) map.set(row.sessionID, entry(row, "attention"))
    for (const row of recent.recent()) map.set(row.sessionID, entry(row, "recent"))
    for (const id of entries.keys()) if (!map.has(id)) entries.delete(id)
    return map
  })

  const restored = new Set<string>()
  const slot = (ids: string[], id: string, current: Map<string, Entry>) => {
    const at = current.get(id)?.interacted ?? 0
    const index = ids.findIndex((other) => (current.get(other)?.interacted ?? 0) < at)
    return index === -1 ? [...ids, id] : [...ids.slice(0, index), id, ...ids.slice(index)]
  }
  const place = (ids: string[], arrived: string[], current: Map<string, Entry>) =>
    arrived
      .filter((id) => restored.has(id))
      .reduce((held, id) => slot(held, id, current), [...arrived.filter((id) => !restored.has(id)), ...ids])

  const seed = live()
  const [order, setOrder] = createStore({
    attention: [...seed.values()].filter((e) => e.section === "attention").map((e) => e.sessionID),
    recent: [...seed.values()].filter((e) => e.section === "recent").map((e) => e.sessionID),
  })

  createEffect(() => {
    const current = live()
    setOrder(
      produce((draft) => {
        const seen = new Set<string>()
        for (const section of ["attention", "recent"] as const) {
          draft[section] = draft[section].filter((id) => {
            const entry = current.get(id)
            if (!entry || entry.section !== section) return false
            seen.add(id)
            return true
          })
        }
        const arrived: string[] = []
        for (const [id, entry] of current) {
          if (seen.has(id)) continue
          if (entry.section === "attention") draft.attention.push(id)
          if (entry.section === "recent") arrived.push(id)
        }
        // New arrivals are prepended as a batch, not one unshift each: current
        // runs newest-first, so unshifting in turn would reverse them against
        // each other. `place` does the prepend and slots restored ids.
        if (arrived.length) draft.recent = place(draft.recent, arrived, current)
        for (const id of arrived) restored.delete(id)
      }),
    )
  })

  // The order arrays carry POSITION only; the entry's own section decides
  // membership, and an entry the arrays have not caught up with is placed here
  // by the same rule the effect below uses. Both halves matter because the
  // effect runs after paint: reading membership off the array renders a moved
  // row in its old section (so a stopped session paints in both), and skipping
  // the not-yet-listed arrivals renders it in neither. Deriving the whole list
  // during render makes the first paint correct, leaving the effect to persist
  // an order this has already settled on.
  const rows = (section: Section) =>
    createMemo(() => {
      const current = live()
      const listed = new Set(order[section])
      const held = order[section].filter((id) => current.get(id)?.section === section)
      const arrived = [...current.values()]
        .filter((entry) => entry.section === section && !listed.has(entry.sessionID))
        .map((entry) => entry.sessionID)
      const ids =
        arrived.length === 0 ? held : section === "attention" ? [...held, ...arrived] : place(held, arrived, current)
      return ids.map((id) => current.get(id)).filter((entry): entry is Entry => entry !== undefined)
    })

  return {
    attention: rows("attention"),
    recent: rows("recent"),
    restore: (id: string) => restored.add(id),
    forget: (id: string) => restored.delete(id),
  }
}

function Row(props: { row: Item }) {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const recent = useRecent()

  const countdown = () => recent.countdown(props.row)

  // The custom color comes from the row's directory child store, the same source
  // the sidebar uses.
  const state = () => {
    const [store] = globalSync.child(props.row.directory, { bootstrap: false })
    return attention(props.row, store.agent.find((a) => a.name === props.row.agent)?.color)
  }

  const halt = useStopSession()
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    halt(props.row.sessionID, props.row.directory)
  }

  return (
    <div class="flex items-center gap-3 w-full min-w-0 text-left">
      <Show when={props.row.starred}>
        <span title={language.t("home.starred")} class="shrink-0 flex">
          <Icon name="star" size="small" class="text-icon-warning-base" />
        </span>
      </Show>
      <span class="text-14-regular text-text-base truncate flex-1">
        {props.row.title || language.t("command.session.new")}
      </span>
      <span class="text-12-regular text-text-weak truncate">{getFilename(props.row.directory)}</span>
      <Show when={props.row.section !== "attention"}>
        <span class="text-12-regular text-text-weak shrink-0">
          {DateTime.fromMillis(props.row.updated).toRelative()}
        </span>
      </Show>
      <Show when={busy(state())}>
        {(dot) => (
          // One overlay per additional reason the session is busy, each
          // cross-fading over the base so the dot's tint oscillates through
          // every contributing colour, like the dock.
          <span
            data-slot="busy-dot"
            // A turn describes itself first, then the work no turn accounts for.
            // A running job is the only cause left once turn and subagents are
            // ruled out, so it is the terminal branch: the dot never lights for
            // anything else.
            title={
              props.row.turn
                ? props.row.subagents > 0
                  ? language.t("home.attention.busyDelegating")
                  : language.t("home.attention.busy")
                : props.row.subagents > 0
                  ? language.t("home.attention.delegating")
                  : language.t("home.attention.job")
            }
            class="relative size-2 rounded-full shrink-0"
            style={{ "--busy-tint": dot().tint }}
          >
            <span class="busy-dot-fill" />
            <For each={dot().overlays}>
              {(tint, index) => (
                <span
                  class="busy-dot-fill busy-dot-fill-overlay"
                  style={{
                    "--overlay-tint": tint,
                    "animation-delay": `0s, ${busyDelay(index(), dot().overlays.length)}`,
                  }}
                />
              )}
            </For>
          </span>
        )}
      </Show>
      <Show when={flat(state())}>
        {(dot) => (
          <span
            title={language.t(dot().label)}
            class={`size-2 rounded-full shrink-0 ${dot().class}`}
            style={dot().tint ? { "background-color": dot().tint } : undefined}
          />
        )}
      </Show>
      <Show when={props.row.section !== "archived"}>
        <ChipGroup>
          <Chip
            class={countdown() ? undefined : "opacity-35"}
            icon={<CountdownRing fraction={countdown() ? recent.remaining(props.row) : 0} />}
          >
            {countdown() ?? "--"}
          </Chip>
        </ChipGroup>
      </Show>
      <Show when={stoppable(props.row)}>
        <IconButton
          icon="circle-ban-sign"
          title={language.t("home.attention.stop")}
          onClick={stop}
          class="[&_[data-slot=icon-svg]]:!text-icon-critical-base [&_[data-slot=icon-svg]]:[stroke-width:1.5]"
        />
      </Show>
    </div>
  )
}

// The single source of truth for the overview's content and section order.
// Both the home page (`/`) and DialogOverview render this body inside their
// own frame, so any change to what the overview shows lands in both views. The
// search input holds focus so the arrow keys drive the list and typing filters.
//
// `manage` turns on the per-row session menu, the delete shortcut, and the
// archived section. Only the home page passes it: inside the overview dialog a
// confirm would replace the dialog itself, and the Ctrl+Tab switcher commits on
// Ctrl release.
export function Overview(props: {
  onOpen?: () => void
  attention?: boolean
  advance?: boolean
  switcher?: boolean
  current?: string
  manage?: boolean
}) {
  const frozen = useFrozen()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const actions = useSessionActions()
  const location = useLocation<{ stopped?: string }>()
  const navigate = useNavigate()
  const halt = useStopSession()
  const language = useLanguage()
  const mru = useMru()

  const [archive, setArchive] = createStore({ shown: false, rows: [] as Item[] })
  const [starredOnly, setStarredOnly] = createSignal(false)
  // Fetched rather than streamed: archived sessions live outside the recent hub,
  // so a membership change (archive, unarchive, delete) refetches the list. Only
  // the latest request may write, and a local change bumps the counter too, so
  // a snapshot taken before that change cannot resurrect a row it removed.
  let seq = 0
  const refetch = () => {
    const mine = ++seq
    return sdk.client.global
      .archived()
      .then((x) => (x.data ?? []).map(archivedRow))
      .catch(() => [] as Item[])
      .then((rows) => {
        if (mine === seq) setArchive("rows", rows)
      })
  }
  createEffect(
    on(
      () => archive.shown,
      (shown) => {
        if (shown) void refetch()
      },
    ),
  )

  const target = (row: OverviewRow): SessionRef => ({ id: row.sessionID, directory: row.directory, title: row.title })
  // The dialog system restores focus on close to whatever held it when the
  // dialog opened. Opening from search makes that search, so the arrow keys
  // drive the list again afterwards rather than the row control that opened it.
  const show = (element: () => JSX.Element) => {
    refocus()
    dialog.show(element)
  }
  const confirmDelete = (row: Item) =>
    show(() => (
      <DialogDeleteSession
        session={target(row)}
        guard
        onDeleted={() => {
          if (row.section === "archived") void refetch()
        }}
      />
    ))
  // Only rows shown as not live offer Archive, but a row can start working
  // between the render and the choice; hiding it then would leave it running
  // out of sight.
  const archiveRow = async (row: Item) => {
    if (!(await actions.idle(target(row), "archive"))) return
    if ((await actions.archive(target(row))) && archive.shown) void refetch()
  }
  const unarchiveRow = (row: Item) => {
    frozen.restore(row.sessionID)
    seq++
    setArchive("rows", (rows) => rows.filter((x) => x.sessionID !== row.sessionID))
    return actions.unarchive(target(row)).then((ok) => {
      if (!ok) frozen.forget(row.sessionID)
      return refetch().then(() => {
        if (!globalSync.data.recent_hub.some((e) => e.sessionID === row.sessionID)) frozen.forget(row.sessionID)
      })
    })
  }

  // A session briefly sits in both the hub and the fetched archive list while
  // the two sources catch up; the hub copy wins so the list keys stay unique.
  const live = createMemo<Item[]>(() => {
    const hub = [...frozen.attention(), ...frozen.recent()]
    const ids = new Set(hub.map((row) => row.sessionID))
    const rows =
      props.manage && archive.shown ? [...hub, ...archive.rows.filter((row) => !ids.has(row.sessionID))] : hub
    return starredOnly() ? rows.filter((row) => row.starred) : rows
  })

  // Sections stay fixed — "Live sessions" always above "Recent sessions" —
  // because section is the primary sort key (attention=0, recent=1), so the
  // sort never crosses the boundary. Group order follows first-appearance, so
  // pinning the boundary pins the groups.
  //
  // MRU reorders the LIVE section only: those are the sessions being juggled
  // right now, so "what this screen looked at last" is the useful order and is
  // what Ctrl+Tab cycles. Recent sessions keeps the server's interaction order
  // (turns and pings) so every device agrees on it — a per-browser view history
  // would otherwise make the same list read differently on each screen, and the
  // screen reading it is rarely the one that opened those sessions. Within live,
  // unviewed rows keep their normal order after the viewed ones (Infinity rank,
  // original index as final tiebreak).
  const overview = createMemo(() => {
    const rank = new Map(mru.order().map((id, i) => [id, i]))
    return live()
      .map((row, i) => ({
        row,
        i,
        section: ORDER[row.section],
        mru: row.section === "attention" ? (rank.get(row.sessionID) ?? Infinity) : 0,
      }))
      .sort((a, b) => a.section - b.section || a.mru - b.mru || a.i - b.i)
      .map((x) => x.row)
  })

  // The Ctrl+Tab switcher is OS Alt+Tab within each section: live sessions
  // first, then the rest, each in view order. The overview keeps the recent
  // section in server order, so the switcher re-sorts it. Snapshotted at open,
  // so a session changing state mid-cycle cannot move a row out from under the
  // highlight.
  const switched = props.switcher
    ? untrack(() => {
        const rank = new Map(mru.order().map((id, i) => [id, i]))
        const at = (row: Item) => rank.get(row.sessionID) ?? rank.size
        const section = (row: Item) => ORDER[row.section]
        return overview().toSorted((a, b) => section(a) - section(b) || at(a) - at(b))
      })
    : undefined
  const items = () => switched ?? overview()
  const empty = () => items().length === 0
  // Ctrl+Tab opens on the first row that is not the session on screen: the next
  // live session from a live one, the most recent live session from one that is
  // not. Ctrl+Shift+Tab rests on the session on screen.
  // Landing here from a stop (navigate carried the stopped id) skips that row: at
  // mount the abort hasn't resolved, so the stopped session is still busy and
  // still sits atop attention — without the skip the cursor would seed on it and,
  // via preserveActive, trail it down into recent. Skip only on the home-page
  // stop path (attention, not the Ctrl+Tab switcher), and fall back to items()[0]
  // when the stopped row is the only one.
  const stopped = props.attention && !props.advance && !props.switcher ? location.state?.stopped : undefined
  const initial = !props.attention
    ? undefined
    : props.switcher
      ? (items().find((row) => (row.sessionID === props.current) !== !!props.advance) ?? items()[0])
      : stopped
        ? (items().find((row) => row.sessionID !== stopped) ?? items()[0])
        : items()[0]

  const open = (row: Item) => {
    // Opening from the overview is an explicit open — declare keep-warm intent
    // so the ping daemon arms. A plain reload/reconnect does not hit this path.
    // An archived session is being looked at, not resumed, so it stays cold.
    void sdk.client.session.seen({ directory: row.directory, sessionID: row.sessionID })
    if (row.section !== "archived") void sdk.client.session.arm({ directory: row.directory, sessionID: row.sessionID })
    navigate(`/${base64Encode(row.directory)}/session/${row.sessionID}`)
    props.onOpen?.()
  }

  // Ctrl+Tab switcher: only armed when the overview was opened via the
  // attention keybind. Holding Ctrl and tapping Tab advances the highlight
  // (Ctrl+Shift+Tab retreats); releasing Ctrl commits the highlighted session,
  // matching OS-style Alt+Tab. Cycling spans the whole list — it starts on the
  // first attention session but flows into the recent sessions past the end.
  // Opened any other way, releasing Ctrl does nothing — a stray modifier must
  // never navigate.
  let ref: ListRef | undefined
  const [highlight, setHighlight] = createSignal(initial)

  const attentionGroup = () => language.t("home.attention")
  const recentGroup = () => language.t("home.recentSessions")
  const archivedGroup = () => language.t("home.archivedSessions")
  const group = (row: Item) =>
    ({ attention: attentionGroup, recent: recentGroup, archived: archivedGroup })[row.section]()

  let container: HTMLDivElement | undefined
  const search = () => container?.querySelector<HTMLInputElement>("[data-slot=list-search] input")
  const refocus = () => search()?.focus()

  // Never on a live row: the server deletes a busy session without complaint,
  // and a live one is what the user is watching. The chord is taken only while
  // the empty search box holds focus, which is where the arrow keys drive the
  // list; typed text keeps it for the input (macOS Cmd+Backspace clears the
  // line), and any other focus (a row's open menu, the toggle) keeps its own.
  const remove = (event: KeyboardEvent) => {
    if (dialog.active || !matchKeybind(deleteKeys, event)) return
    const input = search()
    if (!input || event.target !== input || input.value) return
    const row = highlight()
    if (!row || row.section === "attention") return
    event.preventDefault()
    event.stopPropagation()
    if (row.starred) return actions.refuseStarred("delete")
    confirmDelete(row)
  }
  if (props.manage) {
    onMount(() => window.addEventListener("keydown", remove, true))
    onCleanup(() => window.removeEventListener("keydown", remove, true))
  }

  // A stop key fires the highlighted row's stop button: a full stop, matching
  // the session header's stopSession (abort the running turn AND drop the cache
  // ping). Scoped to the overview: the listener lives only while this component
  // is mounted (home page or dialog), so the key is inert everywhere else.
  // Capture phase because the command system is suspended while a dialog is
  // open, so a registered command would never see the key here. Gated on the
  // same `stoppable` that renders the row's stop button — a row without one is
  // a no-op. If the stopped row is the session open behind the dialog, navigate
  // home like the header does; stopping any other row leaves the view put.
  const stop = (event: KeyboardEvent) => {
    if (!isStopKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    const row = highlight()
    if (!row || !stoppable(row)) return
    if (halt(row.sessionID, row.directory)) props.onOpen?.()
  }
  onMount(() => window.addEventListener("keydown", stop, true))
  onCleanup(() => window.removeEventListener("keydown", stop, true))

  if (props.attention) {
    // The commit-on-Ctrl-release is only a real gesture when the overview was
    // opened BY a Ctrl-hold keybind (Ctrl+Tab / Ctrl+Shift+Tab), which the
    // `switcher` prop marks. That opening keybind IS the gesture, so arm on
    // mount — the command that opened the dialog never runs through `cycle`, so
    // waiting for a second Ctrl+Tab would strand the single-tap case (release
    // Ctrl once and nothing happened). `armed` still gates it so a bare Control
    // keyup on a NON-switcher surface (the home page, a mod+k palette) never
    // navigates; those pass no `switcher`, so they open disarmed.
    let armed = !!props.switcher
    const cycle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.key === "Tab")) return
      event.preventDefault()
      event.stopPropagation()
      armed = true
      ref?.onKeyDown(new KeyboardEvent("keydown", { key: event.shiftKey ? "ArrowUp" : "ArrowDown", bubbles: true }))
    }
    const commit = (event: KeyboardEvent) => {
      if (event.key !== "Control") return
      if (!armed) return
      armed = false
      const row = highlight()
      if (row) open(row)
    }
    onMount(() => {
      window.addEventListener("keydown", cycle, true)
      window.addEventListener("keyup", commit, true)
    })
    onCleanup(() => {
      window.removeEventListener("keydown", cycle, true)
      window.removeEventListener("keyup", commit, true)
    })
  }

  const toggle = () => (
    <div class="flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="small"
        onClick={() => {
          setArchive("shown", (shown) => !shown)
          refocus()
        }}
      >
        {archive.shown ? language.t("home.archived.hide") : language.t("home.archived.show")}
      </Button>
      <Button
        variant="ghost"
        size="small"
        data-active={starredOnly()}
        aria-pressed={starredOnly()}
        onClick={() => {
          setStarredOnly((on) => !on)
          refocus()
        }}
      >
        {starredOnly() ? language.t("home.starred.hide") : language.t("home.starred.show")}
      </Button>
    </div>
  )
  // Built once: List reads its search options at several sites, and an element
  // inside that object would be rebuilt on each read.
  const searchAction = props.manage ? toggle() : undefined

  const menu = (row: Item) => {
    // Kobalte's DropdownMenuContent calls focus on its trigger right
    // after onCloseAutoFocus returns, even when the handler prevents default,
    // so a dialog opened from onSelect loses focus to it. The choice is held
    // until the menu has closed and run a task later, when that refocus is done.
    let pending: (() => void) | undefined
    const choose = (run: () => void) => () => {
      pending = run
    }
    const rename = choose(() => show(() => <DialogRenameSession session={target(row)} />))
    const archiveOne = choose(() => void archiveRow(row).then(refocus))
    const unarchiveOne = choose(() => void unarchiveRow(row).then(refocus))
    const deleteOne = choose(() => confirmDelete(row))
    const starOne = choose(() => void actions.star(target(row), !row.starred).then(refocus))
    return (
      <DropdownMenu>
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          aria-label={language.t("common.moreOptions")}
          class="size-(--control-height) rounded-md opacity-0 focus-visible:opacity-100 data-[expanded]:opacity-100 data-[expanded]:bg-surface-base-active any-pointer-coarse:opacity-100 [[data-slot=list-item-row]:is(:hover,[data-active=true])_&]:opacity-100"
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            onCloseAutoFocus={() => {
              const run = pending ?? refocus
              pending = undefined
              setTimeout(run)
            }}
          >
            <Show when={row.section !== "archived"}>
              <DropdownMenu.Item onSelect={rename}>
                <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={starOne}>
                <DropdownMenu.ItemLabel>
                  {row.starred ? language.t("session.unstar") : language.t("session.star")}
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </Show>
            <Show when={row.section === "recent"}>
              <div title={row.starred ? actions.starredRefusal("archive") : undefined}>
                <DropdownMenu.Item disabled={row.starred} onSelect={archiveOne}>
                  <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </div>
            </Show>
            <Show when={row.section === "archived"}>
              <DropdownMenu.Item onSelect={unarchiveOne}>
                <DropdownMenu.ItemLabel>{language.t("common.unarchive")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </Show>
            <Show when={row.section !== "attention"}>
              <DropdownMenu.Separator />
              <div title={row.starred ? actions.starredRefusal("delete") : undefined}>
                <DropdownMenu.Item disabled={row.starred} onSelect={deleteOne}>
                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                  <span class="ml-auto pl-4 text-12-regular text-text-weak">{formatKeybind(DELETE_KEYBIND)}</span>
                </DropdownMenu.Item>
              </div>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    )
  }

  return (
    <Show
      when={!empty()}
      fallback={
        <div class="flex items-center justify-between px-3 py-6">
          <span class="text-14-regular text-text-weak">
            {starredOnly() ? language.t("home.starred.empty") : language.t("home.empty.description")}
          </span>
          <Show when={props.manage}>{toggle()}</Show>
        </div>
      }
    >
      <div ref={container} class="contents">
        <List
          ref={(r) => (ref = r)}
          preserveActive
          initial={initial}
          onMove={setHighlight}
          search={{
            placeholder: language.t("common.search.placeholder"),
            autofocus: true,
            action: searchAction,
          }}
          items={items}
          key={(row) => row.sessionID}
          filterKeys={["title", "directory"]}
          groupBy={group}
          groups={[attentionGroup(), recentGroup(), ...(props.manage && archive.shown ? [archivedGroup()] : [])]}
          actions={props.manage ? menu : undefined}
          onSelect={(row) => {
            if (row) open(row)
          }}
          // content-visibility skips layout/paint for offscreen rows, which this
          // list needs because it is the one List that runs to hundreds of rows.
          // Deliberately NOT windowing: List resolves the keyboard-active row by
          // querying the live DOM (findByKey), so unmounting offscreen rows would
          // strand arrow-key navigation. Every row stays mounted here.
          // The `auto` in contain-intrinsic-size makes a row remember its measured
          // height, so scroll-into-view math doesn't drift off the estimate.
          class="flex-1 min-h-0 !px-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 [&_[data-slot=list-scroll]]:gap-10 [&_[data-slot=list-scroll]]:pb-6 [&_[data-slot=list-group]:last-child]:pb-0 [&_[data-slot=list-header]]:!bg-background-base [&_[data-slot=list-header]:after]:!bg-none [&_[data-slot=list-items]]:gap-1 [&_[data-slot=list-item]]:rounded-md [&_[data-slot=list-item]]:px-3 [&_[data-slot=list-item]]:py-2 [&_[data-slot=list-item]]:[content-visibility:auto] [&_[data-slot=list-item]]:[contain-intrinsic-size:auto_36px] any-pointer-coarse:[&_[data-slot=list-item]]:[contain-intrinsic-size:auto_56px]"
        >
          {(row) => <Row row={row} />}
        </List>
      </div>
    </Show>
  )
}

export function DialogOverview(props: { advance?: boolean; switcher?: boolean; current?: string }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog size="large" title={language.t("home.title")} transition>
      <Overview
        attention
        advance={props.advance}
        switcher={props.switcher}
        current={props.current}
        onOpen={() => dialog.close()}
      />
    </Dialog>
  )
}
