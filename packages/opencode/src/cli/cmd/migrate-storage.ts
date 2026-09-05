import fs from "fs/promises"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Storage } from "../../storage/storage"
import { Parts } from "../../storage/parts"
import { Messages } from "../../storage/messages"
import { Sessions } from "../../storage/sessions"
import { EOL } from "os"

export const MigrateStorageCommand = cmd({
  command: "migrate-storage",
  describe: "import legacy JSON sessions, messages, and parts into the SQLite store (run with the server stopped)",
  // The flag is `skip-backup`, not `no-backup`: yargs treats a `--no-X` flag as
  // negation sugar for `X=false`, which would collide with this option.
  builder: (yargs) =>
    yargs.option("skip-backup", {
      type: "boolean",
      default: false,
      describe: "skip the pre-migration copy of the storage tree (NOT recommended)",
    }),
  handler: async (args) => {
    // Two connections writing the same WAL DB race: a large migrate transaction
    // blocks the live server's writes (or throws SQLITE_BUSY mid-run) and vice
    // versa. Refuse if the supervisor reports a healthy owned server. The
    // supervisor's default port is 4099 (see supervise.ts).
    const running = await fetch("http://127.0.0.1:4099/status", { signal: AbortSignal.timeout(1000) })
      .then((r) => r.json())
      .then((s: { health?: { healthy?: boolean } }) => s.health?.healthy === true)
      .catch(() => false)
    if (running) {
      process.stderr.write(
        `refusing to migrate: an opencode server is running (supervisor :4099 reports healthy).${EOL}` +
          `stop the supervisor's server first, then re-run.${EOL}`,
      )
      process.exitCode = 1
      return
    }
    await bootstrap(process.cwd(), async () => {
      const dir = await Storage.ready().then((x) => x.dir)

      // A full copy of the storage tree before the migration writes anything.
      // The migration is non-destructive (it leaves the JSON files), but the
      // backup is the guarantee that a bad run is recoverable by restoring one
      // directory.
      if (!args["skip-backup"]) {
        const backup = dir + ".backup-" + Date.now()
        process.stdout.write(`backing up ${dir} -> ${backup}${EOL}`)
        await fs.cp(dir, backup, { recursive: true, errorOnExist: false })
        process.stdout.write(`backup complete${EOL}`)
      }

      const sessions = await Sessions.migrate()
      const messages = await Messages.migrate()
      const parts = await Parts.migrate()

      process.stdout.write(
        `migrated:${EOL}` +
          `  sessions: ${sessions.inserted} inserted / ${sessions.scanned} scanned${EOL}` +
          `  messages: ${messages.inserted} inserted / ${messages.scanned} scanned${EOL}` +
          `  parts:    ${parts.inserted} inserted / ${parts.scanned} scanned ` +
          `(${parts.skipped} present, ${parts.unreadable} unreadable)${EOL}`,
      )
    })
  },
})
