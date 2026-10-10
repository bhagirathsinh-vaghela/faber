import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

test("an IPv6 wildcard bind is reached through loopback", async () => {
  const server = Server.listen({ hostname: "::", port: 0 })
  const url = Server.listening()
  await server.stop(true)
  expect(url).toBe(`http://127.0.0.1:${server.port}`)
})
