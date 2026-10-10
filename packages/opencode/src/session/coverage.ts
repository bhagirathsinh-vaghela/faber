import path from "path"
import { createHash } from "crypto"
import z from "zod"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { Patch } from "@/patch"
import { Debt } from "@/storage/debt"
import { Parts } from "@/storage/parts"
import { Sessions } from "@/storage/sessions"
import { Filesystem } from "@/util/filesystem"
import type { Session } from "."
import { MessageV2 } from "./message-v2"

// Review coverage by content, never by order: a read-only review counts for
// exactly the content it was asked at, as a protected branch set to "dismiss
// stale pull request approvals when new commits are pushed" drops an approval
// whose diff moved (docs.github.com, "About protected branches").
export namespace Coverage {
  // An unrestricted session could edit anything.
  export function canEdit(allowed: Session.Info["allowedTools"]) {
    if (!allowed) return true
    return allowed.some((tool) => MessageV2.EDIT_TOOLS.has(typeof tool === "string" ? tool : tool.id))
  }

  const sha1 = (data: string | Uint8Array) => createHash("sha1").update(data).digest("hex")
  // A file that is gone or unreadable hashes as "-", so deleting one changes the fingerprint.
  const digest = (file: string) =>
    Bun.file(file)
      .bytes()
      .then(sha1, () => "-")

  function hunks(text: string) {
    try {
      return Patch.parsePatch(text).hunks
    } catch {
      return []
    }
  }

  // Resolved against the session's directory, as each tool resolves against
  // its instance's. Any status counts: an errored multiedit, or an edit
  // aborted during its LSP wait, has already written.
  function named(part: MessageV2.ToolPart, directory: string) {
    const input = part.state.input ?? {}
    const files =
      part.tool === "apply_patch"
        ? hunks(String(input.patchText ?? "")).flatMap((hunk) =>
            hunk.type === "update" && hunk.move_path ? [hunk.path, hunk.move_path] : [hunk.path],
          )
        : typeof input.filePath === "string"
          ? [input.filePath]
          : []
    return files.map((file) => Filesystem.resolve(directory, file))
  }

  // Every file an edit tool named in the session or in a child that can
  // edit, with its content. Equal fingerprints mean that content is
  // byte-identical. A skill's own notes file is bookkeeping, not part of the change.
  export async function fingerprint(sessionID: string) {
    const session = await Sessions.read(sessionID)
    const children = await Sessions.children(sessionID).then((ids) =>
      Promise.all(ids.map((id) => Sessions.read(id).catch(() => undefined))),
    )
    const writers = [
      session,
      ...children.filter((child): child is Session.Info => child !== undefined && canEdit(child.allowedTools)),
    ]
    const tools = [...MessageV2.EDIT_TOOLS]
    const ledger = path.join(Global.Path.state, "skill-notes") + path.sep
    const each = await Promise.all(
      writers.map(async (writer) =>
        (await Parts.tools(writer.id, tools)).flatMap((part) => named(part, writer.directory)),
      ),
    )
    const files = [...new Set(each.flat())].filter((file) => !file.startsWith(ledger)).sort()
    const lines = await Promise.all(files.map(async (file) => `${file}\0${await digest(file)}`))
    return sha1(lines.join("\n"))
  }

  export const State = z
    .object({
      skills: z.string().array(),
      reviewed: z.boolean(),
      changed: z.boolean(),
      writers: z.number(),
      edits: z.boolean(),
    })
    .meta({ ref: "LoopCoverage" })
  export type State = z.infer<typeof State>

  // What a reminder skill's rules and its exit read. With `until`, only results
  // written up to that message count, so a result delivered after a skill's
  // exit line cannot vouch for it.
  export async function state(sessionID: string, until?: string): Promise<State> {
    const session = await Sessions.read(sessionID)
    const current = await fingerprint(sessionID)
    const results = (await Parts.results(sessionID)).filter(
      (part) => until === undefined || Identifier.compare(part.messageID, until) <= 0,
    )
    const owed = await Debt.owed(sessionID)
    const children = await Promise.all(
      owed
        .filter((debt) => debt.kind === "subagent")
        .map((debt) => Sessions.read(debt.responder).catch(() => undefined)),
    )
    return {
      skills: session.activeSkills ?? [],
      reviewed: results.some(
        ({ backgroundSubagentResult: result }) =>
          result?.status === "completed" && result.edits === false && result.tree === current,
      ),
      changed: current !== session.loaded,
      writers: children.filter((child) => child !== undefined && canEdit(child.allowedTools)).length,
      edits: canEdit(session.allowedTools),
    }
  }
}
