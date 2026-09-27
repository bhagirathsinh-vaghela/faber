import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.started event", () => {
  test("should emit session.started event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: Session.Info | undefined

        const unsub = Bus.subscribe(Session.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as Session.Info
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(session.id)
        expect(receivedInfo?.projectID).toBe(session.projectID)
        expect(receivedInfo?.directory).toBe(session.directory)
        expect(receivedInfo?.title).toBe(session.title)

        await Session.remove(session.id)
      },
    })
  })

  test("session.started event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubStarted = Bus.subscribe(Session.Event.Created, () => {
          events.push("started")
        })

        const unsubUpdated = Bus.subscribe(Session.Event.Updated, () => {
          events.push("updated")
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsubStarted()
        unsubUpdated()

        expect(events).toContain("started")
        expect(events).toContain("updated")
        expect(events.indexOf("started")).toBeLessThan(events.indexOf("updated"))

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.remove", () => {
  test("drops the session, its messages, and its parts together", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-x" },
        } as MessageV2.User)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })

        await Session.remove(session.id)

        const { Parts } = await import("../../src/storage/parts")
        const { Messages } = await import("../../src/storage/messages")
        const { Sessions } = await import("../../src/storage/sessions")
        expect((await Parts.list(messageID)).parts).toEqual([])
        expect(await Messages.read(messageID).catch(() => undefined)).toBeUndefined()
        expect(await Sessions.read(session.id).catch(() => undefined)).toBeUndefined()
      },
    })
  })
})

