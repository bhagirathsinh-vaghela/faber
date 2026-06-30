import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { CountdownRing } from "@opencode-ai/ui/countdown-ring"
import { useOverview } from "@/context/overview"
import { useGlobalSDK } from "@/context/global-sdk"
import { CACHE_TTL } from "@/utils/cache-countdown"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

function getFilename(dir: string) {
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function Attention() {
  const overview = useOverview()
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
    <Show when={overview.any()}>
      <div class="mb-10 w-full flex flex-col gap-4">
        <div class="text-14-medium text-text-strong pl-3">{language.t("home.attention")}</div>
        <For each={overview.projects()}>
          {(project) => (
            <div class="flex flex-col gap-1">
              <div class="text-12-regular text-text-weak pl-3">{getFilename(project.directory)}</div>
              <For each={project.rows}>
                {(row) => (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => open(row.directory, row.session.id)}
                  >
                    <span class="text-14-regular text-text-base truncate flex-1">
                      {row.session.title || language.t("command.session.new")}
                    </span>
                    <ChipGroup>
                      <Chip
                        accent={row.busy ? "color-text-warning" : undefined}
                        class={row.busy ? undefined : "opacity-35"}
                      >
                        {language.t("home.attention.busy")}
                      </Chip>
                      <Chip
                        accent={row.unseen ? "usage-totals" : undefined}
                        class={row.unseen ? undefined : "opacity-35"}
                      >
                        {language.t("home.attention.unseen")}
                      </Chip>
                      <Chip
                        class={row.countdown ? undefined : "opacity-35"}
                        icon={<CountdownRing fraction={row.countdown ? remainingFraction(row.session) : 0} />}
                      >
                        {row.countdown ?? "--"}
                      </Chip>
                    </ChipGroup>
                    <Show when={row.countdown}>
                      <IconButton
                        icon="circle-ban-sign"
                        title={language.t("home.attention.stopPing")}
                        onClick={(e: MouseEvent) => stopPing(e, row.directory, row.session.id)}
                      />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function remainingFraction(session: { cache?: { lastRequestAt?: number } }) {
  const base = session.cache?.lastRequestAt
  if (!base) return 0
  return Math.max(0, Math.min(1, (base + CACHE_TTL - Date.now()) / CACHE_TTL))
}

export default function Home() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() => {
    return sync.data.project
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory)
        }
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

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
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <div />
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
