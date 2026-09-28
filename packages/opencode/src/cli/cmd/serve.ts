import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { BackgroundOrchestrator } from "../../background/orchestrator"
import { Db } from "../../storage/db"
import { Recovery } from "../../session/recovery"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    // Accepted and ignored: supervisors from before Recovery still pass it.
    withNetworkOptions(yargs).option("restore", { type: "boolean", default: false, hidden: true }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    // Detached: a boot-time GC of orphan rows must not hold the port unserved.
    void Db.sweepOrphansOnce().catch(() => {})
    // Background jobs outlive the server that spawned them, so EVERY start
    // adopts whatever is still on disk. Settling is idempotent, and paying for
    // a settled job is Recovery's, inside the transaction that writes it.
    BackgroundOrchestrator.init()
    void BackgroundOrchestrator.sweep({ adopting: true })
    // Resumes cut turns, delivers owed results, re-arms warm sessions. Runs only
    // in the process holding the lease, and only after a boot grace, so a
    // staging build never acts on the live server's sessions.
    Recovery.init({ primary: true })
    await new Promise(() => {})
    await server.stop()
  },
})
