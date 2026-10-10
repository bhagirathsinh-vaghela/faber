import type {
  Message,
  Session,
  Part,
  FileDiff,
  SessionStatus,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createMemo } from "solid-js"
import { type FileDiffPreload } from "../pierre"
import type { BusyFacts } from "../util/busy-tint"
import { reply } from "../util/question"

type Data = {
  session: Session[]
  // Retry DETAIL only (label/countdown). The busy boolean lives in session_busy.
  session_status: {
    [sessionID: string]: SessionStatus
  }
  // The one operative busy state; every busy indicator reads this.
  session_busy: {
    [sessionID: string]: BusyFacts
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: FileDiffPreload<any>[]
  }
  permission?: {
    [sessionID: string]: PermissionRequest[]
  }
  question?: {
    [sessionID: string]: QuestionRequest[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
}) => void

export type NavigateToSessionFn = (sessionID: string) => void

export type RevertMessageFn = (input: { sessionID: string; messageID: string }) => void

export type FetchMessageDiffFn = (input: { sessionID: string; messageID: string }) => Promise<FileDiff[] | undefined>

// Reads a block of assistant prose aloud. Supplied by the host rather than
// implemented here, since the speech engine and its HUD live in the app.
// `key` is the text part's id: a reading's place and audio belong to the part,
// since two parts can say the same thing.
export type SpeakTextFn = (key: string, text: string) => void

export type SpeakTarget = { key: string; text: string }

// Whether a given part is the one currently being read, so its button can stay
// visible while the reading runs rather than fading out from under it.
export type SpeakingFn = (key: string) => boolean

export const {
  use: useData,
  useOptional: useDataOptional,
  provider: DataProvider,
} = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onPermissionRespond?: PermissionRespondFn
    onNavigateToSession?: NavigateToSessionFn
    onRevertMessage?: RevertMessageFn
    onFetchMessageDiff?: FetchMessageDiffFn
    onSpeakText?: SpeakTextFn
    onSpeaking?: SpeakingFn
  }) => {
    const numbers = createMemo(() => {
      const result: Record<string, Map<string, number>> = {}
      for (const sessionID in props.data.message) {
        const map = new Map<string, number>()
        let n = 0
        for (const message of props.data.message[sessionID]) {
          // One number per message. Every text/tool/thinking part of an assistant
          // message shares that message's number, so the thinking that led into a
          // step, its text, and the tool it called read as one block, not several.
          // Thinking alone does not earn a number: a step with nothing else has
          // no block to belong to.
          // A question's answer is drawn inside the card that asked, so it takes none.
          const parts = props.data.part[message.id] ?? []
          if (message.role === "user" && reply(parts)) continue
          const numbered = message.role === "user" || parts.some((p) => p.type === "text" || p.type === "tool")
          if (!numbered) continue
          const num = ++n
          map.set(message.id, num)
          for (const part of parts) {
            if (part.type === "text" || part.type === "tool" || part.type === "reasoning") map.set(part.id, num)
          }
        }
        result[sessionID] = map
      }
      return result
    })
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      blockNumber(sessionID: string, id: string) {
        return numbers()[sessionID]?.get(id)
      },
      respondToPermission: props.onPermissionRespond,
      navigateToSession: props.onNavigateToSession,
      revertMessage: props.onRevertMessage,
      fetchMessageDiff: props.onFetchMessageDiff,
      speakText: props.onSpeakText,
      speaking: props.onSpeaking,
    }
  },
})
