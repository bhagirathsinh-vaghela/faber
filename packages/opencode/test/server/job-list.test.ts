import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { BackgroundJob } from "../../src/background/job"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

const created: string[] = []

async function write(input: Partial<BackgroundJob.Info> & { id?: string }) {
  const id = input.id ?? BackgroundJob.id()
  created.push(id)
  await BackgroundJob.write({
    id,
    sessionID: "ses_job_list_test",
    directory: projectRoot,
    project: projectRoot,
    command: "true",
    description: "job list test",
    status: "exited",
    exit: 0,
    time: { created: Date.now(), hard: Date.now() + 600_000, completed: Date.now() },
    ...input,
  })
  return id
}

afterEach(async () => {
  for (const id of created.splice(0)) await BackgroundJob.remove(id)
})

describe("job.list", () => {
  // Only jobs this test wrote are counted: the machine's own records share the
  // list.
  test("bounds the finished jobs it returns", async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 60; i++) ids.add(await write({}))

    const body = await Instance.provide({
      directory: projectRoot,
      fn: async () => (await Server.App().request("/job")).json() as Promise<{ id: string }[]>,
    })

    expect(body.filter((job) => ids.has(job.id)).length).toBeLessThan(60)
  }, 20_000)

  // The command is the only unbounded field, and a row shows one clipped line
  // of it, so a list carries at most a line's worth however long the command.
  test("clips a long command and omits the directory", async () => {
    const id = await write({ command: "echo " + "x".repeat(500) })

    const body = await Instance.provide({
      directory: projectRoot,
      fn: async () => (await Server.App().request("/job")).json() as Promise<Record<string, unknown>[]>,
    })
    const row = body.find((job) => job.id === id)!

    expect((row.command as string).length).toBeLessThan(120)
    expect(row.directory).toBeUndefined()
  }, 20_000)
})
