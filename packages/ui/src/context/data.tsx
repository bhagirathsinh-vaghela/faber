import type {
  Message,
  Session,
  Part,
  FileDiff,
  SessionStatus,
  PermissionRequest,
  QuestionRequest,
  QuestionAnswer,
} from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createMemo } from "solid-js"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

type Data = {
  session: Session[]
  // Retry DETAIL only (label/countdown). The busy boolean lives in session_busy.
  session_status: {
    [sessionID: string]: SessionStatus
  }
  // The one operative busy state: busy = effective (own turn OR any subtask,
  // full subtree, rolled up server-side); busySelf = own turn only. Every busy
  // indicator reads this; busySelf picks own-vs-delegating animation.
  session_busy: {
    [sessionID: string]: { busy: boolean; busySelf: boolean; busyDescendant: boolean }
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
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

export type QuestionReplyFn = (input: { requestID: string; answers: QuestionAnswer[] }) => void

export type QuestionRejectFn = (input: { requestID: string }) => void

export type NavigateToSessionFn = (sessionID: string) => void

export type RevertMessageFn = (input: { sessionID: string; messageID: string }) => void

export type FetchMessageDiffFn = (input: { sessionID: string; messageID: string }) => Promise<FileDiff[] | undefined>

// Reads a block of assistant prose aloud. Supplied by the host rather than
// implemented here, since the speech engine and its HUD live in the app.
export type SpeakTextFn = (text: string) => void

// Whether a given block of text is the one currently being read, so its button
// can stay visible while the reading runs rather than fading out from under it.
export type SpeakingFn = (text: string) => boolean

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onPermissionRespond?: PermissionRespondFn
    onQuestionReply?: QuestionReplyFn
    onQuestionReject?: QuestionRejectFn
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
          // One number per message. Every text/tool part of an assistant
          // message shares that message's number, so a text block and the
          // tool it called in the same step read as one block, not two.
          const parts = props.data.part[message.id] ?? []
          const numbered = message.role === "user" || parts.some((p) => p.type === "text" || p.type === "tool")
          if (!numbered) continue
          const num = ++n
          map.set(message.id, num)
          for (const part of parts) {
            if (part.type === "text" || part.type === "tool") map.set(part.id, num)
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
      replyToQuestion: props.onQuestionReply,
      rejectQuestion: props.onQuestionReject,
      navigateToSession: props.onNavigateToSession,
      revertMessage: props.onRevertMessage,
      fetchMessageDiff: props.onFetchMessageDiff,
      speakText: props.onSpeakText,
      speaking: props.onSpeaking,
    }
  },
})
