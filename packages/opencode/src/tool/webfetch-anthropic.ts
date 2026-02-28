import z from "zod"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch-anthropic.txt"
import { abortAfterAny } from "../util/abort"
import { Provider } from "../provider/provider"
import { LLM } from "../session/llm"
import { Agent } from "../agent/agent"
import { Log } from "../util/log"
import type { MessageV2 } from "../session/message-v2"

const log = Log.create({ service: "tool.webfetch" })

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10MB
const DEFAULT_TIMEOUT = 60 * 1000 // 60 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const MAX_CONTENT_CHARS = 100_000 // Truncate content before summarization

export const WebFetchAnthropicTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    prompt: z.string().describe("The prompt to run on the fetched content"),
  }),
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      always: ["*"],
      metadata: {
        url: params.url,
        prompt: params.prompt,
      },
    })

    const timeout = DEFAULT_TIMEOUT
    const { signal, clearTimeout } = abortAfterAny(timeout, ctx.abort)

    // Upgrade http to https
    const url = params.url.replace(/^http:\/\//, "https://")

    const headers = {
      Accept: "text/markdown, text/html, */*",
    }

    let response: Response
    try {
      const initial = await fetch(url, {
        signal,
        headers,
        redirect: "manual",
      })

      // Handle redirects
      if ([301, 302, 307, 308].includes(initial.status)) {
        const location = initial.headers.get("location")
        if (!location) throw new Error("Redirect missing Location header")

        const redirectUrl = new URL(location, url).toString()
        const originalHost = new URL(url).hostname.replace(/^www\./, "")
        const redirectHost = new URL(redirectUrl).hostname.replace(/^www\./, "")

        if (originalHost === redirectHost) {
          // Same host — follow redirect
          response = await fetch(redirectUrl, { signal, headers })
        } else {
          // Different host — tell the model to retry
          clearTimeout()
          return {
            output: `REDIRECT DETECTED: The URL redirects to a different host.\n\nOriginal URL: ${params.url}\nRedirect URL: ${redirectUrl}\nStatus: ${initial.status} ${initial.statusText}\n\nTo complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:\n- url: "${redirectUrl}"\n- prompt: "${params.prompt}"`,
            title: `${params.url} (redirect to ${redirectHost})`,
            metadata: {},
          }
        }
      } else {
        response = initial
      }
    } finally {
      clearTimeout()
    }

    if (!response.ok) {
      throw new Error(`Request failed with status code: ${response.status}`)
    }

    // Check content length
    const contentLength = response.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }

    const rawContent = new TextDecoder().decode(arrayBuffer)
    const contentType = response.headers.get("content-type") || ""

    // Convert HTML to markdown
    let content: string
    if (contentType.includes("text/html")) {
      content = convertHTMLToMarkdown(rawContent)
    } else {
      content = rawContent
    }

    // Truncate before summarization
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS) + "\n\n[Content truncated due to length...]"
    }

    // Summarize with small model (inspired by Claude Code's approach)
    const title = `${params.url} (${contentType})`
    try {
      const result = await summarizeWithModel(content, params.prompt, ctx.sessionID, ctx.abort)
      return {
        output: result,
        title,
        metadata: {},
      }
    } catch (e) {
      // If model summarization fails, return raw content
      log.warn("webfetch summarization failed, returning raw content", { error: e })
      return {
        output: content,
        title,
        metadata: {},
      }
    }
  },
})

async function summarizeWithModel(
  content: string,
  prompt: string,
  sessionID: string,
  abort: AbortSignal,
): Promise<string> {
  const userPrompt = [
    "Web page content:",
    "---",
    content,
    "---",
    "",
    prompt,
    "",
    "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.",
  ].join("\n")

  // Use the title agent's small model (haiku)
  const agent = await Agent.get("title")
  if (!agent) throw new Error("No title agent available for summarization")

  const model = agent.model
    ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
    : await Provider.getSmallModel("anthropic")

  if (!model) throw new Error("No small model available for summarization")

  const { stream } = await LLM.stream({
    agent,
    user: {
      id: "webfetch-summarize",
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
    } as MessageV2.User,
    tools: {},
    model,
    small: true,
    messages: [
      {
        role: "user" as const,
        content: userPrompt,
      },
    ],
    abort,
    sessionID,
    system: { env: [], globalInstructions: [], projectInstructions: [] },
    retries: 1,
  })

  const result = await stream.text
  return result || "No response from model"
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
