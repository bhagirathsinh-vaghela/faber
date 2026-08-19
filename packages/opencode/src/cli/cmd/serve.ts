import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { SessionPing } from "../../session/ping"
import { SessionPrompt } from "../../session/prompt"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("restore", {
      type: "boolean",
      default: false,
      describe: "rebuild session liveness from disk at startup (supervisor cold start only)",
    }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    // Opt-in, because only a COLD start may rebuild liveness from disk. On a
    // /restart the supervisor still holds a snapshot of the server it killed and
    // replays it itself, so restoring here too would resume the same turn twice;
    // the staging server must stay inert for the same reason. Detached: a slow
    // scan must not hold the port unserved, and a client attaching mid-scan only
    // re-arms a session the scan then skips.
    if (args.restore)
      void SessionPing.restore(async (session) => {
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: SessionPing.CONTINUE_TEXT, synthetic: true }],
        }).catch(() => {})
      })
    await new Promise(() => {})
    await server.stop()
  },
})
