import { Component, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import type { Subagent } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"
import { useMru } from "@/context/mru"
import { useStopSession } from "@/hooks/use-stop-session"
import { look, moving, owing } from "@/utils/subagent"

function duration(task: Subagent, now: number): string {
  const end = task.time.completed ?? now
  return `${Math.max(0, Math.round((end - task.time.created) / 1000))}s`
}

function StatusIcon(props: { status: Subagent["status"] }) {
  const row = () => look(props.status)
  return (
    <Show when={row().icon} fallback={<Spinner />}>
      {(icon) => <Icon name={icon()} class={row().tone} />}
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
  const sync = useSync()
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

  // The server list is the source of truth, read from the database, so it is
  // the same before and after a restart. Refetched when the count of open
  // subagents changes and on a slow tick for tool progress. A plain
  // store, not createResource: a resource is Suspense-coupled and would flicker
  // the transcript on every refetch. The sequence keeps a late response from
  // overwriting a newer one.
  const [tasks, setTasks] = createStore<Subagent[]>([])
  const [view, setView] = createStore({ now: Date.now(), switched: undefined as Subagent[] | undefined })
  let seq = 0
  // The listed children whose turn is live, by default as the busy store reports
  // them now.
  const turningOf = (list: readonly Subagent[], live = (id: string) => !!sync.data.session_busy[id]?.turn) =>
    list
      .filter((task) => live(task.id))
      .map((task) => task.id)
      .join()
  // What the latest fetch answers for: the busy store as it stood when the fetch
  // started, applied to the rows it brings back. The server read the rows after
  // that point, so a turn that flipped before the response landed differs from
  // this and refetches, while a child already live at the start does not.
  let fetchedTurning = ""
  const refetch = async () => {
    const sessionID = source()
    if (!sessionID) return
    const mine = ++seq
    const started = new Set(Object.keys(sync.data.session_busy).filter((id) => sync.data.session_busy[id]?.turn))
    fetchedTurning = turningOf(tasks, (id) => started.has(id))
    const res = await sdk.client.background.list({ sessionID })
    if (mine !== seq) return
    const rows = res.data ?? []
    fetchedTurning = turningOf(rows, (id) => started.has(id))
    setTasks(reconcile(rows, { key: "id" }))
    // The memo below fires only when its value changes, and a child that was live
    // at the start but was not listed has no value to change. A follow-up starts
    // from the live store, so it repeats only while the busy set keeps changing.
    if (mine === seq && turningOf(tasks) !== fetchedTurning) void refetch()
  }
  const subagents = () => sync.data.session_busy[source() ?? ""]?.subagents ?? 0
  createEffect(on(subagents, () => void refetch(), { defer: true }))
  // Resuming an interrupted child joins its existing debt, so the count holds
  // still; the child's own turn flipping is the signal its row changed.
  const turning = createMemo(() => turningOf(tasks))
  createEffect(
    on(
      turning,
      (now) => {
        if (now !== fetchedTurning) void refetch()
      },
      { defer: true },
    ),
  )
  // The clock and the poll run only while a listed subagent can change on its
  // own: a finished row's duration is fixed, and each poll makes the server read the parent's whole transcript.
  const active = createMemo(() => tasks.some(moving))
  createEffect(() => {
    if (!active()) return
    setView("now", Date.now())
    const clock = setInterval(() => setView("now", Date.now()), 1000)
    const poll = setInterval(() => void refetch(), 2000)
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(poll)
    })
  })

  // The Ctrl+Tab switcher is OS Alt+Tab over siblings within each section:
  // in progress first, then finished, each in view order, with siblings never viewed
  // last, newest launch first. Snapshotted from the first fetch, so a sibling
  // finishing mid-cycle cannot move a row out from under the highlight.
  const snapshot = () => {
    const rank = new Map(mru.order().map((id, i) => [id, i]))
    const at = (task: Subagent) => rank.get(task.id) ?? rank.size
    const section = (task: Subagent) => (owing(task) ? 0 : 1)
    setView(
      "switched",
      tasks.toSorted((a, b) => section(a) - section(b) || at(a) - at(b) || b.time.created - a.time.created),
    )
  }

  onMount(() => refetch().then(() => props.switcher && snapshot()))

  const progress = language.t("dialog.subagents.section.progress")
  const completed = language.t("dialog.subagents.section.completed")

  // Both sections chronological by launch time (newest first).
  const sections = createMemo(() =>
    tasks.toSorted((a, b) => {
      if (owing(a) && !owing(b)) return -1
      if (!owing(a) && owing(b)) return 1
      return b.time.created - a.time.created
    }),
  )
  const items = () => view.switched ?? sections()
  // Ctrl+Tab opens on the first row that is not the sibling on screen, and
  // Ctrl+Shift+Tab rests on the sibling on screen.
  const initial = () =>
    (props.switcher && items().find((task) => (task.id === props.current) !== !!props.advance)) || items()[0]

  const select = (task: Subagent | undefined) => {
    if (!task) return
    dialog.close()
    navigate(`/${base64Encode(sdk.directory)}/session/${task.id}`)
  }

  const goToParent = () => {
    const id = parentID()
    if (!id) return
    dialog.close()
    navigate(`/${base64Encode(sdk.directory)}/session/${id}`)
  }

  // Cancel is the one Stop, on the subagent's own session.
  const halt = useStopSession()
  const cancel = (task: Subagent) => {
    if (halt(task.id, sdk.directory)) return dialog.close()
    void refetch()
  }

  // Ctrl+Tab hold-cycle, mirroring DialogOverview: when opened by the Ctrl-hold
  // keybind (switcher), each further Ctrl+Tab advances the highlight and
  // releasing Ctrl opens it — so the switcher feels the same in a subagent
  // session as between root sessions. `armed` from mount so a single tap+release
  // commits; a bare Control keyup on a non-switcher open never navigates.
  let listRef: ListRef | undefined
  const [highlight, setHighlight] = createSignal<Subagent | undefined>()

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
        <Show when={!props.switcher || view.switched}>
          <List
            ref={(r) => (listRef = r)}
            class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
            initial={initial()}
            preserveActive={props.switcher}
            onMove={setHighlight}
            key={(x) => x.id}
            items={items}
            groupBy={(x) => (owing(x) ? progress : completed)}
            groups={[progress, completed]}
            onSelect={select}
            onKeyEvent={(event, task) => {
              if (event.key.toLowerCase() === "x" && !event.ctrlKey && !event.metaKey && task && owing(task)) {
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
                    {[language.t(look(task.status).label), task.agent, duration(task, view.now)].join(" · ")}
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
