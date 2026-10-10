import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundSpawn } from "../../src/background/spawn"
import { Debt } from "../../src/storage/debt"

const spawned: string[] = []

async function run(command: string, options: Partial<BackgroundSpawn.Input> = {}) {
  const spawn = await BackgroundSpawn.run({
    command,
    description: "test",
    sessionID: "ses_spawn_test",
    directory: "/tmp",
    project: "/tmp",
    shell: "/bin/sh",
    env: {},
    hard: 60_000,
    ...options,
  })
  spawned.push(spawn.job.id)
  return spawn
}

// The exit watcher is process-global and every test file shares the process,
// so a test installs its own and puts back whatever it replaced.
async function watching<T>(handler: BackgroundSpawn.OnExit, fn: () => Promise<T>) {
  const previous = BackgroundSpawn.watch(handler)
  return fn().finally(() => BackgroundSpawn.watch(previous))
}

afterEach(async () => {
  for (const id of spawned.splice(0)) {
    const job = await BackgroundJob.get(id)
    if (job?.process) await BackgroundProcess.kill(job.process)
    await BackgroundJob.remove(id)
  }
})

describe("BackgroundSpawn inline path", () => {
  // The property that keeps sequential read-decide-act chains in one turn.
  test("a fast command returns inline, well inside the grace window", async () => {
    const started = Date.now()
    const spawn = await run("echo hello")

    expect(spawn.type).toBe("inline")
    expect(Date.now() - started).toBeLessThan(BackgroundSpawn.GRACE_MS)
    if (spawn.type !== "inline") throw new Error("expected inline")
    expect(spawn.output).toContain("hello")
    expect(spawn.exit).toBe(0)
  })

  test("carries a failing command's exit code", async () => {
    const spawn = await run("echo nope >&2; exit 3")
    expect(spawn.type).toBe("inline")
    if (spawn.type !== "inline") throw new Error("expected inline")
    expect(spawn.exit).toBe(3)
    expect(spawn.output).toContain("nope")
  })

  test("marks the record exited so a later sweep leaves it alone", async () => {
    const spawn = await run("true")
    const job = await BackgroundJob.get(spawn.job.id)
    expect(job?.status).toBe("exited")
    expect(job?.time.completed).toBeDefined()
  })
})

describe("BackgroundSpawn background path", () => {
  test("a slow command hands back a task id at the grace window", async () => {
    const started = Date.now()
    const spawn = await run("sleep 30")
    const elapsed = Date.now() - started

    expect(spawn.type).toBe("background")
    expect(elapsed).toBeGreaterThanOrEqual(BackgroundSpawn.GRACE_MS - 500)
    expect(elapsed).toBeLessThan(BackgroundSpawn.GRACE_MS + 5_000)
    expect(spawn.job.status).toBe("running")
  }, 20_000)

  test("the job keeps running and its identity is recorded", async () => {
    const spawn = await run("sleep 30")
    const job = (await BackgroundJob.get(spawn.job.id))!

    expect(job.process).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    // Spawned detached, so the job leads its own group.
    expect(job.process!.pgid).toBe(job.process!.pid)
  }, 20_000)

  // Output must be readable WHILE the job runs, which is what makes progress
  // a plain `tail` rather than a new tool.
  test("output is on disk and growing before the job finishes", async () => {
    const spawn = await run("echo first; sleep 30")
    expect(spawn.type).toBe("background")
    expect(await BackgroundJob.output(spawn.job.id)).toContain("first")
  }, 20_000)
})

