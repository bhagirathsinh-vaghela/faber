import { describe, expect, test } from "bun:test"
import { BackgroundProcess } from "../../src/background/process"

// Spawn the way a background job is spawned: detached, so the child leads its
// own process group and `pgid === pid`.
function spawnJob(script: string) {
  return Bun.spawn({
    cmd: ["sh", "-c", script],
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
}

// The narrowing every caller performs: `inspect` also reports the command line
// for diagnostics, but only these three fields are identity.
async function identify(pid: number): Promise<BackgroundProcess.Identity> {
  const live = await BackgroundProcess.inspect(pid)
  expect(live).toBeDefined()
  return { pid: live!.pid, start: live!.start, pgid: live!.pgid }
}

describe("BackgroundProcess.inspect", () => {
  test("reports a live process, and a detached child leads its own group", async () => {
    const proc = spawnJob("sleep 5")
    const live = (await BackgroundProcess.inspect(proc.pid))!
    expect(live).toBeDefined()
    expect(live.pid).toBe(proc.pid)
    expect(live.pgid).toBe(proc.pid)
    expect(live.command).toContain("sleep 5")
    expect(live.start).toMatch(/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/)
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("returns undefined for a pid that does not exist", async () => {
    expect(await BackgroundProcess.inspect(999999)).toBeUndefined()
  })
})

describe("BackgroundProcess.verify", () => {
  test("alive when every field still matches", async () => {
    const proc = spawnJob("sleep 5")
    expect(await BackgroundProcess.verify(await identify(proc.pid))).toBe("alive")
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("gone once the process has exited", async () => {
    const proc = spawnJob("sleep 0.3")
    const identity = await identify(proc.pid)
    await proc.exited
    expect(await BackgroundProcess.verify(identity)).toBe("gone")
  })

  // The PID-reuse guard: a live pid whose start time is not the recorded one is
  // a DIFFERENT process that inherited the number.
  test("mismatch when the pid is live but the start time differs", async () => {
    const proc = spawnJob("sleep 5")
    const identity = await identify(proc.pid)
    expect(await BackgroundProcess.verify({ ...identity, start: "Mon Jan  1 00:00:00 2001" })).toBe("mismatch")
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("mismatch when the pid is live but the process group differs", async () => {
    const proc = spawnJob("sleep 5")
    const identity = await identify(proc.pid)
    expect(await BackgroundProcess.verify({ ...identity, pgid: identity.pgid + 1 })).toBe("mismatch")
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  // The command line is NOT identity: it changes under the process as it execs
  // (`sh -c sleep 5` becomes `sleep 5`), so treating it as identity would
  // report a healthy job as a mismatch and refuse to kill it. Identity is
  // therefore whatever survives that rewrite.
  test("identity carries no command line, so an exec cannot invalidate it", async () => {
    const proc = spawnJob("sleep 5")
    const identity = await identify(proc.pid)
    expect(identity).toEqual({ pid: proc.pid, start: identity.start, pgid: proc.pid })
    expect(await BackgroundProcess.verify(identity)).toBe("alive")
    await Bun.sleep(300)
    expect(await BackgroundProcess.verify(identity)).toBe("alive")
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })
})

describe("BackgroundProcess.kill", () => {
  test("kills the job AND the children it spawned", async () => {
    // The shell backgrounds a grandchild, then waits. Killing only the leader
    // would leave the grandchild running.
    const proc = spawnJob("sleep 30 & echo $!; sleep 30")
    // One chunk, not `new Response(...).text()`: that resolves only when the
    // stream CLOSES, which a still-running job never does.
    const chunk = await proc.stdout.getReader().read()
    const child = Number(new TextDecoder().decode(chunk.value).trim().split("\n")[0])
    expect(child).toBeGreaterThan(0)

    expect(await BackgroundProcess.inspect(proc.pid)).toBeDefined()
    expect(await BackgroundProcess.inspect(child)).toBeDefined()

    expect(await BackgroundProcess.kill(await identify(proc.pid))).toBe("alive")

    expect(await BackgroundProcess.inspect(proc.pid)).toBeUndefined()
    expect(await BackgroundProcess.inspect(child)).toBeUndefined()
  }, 15_000)

  // The rule that keeps a sweep from killing a stranger.
  test("refuses to signal when the identity does not match, and leaves it running", async () => {
    const proc = spawnJob("sleep 5")
    const identity = await identify(proc.pid)

    expect(await BackgroundProcess.kill({ ...identity, start: "Mon Jan  1 00:00:00 2001" })).toBe("mismatch")
    expect(await BackgroundProcess.inspect(proc.pid)).toBeDefined()

    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("reports gone for an already-exited job without throwing", async () => {
    const proc = spawnJob("sleep 0.3")
    const identity = await identify(proc.pid)
    await proc.exited
    expect(await BackgroundProcess.kill(identity)).toBe("gone")
  })
})

describe("a zombie", () => {
  // The shell backgrounds a short sleep, prints its pid, then execs into a
  // longer sleep that never reaps it, so the short one sits as a zombie.
  test("reads as gone to inspect, verify and alive", async () => {
    const parent = Bun.spawn(["sh", "-c", "sleep 0.1 & echo $!; exec sleep 3"], { stdout: "pipe" })
    const reader = parent.stdout.getReader()
    const pid = Number(new TextDecoder().decode((await reader.read()).value).trim())
    await Bun.sleep(500)
    const listed = await new Response(Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)]).stdout).text()
    expect(listed.trim().startsWith("Z")).toBe(true)
    expect(await BackgroundProcess.inspect(pid)).toBeUndefined()
    expect(await BackgroundProcess.verify({ pid, start: "Thu Jan  1 00:00:00 1970", pgid: pid })).toBe("gone")
    expect(await BackgroundProcess.alive({ pid })).toBe(false)
    parent.kill()
  })
})
