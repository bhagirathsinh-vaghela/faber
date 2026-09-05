import { Session } from "@/session"
import { Instance } from "@/project/instance"
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

  // Every session read and write below resolves against an AsyncLocalStorage
  // context. A job this server spawned inherits one from the tool call, but an
  // ADOPTED job has none, which is exactly the path a restart takes: the
  // delivery then found no session and the result was lost silently.
  //
  // The context is the OWNER's directory, never where the command ran: a job
  // given a workdir outside the project runs somewhere that resolves to a
  // different project, and the session it belongs to is not there.
  export async function send(job: BackgroundJob.Info, kind: BackgroundNotify.Kind, wake = true) {
    return Instance.provide({ directory: BackgroundJob.owner(job), fn: () => deliver(job, kind, wake) })
  }

  async function deliver(job: BackgroundJob.Info, kind: BackgroundNotify.Kind, wake: boolean) {
    const session = await Session.get(job.sessionID).catch(() => undefined)
    // The session was deleted while the job ran. Nothing to deliver into, and
    // the reconciler will reap the job on its next pass.
    if (!session) {
      log.info("no session to deliver into", { job: job.id, sessionID: job.sessionID })
      return false
    }
    if (session.revert) await SessionRevert.cleanup(session)

    // The nudge's freshness delta: how long since the log last grew, read only
    // for a check-in and left undefined otherwise so render drops the clause
    // rather than claiming a freshness it does not have.
    const logAge =
      kind === "checkin"
        ? await BackgroundJob.logMtime(job.id).then((at) => (at === undefined ? undefined : Date.now() - at))
        : undefined
    const text = BackgroundNotify.render(job, await BackgroundJob.output(job.id), kind, Date.now(), logAge)
    const messages = await Session.messages({ sessionID: job.sessionID })
    const messageID = Identifier.ascending("message")

    await Session.updateMessage({
      id: messageID,
      sessionID: job.sessionID,
      role: "user",
      time: { created: Date.now() },
      ...(await MessageV2.currentParams(job.sessionID, messages)),
      synthetic: true,
      promptIndex: MessageV2.nextPromptIndex(messages),
    })

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID,
      sessionID: job.sessionID,
      type: "text",
      text,
      synthetic: true,
      // What turns the envelope into a card rather than a wall of text: the
      // client renders a labelled block from this and strips the header lines
      // out of the body, so the reader sees the command, the outcome and the
      // duration as fields.
      backgroundJobResult: BackgroundNotify.meta(job, kind),
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

}