describe("BackgroundSpawn exit watcher", () => {
  // Without this the result of a job finishing just past the window would wait
  // for the next reconcile sweep, up to five minutes away. The handle is
  // already held in this process, so its exit costs no poller and no worker.
  test("fires the moment a backgrounded job exits", async () => {
    const seen: string[] = []
    await watching(
      (job) => void seen.push(job.id),
      async () => {
        // Must outlive the grace window, or it returns inline and the watcher is
        // correctly never involved.
        const spawn = await run("echo done-late; sleep 7")
        expect(spawn.type).toBe("background")

        const started = Date.now()
        while (!seen.includes(spawn.job.id) && Date.now() - started < 15_000) await Bun.sleep(100)

        expect(seen).toContain(spawn.job.id)
      },
    )
  }, 35_000)

  test("hands the watcher a settled record carrying the exit code", async () => {
    const settled: Array<{ id: string; exit: number | undefined; status: string }> = []
    await watching(
      (job) => void settled.push({ id: job.id, exit: job.exit, status: job.status }),
      async () => {
        const spawn = await run("sleep 7; exit 5")
        const started = Date.now()
        while (!settled.some((j) => j.id === spawn.job.id) && Date.now() - started < 15_000) await Bun.sleep(100)

        const match = settled.find((j) => j.id === spawn.job.id)
        expect(match?.status).toBe("exited")
        expect(match?.exit).toBe(5)
      },
    )
  }, 35_000)

  // A job the watchdog kills on its own deadline settles `killed`, not `exited`.
  // The watchdog's TERM leaves rc 143, indistinguishable from a failure by exit
  // code alone, so the deadline decides it. The orchestrator delivers a `killed`
  // record as `timeout`; classifying it `exited` here would render it "failed".
  test("hands the watcher a killed record when the job hits its deadline", async () => {
    const settled: Array<{ id: string; status: string }> = []
    await watching(
      (job) => void settled.push({ id: job.id, status: job.status }),
      async () => {
        // Outlives the grace window so it backgrounds, and outlives its own 6s hard
        // deadline so the watchdog fires. Both bounds are real: at 5s grace and an
        // 8s sleep, the deadline lands after the window and before the command ends.
        const spawn = await run("sleep 8", { hard: 6_000 })
        expect(spawn.type).toBe("background")

        const started = Date.now()
        while (!settled.some((j) => j.id === spawn.job.id) && Date.now() - started < 15_000) await Bun.sleep(100)

        expect(settled.find((j) => j.id === spawn.job.id)?.status).toBe("killed")
        expect((await BackgroundJob.get(spawn.job.id))?.status).toBe("killed")
      },
    )
  }, 35_000)

  test("does not fire for a job that returned inline", async () => {
    const seen: string[] = []
    await watching(
      (job) => void seen.push(job.id),
      async () => {
        const spawn = await run("echo quick")
        await Bun.sleep(500)

        expect(seen).not.toContain(spawn.job.id)
        expect((await BackgroundJob.get(spawn.job.id))?.status).toBe("exited")
      },
    )
  })

  test("returns the handler it replaced, so a caller can put it back", () => {
    const first: BackgroundSpawn.OnExit = () => {}
    const original = BackgroundSpawn.watch(first)
    expect(BackgroundSpawn.watch(original)).toBe(first)
  })
})

