import { createEffect, createMemo, onCleanup, Show, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { QuestionProvider } from "@/context/question"

import { DataProvider } from "@opencode-ai/ui/context"
import { iife } from "@opencode-ai/util/iife"
import type { QuestionAnswer } from "@opencode-ai/sdk/v2"
import { decode64 } from "@/utils/base64"
import { Snapshot } from "@/utils/snapshot"
import { Visibility } from "@/utils/visibility"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const directory = createMemo(() => {
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    if (!params.dir) return
    if (directory()) return
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: "Invalid directory in URL.",
    })
    navigate("/")
  })
  return (
    <Show when={directory()}>
      <SDKProvider directory={directory()}>
        <SyncProvider>
          {iife(() => {
            const sync = useSync()
            const sdk = useSDK()
            const location = useLocation()

            // Paint from cache, then reconcile. As early as the URL
            // carries a session id, hydrate the on-device snapshot into the store
            // so the transcript paints before any fetch, then run sync: with the
            // store seeded it takes the deltaMessages branch and fetches only the
            // gap since the snapshot. A missing/stale snapshot no-ops the hydrate
            // and sync falls back to the normal tail fetch. The snapshot read is
            // async, so fire the tail fetch immediately too — whichever wins, the
            // store guards make the other a cheap no-op.
            createEffect(() => {
              const id = location.pathname.match(/\/session\/([^/?#]+)/)?.[1]
              if (!id) return
              Snapshot.read(directory(), id).then((snapshot) => {
                if (snapshot) sync.session.hydrate(snapshot)
                sync.session.sync(id, snapshot !== undefined)
              })
            })

            // Persist the open transcript's tail when the tab hides, so the next
            // cold open (every iOS PWA launch is one) has a snapshot to paint. The
            // hidden tab is already off the critical path, so no extra idle gate.
            let disposed = false
            onCleanup(() => (disposed = true))
            const persist = async () => {
              while (!disposed) {
                await Visibility.whenHidden()
                if (disposed) return
                const id = location.pathname.match(/\/session\/([^/?#]+)/)?.[1]
                if (id) {
                  const session = sync.session.get(id)
                  const messages = sync.data.message[id]
                  if (session && messages?.length)
                    await Snapshot.write(Snapshot.build(directory(), session, messages, sync.data.part))
                }
                // Park until the tab is visible again so the loop re-arms on the
                // NEXT hide instead of spinning while the tab stays hidden.
                await Visibility.whenVisible()
              }
            }
            void persist()
            const respond = (input: {
              sessionID: string
              permissionID: string
              response: "once" | "always" | "reject"
            }) => sdk.client.permission.respond(input)

            const replyToQuestion = (input: { requestID: string; answers: QuestionAnswer[] }) =>
              sdk.client.question.reply(input)

            const rejectQuestion = (input: { requestID: string }) => sdk.client.question.reject(input)

            const navigateToSession = (sessionID: string) => {
              navigate(`/${params.dir}/session/${sessionID}`)
            }

            const fetchMessageDiff = (input: { sessionID: string; messageID: string }) =>
              sdk.client.session.diff(input).then((r) => r.data)

            // Cache-safe revert: prime the cache at the prior assistant via a
            // ping probe before reverting, so the conversation cache survives.
            const revertMessage = async (input: { sessionID: string; messageID: string }) => {
              const msgs = sync.data.message[input.sessionID] ?? []
              const prevAssistant = msgs.findLast((m) => m.id < input.messageID && m.role === "assistant")
              await sdk.client.session.unrevert({ sessionID: input.sessionID })
              if (prevAssistant) {
                await sdk.client.session.ping({ sessionID: input.sessionID, cacheProbeMessageID: prevAssistant.id })
              }
              await sdk.client.session.revert({ sessionID: input.sessionID, messageID: input.messageID })
            }

            return (
              <DataProvider
                data={sync.data}
                directory={directory()}
                onPermissionRespond={respond}
                onQuestionReply={replyToQuestion}
                onQuestionReject={rejectQuestion}
                onNavigateToSession={navigateToSession}
                onRevertMessage={revertMessage}
                onFetchMessageDiff={fetchMessageDiff}
              >
                <LocalProvider>
                  <QuestionProvider>{props.children}</QuestionProvider>
                </LocalProvider>
              </DataProvider>
            )
          })}
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
