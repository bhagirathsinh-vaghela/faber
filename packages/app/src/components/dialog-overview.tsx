import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
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
import { useLanguage } from "@/context/language"
import { useStopSession } from "@/hooks/use-stop-session"

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
// hub entirely; a section switch moves it to the end of its new section; a new
// session appends to the end of its section. Reopening reseeds the order.
function useFrozen() {
  const recent = useRecent()

  const live = createMemo(() => {
    const map = new Map<string, Entry>()
    for (const row of recent.attention()) map.set(row.sessionID, { ...row, section: "attention" })
    for (const row of recent.recent()) map.set(row.sessionID, { ...row, section: "recent" })
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
        for (const [id, entry] of current) {
          if (seen.has(id)) continue
          draft[entry.section].push(id)
        }
      }),
    )
  })

  const rows = (section: Section) =>
    createMemo(() => {
      const current = live()
      return order[section].map((id) => current.get(id)).filter((entry): entry is Entry => entry !== undefined)
    })

  return { attention: rows("attention"), recent: rows("recent") }
}

function Row(props: { row: OverviewRow; showTime?: boolean }) {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const recent = useRecent()

  const countdown = () => recent.countdown(props.row)

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
      <Show when={!props.showTime}>
        <ChipGroup>
          <Chip
            class={countdown() ? undefined : "opacity-35"}
            icon={<CountdownRing fraction={countdown() ? recent.remaining(props.row) : 0} />}
          >
            {countdown() ?? "--"}
          </Chip>
        </ChipGroup>
        <Show when={props.row.busy}>
          <span
            title={language.t("home.attention.busy")}
            class="status-ping relative size-2 rounded-full text-icon-warning-base bg-current shrink-0"
          />
        </Show>
        <Show when={!props.row.busy && props.row.unseen}>
          <span
            title={language.t("home.attention.unseen")}
            class="size-2 rounded-full bg-icon-interactive-base shrink-0"
          />
        </Show>
        <Show when={props.row.pingAt}>
          <IconButton icon="circle-ban-sign" title={language.t("home.attention.stopPing")} onClick={stopPing} />
        </Show>
      </Show>
    </div>
  )
}

// The single source of truth for the overview's content and section order.
// Both the home page (`/`) and DialogOverview render this body inside their
// own frame, so any change to what the overview shows lands in both views. The
// search input holds focus so the arrow keys drive the list and typing filters.
export function Overview(props: { onOpen?: () => void; attention?: boolean; advance?: boolean }) {
  const frozen = useFrozen()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const runStop = useStopSession()
  const language = useLanguage()
  const mru = useMru()

  const live = createMemo(() => [...frozen.attention(), ...frozen.recent()])

  // Drop stale MRU ids (session archived or deleted) whenever the live set
  // changes. prune guards against a transient empty list so mid-load churn can't
  // wipe the MRU. Kept out of the ordering memo so it never writes during a read.
  createEffect(() => mru.prune(new Set(live().map((r) => r.sessionID))))

  // Sections stay fixed — "Needs attention" always above "Recent sessions" —
  // because section is the primary sort key (attention=0, recent=1), so the
  // sort never crosses the boundary. MRU only reorders rows WITHIN a section:
  // viewed sessions lead in most-recently-viewed order, unviewed ones keep their
  // normal order after (Infinity rank, original index as final tiebreak). Group
  // order follows first-appearance, so pinning the boundary pins the groups.
  const items = createMemo(() => {
    const rank = new Map(mru.order().map((id, i) => [id, i]))
    return live()
      .map((row, i) => ({
        row,
        i,
        section: row.section === "attention" ? 0 : 1,
        mru: rank.get(row.sessionID) ?? Infinity,
      }))
      .sort((a, b) => a.section - b.section || a.mru - b.mru || a.i - b.i)
      .map((x) => x.row)
  })
  const empty = () => items().length === 0
  // Ctrl+Tab advances one step on the opening press (highlight the next session,
  // position 1), so two live sessions flip with a single tap. Ctrl+Shift+Tab and
  // the home page rest on the current session (position 0). Further taps cycle.
  const initial = !props.attention ? undefined : props.advance ? (items()[1] ?? items()[0]) : items()[0]

  const open = (row: OverviewRow) => {
    void sdk.client.session.seen({ directory: row.directory, sessionID: row.sessionID })
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

  // Alt+Q fires the highlighted row's stop button: a full stop, matching the
  // session header's stopSession (abort the running turn AND drop the cache
  // ping). Scoped to the overview: the listener lives only while this component
  // is mounted (home page or dialog), so Alt+Q is inert everywhere else.
  // Capture phase because the command system is suspended while a dialog is
  // open, so a registered command would never see the key here. Gated on the
  // same pingAt that renders the row's stop button — a row without one is a
  // no-op. If the stopped row is the session open behind the dialog, navigate
  // home like the header does; stopping any other row leaves the view put.
  const stop = (event: KeyboardEvent) => {
    // event.code, not event.key: on macOS Alt+Q composes the glyph "œ", so
    // event.key never equals "q". The physical code is layout/composition proof.
    if (!(event.altKey && event.code === "KeyQ")) return
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    const row = highlight()
    if (!row?.pingAt) return
    if (runStop(row.sessionID, row.directory)) props.onOpen?.()
  }
  onMount(() => window.addEventListener("keydown", stop, true))
  onCleanup(() => window.removeEventListener("keydown", stop, true))

  if (props.attention) {
    const cycle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.key === "Tab")) return
      event.preventDefault()
      event.stopPropagation()
      ref?.onKeyDown(new KeyboardEvent("keydown", { key: event.shiftKey ? "ArrowUp" : "ArrowDown", bubbles: true }))
    }
    const commit = (event: KeyboardEvent) => {
      if (event.key !== "Control") return
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
        groupBy={(row) =>
          row.section === "attention" ? language.t("home.attention") : language.t("home.recentSessions")
        }
        onSelect={(row) => {
          if (row) open(row)
        }}
        class="flex-1 min-h-0 !px-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 [&_[data-slot=list-scroll]]:gap-10 [&_[data-slot=list-scroll]]:pb-6 [&_[data-slot=list-group]:last-child]:pb-0 [&_[data-slot=list-header]]:!bg-background-base [&_[data-slot=list-header]:after]:!bg-none [&_[data-slot=list-items]]:gap-1 [&_[data-slot=list-item]]:rounded-md [&_[data-slot=list-item]]:px-3 [&_[data-slot=list-item]]:py-2"
      >
        {(row) => <Row row={row} showTime={row.section === "recent"} />}
      </List>
    </Show>
  )
}

export function DialogOverview(props: { advance?: boolean }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog size="large" title={language.t("home.title")} transition>
      <Overview attention advance={props.advance} onOpen={() => dialog.close()} />
    </Dialog>
  )
}
