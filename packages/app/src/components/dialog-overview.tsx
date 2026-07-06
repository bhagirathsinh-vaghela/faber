import { For, Show, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { CountdownRing } from "@opencode-ai/ui/countdown-ring"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DateTime } from "luxon"
import { useRecent } from "@/context/recent"
import { useGlobalSDK } from "@/context/global-sdk"
import { CACHE_TTL } from "@/utils/cache-countdown"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"

function getFilename(dir: string) {
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function remainingFraction(row: { updated: number }) {
  return Math.max(0, Math.min(1, (row.updated + CACHE_TTL - Date.now()) / CACHE_TTL))
}

function Attention(props: { onOpen?: () => void }) {
  const recent = useRecent()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const language = useLanguage()

  const open = (directory: string, id: string) => {
    void sdk.client.session.seen({ directory, sessionID: id })
    navigate(`/${base64Encode(directory)}/session/${id}`)
    props.onOpen?.()
  }

  const stopPing = (e: MouseEvent, directory: string, id: string) => {
    e.stopPropagation()
    void sdk.client.session.pingStop({ directory, sessionID: id })
  }

  return (
    <Show when={recent.attention().length > 0}>
      <div class="mb-10 w-full flex flex-col gap-1">
        <div class="text-14-medium text-text-strong pl-3 mb-3">{language.t("home.attention")}</div>
        <For each={recent.attention()}>
          {(row) => (
            <button
              type="button"
              class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
              onClick={() => open(row.directory, row.sessionID)}
            >
              <span class="text-14-regular text-text-base truncate flex-1">
                {row.title || language.t("command.session.new")}
              </span>
              <span class="text-12-regular text-text-weak truncate">{getFilename(row.directory)}</span>
              <ChipGroup>
                <Chip
                  class={row.countdown ? undefined : "opacity-35"}
                  icon={<CountdownRing fraction={row.countdown ? remainingFraction(row) : 0} />}
                >
                  {row.countdown ?? "--"}
                </Chip>
              </ChipGroup>
              <Show when={row.busy}>
                <span
                  title={language.t("home.attention.busy")}
                  class="status-ping relative size-2 rounded-full text-icon-warning-base bg-current shrink-0"
                />
              </Show>
              <Show when={!row.busy && row.unseen}>
                <span
                  title={language.t("home.attention.unseen")}
                  class="size-2 rounded-full bg-icon-interactive-base shrink-0"
                />
              </Show>
              <Show when={row.countdown}>
                <IconButton
                  icon="circle-ban-sign"
                  title={language.t("home.attention.stopPing")}
                  onClick={(e: MouseEvent) => stopPing(e, row.directory, row.sessionID)}
                />
              </Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

function RecentSessions(props: { onOpen?: () => void }) {
  const recent = useRecent()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const language = useLanguage()

  const open = (directory: string, id: string) => {
    void sdk.client.session.seen({ directory, sessionID: id })
    navigate(`/${base64Encode(directory)}/session/${id}`)
    props.onOpen?.()
  }

  return (
    <Show when={recent.recent().length > 0}>
      <div class="mb-10 w-full flex flex-col gap-1">
        <div class="text-14-medium text-text-strong pl-3 mb-3">{language.t("home.recentSessions")}</div>
        <For each={recent.recent()}>
          {(row) => (
            <button
              type="button"
              class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
              onClick={() => open(row.directory, row.sessionID)}
            >
              <span class="text-14-regular text-text-base truncate flex-1">
                {row.title || language.t("command.session.new")}
              </span>
              <span class="text-12-regular text-text-weak truncate">{getFilename(row.directory)}</span>
              <span class="text-12-regular text-text-weak shrink-0">
                {DateTime.fromMillis(row.updated).toRelative()}
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

// The single source of truth for the overview's content and section order.
// Both the home page (`/`) and DialogOverview render this body inside their
// own frame, so any change to what the overview shows lands in both views.
export function Overview(props: { onOpen?: () => void }) {
  const recent = useRecent()
  const language = useLanguage()
  const empty = () => recent.attention().length === 0 && recent.recent().length === 0

  return (
    <>
      <Attention onOpen={props.onOpen} />
      <RecentSessions onOpen={props.onOpen} />
      <Show when={empty()}>
        <div class="px-3 py-6 text-14-regular text-text-weak">{language.t("home.empty.description")}</div>
      </Show>
    </>
  )
}

export function DialogOverview() {
  const dialog = useDialog()
  const language = useLanguage()
  const command = useCommand()
  const state = { selected: false }

  const open = () => {
    state.selected = true
    dialog.close()
  }

  // On dismiss without picking a session, Kobalte restores focus to the
  // trigger (the titlebar house button), not the dock the user was typing in.
  // Return the caret to the dock on teardown. Deferred past the dialog close so
  // Kobalte's own focus-restore can't clobber it. Skipped when a session was
  // selected — the opening session focuses its own dock (session.tsx).
  onCleanup(() => {
    if (state.selected) return
    requestAnimationFrame(() => command.trigger("prompt.focus"))
  })

  return (
    <Dialog size="large" title={language.t("home.title")} transition>
      <Overview onOpen={open} />
    </Dialog>
  )
}
