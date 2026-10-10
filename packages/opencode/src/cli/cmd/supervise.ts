import { spawn, type Subprocess } from "bun"
import path from "path"
import { cmd } from "./cmd"
import { Global } from "../../global"
import { Origin } from "../../server/origin"

// The server it supervises puts every route, health included, behind basic auth
// when a password is set (server.ts), so the probe sends the same credentials.
export function credentials(password: string | undefined, username = "opencode"): Record<string, string> {
  if (!password) return {}
  // UTF-8, as the server's basic auth decodes it; btoa would encode Latin-1.
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

// The supervisor can stop the server, so with a password set it asks for the
// same credentials the server does.
export function admitted(req: Request, password: string | undefined, username?: string) {
  if (!password) return true
  // The scheme name is case-insensitive (RFC 7617), so only the token is compared.
  const token = req.headers.get("authorization")?.match(/^basic +(\S+)$/i)?.[1]
  return token === credentials(password, username).Authorization.slice("Basic ".length)
}

// Supervisor for the long-lived OpenCode server: a small outer shell that owns
// the serve process so it can be restarted from a browser with no terminal.
// Because it is a separate process, killing the server never touches it — it
// is the fixed point that outlives every restart. A running supervisor keeps
// executing the code it started with even when the binary on disk is replaced;
// restart the supervisor itself to pick up new supervisor code.
//
// Endpoints (also buttons on the inline HTML page at /):
//   POST /restart -> stage a fresh server on the alt port, health-check it,
//                    kill the owned server, relaunch on the main port. The new
//                    server resumes cut turns and re-arms pings on its own.
//   POST /stop    -> kill the owned server (and reap any orphan); supervisor
//                    stays up. The page's Start button is /restart from cold.
//   GET  /status  -> owned pid + /global/health of the live server.
//
// There is no reload/dispose lever: session pins are content-addressed
// (SessionPin), so new sessions always see current disk and a stopped session
// re-pins fresh on reopen — nothing needs manual publishing.

// Whether a process command line has the `serve --port <port>` shape serveArgs
// below launches, the only kind of listener reapOrphan may kill. A hand-run
// serve with the same arguments matches too; nothing else does.
export function launched(command: string, port: number) {
  return command.match(/\bserve --port (\d+)\b/)?.[1] === String(port)
}

// stdout of a helper command, or "" when it fails. Bun.spawn throws
// synchronously on a missing binary, before any promise exists to catch.
export async function run(cmd: string[]) {
  if (!Bun.which(cmd[0])) return ""
  return new Response(spawn(cmd, { stderr: "ignore" }).stdout).text().catch(() => "")
}

export const SuperviseCommand = cmd({
  command: "supervise",
  describe: "run the supervisor that owns and restarts the opencode server",
  builder: (yargs) =>
    yargs
      .option("port", { type: "number", describe: "port the supervisor listens on", default: 4099 })
      .option("serve-port", { type: "number", describe: "port the owned opencode server listens on", default: 4097 })
      .option("stage-port", { type: "number", describe: "staging port for health-checked builds", default: 4098 })
      .option("hostname", {
        type: "string",
        describe: "interface the supervisor and its server listen on; 0.0.0.0 exposes both to the network",
        default: "127.0.0.1",
      }),
  handler: async (args) => {
    const SUPERVISOR_PORT = args.port
    const PORT = args["serve-port"]
    const ALT_PORT = args["stage-port"]
    const HOST = args.hostname
    const probe = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST

    // Optional per-machine config. uiUrl is the browser-facing URL of the
    // OpenCode UI when a proxy/tunnel fronts it on a different scheme/host/port
    // than PORT (e.g. a Caddy https origin). Absent → the page falls back to
    // the current host with PORT.
    const configFile = path.join(Global.Path.config, "supervisor.json")
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
      return [...base, "serve", "--port", String(port), "--hostname", HOST]
    }

    // The supervisor OWNS the server it runs: it started it, holds the handle,
    // and kills it through the handle.
    let current: Subprocess | null = null

    async function health(port: number) {
      return fetch(`http://${probe}:${port}/global/health`, {
        headers: credentials(process.env["OPENCODE_SERVER_PASSWORD"], process.env["OPENCODE_SERVER_USERNAME"]),
        signal: AbortSignal.timeout(2000),
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    }

    async function stop(proc: Subprocess | null) {
      if (!proc) return
      proc.kill()
      await proc.exited
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

    // PIDs LISTENING on the port, excluding this supervisor. Pick the probe by
    // platform, not by `command -v ss`: macOS can carry an iproute2mac ss shim
    // that ignores -p and emits no pids, which reads as "nothing listening"
    // and silently disables reaping and ownership checks. ss is the Linux path
    // (some containers have no lsof); lsof everywhere else, and on a Linux box
    // without ss.
    async function listeners(port: number) {
      const found =
        process.platform === "linux" && Bun.which("ss") ? await listenersSs(port) : await listenersLsof(port)
      return [...new Set(found.filter((pid) => pid !== String(process.pid)))]
    }

    // Reap the opencode server LISTENING on the port: an orphan from a prior
    // supervisor, or a killed server whose socket release is racing our
    // relaunch. Gate on the listen socket, not health: a wedged holder that
    // never answers /global/health still blocks the bind. Any other listener
    // is left alone. Returns why the port is not free, or undefined once it
    // is; SIGTERM first, SIGKILL after 5s, give up after 10s.
    async function reapOrphan(port: number) {
      let pids = await listeners(port)
      if (!pids.length) return
      const commands = await Promise.all(pids.map((pid) => run(["ps", "-o", "command=", "-p", pid])))
      if (commands.some((command) => command.trim() && !launched(command, port)))
        return `port ${port} is held by a process this supervisor did not launch`
      // A pid whose command could not be read (it exited between the two reads,
      // or ps cannot see it) is never signalled; the re-reads below decide.
      const owned = new Set(pids.filter((_, index) => launched(commands[index], port)))
      for (const pid of owned) spawn(["kill", pid])
      for (let i = 1; i <= 20; i++) {
        await Bun.sleep(500)
        pids = await listeners(port)
        if (!pids.length) return
        if (i === 10) for (const pid of pids) if (owned.has(pid)) spawn(["kill", "-9", pid])
      }
      return `port ${port} is held by a process that won't die`
    }

    // Health-poll a server WE spawned. A health answer on the port is not
    // proof of success: when the child loses the bind race and dies, the
    // orphan still holding the port answers health and a FAILED relaunch
    // reports ok — the browser then talks to stale bits. Require the child
    // alive AND holding the listen socket.
    async function waitOwned(proc: Subprocess, port: number, tries = 40) {
      for (let i = 0; i < tries; i++) {
        if (proc.exitCode !== null || proc.signalCode !== null) return null
        const info = await health(port)
        if (info && (await listeners(port)).includes(String(proc.pid))) return info
        await Bun.sleep(500)
      }
      return null
    }

    // Only the server on the main port is told it is live. A staged build is
    // health-checked and killed, and must never act on the sessions the live
    // one serves; the live one recovers at once rather than after a grace, so a
    // restart does not leave cut turns and warm caches waiting a minute. An env
    // var, not a flag: a binary that predates it ignores it instead of refusing
    // to start.
    function launch(port: number) {
      const { OPENCODE_LIVE: _, ...rest } = process.env
      const env = port === PORT ? { ...rest, OPENCODE_LIVE: "1" } : rest
      return spawn(serveArgs(port), { stdout: "inherit", stderr: "inherit", env })
    }

    // The supervisor owns processes only. Which sessions to resume, deliver
    // into, or re-arm is decided by the server that holds the recovery lease,
    // from its own database.
    async function restart() {
      // Stage on the alt port and prove it healthy before touching the live
      // server.
      const staging = await reapOrphan(ALT_PORT)
      if (staging) return { ok: false, step: "stage", detail: staging }
      const stage = launch(ALT_PORT)
      const staged = await waitOwned(stage, ALT_PORT)
      if (!staged) {
        await stop(stage)
        return { ok: false, step: "stage", detail: `staged build never became healthy on ${ALT_PORT}` }
      }
      // Build is good. Drop the stage, kill the server we own on PORT (by
      // handle), then relaunch the validated build on PORT and take ownership.
      await stop(stage)
      await stop(current)
      current = null
      // The kill above releases the socket asynchronously; reapOrphan also
      // clears any unowned holder AND confirms the port is actually free, so
      // the relaunch can't lose the bind race and leave stale bits serving.
      const cutover = await reapOrphan(PORT)
      if (cutover) return { ok: false, step: "cutover", detail: cutover }
      current = launch(PORT)
      const live = await waitOwned(current, PORT)
      if (!live) {
        await stop(current)
        current = null
        return { ok: false, step: "cutover", detail: `relaunch on ${PORT} never became healthy` }
      }
      return { ok: true, health: live }
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

  const RESTART_CONFIRM = "Restart the server?\\n\\nCut turns resume and warm sessions re-arm as soon as the new server starts, and every session re-pins against current config. Stop any session you do NOT want resumed before restarting."
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
      hostname: HOST,
      // /restart holds the request through stage-boot + health-check + cutover,
      // well past the 10s default idle timeout. 255 is Bun's max.
      idleTimeout: 255,
      async fetch(req) {
        if (!admitted(req, process.env["OPENCODE_SERVER_PASSWORD"], process.env["OPENCODE_SERVER_USERNAME"]))
          return new Response("authentication required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="supervisor"' },
          })
        const url = new URL(req.url)
        if (url.pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        if (url.pathname === "/status")
          return Response.json({ port: PORT, owned: !!current, pid: current?.pid ?? null, health: await health(PORT) })
        if (req.method === "POST" && Origin.foreign(req))
          return new Response("cross-origin request refused", { status: 403 })
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
      `supervisor listening on ${HOST}:${SUPERVISOR_PORT} (local: http://localhost:${SUPERVISOR_PORT}, opencode :${PORT}, stage :${ALT_PORT})`,
    )

    // Boot the server the supervisor exists to own, so a machine that just
    // rebooted needs no browser round-trip to become usable. Gated on health
    // rather than fired blind: a supervisor relaunched to pick up new
    // supervisor code finds the previous one's server still serving on PORT,
    // and restart() would kill a healthy server (dropping its sessions'
    // in-memory liveness) to replace it with an identical one. reapOrphan
    // inside restart() adopts that orphan on the next explicit /restart.
    if (!(await health(PORT))) {
      const boot = await restart()
      console.log(boot.ok ? `started server on :${PORT}` : `failed to start server: ${boot.step} — ${boot.detail}`)
    }

    await new Promise(() => {})
  },
})