// A job this process is launching or holds a live handle for is settled by that
// handle. A reconcile pass that reached it first would reap a record whose
// identity is not written yet, or settle an inline job and pay it twice.
describe("BackgroundSpawn: a reconcile pass leaves a held job to its handle", () => {
  // The record is put into the state a pass would misjudge (no identity yet, as
  // mid-launch; a dead identity, as between the exit and the handle's settle)
  // and restored after, so the handle still settles and cleans it up.
  async function misjudged(state: BackgroundJob.Info["process"]) {
    const { BackgroundReconcile } = await import("../../src/background/reconcile")
    const spawn = await run(`sleep ${BackgroundSpawn.GRACE_MS / 1000 + 2}`)
    expect(spawn.type).toBe("background")
    const real = (await BackgroundJob.get(spawn.job.id))!.process
    await BackgroundJob.update(spawn.job.id, (draft) => void (draft.process = state))

    try {
      const pass = await BackgroundReconcile.run()
      const record = await BackgroundJob.get(spawn.job.id)
      return { action: pass.actions.find((entry) => entry.job.id === spawn.job.id)?.type, record }
    } finally {
      await BackgroundJob.update(spawn.job.id, (draft) => void (draft.process = real))
    }
  }

  test("a held record with no identity yet is not reaped as orphaned", async () => {
    const seen = await misjudged(undefined)
    expect(seen.action).toBe("kept")
    expect(seen.record?.status).toBe("running")
  }, 25_000)

  test("a held record whose process reads as gone is not settled by the pass", async () => {
    const seen = await misjudged({ pid: 2 ** 22 + 12345, start: "gone", pgid: 2 ** 22 + 12345 })
    expect(seen.action).toBe("kept")
    expect(seen.record?.status).toBe("running")
  }, 25_000)

  test("an inline job is released once it returns", async () => {
    const spawn = await run("echo quick")
    expect(spawn.type).toBe("inline")
    expect(BackgroundSpawn.holding(spawn.job.id)).toBe(false)
  })

  test("a background job stays held until its exit settles it", async () => {
    const settled: string[] = []
    await watching(
      (job) => void settled.push(job.id),
      async () => {
        const spawn = await run(`sleep ${BackgroundSpawn.GRACE_MS / 1000 + 1}`)
        expect(spawn.type).toBe("background")
        expect(BackgroundSpawn.holding(spawn.job.id)).toBe(true)

        const started = Date.now()
        while (!settled.includes(spawn.job.id) && Date.now() - started < 10_000) await Bun.sleep(50)

        expect(settled).toEqual([spawn.job.id])
        expect(BackgroundSpawn.holding(spawn.job.id)).toBe(false)
      },
    )
  }, 25_000)
})

describe("BackgroundSpawn durability", () => {
  // Written before the spawn, so a crash in between leaves a findable record
  // rather than an unfindable process.
  test("the record exists with its log path derivable from the id alone", async () => {
    const spawn = await run("sleep 30")
    const job = (await BackgroundJob.get(spawn.job.id))!

    expect(job.id).toBe(spawn.job.id)
    expect(BackgroundJob.logPath(job.id)).toContain(job.id)
    expect(await Bun.file(BackgroundJob.logPath(job.id)).exists()).toBe(true)
  }, 20_000)

  // The bound is an instant on disk, so it survives the process that set it.
  test("stores the hard deadline as an absolute instant, not a timer", async () => {
    const before = Date.now()
    const spawn = await run("sleep 30", { hard: 60_000 })
    const job = (await BackgroundJob.get(spawn.job.id))!

    expect(job.time.hard).toBeGreaterThanOrEqual(before + 60_000)
    expect(job.time.hard).toBeLessThan(before + 70_000)
  }, 20_000)

  // An explicit soft estimate under the cap is honoured, pulling the first nudge
  // earlier than the derived half-hard default would.
  test("honours an explicit soft estimate under the cap", async () => {
    const before = Date.now()
    const withSoft = await run("sleep 30", { soft: 10_000 })
    const job = (await BackgroundJob.get(withSoft.job.id))!
    expect(job.time.soft).toBeGreaterThanOrEqual(before + 10_000)
    expect(job.time.soft).toBeLessThan(before + 20_000)
  }, 20_000)

  // An estimate can only pull the first nudge earlier, never later: one above the
  // cap is clamped to it, so a nudge still arrives within a few minutes.
  test("clamps an explicit soft estimate above the cap", async () => {
    const before = Date.now()
    const withSoft = await run("sleep 30", { soft: 30 * 60 * 1000 })
    const job = (await BackgroundJob.get(withSoft.job.id))!
    expect(job.time.soft).toBeLessThanOrEqual(before + BackgroundSpawn.SOFT_CAP_MS + 1_000)
  }, 20_000)

  // The derived soft is capped, so a default-hard job still gets its first nudge
  // within a few minutes rather than halfway through a 30-minute budget.
  test("derives a capped soft deadline when none is given", async () => {
    const before = Date.now()
    const job = await run("true")
    const record = (await BackgroundJob.get(job.job.id))!
    expect(record.time.soft).toBeDefined()
    expect(record.time.soft!).toBeLessThanOrEqual(before + BackgroundSpawn.SOFT_CAP_MS + 1_000)
  })

  test("derives soft from half the hard budget when that is under the cap", async () => {
    const before = Date.now()
    const job = await run("true", { hard: 60_000 })
    const record = (await BackgroundJob.get(job.job.id))!
    expect(record.time.soft).toBeGreaterThanOrEqual(before + 30_000)
    expect(record.time.soft).toBeLessThan(before + 40_000)
  })

  test("an estimate past half the hard budget falls back to half of it", async () => {
    const job = await run("true", { hard: 60_000, soft: 90_000 })
    const record = (await BackgroundJob.get(job.job.id))!
    expect(record.time.soft! - record.time.created).toBe(30_000)
  })
})

