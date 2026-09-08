import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { SessionRevert } from "./revert"
import { Identifier } from "../id/id"
import { Log } from "../util/log"

// The one path that puts a synthetic result into a session and drives a turn
// from it. A background job, a subagent result, and a batch of results all do
// the same thing: mint ONE synthetic user message (inheriting the session's
// params, marked synthetic so title/prompt-count skip it), attach the caller's
// part(s), and optionally wake the loop. Consolidated so the mint + wake +
// revert-cleanup dance lives once instead of drifting across three copies.
//
// What stays with the CALLER: the part payload (its own render meta —
// backgroundJobResult vs backgroundSubagentResult), the wake decision, and any
// context wrapper (a job delivers under Instance.provide for its owner's
// directory; an in-loop caller already has context).
export namespace SessionDeliver {
  const log = Log.create({ service: "session-deliver" })

  // The caller's text-part fields; deliver owns the envelope keys.
  export type Part = Omit<MessageV2.TextPart, "id" | "messageID" | "sessionID" | "type">

  // Returns the minted message id, or undefined when the session is gone (the
  // job path maps this to "nothing to deliver into"). The wake is idempotent:
  // SessionPrompt.loop joins a running loop and starts one only when idle, so it
  // never doubles a turn and is safe to call whatever the session is doing.
  export async function deliver(input: {
    sessionID: string
    parts: Part[]
    wake?: boolean
  }): Promise<string | undefined> {
    // A gone session returns undefined rather than throwing: the job path maps
    // it to "nothing to deliver into", and a subagent whose parent was deleted
    // mid-run simply has nowhere to inject.
    const session = await Session.get(input.sessionID).catch(() => undefined)
    if (!session) {
      log.info("no session to deliver into", { sessionID: input.sessionID })
      return undefined
    }
    if (session.revert) await SessionRevert.cleanup(session)

    // Pre-mint history: mintSyntheticMessage reads it for nextPromptIndex.
    const messages = await Session.messages({ sessionID: input.sessionID })
    const messageID = await MessageV2.mintSyntheticMessage(input.sessionID, messages)

    for (const part of input.parts) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID,
        sessionID: input.sessionID,
        type: "text",
        ...part,
      })
    }

    if (input.wake ?? true) {
      SessionPrompt.loop(input.sessionID).catch((error) => {
        log.error("failed to wake the session", { sessionID: input.sessionID, error })
      })
    }

    return messageID
  }
}
