import { createEffect, createMemo, onCleanup, Show, untrack, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { LocalProvider } from "@/context/local"
import { QuestionProvider } from "@/context/question"

import { DataProvider } from "@opencode-ai/ui/context"
import { iife } from "@opencode-ai/util/iife"
import type { QuestionAnswer } from "@opencode-ai/sdk/v2"
import { decode64 } from "@/utils/base64"
import { Snapshot } from "@/utils/snapshot"
import { createSpeech } from "@/utils/speak"
import { SpeechOverlay } from "@/components/speech-overlay"
import { Visibility } from "@/utils/visibility"
import { spokenVoice, voiceApplier } from "@/utils/voice"
import { errorMessage } from "@/utils/error-message"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { RevertHostProvider, useRevertHost } from "@/context/revert"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const globalSync = useGlobalSync()
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
          <RevertHostProvider>
            {iife(() => {
              const sync = useSync()
              const sdk = useSDK()
              const platform = usePlatform()
              const location = useLocation()

              // Paint from cache, then reconcile: hydrate the on-device
              // snapshot so a cold open shows the transcript before any fetch, then
              // sync, which takes the deltaMessages branch off the seeded store and
              // fetches only the gap. A missing snapshot no-ops the hydrate and sync
              // falls back to the normal tail fetch.
              //
              // Snapshot.claim enforces the once-per-page-load contract, so this
              // effect can stay reactive: it still fires the tail fetch on every
              // route change, but only the session the page LANDED on ever reads
              // disk. Navigation and project switches (which remount this layout)
              // get a plain sync() against the live server. The writer below is
              // independent and keeps running.
              createEffect(() => {
                const id = location.pathname.match(/\/session\/([^/?#]+)/)?.[1]
                if (!id) return
                Snapshot.claim(directory(), id).then((snapshot) => {
                  if (snapshot) sync.session.hydrate(snapshot)
                  sync.session.sync(id, snapshot !== undefined)
                })
              })

              // Persist the open transcript's tail on a timer, so a reload paints a
              // snapshot that is seconds old. Writing at unload instead does not
              // work: IndexedDB is asynchronous and the browser tears the page down
              // before the transaction can commit, which leaves only whatever an
              // earlier background-and-survive happened to write.
              //
              // The write costs ~1ms for a 40-message tail, so the cadence is bound
              // by the dirty check rather than the write: an idle session compares
              // one string per tick and does nothing.
              let written = ""
              const capture = async () => {
                const id = location.pathname.match(/\/session\/([^/?#]+)/)?.[1]
                if (!id) return
                const messages = sync.data.message[id]
                if (!messages?.length) return
                const next = Snapshot.fingerprint(messages, sync.data.part)
                if (next === written) return
                const session = sync.session.get(id)
                if (!session) return
                written = next
                await Snapshot.write(Snapshot.build(directory(), session, messages, sync.data.part))
              }

              const timer = setInterval(() => void capture(), 5000)
              onCleanup(() => clearInterval(timer))

              // A tab going hidden may not come back before it is discarded, and it
              // is already off the critical path, so capture the tail immediately
              // rather than waiting out the interval.
              createEffect(() => {
                if (!Visibility.hidden()) return
                void capture()
              })
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

              // One reading at a time is enforced inside createSpeech, so a single
              // instance here serves every message box rather than each owning one.
              const speech = createSpeech({
                url: () => sdk.url,
                fetch: platform.fetch,
                title: () => language.t("speech.speak"),
                // The rewrite pass runs under the current session; the reading
                // always happens inside an open session, so the route's id is it.
                session: () => params.id ?? "",
                // Scopes the rewrite's server-side instance context, since /tts is
                // mounted ahead of the directory middleware.
                directory: () => directory(),
                onError: (message) =>
                  showToast({ variant: "error", title: language.t("speech.failed"), description: message }),
              })

              // Audio already rendered is in the old voice, so a change re-voices the rest
              // of the reading; the chunk playing finishes in its own. Every change, from
              // any client or this one's own save, lands in the store this memo reads, and
              // a change to the config default re-voices too while the picker still shows
              // "Default voice".
              const voice = createMemo(() => sync.data.voice_preference?.name ?? "")
              const spoken = createMemo(() => spokenVoice(voice(), globalSync.data.config.dictation?.voice))
              const apply = voiceApplier(untrack(spoken), speech.revoice)
              createEffect(() => apply(spoken()))

              const revertHost = useRevertHost()

              return (
                <DataProvider
                  data={sync.data}
                  directory={directory()}
                  onPermissionRespond={respond}
                  onQuestionReply={replyToQuestion}
                  onQuestionReject={rejectQuestion}
                  onNavigateToSession={navigateToSession}
                  onRevertMessage={revertHost.revert}
                  onFetchMessageDiff={fetchMessageDiff}
                  onSpeakText={speech.show}
                  onSpeaking={speech.reading}
                >
                  <LocalProvider>
                    <QuestionProvider>{props.children}</QuestionProvider>
                  </LocalProvider>
                  <Show when={speech.open()}>
                    <SpeechOverlay
                      speech={speech}
                      voice={voice()}
                      onVoiceChange={(name) =>
                        globalSync.saveVoice(name).catch((error) => {
                          showToast({
                            variant: "error",
                            title: language.t("speech.voiceFailed"),
                            description: errorMessage(error, language.t("speech.voiceFailed")),
                          })
                        })
                      }
                    />
                  </Show>
                </DataProvider>
              )
            })}
          </RevertHostProvider>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