describe("BackgroundSpawn stdin", () => {
  // An interactive command must fail fast rather than hang forever against an
  // unbounded job. Closed stdin is what turns "waits for input that can never
  // arrive" into an immediate EOF.
  test("stdin is closed, so a command reading it finishes instead of hanging", async () => {
    const started = Date.now()
    const spawn = await run('read line; echo "got:$line"')

    expect(spawn.type).toBe("inline")
    expect(Date.now() - started).toBeLessThan(BackgroundSpawn.GRACE_MS)
    if (spawn.type !== "inline") throw new Error("expected inline")
    expect(spawn.output).toContain("got:")
  })
})

// Settling is what earns the right to deliver, so the guarded write and the
// answer have to agree. The exit watcher and a reconcile sweep are woken by the
// same event — the job ending — so both reach the settle for one job as a matter
// of course, and a settle that answers regardless of its own claim puts two
// results in the session for one job.
describe("BackgroundSpawn: one job settles once", () => {
  test("the exit watcher stays silent for a job another pass already settled", async () => {
    const fired: string[] = []
    await watching(
      async (job) => void fired.push(job.id),
      async () => {
        const spawn = await run(`sleep ${BackgroundSpawn.GRACE_MS / 1000 + 1}`)
        expect(spawn.type).toBe("background")

        // Exactly what a sweep does when it finds the process gone: take the record
        // out of `running` before the exit handle wakes.
        await BackgroundJob.update(spawn.job.id, (draft) => {
          draft.status = "exited"
          draft.exit = 0
          draft.time.completed = Date.now()
        })

        const started = Date.now()
        while (Date.now() - started < 4_000) {
          if (fired.includes(spawn.job.id)) break
          await Bun.sleep(50)
        }

        expect(fired.filter((id) => id === spawn.job.id).length).toBe(0)
      },
    )
  }, 25_000)
})

