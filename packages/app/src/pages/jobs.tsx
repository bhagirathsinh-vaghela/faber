import { createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { useServer } from "@/context/server"
import { useGlobalSDK } from "@/context/global-sdk"
import { useTicker } from "@/context/ticker"
import { ReaderPill } from "@/components/reader-pill"

type Job = {
  id: string
  sessionID: string
  // Absent from a list row: only the detail view fetches a whole record.
  directory?: string
  project?: string
  command: string
  description: string
  status: "running" | "exited" | "killed"
  exit?: number
  // When the job's log last grew, present only on a running row. A finished
  // job's last activity is its completion time, so the server omits this for it.
  updated?: number
  // `lost` is when the result never reached the session that asked for it,
  // which is not a property of the command: it ran, and its output is on disk.
  time: {
    created: number
    soft?: number
    hard: number
    completed?: number
    nudges?: number
    nudgedAt?: number
    lost?: number
  }
}

// How often the LIST is re-read. A row only changes when a job starts or ends,
// and the elapsed time it shows is counted client-side off the shared tick, so
// polling this every second re-reads every record on disk to redraw a number
// the page already knows how to advance on its own.
const LIST_MS = 5_000

function elapsed(job: Job, now: number) {
  const end = job.time.completed ?? now
  const seconds = Math.max(0, Math.round((end - job.time.created) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// How long since the running job's log last grew, counted off the shared tick
// so it advances without a refetch. This is the "actively working vs gone
// silent" signal: a row updating every few seconds is making progress, one
// stuck at minutes has stalled. Absent for a finished row, whose last activity
// was its completion.
function updatedAgo(job: Job, now: number) {
  if (job.updated === undefined) return undefined
  const seconds = Math.max(0, Math.round((now - job.updated) / 1000))
  if (seconds < 60) return `updated ${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `updated ${minutes}m ago`
  return `updated ${Math.floor(minutes / 60)}h ago`
}

// Green reads as "this went well", which a job that is merely still running has
// not earned yet. Blue is the neutral in-progress colour used elsewhere.
//
// A result nobody received is checked FIRST and outranks a clean exit. The
// command succeeding is the less useful half of that record: what a reader
// needs to notice is that its output never reached the session that asked, and
// a row saying "completed" hides exactly the class of record worth finding.

// An absent exit code is UNKNOWN, not a failure. A job killed before it could
// write its own exit file leaves none, and calling that "failed" claims
// something about the command that nothing establishes. Neutral, and named as
// the absence it is.
function unknown(job: Job) {
  return job.exit === undefined
}

function tone(job: Job) {
  if (job.time.lost) return "var(--syntax-critical)"
  if (job.status === "running") return "var(--syntax-primitive)"
  if (job.status === "killed") return "var(--syntax-critical)"
  if (unknown(job)) return "var(--text-weak)"
  return job.exit === 0 ? "var(--syntax-string)" : "var(--syntax-critical)"
}

function label(job: Job) {
  if (job.time.lost) return "never delivered"
  if (job.status === "running") return "running"
  if (job.status === "killed") return "timed out"
  if (unknown(job)) return "ended (exit unknown)"
  return job.exit === 0 ? "completed" : `failed (exit ${job.exit})`
}

export default function Jobs() {
  const params = useParams()
  const navigate = useNavigate()
  const server = useServer()
  const ticker = useTicker()

  // The list is coarse and the log is not. A log is the thing that actually
  // moves while a reader watches, so it follows the shared second; the list is
  // re-read on its own slower key, since a row only changes when a job starts
  // or ends. Both derive from the same tick, so nothing drifts against the
  // elapsed times counted from it.
  //
  // No cache: a record is written by whichever server owns the job, and a
  // reader watching a build wants what is on disk right now.
  const coarse = createMemo(() => Math.floor(ticker.now() / LIST_MS))

  // A transition (a job started or settled) publishes job.updated on the global
  // channel. Bumping this on each one refetches the list at once rather than
  // waiting out the coarse poll, so a job appearing or finishing lands within a
  // frame. The poll stays as the backstop for anything the stream missed (a
  // reconnect gap, an adopted job settled on another server).
  const global = useGlobalSDK()
  const [live, setLive] = createSignal(0)
  const unsub = global.event.listen((e) => {
    if (e.name === "global" && e.details?.type === "job.updated") setLive((n) => n + 1)
  })
  onCleanup(unsub)

  const [jobs] = createResource(
    () => [`${server.url}/job`, coarse(), live()] as const,
    ([url]) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<Job[]>) : [])),
  )

  // Fetched whole rather than picked out of the list: a list row carries a
  // clipped command and no directory, which are two of the four fields this
  // view exists to show. Keyed on the coarse tick and the live signal, since
  // only the status can change and the log beside it is what moves.
  const [detail] = createResource(
    () => (params.id ? ([`${server.url}/job/${params.id}`, coarse(), live()] as const) : undefined),
    ([url]) =>
      fetch(url, { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<{ job: Job }>).then((body) => body.job) : undefined,
      ),
  )

  const [log] = createResource(
    () => (params.id ? ([`${server.url}/job/${params.id}/log`, ticker.now()] as const) : undefined),
    ([url]) =>
      fetch(url, { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<{ output: string; size: number }>) : { output: "", size: 0 },
      ),
  )

  // Session titles, so a group is named after the work rather than an opaque
  // id. A job outlives its session's place in the recent list, so a title can
  // be missing and the group falls back to the id.
  const [sessions] = createResource(
    () => [`${server.url}/global/recent`, coarse()] as const,
    ([url]) =>
      fetch(url, { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<{ sessionID: string; title?: string }[]>) : [],
      ),
  )

  const titles = createMemo(() => new Map((sessions() ?? []).map((row) => [row.sessionID, row.title])))

  // A job belongs to the session that asked for it, which is the only thing
  // distinguishing two identical commands, so the session is the grouping rather
  // than a field on a flat row. Groups sort newest-first on the id, which is
  // time-ordered, so the group with the most recent activity leads.
  function groupBySession(list: Job[]) {
    const bySession = new Map<string, Job[]>()
    for (const job of list) {
      const held = bySession.get(job.sessionID)
      if (held) held.push(job)
      else bySession.set(job.sessionID, [job])
    }
    return [...bySession.entries()]
      .map(([sessionID, items]) => ({
        sessionID,
        title: titles().get(sessionID),
        items,
        newest: items.reduce((max, job) => (job.id > max ? job.id : max), ""),
      }))
      .sort((a, b) => (a.newest > b.newest ? -1 : 1))
  }

  // Two sections rather than one flat list: what a reader opens this page for is
  // work still in flight, so the running jobs are their own section above the
  // finished tail. A single session can appear in both — some of its jobs
  // running, others done — so the split is on the JOBS, then each half is
  // grouped by session independently. A never-delivered result stays with the
  // recent tail: it is finished work, flagged rather than in-progress.
  const inProgress = createMemo(() => groupBySession((jobs() ?? []).filter((job) => job.status === "running")))
  const recent = createMemo(() => groupBySession((jobs() ?? []).filter((job) => job.status !== "running")))

  // Which groups the reader expanded. Every group starts COLLAPSED, showing just
  // the session header and its job count; the reader opens the ones they care
  // about. Keyed by section AND session, because one session can head a group in
  // both sections and expanding its in-progress group must not open its recent
  // one.
  const [expanded, setExpanded] = createSignal(new Set<string>())
  const toggle = (key: string) =>
    setExpanded((held) => {
      const next = new Set(held)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // One session's group of rows, shared by both sections. `keyPrefix` scopes the
  // collapse state to the section so a session heading both sections folds in
  // each independently; `running` colours the count the reader is looking for.
  function Group(props: { group: ReturnType<typeof groupBySession>[number]; keyPrefix: string; running: boolean }) {
    const key = () => `${props.keyPrefix}:${props.group.sessionID}`
    return (
      <>
        <button
          type="button"
          data-slot="job-group"
          class="mt-4 mb-2 w-full flex items-center gap-2 text-left"
          onClick={() => toggle(key())}
          aria-expanded={expanded().has(key())}
        >
          <Icon
            name={expanded().has(key()) ? "chevron-down" : "chevron-right"}
            size="small"
            class="shrink-0 text-text-weaker"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-14-medium text-text-base">
            {props.group.title ?? props.group.sessionID}
          </span>
          <span
            class="shrink-0 text-12-regular"
            style={{ color: props.running ? "var(--syntax-primitive)" : "var(--text-weaker)" }}
          >
            {props.group.items.length}
          </span>
        </button>
        <ul
          class="flex flex-col gap-1"
          data-slot="job-list"
          style={{ display: expanded().has(key()) ? undefined : "none" }}
        >
          <For each={props.group.items}>
            {(job) => (
              <li>
                <button
                  type="button"
                  data-slot="job-row"
                  class="w-full flex items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface-raised-base-hover"
                  onClick={() => navigate(`/jobs/${job.id}`)}
                >
                  <span
                    class="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ background: tone(job) }}
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block text-14-medium text-text-base truncate">{job.description}</span>
                    <span class="block font-mono text-12-regular text-text-weaker truncate">{job.command}</span>
                  </span>
                  <span class="shrink-0 text-right">
                    <span class="block text-12-regular" style={{ color: tone(job) }}>
                      {label(job)}
                    </span>
                    <span class="block text-12-regular text-text-weaker">{elapsed(job, ticker.now())}</span>
                    <Show when={updatedAgo(job, ticker.now())}>
                      {(ago) => <span class="block text-12-regular text-text-weakest">{ago()}</span>}
                    </Show>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </>
    )
  }

  // A section header sits above its groups only when the section has any, so an
  // empty In-progress collapses away rather than showing a bare heading.
  function Section(props: { label: string; groups: ReturnType<typeof groupBySession>; running: boolean }) {
    return (
      <Show when={props.groups.length > 0}>
        <h2 class="mt-6 mb-1 text-12-medium text-text-weaker uppercase tracking-wide">{props.label}</h2>
        <For each={props.groups}>
          {(group) => <Group group={group} keyPrefix={props.label} running={props.running} />}
        </For>
      </Show>
    )
  }

  return (
    <div class="size-full min-h-0 flex-1 overflow-y-auto" data-component="jobs-page">
      <ReaderPill />
      <div class="mx-auto w-full max-w-3xl px-6 py-8">
        <Show
          when={params.id}
          fallback={
            <>
              <h1 class="text-20-medium text-text-strong mb-1">Jobs</h1>
              <p class="text-12-regular text-text-weaker mb-5">
                Background shell commands on this machine. Read only: a job is stopped by the session that started it.
              </p>

              <Show when={jobs()} fallback={<p class="text-14-regular text-text-weaker">Loading...</p>}>
                <Show
                  when={inProgress().length > 0 || recent().length > 0}
                  fallback={<p class="text-14-regular text-text-weaker">No jobs have run recently.</p>}
                >
                  <Section label="In progress" groups={inProgress()} running={true} />
                  <Section label="Recent" groups={recent()} running={false} />
                </Show>
              </Show>
            </>
          }
        >
          <button
            type="button"
            class="mb-5 flex items-center gap-1.5 text-12-regular text-text-weak hover:text-text-strong"
            onClick={() => navigate("/jobs")}
          >
            <Icon name="arrow-left" size="small" aria-hidden="true" />
            Jobs
          </button>

          <Show when={detail()} fallback={<p class="text-14-regular text-text-weaker">Loading...</p>}>
            {(job) => (
              <>
                <h1 class="text-20-medium text-text-strong">{job().description}</h1>
                <p class="font-mono text-12-regular text-text-weaker mt-1 break-all">{job().command}</p>

                <dl class="grid grid-cols-2 gap-x-6 gap-y-2 mt-5 mb-6 text-12-regular" data-slot="job-meta">
                  <For
                    each={[
                      { term: "Status", value: label(job()), color: tone(job()) },
                      { term: "Elapsed", value: elapsed(job(), ticker.now()) },
                      { term: "Directory", value: job().directory },
                      { term: "Session", value: job().sessionID },
                    ]}
                  >
                    {(field) => (
                      <div class="min-w-0">
                        <dt class="text-text-weaker">{field.term}</dt>
                        <dd class="truncate font-mono" style={{ color: field.color ?? "var(--text-base)" }}>
                          {field.value}
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>

                <h2 class="text-12-medium text-text-weaker uppercase tracking-wide mb-2">Output</h2>
                <Switch>
                  <Match when={log()?.output}>
                    <pre
                      data-slot="job-log"
                      class="max-h-[60vh] overflow-auto rounded-md bg-surface-inset-base p-3 font-mono text-12-regular whitespace-pre-wrap break-all"
                    >
                      {log()!.output}
                    </pre>
                  </Match>
                  <Match when={true}>
                    <p class="text-14-regular text-text-weaker">
                      {job().status === "running" ? "Nothing written yet." : "This job produced no output."}
                    </p>
                  </Match>
                </Switch>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
