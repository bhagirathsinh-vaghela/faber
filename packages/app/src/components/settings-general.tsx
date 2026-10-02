import { Component, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { playSound, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "./link"
import { SettingsRow } from "./settings-row"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const playDemoSound = (src: string) => {
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }

  clearTimeout(demoSoundState.timeout)

  demoSoundState.timeout = setTimeout(() => {
    demoSoundState.cleanup = playSound(src)
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  const [store, setStore] = createStore({
    checking: false,
  })

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions =
          platform.update && platform.restart
            ? [
                {
                  label: language.t("toast.update.action.installRestart"),
                  onClick: async () => {
                    await platform.update!()
                    await platform.restart!()
                  },
                },
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]
            : [
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  // Built-in bases first, then the user's named themes. `user` marks which
  // branch a selection takes: user themes apply via the settings context (base +
  // overrides); built-ins go straight to the theme provider.
  const themeOptions = createMemo(() => [
    ...Object.entries(theme.themes()).map(([id, def]) => ({ id, name: def.name ?? id, user: false })),
    ...settings.themes.list().map((t) => ({ id: t.id, name: t.name, user: true })),
  ])

  const currentThemeOption = createMemo(() => {
    const opts = themeOptions()
    const activeUser = settings.themes.activeID()
    if (activeUser) return opts.find((o) => o.user && o.id === activeUser)
    return opts.find((o) => !o.user && o.id === theme.themeId())
  })

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const soundOptions = [...SOUND_OPTIONS]

  // Highlighting an option previews it; picking one stores and plays it.
  const SoundRow = (props: {
    slot: "agent" | "blocking" | "errors" | "stopped" | "archived" | "deleted"
    current: () => string
    set: (id: string) => void
  }) => (
    <SettingsRow
      title={language.t(`settings.general.sounds.${props.slot}.title`)}
      description={language.t(`settings.general.sounds.${props.slot}.description`)}
    >
      <Select
        data-action={`settings-sounds-${props.slot}`}
        options={soundOptions}
        current={soundOptions.find((o) => o.id === props.current())}
        value={(o) => o.id}
        label={(o) => language.t(o.label)}
        onHighlight={(option) => {
          if (!option) return
          playDemoSound(option.src)
        }}
        onSelect={(option) => {
          if (!option) return
          props.set(option.id)
          playDemoSound(option.src)
        }}
        variant="secondary"
        size="small"
        triggerVariant="settings"
      />
    </SettingsRow>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 wide:px-10 wide:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        {/* Appearance Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.row.appearance.title")}
              description={language.t("settings.general.row.appearance.description")}
            >
              <Select
                data-action="settings-color-scheme"
                options={colorSchemeOptions()}
                current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(option) => option && theme.setColorScheme(option.value)}
                onHighlight={(option) => {
                  if (!option) return
                  theme.previewColorScheme(option.value)
                  return () => theme.cancelPreview()
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.theme.title")}
              description={
                <>
                  {language.t("settings.general.row.theme.description")}{" "}
                  <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
                </>
              }
            >
              <Select
                data-action="settings-theme"
                options={themeOptions()}
                current={currentThemeOption()}
                value={(o) => o.id}
                label={(o) => o.name}
                onSelect={(option) => {
                  if (!option) return
                  if (option.user) settings.themes.select(option.id)
                  else settings.themes.selectBase(option.id)
                }}
                onHighlight={(option) => {
                  // Skip hover-preview for user themes, and while a user theme is
                  // active: its inline overrides would mask the previewed base, so
                  // the preview would look identical and mislead. Click still switches.
                  if (!option || option.user || settings.themes.activeID()) return
                  theme.previewTheme(option.id)
                  return () => theme.cancelPreview()
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
          </div>
        </div>

        {/* System notifications Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.notifications.agent.title")}
              description={language.t("settings.general.notifications.agent.description")}
            >
              <div data-action="settings-notifications-agent">
                <Switch
                  checked={settings.notifications.agent()}
                  onChange={(checked) => settings.notifications.setAgent(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.notifications.blocking.title")}
              description={language.t("settings.general.notifications.blocking.description")}
            >
              <div data-action="settings-notifications-blocking">
                <Switch
                  checked={settings.notifications.blocking()}
                  onChange={(checked) => settings.notifications.setBlocking(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.notifications.errors.title")}
              description={language.t("settings.general.notifications.errors.description")}
            >
              <div data-action="settings-notifications-errors">
                <Switch
                  checked={settings.notifications.errors()}
                  onChange={(checked) => settings.notifications.setErrors(checked)}
                />
              </div>
            </SettingsRow>
          </div>
        </div>

        {/* Sound effects Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SoundRow slot="agent" current={settings.sounds.agent} set={settings.sounds.setAgent} />
            <SoundRow slot="blocking" current={settings.sounds.blocking} set={settings.sounds.setBlocking} />
            <SoundRow slot="errors" current={settings.sounds.errors} set={settings.sounds.setErrors} />
            <SoundRow slot="stopped" current={settings.sounds.stopped} set={settings.sounds.setStopped} />
            <SoundRow slot="archived" current={settings.sounds.archived} set={settings.sounds.setArchived} />
            <SoundRow slot="deleted" current={settings.sounds.deleted} set={settings.sounds.setDeleted} />
          </div>
        </div>

        {/* Updates Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.updates.row.startup.title")}
              description={language.t("settings.updates.row.startup.description")}
            >
              <div data-action="settings-updates-startup">
                <Switch
                  checked={settings.updates.startup()}
                  disabled={!platform.checkUpdate}
                  onChange={(checked) => settings.updates.setStartup(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.releaseNotes.title")}
              description={language.t("settings.general.row.releaseNotes.description")}
            >
              <div data-action="settings-release-notes">
                <Switch
                  checked={settings.general.releaseNotes()}
                  onChange={(checked) => settings.general.setReleaseNotes(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.updates.row.check.title")}
              description={language.t("settings.updates.row.check.description")}
            >
              <Button
                size="small"
                variant="secondary"
                disabled={store.checking || !platform.checkUpdate}
                onClick={check}
              >
                {store.checking
                  ? language.t("settings.updates.action.checking")
                  : language.t("settings.updates.action.checkNow")}
              </Button>
            </SettingsRow>
          </div>
        </div>
      </div>
    </div>
  )
}
