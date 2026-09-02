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
// whole thing spends most of the payload on text no reader can see: a command
// is unbounded (a heredoc, a long pipeline) while every other field is a few
// bytes, which makes it the entire cost of a list that is re-read while a job
// runs. The full command is on the detail view, which fetches one record.
const CLIP = 160

const Summary = BackgroundJob.Info.pick({
  id: true,
  sessionID: true,
  command: true,
  description: true,
  status: true,
  exit: true,
  time: true,
}).meta({ ref: "BackgroundJobSummary" })

function summarize(job: BackgroundJob.Info) {
  return {
    id: job.id,
    sessionID: job.sessionID,
    command: job.command.length > CLIP ? `${job.command.slice(0, CLIP)}...` : job.command,
    description: job.description,
    status: job.status,
    exit: job.exit,
    time: job.time,
  }
}

export const JobRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List background shell jobs",
        description:
          "A summary of every background shell job on this machine, newest first. The command a job ran is the largest field in a record and only the detail view shows it, so it is left out here.",
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
        return c.json(jobs.sort((a, b) => (a.id > b.id ? -1 : 1)).map(summarize))
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
