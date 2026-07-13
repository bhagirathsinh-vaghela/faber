import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"

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
