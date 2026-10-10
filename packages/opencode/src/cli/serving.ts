import { EOL } from "os"

// The supervisor's default port (see supervise.ts).
const SUPERVISOR = 4099

// Whether a server is live and owning the storage DB, for the commands that
// bulk-write it. Two connections writing one WAL database race: a large import
// transaction blocks the live server's writes (or throws SQLITE_BUSY mid-run)
// and vice versa, and a CLI write also leaves the running server's in-memory
// session index stale.
//
// This asks the supervisor rather than probing the file, so it answers for the
// server the supervisor owns and NOT for one started by hand on another port.
// Quiescence is still the caller's guarantee; this only catches the ordinary
// case where the supervisor has a server up.
export async function serving() {
  return fetch(`http://127.0.0.1:${SUPERVISOR}/status`, { signal: AbortSignal.timeout(1000) })
    .then((r) => r.json())
    .then((s: { health?: { healthy?: boolean } }) => s.health?.healthy === true)
    .catch(() => false)
}

// Print the refusal and set a failing exit code. Returns whether the caller
// should stop, so a command reads `if (await refuseWhileServing("import")) return`.
export async function refuseWhileServing(what: string) {
  if (!(await serving())) return false
  process.stderr.write(
    `refusing to ${what}: a Faber server is running (supervisor :${SUPERVISOR} reports healthy).${EOL}` +
      `stop the supervisor's server first, then re-run.${EOL}`,
  )
  process.exitCode = 1
  return true
}
