import { spawn, type Subprocess } from "bun"
import os from "os"
import path from "path"
import { cmd } from "./cmd"

// Supervisor for the long-lived OpenCode server: a small outer shell that owns
// the serve process so it can be restarted from a browser with no terminal.
// Because it is a separate process, killing the server never touches it — it
// is the fixed point that outlives every restart. A running supervisor keeps
// executing the code it started with even when the binary on disk is replaced;
// restart the supervisor itself to pick up new supervisor code.
//
// Endpoints (also buttons on the inline HTML page at /):
//   POST /restart -> stage a fresh server on the alt port, health-check it,
//                    kill the owned server, relaunch on the main port, then
//                    resume interrupted turns and re-arm ping daemons.
//   POST /stop    -> kill the owned server (and reap any orphan); supervisor
//                    stays up. The page's Start button is /restart from cold.
//   GET  /status  -> owned pid + /global/health of the live server.
//
// There is no reload/dispose lever: session pins are content-addressed
// (SessionPin), so new sessions always see current disk and a stopped session
// re-pins fresh on reopen — nothing needs manual publishing.

export const SuperviseCommand = cmd({
  command: "supervise",
  describe: "run the supervisor that owns and restarts the opencode server",
  builder: (yargs) =>
    yargs
      .option("port", { type: "number", describe: "port the supervisor listens on", default: 4099 })
      .option("serve-port", { type: "number", describe: "port the owned opencode server listens on", default: 4097 })
      .option("stage-port", { type: "number", describe: "staging port for health-checked builds", default: 4098 }),
  handler: async (args) => {
    const SUPERVISOR_PORT = args.port
    const PORT = args["serve-port"]
    const ALT_PORT = args["stage-port"]

    // Optional per-machine config. uiUrl is the browser-facing URL of the
    // OpenCode UI when a proxy/tunnel fronts it on a different scheme/host/port
    // than PORT (e.g. a Caddy https origin). Absent → the page falls back to
    // the current host with PORT.
    const configFile = path.join(os.homedir(), ".config", "opencode", "supervisor.json")
    const uiUrl = await Bun.file(configFile)
      .json()
      .then((c) => (typeof c.uiUrl === "string" ? c.uiUrl : ""))
      .catch(() => "")

    // Compiled binary: execPath IS the opencode CLI (argv[1] is the embedded
    // /$bunfs entry — not a real file). Source run (bun): execPath is bun and
    // argv[1] is the on-disk entry script, so replay it. Either way the child
    // is "opencode serve" from the same code that launched the supervisor.
    const entry = process.argv[1]
    const compiled = !entry || entry.startsWith("/$bunfs")
    const base = compiled ? [process.execPath] : [process.execPath, "run", "--conditions=browser", entry]

    function serveArgs(port: number) {
      return [...base, "serve", "--port", String(port), "--hostname", "0.0.0.0"]
    }

    // The supervisor OWNS the server it runs: it started it, holds the handle,
    // and kills it through the handle. No lsof/port-scan in the normal path.
    let current: Subprocess | null = null

    async function health(port: number) {
      return fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    }

    async function stop(proc: Subprocess | null) {
      if (!proc) return
      proc.kill()
      await proc.exited
    }

    async function run(cmd: string[]) {
      return new Response(spawn(cmd, { stderr: "ignore" }).stdout).text().catch(() => "")
    }

    // ss -p prints LISTEN sockets with `users:(("proc",pid=NNN,fd=N))`; pull
    // every pid on a row whose local address ends `:<port>`. The -p flag is
    // required — without it ss emits no pid to match.
    async function listenersSs(port: number) {
      const out = await run(["ss", "-ltnHp"])
      const pids: string[] = []
      for (const line of out.split("\n")) {
        const local = line.trim().split(/\s+/)[3] ?? ""
        if (!local.endsWith(`:${port}`)) continue
        for (const match of line.matchAll(/pid=(\d+)/g)) pids.push(match[1])
      }
      return pids
    }

    // lsof -Fpn output is flat: `p<pid>` lines each followed by that pid's
    // `n<name>` socket lines; a pid owns the port when a name ends `:<port>`.
    // The bare `-iTCP` form is used (not `-iTCP:<port>`) because the arg form
    // is unreliable on some lsof builds.
    async function listenersLsof(port: number) {
      const out = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
      const pids: string[] = []
      let pid = ""
      for (const line of out.split("\n")) {
        if (line[0] === "p") pid = line.slice(1)
        else if (line[0] === "n" && line.endsWith(`:${port}`) && pid) pids.push(pid)
      }
      return pids
    }

    // PIDs LISTENING on the port, excluding this supervisor. ss is standard on
    // Linux (and some containers have no lsof); lsof is the macOS path.
    async function listeners(port: number) {
      const which = await run(["sh", "-c", "command -v ss || true"])
      const found = which.trim() ? await listenersSs(port) : await listenersLsof(port)
      return [...new Set(found.filter((pid) => pid !== String(process.pid)))]
    }

    // Only used at bind time to reap an orphan left by a PRIOR supervisor that
    // was killed without cleaning up — the owned-handle path can't see a process
    // it did not spawn.
    async function reapOrphan(port: number) {
      if (!(await health(port))) return
      const pids = await listeners(port)
      for (const pid of pids) spawn(["kill", pid])
      if (pids.length) await Bun.sleep(500)
    }

    async function waitHealthy(port: number, tries = 40) {
      for (let i = 0; i < tries; i++) {
        const info = await health(port)
        if (info) return info
        await Bun.sleep(500)
      }
      return null
    }

    function launch(port: number) {
      return spawn(serveArgs(port), { stdout: "inherit", stderr: "inherit" })
    }

    type SessionRef = { sessionID: string; directory: string }

    // Liveness snapshot from the server we are about to kill. Two tiers:
    //   busy  — mid-turn (loop executing): the restart interrupts real work, so
    //           these get a "continue" prompt on the new server.
    //   armed — cache-ping daemon running but NOT mid-turn: the turn is
    //           finished, so no prompt (nothing to continue) — a bare session
    //           GET on the new server re-arms the daemon from the persisted
    //           cache anchor.
    // Only a planned /restart ever reads this, so a crash-looping server can
    // never auto-resume anything — the arm dies with the restart request.
    async function liveness(): Promise<{ busy: SessionRef[]; armed: SessionRef[] }> {
      const get = (path: string) =>
        fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(2000) })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])
      const [recent, pings] = await Promise.all([get("/global/recent"), get("/global/ping/armed")])
      const busy = (recent as (SessionRef & { busy: boolean })[])
        .filter((r) => r.busy)
        .map((r) => ({ sessionID: r.sessionID, directory: r.directory }))
      const busyIDs = new Set(busy.map((r) => r.sessionID))
      const armed = (pings as SessionRef[])
        .filter((r) => !busyIDs.has(r.sessionID))
        .map((r) => ({ sessionID: r.sessionID, directory: r.directory }))
      return { busy, armed }
    }

    const CONTINUE_TEXT =
      "Pardon the interruption — the server needed a restart and your turn was cut off. Please continue what you were doing."

    async function resume(sessions: SessionRef[]) {
      const results = []
      for (const s of sessions) {
        const res = await fetch(
          `http://127.0.0.1:${PORT}/session/${s.sessionID}/prompt_async?directory=${encodeURIComponent(s.directory)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text: CONTINUE_TEXT }] }),
            signal: AbortSignal.timeout(10000),
          },
        ).catch(() => null)
        results.push({ ...s, resumed: res?.status === 204 })
      }
      return results
    }

    // The session.get route re-arms the ping daemon (idempotent, self-stops if
    // the cache window already died) and pins the session's prompt state — a
    // read is the whole re-arm.
    async function rearm(sessions: SessionRef[]) {
      const results = []
      for (const s of sessions) {
        const res = await fetch(
          `http://127.0.0.1:${PORT}/session/${s.sessionID}?directory=${encodeURIComponent(s.directory)}`,
          { signal: AbortSignal.timeout(10000) },
        ).catch(() => null)
        results.push({ ...s, rearmed: res?.ok === true })
      }
      return results
    }

    async function restart() {
      // Stage on the alt port and prove it healthy before touching the live
      // server.
      await reapOrphan(ALT_PORT)
      const stage = launch(ALT_PORT)
      const staged = await waitHealthy(ALT_PORT)
      if (!staged) {
        await stop(stage)
        return { ok: false, step: "stage", detail: `staged build never became healthy on ${ALT_PORT}` }
      }
      // Snapshot liveness at the last possible moment — after the stage is
      // proven (the slow part) and immediately before the kill — so the
      // busy/armed lists can't go stale while the stage boots.
      const snapshot = await liveness()
      // Build is good. Drop the stage, kill the server we own on PORT (by
      // handle), then relaunch the validated build on PORT and take ownership.
      await stop(stage)
      await stop(current)
      current = null
      await reapOrphan(PORT)
      current = launch(PORT)
      const live = await waitHealthy(PORT)
      if (!live) {
        await stop(current)
        current = null
        return { ok: false, step: "cutover", detail: `relaunch on ${PORT} never became healthy` }
      }
      const resumed = await resume(snapshot.busy)
      const rearmed = await rearm(snapshot.armed)
      return { ok: true, health: live, resumed, rearmed }
    }

    const page = `<!doctype html><html><head><meta charset="utf-8"><title>OpenCode Supervisor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark }
  body { font: 15px/1.5 ui-monospace, monospace; background:#16161e; color:#c0caf5; margin:0; padding:2rem; max-width:640px }
  h1 { font-size:1.1rem; color:#7aa2f7 }
  button { font:inherit; padding:.6rem 1rem; margin:.25rem .5rem .25rem 0; border-radius:8px; border:1px solid #3b4261; background:#1f2335; color:#c0caf5; cursor:pointer }
  button:hover { background:#292e42 }
  button.danger { border-color:#f7768e; color:#f7768e }
  button:disabled { opacity:.5; cursor:wait }
  pre { background:#1a1b26; padding:1rem; border-radius:8px; white-space:pre-wrap; word-break:break-word; min-height:3rem }
  .muted { color:#565f89 }
</style></head><body>
<h1>OpenCode Supervisor</h1>
<p class="muted">supervisor :${SUPERVISOR_PORT} · opencode :${PORT} · stage :${ALT_PORT}</p>
<p id="state" class="muted">checking…</p>
<a id="open" target="_blank" rel="noopener"><button id="openbtn" disabled>Open OpenCode</button></a>
<button id="primary" disabled>…</button>
<button id="stop" class="danger" disabled>Stop</button>
<pre id="out">ready.</pre>
<script>
  const out = document.getElementById("out")
  const state = document.getElementById("state")
  const primary = document.getElementById("primary")
  const stopBtn = document.getElementById("stop")
  const openBtn = document.getElementById("openbtn")
  const openLink = document.getElementById("open")
  const configUiUrl = ${JSON.stringify(uiUrl)}

  const fallbackUrl = () => {
    const u = new URL(location.href)
    u.port = "${PORT}"
    u.pathname = "/"
    return u.toString()
  }
  openLink.href = configUiUrl || fallbackUrl()

  let busy = false
  async function call(path, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return
    busy = true
    for (const b of document.querySelectorAll("button")) b.disabled = true
    out.textContent = "working: " + path + " …"
    try {
      const r = await fetch(path, { method: "POST" })
      out.textContent = JSON.stringify(await r.json(), null, 2)
    } catch (e) { out.textContent = "error: " + e }
    busy = false
    refresh()
  }

  const RESTART_CONFIRM = "Restart the server?\\n\\nBusy sessions will be auto-resumed, warm idle sessions re-armed, and every session re-pins against current config. Stop any session you do NOT want kept alive before restarting."
  const STOP_CONFIRM = "Stop the server?\\n\\nEvery open session's UI will disconnect until the next start."

  function render(s) {
    const up = !!(s && s.health && s.health.healthy)
    if (up) {
      state.textContent = "running · pid " + s.pid + " · " + s.health.version + " · " + s.health.host
      primary.textContent = "Restart"
      primary.onclick = () => call("/restart", RESTART_CONFIRM)
    } else {
      state.textContent = "not running"
      primary.textContent = "Start"
      primary.onclick = () => call("/restart")
    }
    primary.disabled = busy
    stopBtn.disabled = busy || !up
    openBtn.disabled = !up
  }

  async function refresh() {
    try {
      const r = await fetch("/status")
      render(await r.json())
    } catch { state.textContent = "supervisor unreachable" }
  }

  stopBtn.onclick = () => call("/stop", STOP_CONFIRM)
  refresh()
  setInterval(() => { if (!busy) refresh() }, 3000)
</script>
</body></html>`

    Bun.serve({
      port: SUPERVISOR_PORT,
      hostname: "0.0.0.0",
      // /restart holds the request through stage-boot + health-check + cutover
      // + resume — well past the 10s default idle timeout. 255 is Bun's max.
      idleTimeout: 255,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        if (url.pathname === "/status")
          return Response.json({ port: PORT, owned: !!current, pid: current?.pid ?? null, health: await health(PORT) })
        if (url.pathname === "/restart" && req.method === "POST") return Response.json(await restart())
        if (url.pathname === "/stop" && req.method === "POST") {
          await stop(current)
          current = null
          await reapOrphan(PORT)
          return Response.json({ ok: true, health: await health(PORT) })
        }
        return new Response("not found", { status: 404 })
      },
    })

    console.log(
      `supervisor listening on 0.0.0.0:${SUPERVISOR_PORT} (local: http://localhost:${SUPERVISOR_PORT}, opencode :${PORT}, stage :${ALT_PORT})`,
    )
    await new Promise(() => {})
  },
})
