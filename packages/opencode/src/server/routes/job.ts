import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { BackgroundJob } from "../../background/job"
import { lazy } from "../../util/lazy"

// Read-only views of the shell jobs this machine is running.
//
// Separate from /background, which serves subagent tasks: the two share the
// word "job" and nothing else. These records live on disk rather than in
// memory, so a page reading them sees jobs this server never spawned.
//
// Nothing here mutates. A job's fate belongs to the session that owns it and
// to the sweep, and a viewer that could kill one would be a second authority
// over the same record.

// What a list row draws. A row clips its command to one line, so sending the
// whole thing spends the payload on text no reader can see: a command is
// unbounded (a heredoc, a long pipeline) while every other field is a few
// bytes. Measured in the browser, a row renders about 76 characters before CSS
// truncates it, so this is roughly a line's worth and no more. The full
// command is on the detail view, which fetches one record.
const CLIP = 96

// How much finished history a list carries. Every RUNNING job is always
// returned, however many there are, since those are the page's live content;
// this bounds only the finished tail behind them.
//
// A cap rather than a wider clip, because the cost is the number of records
// and not the size of one: records live for a week, so a busy machine can
// accumulate hundreds, each a few hundred bytes of fields no truncation
// touches. An older result is still reachable at its own URL, which the detail
// route serves without consulting this list.
const TAIL = 50

const Summary = BackgroundJob.Info.pick({
  id: true,
  sessionID: true,
  command: true,
  description: true,
  status: true,
  exit: true,
  time: true,
})
  .extend({
    // When the job's log last grew, so a running row shows genuine progress:
    // "updated 4s ago" is actively working, "updated 6m ago" has gone silent.
    // Only meaningful for a running row — a finished job's last activity is its
    // completion time, already in `time.completed` — so it is read only for
    // those and omitted otherwise rather than stat-ing every historical log.
    updated: z.number().optional(),
  })
  .meta({ ref: "BackgroundJobSummary" })

async function summarize(job: BackgroundJob.Info) {
  return {
    id: job.id,
    sessionID: job.sessionID,
    command: job.command.length > CLIP ? `${job.command.slice(0, CLIP)}...` : job.command,
    description: job.description,
    status: job.status,
    exit: job.exit,
    time: job.time,
    updated: job.status === "running" ? await BackgroundJob.logMtime(job.id) : undefined,
  }
}

export const JobRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List background shell jobs",
        description:
          "Every running background shell job on this machine, plus the most recent finished ones, newest first. A row's command is clipped to about a line, and its directory omitted; the detail route serves the whole record for one job.",
        operationId: "job.list",
        responses: {
          200: {
            description: "List of jobs",
            content: {
              "application/json": {
                schema: resolver(Summary.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const jobs = await BackgroundJob.list()
        // The id is a time-ordered uuidv7, so it sorts by start time with no
        // separate comparison on the timestamps inside the record.
        const newest = jobs.sort((a, b) => (a.id > b.id ? -1 : 1))
        return c.json(
          await Promise.all(
            [
              ...newest.filter((job) => job.status === "running"),
              ...newest.filter((job) => job.status !== "running").slice(0, TAIL),
            ].map(summarize),
          ),
        )
      },
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get a background shell job",
        description: "One job's record, with its output.",
        operationId: "job.get",
        responses: {
          200: {
            description: "Job and its output",
            content: {
              "application/json": {
                schema: resolver(z.object({ job: BackgroundJob.Info, output: z.string() })),
              },
            },
          },
          404: {
            description: "Job not found",
          },
        },
      }),
      validator("param", z.object({ id: z.string().meta({ description: "Job ID" }) })),
      async (c) => {
        const { id } = c.req.valid("param")
        const job = await BackgroundJob.get(id)
        if (!job) return c.json({ error: "Job not found" }, 404)
        return c.json({ job, output: await BackgroundJob.output(id) })
      },
    )
    .get(
      "/:id/log",
      describeRoute({
        summary: "Read a job's output",
        description:
          "The tail of a job's log. The file is appended to while the job runs, so a viewer polls this for progress.",
        operationId: "job.log",
        responses: {
          200: {
            description: "Log tail",
            content: {
              "application/json": {
                schema: resolver(z.object({ output: z.string(), size: z.number() })),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string().meta({ description: "Job ID" }) })),
      validator(
        "query",
        z.object({
          limit: z.coerce
            .number()
            .optional()
            .meta({ description: "Return only the last N bytes, for a log that has grown large" }),
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit } = c.req.valid("query")
        const output = await BackgroundJob.output(id)
        return c.json({
          output: limit && output.length > limit ? output.slice(-limit) : output,
          size: output.length,
        })
      },
    ),
)
