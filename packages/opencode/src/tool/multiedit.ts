import z from "zod"
import { Tool } from "./tool"
import { change } from "./edit"
import DESCRIPTION from "./multiedit.txt"

export const MultiEditTool = Tool.define("multiedit", {
  description: DESCRIPTION,
  parameters: z
    .object({
      filePath: z.string().describe("The absolute path to the file to modify"),
      edits: z
        .array(
          z
            .object({
              oldString: z.string().describe("The text to replace"),
              newString: z.string().describe("The text to replace it with (must be different from oldString)"),
              replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
            })
            .strict(),
        )
        .min(1)
        .describe("Edits applied in order, each to the result of the ones before it. All apply or none do."),
    })
    .strict(),
  async execute(params, ctx) {
    return change(params.filePath, params.edits, ctx)
  },
})
