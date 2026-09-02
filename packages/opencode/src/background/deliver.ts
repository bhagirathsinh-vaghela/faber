import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { Log } from "@/util/log"
import { BackgroundJob } from "./job"
import { BackgroundNotify } from "./notify"

// Putting a job's result into the session that asked for it.
//
// The job reports nothing, so this is the only way a result is ever seen. It
// arrives as a SYNTHETIC user message: the model reads it as input, while
// everything that counts real user prompts (title generation, inherited
// parameters, prompt indexing) skips it.
export namespace BackgroundDeliver {
  const log = Log.create({ service: "background-deliver" })

  export async function send(job: BackgroundJob.Info, kind: BackgroundNotify.Kind, wake = true) {
    const session = await Session.get(job.sessionID).catch(() => undefined)
    // The session was deleted while the job ran. Nothing to deliver into, and
    // the reconciler will reap the job on its next pass.
    if (!session) {
      log.info("no session to deliver into", { job: job.id, sessionID: job.sessionID })
      return false
    }
    if (session.revert) await SessionRevert.cleanup(session)

    const text = BackgroundNotify.render(job, await BackgroundJob.output(job.id), kind)
    const messages = await Session.messages({ sessionID: job.sessionID })
    const messageID = Identifier.ascending("message")

    await Session.updateMessage({
      id: messageID,
      sessionID: job.sessionID,
      role: "user",
      time: { created: Date.now() },
      ...inherited(messages),
      synthetic: true,
      promptIndex: messages.reduce((max, m) => Math.max(max, m.info.promptIndex ?? 0), 0) + 1,
    })

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID,
      sessionID: job.sessionID,
      type: "text",
      text,
      synthetic: true,
    })

    log.info("delivered", { job: job.id, sessionID: job.sessionID, kind })

    // Waking is what turns a delivered result into work. A check-in on a job
    // the model is already waiting for should reach it now; a caller batching
    // several results wakes once at the end instead.
    if (wake) {
      SessionPrompt.loop(job.sessionID).catch((error) => {
        log.error("failed to wake the session", { job: job.id, error })
      })
    }
    return true
  }

  // Which agent, model and variant the synthetic message runs as. Taken from
  // the last message a HUMAN sent, so a chain of injected results cannot drift
  // the session onto different parameters than the user chose.
  function inherited(messages: MessageV2.WithParts[]) {
    const user = messages.findLast((m) => m.info.role === "user" && !m.info.synthetic)?.info as
      | MessageV2.User
      | undefined
    return user
      ? MessageV2.inherit(user)
      : { agent: "build", model: { providerID: "unknown", modelID: "unknown" }, variant: undefined }
  }
}
