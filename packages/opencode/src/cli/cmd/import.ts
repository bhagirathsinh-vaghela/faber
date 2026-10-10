import type { Argv } from "yargs"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Parts } from "../../storage/parts"
import { Messages } from "../../storage/messages"
import { Sessions } from "../../storage/sessions"
import { refuseWhileServing } from "../serving"
import { EOL } from "os"

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from a JSON file",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to a JSON file written by `opencode export`",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    // Same contract as migrate-storage: this bulk-writes the tables a live
    // server is also writing, and leaves that server's session index stale.
    if (await refuseWhileServing("import")) return
    await bootstrap(process.cwd(), async () => {
      const exportData: { info: Session.Info; messages: Array<{ info: any; parts: any[] }> } | undefined =
        await Bun.file(args.file)
          .json()
          .catch(() => undefined)
      if (!exportData) {
        process.stdout.write(`Could not read session data from ${args.file}`)
        process.stdout.write(EOL)
        return
      }

      await Sessions.write(exportData.info)

      for (const msg of exportData.messages) {
        await Messages.put(msg.info)

        for (const part of msg.parts) {
          await Parts.put(part)
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
