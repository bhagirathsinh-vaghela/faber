import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { BackgroundJob } from "./job"
import { BackgroundNotify } from "./notify"

// A running job's check-in, sent to the session that started it.
//
// A job's RESULT is a debt Recovery pays; a check-in is only progress, so it
// goes out directly and a lost one is the next nudge's to make. Both travel the
// same send a typed prompt does (Recovery.notify / Recovery.deliver). It
// arrives as a SYNTHETIC user message: the model reads it as input, while
// everything that counts real user prompts (title generation, inherited
// parameters, the prompt ordinal) skips it.
export namespace BackgroundDeliver {
  const log = Log.create({ service: "background-deliver" })

  // Every session read and write below resolves against an AsyncLocalStorage
  // context. A job this server spawned inherits one from the tool call, but an
  // ADOPTED job has none, which is exactly the path a restart takes.
  //
  // The context is the OWNER's directory, never where the command ran: a job
  // given a workdir outside the project runs somewhere that resolves to a
  // different project, and the session it belongs to is not there.
  export async function checkin(job: BackgroundJob.Info) {
    return Instance.provide({ directory: BackgroundJob.owner(job), fn: () => send(job) })
  }

  async function send(claimed: BackgroundJob.Info) {
    const job = await BackgroundJob.get(claimed.id)
    if (job?.status !== "running") return false
    // How long since the log last grew, so the check-in can say whether the
    // job is still producing output.
    const logAge = await BackgroundJob.logMtime(job.id).then((at) => (at === undefined ? undefined : Date.now() - at))
    const text = BackgroundNotify.render(job, await BackgroundJob.output(job.id), "checkin", Date.now(), logAge)

    // The backgroundJobResult meta is what turns the envelope into a card rather
    // than a wall of text: the client renders a labelled block from it and
    // strips the header lines out of the body.
    const { Recovery } = await import("@/session/recovery")
    const sent = await Recovery.notify(
      job.sessionID,
      [{ text, synthetic: true, backgroundJobResult: BackgroundNotify.meta(job, "checkin") }],
      job.id,
    )
    // False means the session was deleted, archived, or held by a Stop, or the
    // job finished while the check-in was being written. A finished job's
    // result is on its way; a check-in that was dropped is tried again.
    if (!sent) return false

    log.info("checked in", { job: job.id, sessionID: job.sessionID })
    return true
  }
}
