import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./websearch-anthropic.txt"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.websearch" })

export const WebSearchAnthropicTool = Tool.define("websearch", async () => {
  return {
    // The description is a tool definition, and tools[] is hashed ahead of the
    // system prompt and every marker, so a date spliced in here invalidates the
    // whole prefix for every session on the machine when it turns over. The
    // current date reaches the model through the session-context block instead,
    // which sits past the last 1h marker.
    description: DESCRIPTION,
    parameters: z
      .object({
        query: z.string().min(2).describe("The search query to use"),
        allowed_domains: z.array(z.string()).optional().describe("Only include search results from these domains"),
        blocked_domains: z.array(z.string()).optional().describe("Never include search results from these domains"),
      })
      .strict(),
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

      // Make a streaming API call using the provider's auth
      const betaHeaders = [
        ...(sdkOpts.headers["anthropic-beta"]?.split(",").filter(Boolean) ?? []),
        "web-search-2025-03-05",
      ]

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
          stream: true,
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

      // Parse SSE stream for progress updates
      const searchResults: Array<{ title: string; url: string }> = []
      const textParts: string[] = []
      let searchCount = 0

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let boundary: number
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue
            const json = line.slice(6).trim()
            if (json === "[DONE]") continue

            try {
              const event = JSON.parse(json) as {
                type: string
                content_block?: {
                  type: string
                  content?: Array<{ type: string; url: string; title: string }>
                  text?: string
                }
                delta?: { type: string; text?: string }
              }

              // Track web_search_tool_result blocks for progress
              if (event.type === "content_block_start" && event.content_block?.type === "web_search_tool_result") {
                searchCount++
                if (Array.isArray(event.content_block.content)) {
                  for (const item of event.content_block.content) {
                    if (item.type === "web_search_result" && item.url && item.title) {
                      searchResults.push({ title: item.title, url: item.url })
                    }
                  }
                }
                ctx.metadata({
                  title: `Searching... (${searchCount} queries, ${searchResults.length} results)`,
                  metadata: { searchCount, resultCount: searchResults.length },
                })
              }

              // Collect text deltas
              if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                textParts.push(event.delta.text)
              }
            } catch {
              // Skip malformed SSE events
            }
          }
        }
      }

      const durationSeconds = Number(((performance.now() - startTime) / 1000).toFixed(1))

      // Format output (inspired by Claude Code's web search output)
      let output = `Web search results for query: "${params.query}"\n\n`

      const text = textParts.join("")
      if (text.length > 0) {
        output += text + "\n\n"
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
        metadata: {
          query: params.query,
          results: searchResults,
          durationSeconds,
        },
      }
    },
  }
})
