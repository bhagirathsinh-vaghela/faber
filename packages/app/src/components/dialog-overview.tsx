import { createEffect, createMemo, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { CountdownRing } from "@opencode-ai/ui/countdown-ring"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DateTime } from "luxon"
import { useRecent, type OverviewRow } from "@/context/recent"
import { useGlobalSDK } from "@/context/global-sdk"
import { CACHE_TTL } from "@/utils/cache-countdown"
import { useLanguage } from "@/context/language"

function getFilename(dir: string) {
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function remainingFraction(row: { updated: number }) {
  return Math.max(0, Math.min(1, (row.updated + CACHE_TTL - Date.now()) / CACHE_TTL))
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
            icon={<CountdownRing fraction={countdown() ? remainingFraction(props.row) : 0} />}
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
export function Overview(props: { onOpen?: () => void }) {
  const frozen = useFrozen()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const language = useLanguage()

  const items = createMemo(() => [...frozen.attention(), ...frozen.recent()])
  const empty = () => items().length === 0

  const open = (row: OverviewRow) => {
    void sdk.client.session.seen({ directory: row.directory, sessionID: row.sessionID })
    navigate(`/${base64Encode(row.directory)}/session/${row.sessionID}`)
    props.onOpen?.()
  }

  return (
    <Show
      when={!empty()}
      fallback={<div class="px-3 py-6 text-14-regular text-text-weak">{language.t("home.empty.description")}</div>}
    >
      <List
        preserveActive
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
        class="flex-1 min-h-0 !px-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 [&_[data-slot=list-scroll]]:gap-10 [&_[data-slot=list-scroll]]:pb-6 [&_[data-slot=list-group]:last-child]:pb-0 [&_[data-slot=list-header]]:!static [&_[data-slot=list-header]]:!bg-transparent [&_[data-slot=list-header]]:pl-3 [&_[data-slot=list-header]]:pb-3 [&_[data-slot=list-header]]:text-14-medium [&_[data-slot=list-header]]:text-text-strong [&_[data-slot=list-items]]:gap-1 [&_[data-slot=list-item]]:rounded-md [&_[data-slot=list-item]]:px-3 [&_[data-slot=list-item]]:py-2"
      >
        {(row) => <Row row={row} showTime={row.section === "recent"} />}
      </List>
    </Show>
  )
}

export function DialogOverview() {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog size="large" title={language.t("home.title")} transition>
      <Overview onOpen={() => dialog.close()} />
    </Dialog>
  )
}
