import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./websearch-anthropic.txt"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.websearch" })

export const WebSearchAnthropicTool = Tool.define("websearch", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      query: z.string().min(2).describe("The search query to use"),
      allowed_domains: z.array(z.string()).optional().describe("Only include search results from these domains"),
      blocked_domains: z.array(z.string()).optional().describe("Never include search results from these domains"),
    }),
    async execute(params, ctx) {
      if (params.allowed_domains?.length && params.blocked_domains?.length) {
        throw new Error("Cannot specify both allowed_domains and blocked_domains in the same request")
      }

      await ctx.ask({
        permission: "websearch",
        patterns: [params.query],
        always: ["*"],
        metadata: { query: params.query },
      })

      const startTime = performance.now()

      // Get a small Anthropic model and its connection options (reuses existing auth)
      const smallModel = (await Provider.getSmallModel("anthropic")) ?? (await Provider.getSmallModel("opencode"))
      if (!smallModel) throw new Error("No small model available for web search")

      const sdkOpts = await Provider.getSDKOptions(smallModel)
      if (!sdkOpts.apiKey) throw new Error("No API key available for web search")

      // Build the server tool schema
      const serverTool: Record<string, unknown> = {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 8,
      }
      if (params.allowed_domains?.length) serverTool.allowed_domains = params.allowed_domains
      if (params.blocked_domains?.length) serverTool.blocked_domains = params.blocked_domains

      // Make a direct API call using the provider's auth
      const betaHeaders = [
        ...(sdkOpts.headers["anthropic-beta"]?.split(",").filter(Boolean) ?? []),
        "web-search-2025-03-05",
      ]

      // Use the provider's custom fetch (any auth-plugin wrapper and provider-specific logic)
      const providerFetch = sdkOpts.fetch
      const baseURL = sdkOpts.baseURL || "https://api.anthropic.com"
      const response = await providerFetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          ...sdkOpts.headers,
          "Content-Type": "application/json",
          "x-api-key": sdkOpts.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": [...new Set(betaHeaders)].join(","),
        },
        body: JSON.stringify({
          model: smallModel.api.id,
          max_tokens: 4096,
          system:
            "You are an assistant for performing a web search tool use. Use the web_search tool to answer the query.",
          tools: [serverTool],
          tool_choice: { type: "tool", name: "web_search" },
          messages: [
            {
              role: "user",
              content: `Perform a web search for the query: ${params.query}`,
            },
          ],
        }),
        signal: ctx.abort,
      })

      if (!response.ok) {
        const errorText = await response.text()
        log.error("websearch API error", { status: response.status, error: errorText.slice(0, 500) })
        throw new Error(`Web search API error (${response.status}): ${errorText.slice(0, 200)}`)
      }

      const data = (await response.json()) as {
        content: Array<{
          type: string
          tool_use_id?: string
          content?: Array<{ type: string; url: string; title: string }> | { type: string; error_code: string }
          text?: string
        }>
      }

      // Extract search results from the response content blocks
      const searchResults: Array<{ title: string; url: string }> = []
      const textParts: string[] = []

      for (const block of data.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const item of block.content) {
            if (item.type === "web_search_result" && item.url && item.title) {
              searchResults.push({ title: item.title, url: item.url })
            }
          }
        } else if (block.type === "text" && block.text) {
          textParts.push(block.text)
        }
      }

      const durationSeconds = ((performance.now() - startTime) / 1000).toFixed(1)

      // Format output (inspired by Claude Code's web search output)
      let output = `Web search results for query: "${params.query}"\n\n`

      if (textParts.length > 0) {
        output += textParts.join("\n") + "\n\n"
      }

      if (searchResults.length > 0) {
        output += `Links: ${JSON.stringify(searchResults)}\n\n`
      } else {
        output += "No links found.\n\n"
      }

      output += `\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.`

      log.info("web search completed", {
        query: params.query,
        resultCount: searchResults.length,
        durationSeconds,
      })

      return {
        output,
        title: `Web search: ${params.query} (${searchResults.length} results, ${durationSeconds}s)`,
        metadata: {},
      }
    },
  }
})
