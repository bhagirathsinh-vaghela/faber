import { Instance } from "@/project/instance"
import { SessionDeliver } from "@/session/deliver"
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
    // The nudge's freshness delta: how long since the log last grew, read only
    // for a check-in and left undefined otherwise so render drops the clause
    // rather than claiming a freshness it does not have.
    const logAge =
      kind === "checkin"
        ? await BackgroundJob.logMtime(job.id).then((at) => (at === undefined ? undefined : Date.now() - at))
        : undefined
    const text = BackgroundNotify.render(job, await BackgroundJob.output(job.id), kind, Date.now(), logAge)

    // The backgroundJobResult meta is what turns the envelope into a card rather
    // than a wall of text: the client renders a labelled block from it and
    // strips the header lines out of the body.
    const messageID = await SessionDeliver.deliver({
      sessionID: job.sessionID,
      parts: [{ text, synthetic: true, backgroundJobResult: BackgroundNotify.meta(job, kind) }],
      wake,
    })
    // undefined means the session was deleted while the job ran; the reconciler
    // reaps the job on its next pass.
    if (messageID === undefined) return false

    log.info("delivered", { job: job.id, sessionID: job.sessionID, kind })
    return true
  }
}
