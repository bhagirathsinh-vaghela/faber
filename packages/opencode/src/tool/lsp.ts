import z from "zod"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { pathToFileURL } from "url"
import { assertExternalDirectory } from "./external-directory"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const LspTool = Tool.define("lsp", {
  description: DESCRIPTION,
  parameters: z
    .object({
      operation: z.enum(operations).describe("The LSP operation to perform"),
      filePath: z
        .string()
        .optional()
        .describe(
          "The absolute or relative path to the file. Optional for workspaceSymbol, where it starts that file's language servers first.",
        ),
      symbol: z
        .string()
        .optional()
        .describe(
          "Name of the symbol to target, e.g. 'getClients' or 'LSP.getClients'. Use instead of line/character when the position is unknown.",
        ),
      query: z.string().optional().describe("Search string for workspaceSymbol."),
      line: z.number().int().min(1).optional().describe("The line number (1-based, as shown in editors)"),
      character: z.number().int().min(1).optional().describe("The character offset (1-based, as shown in editors)"),
      limit: z.number().int().min(1).optional().describe("Max results for workspaceSymbol (default 10)"),
      offset: z.number().int().min(0).optional().describe("Result offset for workspaceSymbol, to page past a cap"),
    })
    .strict(),
  execute: async (args, ctx) => {
    await ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    if (args.operation === "workspaceSymbol") {
      if (!args.query) throw new Error("workspaceSymbol requires `query`.")
      if (args.filePath) {
        const file = Filesystem.resolve(Instance.directory, args.filePath)
        await assertExternalDirectory(ctx, file)
        await LSP.touchFile(file)
      }
      const symbols = await LSP.workspaceSymbol(args.query, { limit: args.limit, offset: args.offset })
      return {
        title: `workspaceSymbol ${args.query}`,
        metadata: { result: symbols },
        output: symbols.length === 0 ? `No symbols matching ${args.query}` : JSON.stringify(symbols, null, 2),
      }
    }

    if (!args.filePath) throw new Error(`${args.operation} requires \`filePath\`.`)
    const file = Filesystem.resolve(Instance.directory, args.filePath)
    await assertExternalDirectory(ctx, file)

    const exists = await Bun.file(file).exists()
    if (!exists) {
      throw new Error(`File not found: ${file}`)
    }

    const available = await LSP.hasClients(file)
    if (!available) {
      throw new Error("No LSP server available for this file type.")
    }

    await LSP.touchFile(file, true)

    if (args.operation === "documentSymbol") {
      const symbols = await LSP.documentSymbol(pathToFileURL(file).href)
      return {
        title: `documentSymbol ${file}`,
        metadata: { result: symbols },
        output: symbols.length === 0 ? "No symbols found" : JSON.stringify(symbols, null, 2),
      }
    }

    // A named symbol is resolved to a position here, so every positional
    // operation below can be addressed either way. Resolution may land in a
    // different file than the one asked about (the symbol was found through the
    // workspace index), and a position request only answers for a file the
    // server has been told about, so open that one too.
    const position = await (async () => {
      if (args.symbol) {
        const found = await LSP.symbolPosition({ file, symbol: args.symbol })
        if (!found) throw new Error(`Symbol not found: ${args.symbol}`)
        if (found.file !== file) await LSP.touchFile(found.file, true)
        return found
      }
      if (args.line === undefined || args.character === undefined) {
        throw new Error(`${args.operation} requires either \`symbol\`, or both \`line\` and \`character\`.`)
      }
      return { file, line: args.line - 1, character: args.character - 1 }
    })()

    const result: unknown[] = await (async () => {
      switch (args.operation) {
        case "goToDefinition":
          return LSP.definition(position)
        case "findReferences":
          return LSP.references(position)
        case "hover":
          return LSP.hover(position)
        case "goToImplementation":
          return LSP.implementation(position)
        case "prepareCallHierarchy":
          return LSP.prepareCallHierarchy(position)
        case "incomingCalls":
          return LSP.incomingCalls(position)
        case "outgoingCalls":
          return LSP.outgoingCalls(position)
        default:
          throw new Error(`Unhandled operation: ${args.operation}`)
      }
    })()

    const target = args.symbol ?? `${position.line + 1}:${position.character + 1}`
    const output = (() => {
      if (result.length === 0) return `No results found for ${args.operation}`
      return JSON.stringify(result, null, 2)
    })()

    return {
      title: `${args.operation} ${position.file} ${target}`,
      metadata: { result },
      output,
    }
  },
})
