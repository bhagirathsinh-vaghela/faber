import { describe, test, expect } from "bun:test"
import { Jobs } from "../../src/storage/jobs"
import type { BackgroundJob } from "../../src/background/job"

function job(id: string, sessionID: string, status: BackgroundJob.Status, created = 1000): BackgroundJob.Info {
  return {
    id,
    sessionID,
    directory: "/tmp",
    command: "echo " + id,
    description: "test " + id,
    status,
    time: { created, hard: created + 60_000 },
  }
}

describe("Jobs", () => {
  test("put then get round-trips the record, including ended", async () => {
    const killed = { ...job("job_rt", "ses_rt", "killed"), exit: 137, ended: "stop" as const }
    await Jobs.put(killed)
    expect(await Jobs.get(killed.id)).toEqual(killed)
  })

  test("get of an absent job is undefined", async () => {
    expect(await Jobs.get("job_absent")).toBeUndefined()
  })

  test("update writes the mutated record and returns it", async () => {
    await Jobs.put(job("job_up", "ses_up", "running"))
    const settled = await Jobs.update("job_up", (draft) => {
      draft.status = "exited"
      draft.exit = 0
    })
    const expected = { ...job("job_up", "ses_up", "exited"), exit: 0 }
    expect(settled).toEqual(expected)
    expect(await Jobs.get("job_up")).toEqual(expected)
  })

  test("update leaves the record unchanged when the mutator returns false", async () => {
    const original = job("job_up_false", "ses_up", "running")
    await Jobs.put(original)
    const declined = await Jobs.update(original.id, (draft) => {
      draft.status = "killed"
      return false
    })
    expect(declined).toBeUndefined()
    expect(await Jobs.get(original.id)).toEqual(original)
  })

  test("update leaves the record unchanged when the mutator throws", async () => {
    const original = job("job_up_throw", "ses_up", "running")
    await Jobs.put(original)
    await expect(
      Jobs.update(original.id, (draft) => {
        draft.status = "killed"
        throw new Error("abort in mutator")
      }),
    ).rejects.toThrow("abort in mutator")
    expect(await Jobs.get(original.id)).toEqual(original)
  })

  test("update of an absent job is undefined", async () => {
    expect(await Jobs.update("job_up_absent", () => {})).toBeUndefined()
  })

  test("remove deletes the record", async () => {
    await Jobs.put(job("job_rm", "ses_rm", "exited"))
    await Jobs.remove("job_rm")
    expect(await Jobs.get("job_rm")).toBeUndefined()
  })
})
