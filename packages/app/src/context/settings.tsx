import { createStore, reconcile, unwrap } from "solid-js/store"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useTheme } from "@opencode-ai/ui/theme"
import { persisted } from "@/utils/persist"
import { useGlobalSDK } from "@/context/global-sdk"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agent: string
  permissions: string
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
  }
  updates: {
    startup: boolean
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  attachments: {
    compress: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
  },
  updates: {
    startup: true,
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  attachments: {
    compress: true,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agent: "staplebops-01",
    permissions: "staplebops-02",
    errors: "nope-03",
  },
}

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoFonts: Record<string, string> = {
  "ibm-plex-mono": `"IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "cascadia-code": `"Cascadia Code Nerd Font", "Cascadia Code NF", "Cascadia Mono NF", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "fira-code": `"Fira Code Nerd Font", "FiraMono Nerd Font", "FiraMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  hack: `"Hack Nerd Font", "Hack Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  inconsolata: `"Inconsolata Nerd Font", "Inconsolata Nerd Font Mono","IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "intel-one-mono": `"Intel One Mono Nerd Font", "IntoneMono Nerd Font", "IntoneMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  iosevka: `"Iosevka Nerd Font", "Iosevka Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "jetbrains-mono": `"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrainsMonoNL Nerd Font", "JetBrainsMonoNL Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "geist-mono": `"Geist Mono", "GeistMono Nerd Font", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "monaspace-neon": `"Monaspace Neon", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "commit-mono": `"Commit Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "maple-mono": `"Maple Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "meslo-lgs": `"Meslo LGS Nerd Font", "MesloLGS Nerd Font", "MesloLGM Nerd Font", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "roboto-mono": `"Roboto Mono Nerd Font", "RobotoMono Nerd Font", "RobotoMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "source-code-pro": `"Source Code Pro Nerd Font", "SauceCodePro Nerd Font", "SauceCodePro Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "ubuntu-mono": `"Ubuntu Mono Nerd Font", "UbuntuMono Nerd Font", "UbuntuMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
}

export function monoFontFamily(font: string | undefined) {
  return monoFonts[font ?? "jetbrains-mono"] ?? monoFonts["jetbrains-mono"]
}

// The appearance slice is server-persisted (survives restart, is shared by
// every client of the server), NOT localStorage. Shape mirrors the
// server's AppearancePreference.Info.
export interface Appearance {
  fontSize: number
  font: string
  codeFont: string
  fontWeight: number
  headingWeight: Record<number, number>
  overrides: { light: Record<string, string>; dark: Record<string, string> }
}

const defaultAppearance: Appearance = {
  fontSize: 13,
  font: "jetbrains-mono",
  codeFont: "jetbrains-mono",
  fontWeight: 400,
  headingWeight: { 1: 700, 2: 700, 3: 700, 4: 700, 5: 700, 6: 700 },
  overrides: { light: {}, dark: {} },
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))
    const theme = useTheme()
    const globalSDK = useGlobalSDK()

    // Appearance = working (in-memory, live) + saved (last server snapshot).
    // Editing mutates `work` -> applies live via the effects below. Save writes
    // `work` to the server and copies it into `saved`. Discard reverts work<-saved.
    // Reload reseeds work from the server, so un-Saved edits do not survive.
    const [work, setWork] = createStore<Appearance>(structuredClone(defaultAppearance))
    const [saved, setSaved] = createSignal<Appearance>(structuredClone(defaultAppearance))

    // Stringify the reactive `work` proxy directly (NOT unwrap): JSON.stringify
    // traverses every field, which subscribes the memo to the store so it
    // recomputes on any edit. unwrap() would strip reactivity and freeze dirty.
    const dirty = createMemo(() => JSON.stringify(work) !== JSON.stringify(saved()))

    const save = () => {
      const snapshot = structuredClone(unwrap(work))
      return globalSDK.client.preference.appearance
        .set({ appearancePreference: snapshot as any })
        .then(() => setSaved(snapshot))
        .catch(() => undefined)
    }

    const discard = () => setWork(reconcile(structuredClone(saved())))

    onMount(() => {
      globalSDK.client.preference.appearance
        .get()
        .then((r) => {
          const info = (r as any).data ?? r
          if (!info) return
          setWork(reconcile(info as Appearance))
          setSaved(structuredClone(unwrap(work)))
        })
        .catch(() => undefined)
    })

    // Font family / size / weights -> CSS custom props on <html> (live/Apply).
    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement.style
      root.setProperty("--font-family-mono", monoFontFamily(work.font))
      root.setProperty("--font-family-sans", monoFontFamily(work.font))
      root.setProperty("--markdown-code-block-family", monoFontFamily(work.codeFont))
      root.setProperty("--font-size-base", `${work.fontSize}px`)
      root.setProperty("--text-base-weight", `${work.fontWeight}`)
      for (const level of [1, 2, 3, 4, 5, 6]) {
        root.setProperty(`--markdown-heading-${level}-weight`, `${work.headingWeight[level] ?? 700}`)
      }
    })

    // Per-mode theme token overrides (live/Apply). Track which props we set so
    // switching modes (or clearing an override) removes the stale inline prop and
    // lets the theme's :root value show through again.
    let applied: string[] = []
    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement.style
      for (const token of applied) root.removeProperty(token)
      const overrides = work.overrides?.[theme.mode()] ?? {}
      applied = Object.keys(overrides)
      for (const [token, value] of Object.entries(overrides)) {
        if (value) root.setProperty(token, value)
      }
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: createMemo(() => store.general?.autoSave ?? defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: createMemo(() => store.general?.releaseNotes ?? defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
      },
      updates: {
        startup: createMemo(() => store.updates?.startup ?? defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
      },
      appearance: {
        // Live/working values. Edits apply immediately (Apply); Save persists.
        fontSize: () => work.fontSize,
        setFontSize(value: number) {
          setWork("fontSize", value)
        },
        font: () => work.font,
        setFont(value: string) {
          setWork("font", value)
        },
        codeFont: () => work.codeFont,
        setCodeFont(value: string) {
          setWork("codeFont", value)
        },
        fontWeight: () => work.fontWeight,
        setFontWeight(value: number) {
          setWork("fontWeight", value)
        },
        headingWeight: (level: number) => work.headingWeight[level] ?? 700,
        setHeadingWeight(level: number, value: number) {
          setWork("headingWeight", level, value)
        },
        // Save/Discard for the whole appearance slice (server-persisted).
        dirty,
        save,
        discard,
      },
      overrides: {
        get: (mode: "light" | "dark", token: string) => work.overrides[mode]?.[token],
        set(mode: "light" | "dark", token: string, value: string) {
          setWork("overrides", mode, token, value)
        },
        reset(mode: "light" | "dark", token: string) {
          setWork("overrides", mode, token, undefined!)
        },
        resetAll(mode: "light" | "dark") {
          setWork("overrides", mode, {})
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", action, undefined!)
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: createMemo(() => store.permissions?.autoApprove ?? defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      attachments: {
        compress: createMemo(() => store.attachments?.compress ?? defaultSettings.attachments.compress),
        setCompress(value: boolean) {
          setStore("attachments", "compress", value)
        },
      },
      notifications: {
        agent: createMemo(() => store.notifications?.agent ?? defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: createMemo(() => store.notifications?.permissions ?? defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: createMemo(() => store.notifications?.errors ?? defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agent: createMemo(() => store.sounds?.agent ?? defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissions: createMemo(() => store.sounds?.permissions ?? defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errors: createMemo(() => store.sounds?.errors ?? defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
    }
  },
})
