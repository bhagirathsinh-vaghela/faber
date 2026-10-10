import { fn } from "@/util/fn"
import z from "zod"
import { Session } from "."

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { Snapshot } from "@/snapshot"

import path from "path"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Bus } from "@/bus"

export namespace SessionSummary {
  function unquoteGitPath(input: string) {
    if (!input.startsWith('"')) return input
    if (!input.endsWith('"')) return input
    const body = input.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]
      if (!next) {
        bytes.push("\\".charCodeAt(0))
        continue
      }

      if (next >= "0" && next <= "7") {
        const chunk = body.slice(i + 1, i + 4)
        const match = chunk.match(/^[0-7]{1,3}/)
        if (!match) {
          bytes.push(next.charCodeAt(0))
          i++
          continue
        }
        bytes.push(parseInt(match[0], 8))
        i += match[0].length
        continue
      }

      const escaped =
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next === "\\" || next === '"'
                      ? next
                      : undefined

      bytes.push((escaped ?? next).charCodeAt(0))
      i++
    }

    return Buffer.from(bytes).toString()
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      // Callers do not await this, so a session removed while it runs must not
      // surface as an unhandled rejection; there is nothing left to summarize.
      await Promise.resolve()
        .then(async () => {
          const all = await Session.messages({ sessionID: input.sessionID, compacted: false })
          await Promise.all([
            summarizeSession({ sessionID: input.sessionID, messages: all }),
            summarizeMessage({ messageID: input.messageID, messages: all }),
          ])
        })
        .catch((error) => {
          if (!Storage.NotFoundError.isInstance(error)) throw error
        })
    },
  )

  async function summarizeSession(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    const files = new Set(
      input.messages
        .flatMap((x) => x.parts)
        .filter((x) => x.type === "patch")
        .flatMap((x) => x.files)
        .map((x) => path.relative(Instance.worktree, x).replaceAll("\\", "/")),
    )
    const diffs = await computeDiff({ messages: input.messages }).then((x) =>
      x.filter((x) => {
        return files.has(x.file)
      }),
    )
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Storage.write(["session_diff", input.sessionID], diffs)
    // Broadcast bodyless: before/after are whole file bodies, and every event
    // consumer either strips them (web client) or re-reads the stored full
    // diff (share-next). Bodies stay fetchable via the session.diff route.
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs.map(({ before, after, ...rest }) => rest),
    })
  }

  // The turn `messageID` belongs to, opener first: the user message that opened
  // it, every question's answer after it (MessageV2.reply), and the steps
  // parented to any of them. The loop parents the steps after an answer to the
  // answer, so a diff read off the opener alone would stop at the question.
  export function turn(all: MessageV2.WithParts[], messageID: string) {
    const users = all.filter((m) => m.info.role === "user")
    const at = users.findIndex((m) => m.info.id === messageID)
    if (at < 0) return []
    const start = users.findLastIndex((m, i) => i <= at && !MessageV2.reply(m))
    const end = users.findIndex((m, i) => i > start && !MessageV2.reply(m))
    const ids = new Set(users.slice(Math.max(start, 0), end < 0 ? undefined : end).map((m) => m.info.id))
    return all.filter((m) => ids.has(m.info.id) || (m.info.role === "assistant" && ids.has(m.info.parentID)))
  }

  async function summarizeMessage(input: { messageID: string; messages: MessageV2.WithParts[] }) {
    const messages = turn(input.messages, input.messageID)
    // The message can be gone by the time this runs (the session or the
    // message was removed meanwhile); there is then nothing to summarize.
    if (!messages.length) return
    const userMsg = messages[0].info as MessageV2.User
    const diffs = await computeDiff({ messages })
    userMsg.summary = {
      ...userMsg.summary,
      // Bodyless: before/after are whole file bodies, and this summary rides
      // every message.updated broadcast and message-list response. Bodies are
      // recomputed on demand by the diff route's messageID path.
      diffs: diffs.map(({ before, after, ...rest }) => rest),
    }
    await Session.updateMessage(userMsg)
  }

  async function messageDiff(input: { sessionID: string; messageID: string }) {
    return computeDiff({ messages: turn(await Session.messages({ sessionID: input.sessionID, compacted: false }), input.messageID) })
  }

  export const diff = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
      // when set, only the diff for this one file is returned (with bodies)
      file: z.string().optional(),
      // when true, file bodies (before/after) are stripped from the response
      summary: z.boolean().optional(),
    }),
    async (input) => {
      // The per-message tier recomputes from snapshots (bodies included):
      // message summaries persist bodyless, so this is the on-demand body
      // source for a turn's diff panel.
      const diffs: Snapshot.FileDiff[] = input.messageID
        ? await messageDiff({ sessionID: input.sessionID, messageID: input.messageID })
        : await Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => [])
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return {
          ...item,
          file,
        }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      // The stored session_diff only holds the session-level tier; a
      // per-message recompute must not overwrite it.
      if (changed && !input.messageID) Storage.write(["session_diff", input.sessionID], next).catch(() => {})
      if (input.file) return next.filter((item) => item.file === input.file)
      if (input.summary) return next.map(({ before, after, ...rest }) => rest)
      return next
    },
  )

  export async function computeDiff(input: { messages: MessageV2.WithParts[] }) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of input.messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
          break
        }
      }
    }

    if (from && to) return Snapshot.diffFull(from, to)
    return []
  }
}