// The recorded identity is the WRAPPER's, because that is what spawning
// returns. `set -m` puts the user's command in a group of its own that nothing
// outside can name, so a kill aimed at the record reaches the wrapper and its
// watchdog and leaves the command running with nothing left that knows about
// it. The wrapper forwards the signal to the group it created.
describe("BackgroundSpawn: a kill reaches the command, not just the wrapper", () => {
  test("stopping a wrapped job ends the command it launched", async () => {
    const spawn = await run(`echo "CMDPID=$$"; sleep ${BackgroundSpawn.GRACE_MS / 1000 + 40}`)
    expect(spawn.type).toBe("background")

    await Bun.sleep(600)
    const output = await BackgroundJob.output(spawn.job.id)
    const cmdpid = Number(/CMDPID=(\d+)/.exec(output ?? "")?.[1])
    expect(cmdpid).toBeGreaterThan(0)

    // The two groups differ by construction, which is the whole point: the
    // record cannot name the group the command is in.
    const record = await BackgroundJob.get(spawn.job.id)
    expect(record?.process?.pgid).not.toBe(cmdpid)

    await BackgroundJob.stop(spawn.job.id)
    await Bun.sleep(1200)

    const alive = await Bun.$`ps -p ${cmdpid} -o pid=`.quiet().nothrow()
    expect(alive.stdout.toString().trim()).toBe("")
  }, 30_000)

  // The case a plain `sleep` cannot exercise: a command that IGNORES SIGTERM.
  // The outside killer only reaches the wrapper's group, so ending such a command
  // falls to the wrapper's trap escalating TERM to KILL on the inner group. A
  // plain `sleep` dies on the first TERM and never exercises that path.
  //
  // This proves the command IS ended, not that the outer SIGKILL delay is what
  // ends it — the trap does, on its own clock, whatever the delay. The delay's
  // backstop ordering is asserted in kill-escalation.test.ts instead.
  test("stopping a job ends a command that ignores SIGTERM", async () => {
    const spawn = await run(`echo "CMDPID=$$"; trap '' TERM; while true; do sleep 0.2; done`)
    expect(spawn.type).toBe("background")

    await Bun.sleep(600)
    const output = await BackgroundJob.output(spawn.job.id)
    const cmdpid = Number(/CMDPID=(\d+)/.exec(output ?? "")?.[1])
    expect(cmdpid).toBeGreaterThan(0)

    await BackgroundJob.stop(spawn.job.id)
    // Past the wrapper's escalation window plus a margin, by which point the trap
    // has KILLed the inner group.
    await Bun.sleep((BackgroundProcess.ESCALATION_SECONDS + 2) * 1000)

    const alive = await Bun.$`ps -p ${cmdpid} -o pid=`.quiet().nothrow()
    expect(alive.stdout.toString().trim()).toBe("")
  }, 30_000)
})

// A Stop whose abort lands while the process is being spawned is caught by the
// check after the spawn, which kills the job without paying and then collects
// its result itself: no exit handle is held for it to do so.
describe("BackgroundSpawn: a Stop during the spawn", () => {
  test("kills the job as stopped and delivers the stopped result without waking", async () => {
    const path = await import("path")
    const { tmpdir } = await import("../fixture/fixture")
    const { Instance } = await import("../../src/project/instance")
    const { Session } = await import("../../src/session")
    const { SessionPrompt } = await import("../../src/session/prompt")
    await using project = await tmpdir({
      git: true,
      init: (dir) =>
        Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            model: "anthropic/claude-3-5-sonnet-20241022",
            provider: { anthropic: { options: { apiKey: "test-key", baseURL: "http://127.0.0.1:9/v1" } } },
          }),
        ),
    })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "stopped mid-spawn" })
        // Clear at the check before the spawn, aborted at the one after it.
        const reads = { count: 0 }
        const signal = {
          get aborted() {
            reads.count++
            return reads.count > 1
          },
          reason: SessionPrompt.STOPPED,
        } as AbortSignal

        const error = await BackgroundSpawn.run({
          command: "sleep 30",
          description: "stopped mid-spawn",
          sessionID: session.id,
          signal,
          directory: project.path,
          project: project.path,
          shell: "/bin/sh",
          env: {},
          hard: 60_000,
        }).then(
          () => undefined,
          (failure: Error) => failure.message,
        )

        const [job] = (await BackgroundJob.list()).filter((record) => record.sessionID === session.id)
        expect(error).toBe(`session ${session.id} was stopped while launching job ${job!.id}`)
        expect(job!.status).toBe("killed")
        expect(job!.ended).toBe("stop")
        expect(await Debt.has(job!.id)).toBe(false)
        const delivered = (await Session.messages({ sessionID: session.id })).flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "text" && part.backgroundJobResult?.jobId === job!.id
              ? [part.backgroundJobResult.status]
              : [],
          ),
        )
        expect(delivered).toEqual(["stopped"])

        await Session.remove(session.id)
        await BackgroundJob.remove(job!.id)
      },
    })
  }, 30_000)
})

