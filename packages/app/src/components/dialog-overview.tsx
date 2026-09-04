import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
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
import { attention, busy, flat } from "@/utils/attention"
import { busyDelay } from "@opencode-ai/ui/util/busy-tint"

function getFilename(dir: string) {
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

type Section = "attention" | "recent"
type Entry = OverviewRow & { section: Section }

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
        // Prepended as a batch, not one unshift each: current runs newest-first,
        // so unshifting in turn would reverse them against each other.
        if (arrived.length) draft.recent = [...arrived, ...draft.recent]
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
      const held = order[section]
        .map((id) => current.get(id))
        .filter((entry): entry is Entry => entry !== undefined && entry.section === section)
      const arrived = [...current.values()].filter((entry) => entry.section === section && !listed.has(entry.sessionID))
      if (arrived.length === 0) return held
      return section === "attention" ? [...held, ...arrived] : [...arrived, ...held]
    })

  return { attention: rows("attention"), recent: rows("recent") }
}

function Row(props: { row: OverviewRow; showTime?: boolean }) {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const recent = useRecent()

  const countdown = () => recent.countdown(props.row)

  // The custom color comes from the row's directory child store, the same source
  // the sidebar uses.
  const state = () => {
    const [store] = globalSync.child(props.row.directory, { bootstrap: false })
    return attention(props.row, store.agent.find((a) => a.name === props.row.agent)?.color)
  }

  const stopPing = (e: MouseEvent) => {
    e.stopPropagation()
    void sdk.client.session.pingStop({ directory: props.row.directory, sessionID: props.row.sessionID })
  }

  return (
    <div class="flex items-center gap-3 w-full min-w-0 text-left">
      <span class="text-14-regular text-text-base truncate flex-1">
        {props.row.title || language.t("command.session.new")}
      </span>
      <span class="text-12-regular text-text-weak truncate">{getFilename(props.row.directory)}</span>
      <Show when={props.showTime}>
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
            // A running job is the only cause left once self and descendant are
            // ruled out, so it is the terminal branch: the dot never lights for
            // anything else.
            title={
              props.row.busySelf
                ? props.row.busyDescendant
                  ? language.t("home.attention.busyDelegating")
                  : language.t("home.attention.busy")
                : props.row.busyDescendant
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
      <ChipGroup>
        <Chip
          class={countdown() ? undefined : "opacity-35"}
          icon={<CountdownRing fraction={countdown() ? recent.remaining(props.row) : 0} />}
        >
          {countdown() ?? "--"}
        </Chip>
      </ChipGroup>
      <Show when={props.row.pingAt}>
        <IconButton
          icon="circle-ban-sign"
          title={language.t("home.attention.stopPing")}
          onClick={stopPing}
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
export function Overview(props: { onOpen?: () => void; attention?: boolean; advance?: boolean; switcher?: boolean }) {
  const frozen = useFrozen()
  const sdk = useGlobalSDK()
  const location = useLocation<{ stopped?: string }>()
  const navigate = useNavigate()
  const runStop = useStopSession()
  const language = useLanguage()
  const mru = useMru()

  const live = createMemo(() => [...frozen.attention(), ...frozen.recent()])

  // Drop stale MRU ids (session archived or deleted) whenever the live set
  // changes. prune guards against a transient empty list so mid-load churn can't
  // wipe the MRU. Kept out of the ordering memo so it never writes during a read.
  createEffect(() => mru.prune(new Set(live().map((r) => r.sessionID))))

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
  const items = createMemo(() => {
    const rank = new Map(mru.order().map((id, i) => [id, i]))
    return live()
      .map((row, i) => ({
        row,
        i,
        section: row.section === "attention" ? 0 : 1,
        mru: row.section === "attention" ? (rank.get(row.sessionID) ?? Infinity) : 0,
      }))
      .sort((a, b) => a.section - b.section || a.mru - b.mru || a.i - b.i)
      .map((x) => x.row)
  })
  const empty = () => items().length === 0
  // Ctrl+Tab advances one step on the opening press (highlight the next session,
  // position 1), so two live sessions flip with a single tap. Ctrl+Shift+Tab and
  // the home page rest on the current session (position 0). Further taps cycle.
  // Landing here from a stop (navigate carried the stopped id) skips that row: at
  // mount the abort hasn't resolved, so the stopped session is still busy and
  // still sits atop attention — without the skip the cursor would seed on it and,
  // via preserveActive, trail it down into recent. Skip only on the home-page
  // stop path (attention, not the Ctrl+Tab switcher), and fall back to items()[0]
  // when the stopped row is the only one.
  const stopped = props.attention && !props.advance && !props.switcher ? location.state?.stopped : undefined
  const initial = !props.attention
    ? undefined
    : props.advance
      ? (items()[1] ?? items()[0])
      : stopped
        ? (items().find((row) => row.sessionID !== stopped) ?? items()[0])
        : items()[0]

  const open = (row: OverviewRow) => {
    void sdk.client.session.seen({ directory: row.directory, sessionID: row.sessionID })
    // Opening from the overview is an explicit open — declare keep-warm intent
    // so the ping daemon arms. A plain reload/reconnect does not hit this path.
    void sdk.client.session.arm({ directory: row.directory, sessionID: row.sessionID })
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

  // A stop key fires the highlighted row's stop button: a full stop, matching
  // the session header's stopSession (abort the running turn AND drop the cache
  // ping). Scoped to the overview: the listener lives only while this component
  // is mounted (home page or dialog), so the key is inert everywhere else.
  // Capture phase because the command system is suspended while a dialog is
  // open, so a registered command would never see the key here. Gated on the
  // same pingAt that renders the row's stop button — a row without one is a
  // no-op. If the stopped row is the session open behind the dialog, navigate
  // home like the header does; stopping any other row leaves the view put.
  const stop = (event: KeyboardEvent) => {
    if (!isStopKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    const row = highlight()
    if (!row?.pingAt) return
    if (runStop(row.sessionID, row.directory)) props.onOpen?.()
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

  return (
    <Show
      when={!empty()}
      fallback={<div class="px-3 py-6 text-14-regular text-text-weak">{language.t("home.empty.description")}</div>}
    >
      <List
        ref={(r) => (ref = r)}
        preserveActive
        initial={initial}
        onMove={setHighlight}
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        items={items}
        key={(row) => row.sessionID}
        filterKeys={["title", "directory"]}
        groupBy={(row) => (row.section === "attention" ? attentionGroup() : recentGroup())}
        groups={[attentionGroup(), recentGroup()]}
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
        {(row) => <Row row={row} showTime={row.section === "recent"} />}
      </List>
    </Show>
  )
}

export function DialogOverview(props: { advance?: boolean; switcher?: boolean }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog size="large" title={language.t("home.title")} transition>
      <Overview attention advance={props.advance} switcher={props.switcher} onOpen={() => dialog.close()} />
    </Dialog>
  )
}
