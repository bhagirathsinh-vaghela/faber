import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { CountdownRing } from "@opencode-ai/ui/countdown-ring"
import { useRecent } from "@/context/recent"
import { useGlobalSDK } from "@/context/global-sdk"
import { CACHE_TTL } from "@/utils/cache-countdown"
import { DateTime } from "luxon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"

function getFilename(dir: string) {
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function Attention() {
  const recent = useRecent()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const language = useLanguage()

  const open = (directory: string, id: string) => {
    void sdk.client.session.seen({ directory, sessionID: id })
    navigate(`/${base64Encode(directory)}/session/${id}`)
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
                <Chip accent={row.busy ? "color-text-warning" : undefined} class={row.busy ? undefined : "opacity-35"}>
                  {language.t("home.attention.busy")}
                </Chip>
                <Chip accent={row.unseen ? "usage-totals" : undefined} class={row.unseen ? undefined : "opacity-35"}>
                  {language.t("home.attention.unseen")}
                </Chip>
                <Chip
                  class={row.countdown ? undefined : "opacity-35"}
                  icon={<CountdownRing fraction={row.countdown ? remainingFraction(row) : 0} />}
                >
                  {row.countdown ?? "--"}
                </Chip>
              </ChipGroup>
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

function RecentSessions() {
  const recent = useRecent()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const language = useLanguage()

  const open = (directory: string, id: string) => {
    void sdk.client.session.seen({ directory, sessionID: id })
    navigate(`/${base64Encode(directory)}/session/${id}`)
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

function remainingFraction(row: { updated: number }) {
  return Math.max(0, Math.min(1, (row.updated + CACHE_TTL - Date.now()) / CACHE_TTL))
}

export default function Home() {
  const dialog = useDialog()
  const server = useServer()

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            "bg-icon-success-base": server.healthy() === true,
            "bg-icon-critical-base": server.healthy() === false,
            "bg-border-weak-base": server.healthy() === undefined,
          }}
        />
        {server.name}
      </Button>
      <div class="mt-20" />
      <Attention />
      <RecentSessions />
    </div>
  )
}