describe("archive and unarchive", () => {
  test("archiving evicts the recent entry and unarchiving restores it at its last-activity slot", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { SessionRecent } = await import("../../src/session/recent")
        const session = await Session.create({})
        const activity = Date.now() - 60_000
        await Session.update(session.id, (draft) => {
          draft.lastActivity = activity
        })
        await SessionRecent.touch({
          sessionID: session.id,
          directory: session.directory,
          title: session.title,
          updated: activity,
        })
        const entry = async () => (await SessionRecent.list()).find((row) => row.sessionID === session.id)

        await Session.update(session.id, (draft) => {
          draft.time.archived = Date.now()
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(await entry()).toBeUndefined()

        await Session.markUnseen(session.id)
        await Session.update(session.id, (draft) => {
          delete draft.time.archived
        })
        const restored = await entry()
        expect(restored?.updated).toBe(activity)
        expect(restored?.unseen).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("PATCH archived:null unarchives, a number archives, and an omitted field leaves it", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const patch = (body: object) =>
          Server.App().request(`/session/${session.id}?directory=${encodeURIComponent(projectRoot)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })

        expect((await patch({ time: { archived: 5_000 } })).status).toBe(200)
        expect((await Session.get(session.id)).time.archived).toBe(5_000)
        expect((await patch({ title: "kept archived" })).status).toBe(200)
        expect((await Session.get(session.id)).time.archived).toBe(5_000)
        expect((await patch({ time: { archived: null } })).status).toBe(200)
        expect((await Session.get(session.id)).time.archived).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })

  test("unarchive restores a root only, and a never-archived session is left out", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { SessionRecent } = await import("../../src/session/recent")
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        const plain = await Session.create({})
        const listed = async () =>
          (await SessionRecent.list()).map((row) => row.sessionID).filter((id) => [child.id, plain.id].includes(id))

        await Session.update(child.id, (draft) => {
          draft.time.archived = 1_000
        })
        await Session.update(child.id, (draft) => {
          delete draft.time.archived
        })
        await Session.update(plain.id, (draft) => {
          delete draft.time.archived
        })
        expect(await listed()).toEqual([])

        for (const s of [child, parent, plain]) await Session.remove(s.id)
      },
    })
  })

  test("a message written to an archived session does not put it back in the overview", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { SessionRecent } = await import("../../src/session/recent")
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.time.archived = Date.now()
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-x" },
        } as MessageV2.User)
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect((await SessionRecent.list()).some((row) => row.sessionID === session.id)).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("GET /session/:id/live reports a running turn even after the session is archived", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { SessionBusy } = await import("../../src/session/busy")
        const session = await Session.create({})
        const live = async () =>
          (
            await Server.App().request(`/session/${session.id}/live?directory=${encodeURIComponent(projectRoot)}`)
          ).json()

        const other = path.join(projectRoot, "src")
        const elsewhere = async () =>
          (await Server.App().request(`/session/${session.id}/live?directory=${encodeURIComponent(other)}`)).json()

        expect(await live()).toEqual({ live: false, busy: false, pinging: false, job: false })
        SessionBusy.enter(session.id)
        await Session.update(session.id, (draft) => {
          draft.time.archived = Date.now()
        })
        expect(await live()).toEqual({ live: true, busy: true, pinging: false, job: false })
        expect(await elsewhere()).toEqual({ live: true, busy: true, pinging: false, job: false })
        SessionBusy.exit(session.id)
        expect(await live()).toEqual({ live: false, busy: false, pinging: false, job: false })

        const missing = await Server.App().request(
          `/session/ses_nope/live?directory=${encodeURIComponent(projectRoot)}`,
        )
        expect(missing.status).toBe(404)

        await Session.remove(session.id)
      },
    })
  }, 20_000)

  test("unarchive restores the busy flags a turn set while archived and marks the event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { SessionRecent } = await import("../../src/session/recent")
        const { SessionBusy } = await import("../../src/session/busy")
        const session = await Session.create({})
        const events: string[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (event) => {
          if (event.properties.info.id !== session.id) return
          events.push(event.properties.archived ? "archived" : event.properties.unarchived ? "unarchived" : "other")
        })
        await Session.update(session.id, (draft) => {
          draft.time.archived = Date.now()
        })
        await Session.update(session.id, (draft) => {
          draft.title = "renamed while archived"
        })
        SessionBusy.enter(session.id)

        await Session.update(session.id, (draft) => {
          delete draft.time.archived
        })
        await Session.update(session.id, (draft) => {
          draft.title = "renamed after unarchive"
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        unsub()

        const entry = (await SessionRecent.list()).find((row) => row.sessionID === session.id)
        expect(entry?.busy).toBe(true)
        expect(entry?.busySelf).toBe(true)
        expect(events).toEqual(["archived", "other", "unarchived", "other"])

        SessionBusy.exit(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("restore skips the insert when the session was archived again before it landed", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { SessionRecent } = await import("../../src/session/recent")
        const session = await Session.create({})
        const input = {
          sessionID: session.id,
          directory: session.directory,
          title: session.title,
          updated: 1,
          unseen: false,
          flags: () => ({ busy: false, busySelf: false, busyDescendant: false }),
          running: false,
        }
        const listed = async () => (await SessionRecent.list()).some((row) => row.sessionID === session.id)

        await SessionRecent.restore({ ...input, still: () => false })
        expect(await listed()).toBe(false)
        await SessionRecent.restore({ ...input, still: () => true })
        expect(await listed()).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("listArchived returns only archived root sessions, most recently archived first", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Sessions } = await import("../../src/storage/sessions")
        const older = await Session.create({})
        const newer = await Session.create({})
        const child = await Session.create({ parentID: newer.id })
        const plain = await Session.create({})
        await Session.update(older.id, (draft) => {
          draft.time.archived = 1_000
        })
        await Session.update(newer.id, (draft) => {
          draft.time.archived = 2_000
        })
        await Session.update(child.id, (draft) => {
          draft.time.archived = 3_000
        })

        const ids = (await Sessions.listArchived())
          .map((s) => s.id)
          .filter((id) => [older.id, newer.id, child.id, plain.id].includes(id))
        expect(ids).toEqual([newer.id, older.id])

        for (const s of [child, older, newer, plain]) await Session.remove(s.id)
      },
    })
  })
})

describe("session index", () => {
  async function ids() {
    const result: string[] = []
    for await (const session of Session.list()) result.push(session.id)
    return result
  }

  test("list and children reflect create, rename, and remove without stale entries", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })

        expect(await ids()).toEqual(expect.arrayContaining([parent.id, child.id]))

        const children = await Session.children(parent.id)
        expect(children.map((s) => s.id)).toEqual([child.id])
        expect(await Session.children(child.id)).toEqual([])

        await Session.update(parent.id, (draft) => {
          draft.title = "renamed parent"
        })
        const found = (await Array.fromAsync(Session.list())).find((s) => s.id === parent.id)
        expect(found?.title).toBe("renamed parent")

        await Session.remove(child.id)
        expect(await Session.children(parent.id)).toEqual([])
        expect(await ids()).not.toContain(child.id)

        await Session.remove(parent.id)
        expect(await ids()).not.toContain(parent.id)
      },
    })
  })

  test("message cache serves completed turns and drops them on any write", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        async function assistant(completed: boolean) {
          const msg = {
            id: Identifier.ascending("message"),
            role: "assistant" as const,
            sessionID: session.id,
            mode: "default",
            agent: "default",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "gpt-4",
            providerID: "openai",
            parentID: Identifier.ascending("message"),
            time: completed ? { created: Date.now(), completed: Date.now() } : { created: Date.now() },
          }
          await Session.updateMessage(msg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: msg.id,
            sessionID: session.id,
            type: "text",
            text: "first",
          })
          return msg
        }

        const done = await assistant(true)
        const first = await MessageV2.get({ sessionID: session.id, messageID: done.id })
        const second = await MessageV2.get({ sessionID: session.id, messageID: done.id })
        expect(second).toBe(first)
        expect(second.parts.map((p) => (p.type === "text" ? p.text : p.type))).toEqual(["first"])

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: done.id,
          sessionID: session.id,
          type: "text",
          text: "second",
        })
        const afterWrite = await MessageV2.get({ sessionID: session.id, messageID: done.id })
        expect(afterWrite).not.toBe(first)
        expect(afterWrite.parts.map((p) => (p.type === "text" ? p.text : p.type))).toEqual(["first", "second"])

        const streaming = await assistant(false)
        const live = await MessageV2.get({ sessionID: session.id, messageID: streaming.id })
        expect(await MessageV2.get({ sessionID: session.id, messageID: streaming.id })).not.toBe(live)

        await Session.remove(session.id)
      },
    })
  })

  test("list is sorted by id descending-session ordering", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const a = await Session.create({})
        const b = await Session.create({})

        const listed = (await ids()).filter((id) => id === a.id || id === b.id)
        expect(listed).toEqual([...listed].sort((x, y) => (x > y ? 1 : -1)))

        await Session.remove(a.id)
        await Session.remove(b.id)
      },
    })
  })
})
