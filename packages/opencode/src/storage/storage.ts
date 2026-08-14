import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { $ } from "bun"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
    async (dir) => {
      const TIME_BYTES = 8

      const encode8 = (timestamp: number, counter: number, descending: boolean) => {
        let now = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter)
        if (descending) now = ~now
        const bytes = Buffer.alloc(TIME_BYTES)
        for (let i = 0; i < TIME_BYTES; i++)
          bytes[i] = Number((now >> BigInt((TIME_BYTES - 1 - i) * 8)) & BigInt(0xff))
        return bytes.toString("hex")
      }

      const isOldId = (id: string) => {
        const body = id.split("_").slice(1).join("_")
        return body.length <= 26
      }

      const reencodeId = (id: string, timestamp: number, counter: number) => {
        const prefix = id.split("_")[0]
        const body = id.slice(prefix.length + 1)
        const randomPart = body.slice(12)
        const descending = prefix === "ses"
        return prefix + "_" + encode8(timestamp, counter, descending) + randomPart
      }

      const messageDir = path.join(dir, "message")
      const partDir = path.join(dir, "part")
      const sessionDirs = await fs.readdir(messageDir).catch(() => [] as string[])

      for (const sessionId of sessionDirs) {
        const msgDir = path.join(messageDir, sessionId)
        const msgFiles = await fs.readdir(msgDir).catch(() => [] as string[])
        const oldMsgFiles = msgFiles.filter((f) => f.endsWith(".json") && isOldId(f.slice(0, -5)))
        if (oldMsgFiles.length === 0) continue

        log.info("re-encoding old IDs", { session: sessionId, count: oldMsgFiles.length })

        const entries = [] as { old: string; data: any; created: number }[]
        for (const file of oldMsgFiles) {
          const data = await Bun.file(path.join(msgDir, file)).json().catch(() => undefined)
          if (!data) continue
          entries.push({ old: data.id, data, created: data.time?.created ?? 0 })
        }
        entries.sort((a, b) => a.created - b.created)

        const idMap = new Map<string, string>()
        let lastTs = 0
        let ctr = 0
        for (const entry of entries) {
          const ts = entry.created
          if (ts !== lastTs) {
            lastTs = ts
            ctr = 0
          }
          ctr++
          const newId = reencodeId(entry.old, ts, ctr)
          idMap.set(entry.old, newId)
        }

        for (const entry of entries) {
          const newId = idMap.get(entry.old)!
          const data = entry.data
          data.id = newId
          if (data.parentID && idMap.has(data.parentID)) data.parentID = idMap.get(data.parentID)

          await Bun.write(path.join(msgDir, newId + ".json"), JSON.stringify(data))
          if (newId !== entry.old) await fs.unlink(path.join(msgDir, entry.old + ".json")).catch(() => {})
        }

        for (const [oldMsgId, newMsgId] of idMap) {
          const oldPartDir = path.join(partDir, oldMsgId)
          const exists = await Filesystem.isDir(oldPartDir)
          if (!exists) continue

          const partFiles = await fs.readdir(oldPartDir).catch(() => [] as string[])
          const newPartDir = path.join(partDir, newMsgId)
          if (oldMsgId !== newMsgId) await fs.mkdir(newPartDir, { recursive: true })

          for (const pf of partFiles) {
            if (!pf.endsWith(".json")) continue
            const partData = await Bun.file(path.join(oldPartDir, pf)).json().catch(() => undefined)
            if (!partData) continue

            if (partData.messageID && idMap.has(partData.messageID))
              partData.messageID = idMap.get(partData.messageID)

            await Bun.write(path.join(newPartDir, pf), JSON.stringify(partData))
          }

          if (oldMsgId !== newMsgId) await fs.rm(oldPartDir, { recursive: true }).catch(() => {})
        }
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    await sweepOrphans(dir)
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Bun.file(target).json()
      fn(content)
      await atomic(target, JSON.stringify(content, null, 2))
      return content as T
    })
  }

  // Indented by default: these files are read by hand while debugging. `compact`
  // is for the few keys rewritten wholesale on a timer, where the indentation is
  // pure write amplification and no one reads the file directly.
  export async function write<T>(key: string[], content: T, options?: { compact?: boolean }) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await atomic(target, JSON.stringify(content, null, options?.compact ? undefined : 2))
    })
  }

  // A crash mid-write must never tear a previously-intact file. Write to a temp
  // sibling then rename: rename is atomic within a filesystem, so a reader sees
  // either the old file or the fully-written new one, never a truncated blend.
  // The temp lives beside the target so the rename stays same-filesystem.
  async function atomic(target: string, content: string) {
    const tmp = target + "." + Bun.randomUUIDv7() + ".tmp"
    await Bun.write(tmp, content)
    await fs.rename(tmp, target).catch(async (e) => {
      await fs.unlink(tmp).catch(() => {})
      throw e
    })
  }

  // A .tmp file only exists for the microseconds between write and rename in
  // atomic() — unless a process is killed mid-rename, which orphans it. Orphans
  // are inert (list globs *.json, read opens an exact path), just clutter. Sweep
  // them once at boot. The age guard is a hard safety floor: only reap a .tmp
  // that has sat untouched for 15 days, far longer than any write, so a sweep
  // can never race and delete a temp an active turn is renaming. A real orphan
  // is permanent clutter, so there is no urgency to reap it sooner.
  const ORPHAN_MIN_AGE_MS = 15 * 24 * 60 * 60 * 1000
  export async function sweepOrphans(dir: string) {
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS
    const tmpGlob = new Bun.Glob("**/*.tmp")
    for await (const entry of tmpGlob.scan({ cwd: dir, onlyFiles: true })) {
      const file = path.join(dir, entry)
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat || stat.mtimeMs >= cutoff) continue
      await fs.unlink(file).catch(() => {})
    }
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  const glob = new Bun.Glob("**/*.json")
  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
