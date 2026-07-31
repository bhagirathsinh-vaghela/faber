import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { LSPServer } from "./server"
import z from "zod"
import { Config } from "../config/config"
import { spawn } from "child_process"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object({})),
  }

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
    if (Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
      // If experimental flag is enabled, disable pyright
      if (servers["pyright"]) {
        log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
        delete servers["pyright"]
      }
    } else {
      // If experimental flag is disabled, disable ty
      if (servers["ty"]) {
        delete servers["ty"]
      }
    }
  }

  // Language servers outlive the instance that first reached for them. A cold
  // server costs whatever its workspace load costs (gopls re-derives metadata
  // for every module in a go.work on each new LSP session, tens of seconds on a
  // large one), and that price is paid by the SERVER, where no timeout here can
  // bound it. Tying the pool to Instance.state charged it again every time a
  // directory went idle long enough to be disposed, so these live at module
  // scope instead, outside any instance context, and are torn down only by the
  // two events that mean the workspace is really finished with: the project
  // closing, and the process exiting. This mirrors an editor holding one
  // connection open for as long as the workspace is open.
  //
  // Config is read at spawn and never re-read for a live client, so an edited
  // lsp block needs the project closed and reopened, or the server restarted.
  const pool = new Map<string, { client: LSPClient.Info; projectID: string }>()
  const spawning = new Map<string, Promise<LSPClient.Info | undefined>>()

  const state = Instance.state(async () => {
    const servers: Record<string, LSPServer.Info> = {}
    const cfg = await Config.get()

    // Instance-scoped, unlike the pool: a spawn failure is usually transient (a
    // half-installed binary, a missing toolchain that appears later), so it must
    // expire rather than disable the server for the life of the process.
    const broken = new Set<string>()

    if (cfg.lsp === false) {
      log.info("all LSPs are disabled")
      return { servers, broken }
    }

    for (const server of Object.values(LSPServer)) {
      servers[server.id] = server
    }

    filterExperimentalServers(servers)

    for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
      const existing = servers[name]
      if (item.disabled) {
        log.info(`LSP server ${name} is disabled`)
        delete servers[name]
        continue
      }
      servers[name] = {
        ...existing,
        id: name,
        root: existing?.root ?? (async () => Instance.directory),
        extensions: item.extensions ?? existing?.extensions ?? [],
        spawn: async (root) => {
          return {
            process: spawn(item.command[0], item.command.slice(1), {
              cwd: root,
              env: {
                ...process.env,
                ...item.env,
              },
            }),
            initialization: item.initialization,
          }
        },
      }
    }

    log.info("enabled LSP servers", {
      serverIds: Object.values(servers)
        .map((server) => server.id)
        .join(", "),
    })

    return { servers, broken }
  })

  export async function init() {
    return state()
  }

  async function drop(keys: string[]) {
    if (!keys.length) return
    await Promise.all(
      keys.map(async (key) => {
        const entry = pool.get(key)
        if (!entry) return
        pool.delete(key)
        await entry.client.shutdown().catch((err: unknown) => {
          log.error("failed to shut down lsp client", { key, error: err })
        })
      }),
    )
    Bus.publish(Event.Updated, {})
  }

  // A closed project is finished with its language servers. Sessions in it are
  // already gone by the time this runs (project close unlinks the view, and any
  // live session keeps its own instance alive independently), so nothing is
  // mid-request on these clients.
  export async function shutdownProject(projectID: string) {
    await drop([...pool].filter(([, entry]) => entry.projectID === projectID).map(([key]) => key))
  }

  // Process-exit backstop. Nothing else reaches these clients once the pool
  // stopped riding on Instance.state, so a root that never sees an explicit
  // project close would otherwise leak its server for the life of the process.
  export async function shutdownAll() {
    await drop([...pool.keys()])
  }

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  export async function status() {
    return state().then((x) => {
      const projectID = Instance.project.id
      const statuses: Status[] = []
      for (const entry of pool.values()) {
        if (entry.projectID !== projectID) continue
        const server = x.servers[entry.client.serverID]
        if (!server) continue
        statuses.push({
          id: entry.client.serverID,
          name: server.id,
          root: path.relative(Instance.directory, entry.client.root),
          status: "connected",
        })
      }
      return statuses
    })
  }

  async function getClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    const matched: LSPClient.Info[] = []
    const projectID = Instance.project.id

    async function schedule(server: LSPServer.Info, root: string, key: string) {
      const handle = await server
        .spawn(root)
        .then((value) => {
          if (!value) s.broken.add(key)
          return value
        })
        .catch((err) => {
          s.broken.add(key)
          log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
          return undefined
        })

      if (!handle) return undefined
      log.info("spawned lsp server", { serverID: server.id })

      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        s.broken.add(key)
        handle.process.kill()
        log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
        return undefined
      })

      if (!client) {
        handle.process.kill()
        return undefined
      }

      const existing = pool.get(key)
      if (existing) {
        handle.process.kill()
        return existing.client
      }

      pool.set(key, { client, projectID })
      return client
    }

    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue

      const root = await server.root(file)
      if (!root) continue
      const key = root + server.id
      if (s.broken.has(key)) continue

      const match = pool.get(key)
      if (match) {
        matched.push(match.client)
        continue
      }

      const inflight = spawning.get(key)
      if (inflight) {
        const client = await inflight
        if (!client) continue
        matched.push(client)
        continue
      }

      const task = schedule(server, root, key)
      spawning.set(key, task)

      task.finally(() => {
        if (spawning.get(key) === task) {
          spawning.delete(key)
        }
      })

      const client = await task
      if (!client) continue

      matched.push(client)
      Bus.publish(Event.Updated, {})
    }

    return matched
  }

  export async function hasClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(root + server.id)) continue
      return true
    }
    return false
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    log.info("touching file", { file: input })
    const clients = await getClients(input)
    await Promise.all(
      clients.map(async (client) => {
        const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve()
        await client.notify.open({ path: input })
        return wait
      }),
    ).catch((err) => {
      log.error("failed to touch file", { err, file: input })
    })
  }

  export async function diagnostics() {
    const results: Record<string, LSPClient.Diagnostic[]> = {}
    for (const result of await runAll(async (client) => client.diagnostics)) {
      for (const [path, diagnostics] of result.entries()) {
        const arr = results[path] || []
        arr.push(...diagnostics)
        results[path] = arr
      }
    }
    return results
  }

  export async function hover(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) => {
      return client.connection
        .sendRequest("textDocument/hover", {
          textDocument: {
            uri: pathToFileURL(input.file).href,
          },
          position: {
            line: input.line,
            character: input.character,
          },
        })
        .catch(() => null)
    })
  }

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  // The cap is applied AFTER merging every client's results, not per client:
  // capping inside runAll returns up to limit x clients and silently drops
  // whichever server answered last. offset lets a caller page a common name
  // rather than guess whether a truncated list held the match.
  export async function workspaceSymbol(query: string, page?: { limit?: number; offset?: number }) {
    const limit = page?.limit ?? 10
    const offset = page?.offset ?? 0
    return runAll((client) =>
      client.connection
        .sendRequest("workspace/symbol", {
          query,
        })
        .then((symbols: any) => symbols.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
        .catch(() => []),
    ).then((symbols) => (symbols.flat() as LSP.Symbol[]).slice(offset, offset + limit))
  }

  export async function documentSymbol(uri: string) {
    const file = new URL(uri).pathname
    return run(file, (client) =>
      client.connection
        .sendRequest("textDocument/documentSymbol", {
          textDocument: {
            uri,
          },
        })
        .catch(() => []),
    )
      .then((symbols) => symbols.flat() as (LSP.DocumentSymbol | LSP.Symbol)[])
      .then((symbols) => symbols.filter(Boolean))
  }

  // Resolve a symbol name to the position its definition starts at, so a caller
  // can address code the way it reads (`Foo.bar`) instead of by coordinates it
  // could only obtain by reading the file first. A dotted name matches on its
  // last segment: a document symbol carries a method as `bar`, expressing `Foo`
  // as nesting rather than as part of the name.
  export async function symbolPosition(input: { file: string; symbol: string }) {
    const leaf = input.symbol.split(".").pop() || input.symbol
    const flatten = (symbols: any[]): any[] => symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children ?? [])])

    // A DocumentSymbol carries selectionRange, which is the name itself. A flat
    // SymbolInformation carries only location.range, which spans the whole
    // declaration and so starts on a keyword (`async`, `export`) where every
    // position request answers null. Find the name inside that line instead, so
    // both server shapes land on the identifier.
    const onName = async (file: string, range: any) => {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      const line = text.split("\n")[range.start.line]
      const column = line === undefined ? -1 : line.indexOf(leaf, range.start.character)
      return { file, line: range.start.line, character: column === -1 ? range.start.character : column }
    }

    const local = flatten(await documentSymbol(pathToFileURL(input.file).href))
    const match = local.find((symbol: any) => symbol.name === leaf)
    if (match?.selectionRange) {
      return {
        file: input.file,
        line: match.selectionRange.start.line,
        character: match.selectionRange.start.character,
      }
    }
    if (match?.location?.range) return onName(input.file, match.location.range)

    // Absent from this file, so ask the workspace index: naming a symbol without
    // knowing which file holds it is the case this exists for.
    const found = (await workspaceSymbol(leaf)).find((symbol) => symbol.name === leaf)
    if (!found) return undefined
    return onName(fileURLToPath(found.location.uri), found.location.range)
  }

  export async function definition(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/definition", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function references(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/references", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          context: { includeDeclaration: true },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function implementation(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/implementation", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function incomingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  // Scoped to the calling project: the pool spans every open project, and a
  // workspace-wide query must not reach into a sibling project's servers.
  async function runAll<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const projectID = Instance.project.id
    const tasks = [...pool.values()].filter((x) => x.projectID === projectID).map((x) => input(x.client))
    return Promise.all(tasks)
  }

  async function run<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await getClients(file)
    const tasks = clients.map((x) => input(x))
    return Promise.all(tasks)
  }

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
