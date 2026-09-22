import { Component, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { BackgroundSubagent } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"
import { useMru } from "@/context/mru"

function duration(task: BackgroundSubagent): string {
  const end = task.time.completed ?? Date.now()
  return `${Math.round((end - task.time.created) / 1000)}s`
}

function StatusIcon(props: { status: BackgroundSubagent["status"] }) {
  return (
    <Show when={props.status !== "running"} fallback={<Spinner />}>
      <Icon
        name={props.status === "completed" ? "circle-check" : "circle-x"}
        class={props.status === "completed" ? "text-success" : "text-error"}
      />
    </Show>
  )
}

// `sessionID` overrides which session's subagents are listed (sibling mode: pass
// the parent so its children — the current session's siblings — are shown).
// `parentID` is the target of the "Parent session" escape button, passed by the
// caller (which already holds the session record) rather than looked up here.
export const DialogSubagents: Component<{
  sessionID?: string
  parentID?: string
  switcher?: boolean
  advance?: boolean
  current?: string
}> = (props) => {
  const sdk = useSDK()
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const mru = useMru()

  const source = () => props.sessionID ?? params.id
  const parentID = () => props.parentID

  // Opened inside a subagent session by the Alt+A keybind (a parent to escape
  // to, and not the Ctrl+Tab sibling switcher). A subagent cannot launch its own
  // subagents, so this list is always empty; show only the parent escape instead
  // of empty sections. The switcher still lists the parent's other children.
  const parentOnly = () => !!parentID() && !props.switcher

  // Same pattern as PromptActionBar: one seed fetch on mount, then keep the list
  // live off the background.subagent.* events. NOT createResource — a resource is
  // Suspense-coupled, so its pending state (on open and on every refetch) trips
  // the <Suspense> around <Session> and flickers the whole transcript. A plain
  // store fed by events never suspends, exactly like the overview's recent_hub.
  const [tasks, setTasks] = createStore<BackgroundSubagent[]>([])

  // The server list is the source of truth: it merges the durable child sessions
  // with the in-memory tasks, deduped by child session, so it survives a restart
  // and never double-counts a resumed child. The task events carry a task id
  // that a disk-derived entry (keyed by child session) cannot match, so rather
  // than reconcile them locally, any task transition just refetches the correct
  // list. Keyed by id via reconcile so unchanged rows keep their identity.
  //
  // A monotonic sequence guards against out-of-order responses: two events can
  // each fire a refetch, and the second's response may land first, so only the
  // newest request is allowed to write.
  let seq = 0
  const refetch = async () => {
    const sessionID = source()
    if (!sessionID) return
    const mine = ++seq
    const res = await sdk.client.background.list({ sessionID })
    if (mine !== seq) return
    setTasks(reconcile(res.data ?? [], { key: "id" }))
  }

  // The Ctrl+Tab switcher is OS Alt+Tab over siblings: every one in view order,
  // so the one on screen leads and the one before it is a single tap away even
  // once it has finished. Siblings never viewed follow, newest launch first.
  // Snapshotted from the first fetch, so a sibling finishing mid-cycle cannot
  // move a row out from under the highlight.
  const [switched, setSwitched] = createSignal<BackgroundSubagent[]>()
  const snapshot = () => {
    const rank = new Map(mru.order().map((id, i) => [id, i]))
    const at = (task: BackgroundSubagent) => rank.get(task.subagent?.sessionID ?? "") ?? rank.size
    setSwitched(tasks.toSorted((a, b) => at(a) - at(b) || b.time.created - a.time.created))
  }

  onMount(() => refetch().then(() => props.switcher && snapshot()))

  const unsubs = [
    sdk.event.on("background.subagent.created", (evt) => {
      if (evt.properties.subagent.parentSessionID === source()) void refetch()
    }),
    sdk.event.on("background.subagent.progress", (evt) => {
      if (evt.properties.parentSessionID !== source()) return
      // Progress carries the in-memory subagent id, which a disk-derived row
      // cannot match; write it where the row IS the live subagent, and let the
      // periodic refetch carry it otherwise.
      setTasks(
        produce((list) => {
          const t = list.find((x) => x.id === evt.properties.subagentId)
          if (t) t.progress = evt.properties.progress
        }),
      )
    }),
    sdk.event.on("background.subagent.completed", (evt) => {
      if (evt.properties.parentSessionID === source()) void refetch()
    }),
  ]
  onCleanup(() => unsubs.forEach((u) => u()))

  const running = language.t("dialog.subagents.section.running")
  const completed = language.t("dialog.subagents.section.completed")

  // Both sections chronological by launch time (newest first).
  const sections = createMemo(() =>
    tasks.toSorted((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1
      if (a.status !== "running" && b.status === "running") return 1
      return b.time.created - a.time.created
    }),
  )
  const items = () => switched() ?? sections()
  // Ctrl+Tab advances one step on the opening press, past the sibling on screen,
  // so one tap flips between the two most recent. Ctrl+Shift+Tab rests on the
  // sibling on screen.
  const initial = () => items()[props.switcher && props.advance && props.current ? 1 : 0] ?? items()[0]

  const select = (task: BackgroundSubagent | undefined) => {
    if (!task?.subagent?.sessionID) return
    dialog.close()
    navigate(`/${base64Encode(sdk.directory)}/session/${task.subagent.sessionID}`)
  }

  const goToParent = () => {
    const id = parentID()
    if (!id) return
    dialog.close()
    navigate(`/${base64Encode(sdk.directory)}/session/${id}`)
  }

  // Cancelling emits background.subagent.completed (status "cancelled"), which
  // the listener above folds into the store — no manual refetch.
  const cancel = (task: BackgroundSubagent) => sdk.client.background.cancel({ id: task.id })

  // Ctrl+Tab hold-cycle, mirroring DialogOverview: when opened by the Ctrl-hold
  // keybind (switcher), each further Ctrl+Tab advances the highlight and
  // releasing Ctrl opens it — so the switcher feels the same in a subagent
  // session as between root sessions. `armed` from mount so a single tap+release
  // commits; a bare Control keyup on a non-switcher open never navigates.
  let listRef: ListRef | undefined
  const [highlight, setHighlight] = createSignal<BackgroundSubagent | undefined>()

  // The list has no search box and no focused row on open, so nothing inside it
  // would receive arrow/Enter keys. Forward them from the window into the list's
  // key handler so the dialog is keyboard-navigable the moment it opens, without
  // a search input. A fresh KeyboardEvent is forwarded (not the original) so the
  // list's own preventDefault path runs uninhibited.
  const forward = (key: string) => listRef?.onKeyDown(new KeyboardEvent("keydown", { key, bubbles: true }))
  const navKeys = ["ArrowUp", "ArrowDown", "Enter"]
  const onKey = (event: KeyboardEvent) => {
    if (parentOnly() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    if (navKeys.includes(event.key) || event.key.toLowerCase() === "x") {
      // stopPropagation so a list-item button that happens to hold focus (e.g.
      // reached by Tab) does not ALSO run its own bubble-phase handler on the
      // same press and act twice — this forward is the single source of truth.
      event.preventDefault()
      event.stopPropagation()
      forward(event.key)
    }
  }
  onMount(() => window.addEventListener("keydown", onKey, true))
  onCleanup(() => window.removeEventListener("keydown", onKey, true))

  if (props.switcher) {
    let armed = true
    // A release that beats the first fetch is held until the list exists, or a
    // quick tap would commit an empty highlight and leave the dialog open.
    const [released, setReleased] = createSignal(false)
    createEffect(() => {
      if (released() && highlight()) select(highlight())
    })
    const cycle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.key === "Tab")) return
      event.preventDefault()
      event.stopPropagation()
      armed = true
      listRef?.onKeyDown(new KeyboardEvent("keydown", { key: event.shiftKey ? "ArrowUp" : "ArrowDown", bubbles: true }))
    }
    const commit = (event: KeyboardEvent) => {
      if (event.key !== "Control" || !armed) return
      armed = false
      setReleased(true)
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
    <Dialog title={language.t("dialog.subagents.title")}>
      <Show
        when={!parentOnly()}
        fallback={
          <div class="flex flex-col items-center gap-3 px-4 py-8">
            <p class="text-14-regular text-text-weak text-center">{language.t("dialog.subagents.parentOnly")}</p>
            <Button autofocus size="large" variant="primary" icon="arrow-left" onClick={goToParent}>
              {language.t("dialog.subagents.parent")}
            </Button>
          </div>
        }
      >
        {/* The List reads `initial` once at creation, so the switcher holds it
            back until its snapshot exists. */}
        <Show when={!props.switcher || switched()}>
          <List
            ref={(r) => (listRef = r)}
            class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
            initial={initial()}
            preserveActive={props.switcher}
            onMove={setHighlight}
            key={(x) => x.id}
            items={items}
            groupBy={props.switcher ? undefined : (x) => (x.status === "running" ? running : completed)}
            groups={props.switcher ? undefined : [running, completed]}
            onSelect={select}
            onKeyEvent={(event, task) => {
              if (event.key.toLowerCase() === "x" && !event.ctrlKey && !event.metaKey && task?.status === "running") {
                event.preventDefault()
                cancel(task)
              }
            }}
          >
            {(task) => (
              <div class="w-full flex items-center gap-2">
                <StatusIcon status={task.status} />
                <div class="flex-1 min-w-0 flex flex-col text-left">
                  <span class="truncate font-normal">{task.description}</span>
                  <span class="truncate text-text-weak font-normal">
                    {(task.subagent?.agent ?? "subagent") + " · " + duration(task)}
                  </span>
                </div>
              </div>
            )}
          </List>
        </Show>
      </Show>
    </Dialog>
  )
}