describe("BackgroundJob.create", () => {
  test("writes the record and its debt together", async () => {
    const id = BackgroundJob.id()
    const job: BackgroundJob.Info = {
      id,
      sessionID: "ses_create_both",
      directory: "/tmp",
      command: "true",
      description: "create",
      status: "running",
      time: { created: 1000, hard: 61_000 },
    }
    await BackgroundJob.create(job)
    expect(await BackgroundJob.get(id)).toEqual(job)
    expect(await Debt.get(id)).toEqual({
      responder: id,
      kind: "job",
      caller: "ses_create_both",
      created: 1000,
      asks: 0,
    })
    await Debt.remove(id)
    await BackgroundJob.remove(id)
  })

  // A record that cannot be serialized throws after the debt is written in
  // the same transaction, which rolls both back.
  test("a throw inside the write leaves neither the record nor the debt", async () => {
    const id = BackgroundJob.id()
    const job = {
      id,
      sessionID: "ses_create_neither",
      directory: "/tmp",
      command: "true",
      description: "create",
      status: "running",
      exit: 1n,
      time: { created: 1000, hard: 61_000 },
    } as unknown as BackgroundJob.Info
    await expect(BackgroundJob.create(job)).rejects.toThrow("BigInt")
    expect(await BackgroundJob.get(id)).toBeUndefined()
    expect(await Debt.get(id)).toBeUndefined()
  })
})

// A Stop's abort precedes its payment, so a Stop that lands after an inline job
// paid its debt and settled must not open that debt again.
describe("BackgroundSpawn: a Stop after the inline payment", () => {
  test("leaves no job debt behind", async () => {
    const { GlobalBus } = await import("../../src/bus/global")
    const { SessionPrompt } = await import("../../src/session/prompt")
    const abort = new AbortController()
    const listener = (event: { payload: { type: string; properties: { job?: BackgroundJob.Info } } }) => {
      if (event.payload.properties.job?.status === "exited") abort.abort(SessionPrompt.STOPPED)
    }
    GlobalBus.on("event", listener)
    const spawn = await run("echo done", { signal: abort.signal }).finally(() => GlobalBus.off("event", listener))

    expect(spawn.type).toBe("inline")
    expect(abort.signal.aborted).toBe(true)
    expect(await Debt.has(spawn.job.id)).toBe(false)
  })

  test("an Esc there still puts the debt back for the collector", async () => {
    const { GlobalBus } = await import("../../src/bus/global")
    const abort = new AbortController()
    const listener = (event: { payload: { type: string; properties: { job?: BackgroundJob.Info } } }) => {
      if (event.payload.properties.job?.status === "exited") abort.abort()
    }
    GlobalBus.on("event", listener)
    const spawn = await watching(
      () => {},
      () => run("echo done", { signal: abort.signal }),
    ).finally(() => GlobalBus.off("event", listener))

    expect(spawn.type).toBe("inline")
    expect(await Debt.has(spawn.job.id)).toBe(true)
    await Debt.remove(spawn.job.id)
  })

  test("an Esc there while a Stop holds the session leaves no job debt behind", async () => {
    const { GlobalBus } = await import("../../src/bus/global")
    const { Recovery } = await import("../../src/session/recovery")
    const abort = new AbortController()
    const listener = (event: { payload: { type: string; properties: { job?: BackgroundJob.Info } } }) => {
      if (event.payload.properties.job?.status === "exited") abort.abort()
    }
    GlobalBus.on("event", listener)
    Recovery.hold(["ses_spawn_test"])
    const spawn = await run("echo done", { signal: abort.signal }).finally(() => {
      GlobalBus.off("event", listener)
      Recovery.release(["ses_spawn_test"])
    })

    expect(spawn.type).toBe("inline")
    expect(abort.signal.aborted).toBe(true)
    expect(await Debt.has(spawn.job.id)).toBe(false)
  })
})
