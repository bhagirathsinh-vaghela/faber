import { createStore, reconcile, unwrap } from "solid-js/store"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useTheme } from "@opencode-ai/ui/theme"
import { persisted } from "@/utils/persist"
import { useGlobalSDK } from "@/context/global-sdk"
import { FONT_WEIGHTS, type FontWeights } from "@opencode-ai/ui/font"

// `blocking` covers every prompt that halts the turn until answered: a
// permission request and a question both qualify.
export interface NotificationSettings {
  agent: boolean
  blocking: boolean
  errors: boolean
}

export interface SoundSettings {
  agent: string
  blocking: string
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
  debug: {
    // Render every injected block the transcript hides: rule reminders, the
    // MCP catalog, mid-turn nudges. For inspecting what the model was actually
    // sent, so what it reveals is shown plainly rather than styled.
    showInternal: boolean
  }
}

// One declaration, in the layer that cannot import this one.
import type { BoxMode } from "@opencode-ai/ui/context/box-defaults"
export type { BoxMode }

// Per-box-type collapse defaults, keyed by tool/box name. Each mode flag is
// `true` = collapsed by default, absent/`false` = expanded. Server-persisted
// (mirrors AppearancePreference) so it syncs across clients, unlike the
// localStorage Settings above.
export type BoxDefaults = Record<string, { normal?: boolean; reader?: boolean }>

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
    blocking: true,
    errors: false,
  },
  sounds: {
    agent: "staplebops-01",
    blocking: "staplebops-02",
    errors: "nope-03",
  },
  debug: {
    showInternal: false,
  },
}

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

// Symbol-rescue tail, inserted before IBM Plex in every stack. Anthropic emits
// box-drawing, arrows, geometric shapes, and circled digits (①–④) that most
// mono fonts lack; when a glyph is missing the browser falls through to the
// system, which substitutes a PROPORTIONAL glyph and shears ASCII diagrams.
// "Symbol Rescue" (declared in ui/components/font.tsx) carries exactly those
// glyphs at the same 0.602em cell as the full faces, so filling a gap never
// changes advance width.
const symbolRescue = `"Symbol Rescue", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`

// A "…Variable" woff2 is subset to Latin-only (~225 glyphs). It must sit AFTER
// its full static Nerd Font, never first, or every symbol falls through it.
const monoFonts: Record<string, string> = {
  "ibm-plex-mono": symbolRescue,
  "cascadia-code": `"Cascadia Code Nerd Font", "Cascadia Code NF", "Cascadia Mono NF", ${symbolRescue}`,
  "fira-code": `"Fira Code Nerd Font", "FiraMono Nerd Font", "FiraMono Nerd Font Mono", ${symbolRescue}`,
  hack: `"Hack Nerd Font", "Hack Nerd Font Mono", ${symbolRescue}`,
  inconsolata: `"Inconsolata Nerd Font", "Inconsolata Nerd Font Mono", ${symbolRescue}`,
  "intel-one-mono": `"Intel One Mono Nerd Font", "IntoneMono Nerd Font", "IntoneMono Nerd Font Mono", ${symbolRescue}`,
  iosevka: `"Iosevka Nerd Font", "Iosevka Nerd Font Mono", ${symbolRescue}`,
  "jetbrains-mono": `"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrainsMonoNL Nerd Font", "JetBrainsMonoNL Nerd Font Mono", "JetBrains Mono Variable", ${symbolRescue}`,
  "geist-mono": `"GeistMono Nerd Font", "Geist Mono", "Geist Mono Variable", ${symbolRescue}`,
  "monaspace-neon": `"Monaspace Neon", ${symbolRescue}`,
  "commit-mono": `"Commit Mono", ${symbolRescue}`,
  "maple-mono": `"Maple Mono", ${symbolRescue}`,
  "meslo-lgs": `"Meslo LGS Nerd Font", "MesloLGS Nerd Font", "MesloLGM Nerd Font", ${symbolRescue}`,
  "roboto-mono": `"Roboto Mono Nerd Font", "RobotoMono Nerd Font", "RobotoMono Nerd Font Mono", ${symbolRescue}`,
  "source-code-pro": `"Source Code Pro Nerd Font", "SauceCodePro Nerd Font", "SauceCodePro Nerd Font Mono", "Source Code Pro Variable", ${symbolRescue}`,
  "ubuntu-mono": `"Ubuntu Mono Nerd Font", "UbuntuMono Nerd Font", "UbuntuMono Nerd Font Mono", ${symbolRescue}`,
}

export function monoFontFamily(font: string | undefined) {
  return monoFonts[font ?? "jetbrains-mono"] ?? monoFonts["jetbrains-mono"]
}

// The weights the given font can actually render (see FONT_WEIGHTS).
export function fontWeights(font: string | undefined): FontWeights {
  return FONT_WEIGHTS[font ?? "jetbrains-mono"] ?? FONT_WEIGHTS["jetbrains-mono"]
}

// Coerce a weight into what the font supports: nearest listed face for a
// discrete font, or the clamped range bound for a variable font. Keeps a stored
// weight from ever being a value the font can't paint (e.g. after a font switch).
export function clampWeight(font: string | undefined, weight: number): number {
  const w = fontWeights(font)
  if ("list" in w) return w.list.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a))
  return Math.min(w.max, Math.max(w.min, weight))
}

// The appearance slice is server-persisted (survives restart, is shared by
// every client of the server), NOT localStorage. Shape mirrors the
// server's AppearancePreference.Info.
export interface Appearance {
  fontSize: number
  font: string
  codeBlockFont: string
  inlineCodeFont: string
  codeTheme: string
  diffTheme: string
  fontWeight: number
  headingWeight: Record<number, number>
  overrides: { light: Record<string, string>; dark: Record<string, string> }
}

// A named user theme: an appearance diff (fonts + per-mode overrides) layered on
// top of a built-in base. Mirrors the server ThemePreference.Info shape.
export interface UserTheme extends Appearance {
  id: string
  name: string
  baseId: string
}

// True when an appearance carries any edit worth migrating into a named theme —
// any per-mode override, or a font/size/weight differing from the default.
function hasCustomizations(a: Appearance): boolean {
  if (Object.keys(a.overrides?.light ?? {}).length > 0) return true
  if (Object.keys(a.overrides?.dark ?? {}).length > 0) return true
  const d = defaultAppearance
  return (
    a.fontSize !== d.fontSize ||
    a.font !== d.font ||
    a.codeBlockFont !== d.codeBlockFont ||
    a.inlineCodeFont !== d.inlineCodeFont ||
    a.codeTheme !== d.codeTheme ||
    a.diffTheme !== d.diffTheme ||
    a.fontWeight !== d.fontWeight
  )
}

const defaultAppearance: Appearance = {
  fontSize: 13,
  font: "jetbrains-mono",
  codeBlockFont: "jetbrains-mono",
  inlineCodeFont: "jetbrains-mono",
  codeTheme: "github-dark",
  diffTheme: "github-dark",
  fontWeight: 400,
  headingWeight: { 1: 700, 2: 700, 3: 700, 4: 700, 5: 700, 6: 700 },
  overrides: { light: {}, dark: {} },
}

// Normalize a persisted appearance onto the current shape. Records saved before
// the code-font split carry a single `codeFont`; seed both the block and inline
// fields from it so an older theme keeps its chosen code font on both surfaces.
function migrate(a: Partial<Appearance> & { codeFont?: string }): Appearance {
  const legacy = a.codeFont
  return {
    ...structuredClone(defaultAppearance),
    ...a,
    codeBlockFont: a.codeBlockFont ?? legacy ?? defaultAppearance.codeBlockFont,
    inlineCodeFont: a.inlineCodeFont ?? legacy ?? defaultAppearance.inlineCodeFont,
  }
}

// Records saved before permissions and questions were unified carry the alert
// choice under `permissions`; move it to `blocking` so the selection survives.
function migrateSettings(value: unknown) {
  if (!value || typeof value !== "object") return value
  const settings = value as Record<string, Record<string, unknown> | undefined>
  for (const group of ["notifications", "sounds"]) {
    const section = settings[group]
    if (!section || !("permissions" in section)) continue
    settings[group] = { ...section, blocking: section.blocking ?? section.permissions }
    delete settings[group]!.permissions
  }
  return settings
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    const [store, setStore, _, ready] = persisted(
      { key: "settings.v3", migrate: migrateSettings },
      createStore<Settings>(defaultSettings),
    )
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

    const discard = () => setWork(reconcile(structuredClone(saved())))

    // Named themes: the working appearance (`work`) is always "edits on top of a
    // base". A user theme bundles that appearance with an id/name/base. `themes`
    // is the server-persisted collection; `activeThemeID` is which one is active.
    const [themes, setThemes] = createStore<UserTheme[]>([])
    const [activeThemeID, setActiveThemeID] = createSignal<string | null>(null)
    // Working identity of an unsaved derived theme (auto-created on first edit of
    // a built-in). Null once nothing derived is in flight.
    const [workingID, setWorkingID] = createSignal<string | null>(null)
    const [workingName, setWorkingName] = createSignal<string | null>(null)

    // Per-box collapse defaults — server-persisted (mirrors appearance/themes),
    // so ticks survive across clients. Edit-then-Save like appearance: checkbox
    // clicks mutate the working `boxes` store only; `boxesSaved` is the last
    // server snapshot; Save pushes, Discard reverts. This keeps the network PUT
    // off the click path entirely.
    const [boxes, setBoxes] = createStore<BoxDefaults>({})
    const [boxesSaved, setBoxesSaved] = createSignal<BoxDefaults>({})
    const boxesDirty = createMemo(() => JSON.stringify(boxes) !== JSON.stringify(boxesSaved()))
    const discardBoxes = () => setBoxes(reconcile(structuredClone(boxesSaved())))
    const saveBoxes = () => {
      const snapshot = structuredClone(unwrap(boxes))
      setBoxesSaved(snapshot)
      return globalSDK.client.preference.boxes.set({ boxPreference: snapshot as any }).catch(() => undefined)
    }

    const activeName = createMemo(() => {
      const id = activeThemeID()
      const t = id ? themes.find((x) => x.id === id) : undefined
      return t?.name ?? workingName() ?? theme.themes()[theme.themeId()]?.name ?? theme.themeId()
    })

    // Snapshot the live appearance into a UserTheme record.
    const snapshot = (id: string, name: string): UserTheme => ({
      ...structuredClone(unwrap(work)),
      id,
      name,
      baseId: theme.themeId(),
    })

    const upsertLocal = (t: UserTheme) => {
      const at = themes.findIndex((x) => x.id === t.id)
      if (at === -1) setThemes(themes.length, t)
      else setThemes(at, reconcile(t))
    }

    const push = (t: UserTheme) =>
      globalSDK.client.preference.theme.save({ userTheme: t as any }).catch(() => undefined)

    // Apply a stored user theme: switch to its base, load its appearance into
    // `work`, mark it active and saved (a freshly-loaded theme is not dirty).
    const applyTheme = (t: UserTheme) => {
      if (theme.themeId() !== t.baseId) theme.setTheme(t.baseId)
      const appearance = migrate(t)
      setWork(reconcile(appearance))
      setSaved(structuredClone(appearance))
      setActiveThemeID(t.id)
      setWorkingID(null)
      setWorkingName(null)
      globalSDK.client.preference.theme.setActive({ id: t.id }).catch(() => undefined)
    }

    // Switch to a plain built-in base: change the base AND clear the active user
    // theme + its overrides. Without the reset, the active theme's inline
    // overrides keep painting over the new base and it looks like nothing changed.
    const selectBase = (id: string) => {
      theme.setTheme(id)
      setActiveThemeID(null)
      setWorkingID(null)
      setWorkingName(null)
      setWork(reconcile(structuredClone(defaultAppearance)))
      setSaved(structuredClone(defaultAppearance))
      globalSDK.client.preference.theme.setActive({ id: null }).catch(() => undefined)
    }

    // Called when an override/appearance edit happens while no user theme is
    // active — derive an unsaved "<Base> (customized)" theme so edits have a home.
    const deriveIfNeeded = () => {
      if (activeThemeID() || workingID()) return
      const base = theme.themes()[theme.themeId()]
      setWorkingID(crypto.randomUUID())
      setWorkingName(`${base?.name ?? theme.themeId()} (customized)`)
    }

    // Save destinations — the "where does this land" decision.
    const saveToCustomized = () => {
      const id = workingID() ?? crypto.randomUUID()
      const name = workingName() ?? `${theme.themes()[theme.themeId()]?.name ?? theme.themeId()} (customized)`
      const t = snapshot(id, name)
      upsertLocal(t)
      setActiveThemeID(id)
      setWorkingID(null)
      setSaved(structuredClone(unwrap(work)))
      globalSDK.client.preference.theme.setActive({ id }).catch(() => undefined)
      return push(t)
    }

    const saveAs = (name: string) => {
      const id = crypto.randomUUID()
      const t = snapshot(id, name)
      upsertLocal(t)
      setActiveThemeID(id)
      setWorkingID(null)
      setWorkingName(null)
      setSaved(structuredClone(unwrap(work)))
      globalSDK.client.preference.theme.setActive({ id }).catch(() => undefined)
      return push(t)
    }

    const saveOver = () => {
      const id = activeThemeID()
      if (!id) return saveToCustomized()
      const existing = themes.find((x) => x.id === id)
      const t = snapshot(id, existing?.name ?? activeName())
      upsertLocal(t)
      setSaved(structuredClone(unwrap(work)))
      return push(t)
    }

    const duplicate = (id: string, name: string) => {
      const src = themes.find((x) => x.id === id)
      if (!src) return
      const copy: UserTheme = { ...structuredClone(unwrap(src)), id: crypto.randomUUID(), name }
      upsertLocal(copy)
      return push(copy)
    }

    const rename = (id: string, name: string) => {
      const at = themes.findIndex((x) => x.id === id)
      if (at === -1) return
      setThemes(at, "name", name)
      return push(snapshot(id, name))
    }

    const removeTheme = (id: string) => {
      setThemes((list) => list.filter((x) => x.id !== id))
      if (activeThemeID() === id) setActiveThemeID(null)
      return globalSDK.client.preference.theme.remove({ id }).catch(() => undefined)
    }

    onMount(() => {
      // Load server-persisted box collapse defaults (independent of the theme
      // chain below so one failing doesn't block the other).
      globalSDK.client.preference.boxes
        .get()
        .then((r) => ((r as any).data ?? r) as BoxDefaults | null)
        .then((loaded) => {
          if (loaded && typeof loaded === "object") {
            setBoxes(reconcile(loaded))
            setBoxesSaved(structuredClone(loaded))
          }
        })
        .catch(() => undefined)

      // Load themes + active pointer, then fall back to (or migrate) the legacy
      // single appearance blob so nothing a user tuned before named themes is lost.
      Promise.all([
        globalSDK.client.preference.theme.list().then((r) => ((r as any).data ?? r) as UserTheme[]),
        globalSDK.client.preference.theme.getActive().then((r) => ((r as any).data ?? r) as string | null),
        globalSDK.client.preference.appearance.get().then((r) => ((r as any).data ?? r) as Appearance | null),
      ])
        .then(([list, active, appearance]) => {
          const themeList = Array.isArray(list) ? list : []

          // Migration: first run with no themes but existing custom overrides.
          // Turn the legacy appearance into a named theme so it becomes selectable.
          if (themeList.length === 0 && appearance && hasCustomizations(appearance)) {
            const migrated: UserTheme = {
              ...migrate(appearance),
              id: crypto.randomUUID(),
              name: "Custom",
              baseId: theme.themeId(),
            }
            themeList.push(migrated)
            active = migrated.id
            push(migrated)
            globalSDK.client.preference.theme.setActive({ id: migrated.id }).catch(() => undefined)
          }

          setThemes(reconcile(themeList))
          const target = active ? themeList.find((t) => t.id === active) : undefined
          if (target) {
            applyTheme(target)
            return
          }
          // No active user theme: seed work from the legacy appearance so the
          // customization editor still reflects saved overrides.
          if (appearance) {
            setWork(reconcile(migrate(appearance)))
            setSaved(structuredClone(unwrap(work)))
          }
        })
        .catch(() => undefined)
    })

    // Font family / size / weights -> CSS custom props on <html> (live/Apply).
    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement.style
      root.setProperty("--font-family-mono", monoFontFamily(work.font))
      root.setProperty("--font-family-sans", monoFontFamily(work.font))
      root.setProperty("--markdown-code-block-family", monoFontFamily(work.codeBlockFont))
      root.setProperty("--markdown-inline-code-family", monoFontFamily(work.inlineCodeFont))
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
        // Every edit calls deriveIfNeeded so editing a built-in base auto-creates
        // an unsaved "<Base> (customized)" working theme.
        fontSize: () => work.fontSize,
        setFontSize(value: number) {
          deriveIfNeeded()
          setWork("fontSize", value)
        },
        font: () => work.font,
        setFont(value: string) {
          deriveIfNeeded()
          setWork("font", value)
          setWork("fontWeight", clampWeight(value, work.fontWeight))
          for (const level of [1, 2, 3, 4, 5, 6]) {
            setWork("headingWeight", level, clampWeight(value, work.headingWeight[level] ?? 700))
          }
        },
        codeBlockFont: () => work.codeBlockFont,
        setCodeBlockFont(value: string) {
          deriveIfNeeded()
          setWork("codeBlockFont", value)
        },
        inlineCodeFont: () => work.inlineCodeFont,
        setInlineCodeFont(value: string) {
          deriveIfNeeded()
          setWork("inlineCodeFont", value)
          const weight = work.overrides[theme.mode()]?.["--markdown-inline-code-weight"]
          if (weight)
            setWork(
              "overrides",
              theme.mode(),
              "--markdown-inline-code-weight",
              `${clampWeight(value, parseFloat(weight))}`,
            )
        },
        codeTheme: () => work.codeTheme ?? defaultAppearance.codeTheme,
        setCodeTheme(value: string) {
          deriveIfNeeded()
          setWork("codeTheme", value)
        },
        diffTheme: () => work.diffTheme ?? defaultAppearance.diffTheme,
        setDiffTheme(value: string) {
          deriveIfNeeded()
          setWork("diffTheme", value)
        },
        fontWeight: () => work.fontWeight,
        setFontWeight(value: number) {
          deriveIfNeeded()
          setWork("fontWeight", value)
        },
        headingWeight: (level: number) => work.headingWeight[level] ?? 700,
        setHeadingWeight(level: number, value: number) {
          deriveIfNeeded()
          setWork("headingWeight", level, value)
        },
        // Weight capability of a font id — drives the weight picker's shape.
        weights: (font: string) => fontWeights(font),
        dirty,
        discard,
      },
      // Named themes: the active theme, the collection, save destinations, CRUD.
      themes: {
        list: () => themes,
        activeID: activeThemeID,
        activeName,
        dirty,
        apply: applyTheme,
        selectBase,
        select(id: string) {
          const t = themes.find((x) => x.id === id)
          if (t) applyTheme(t)
        },
        saveToCustomized,
        saveAs,
        saveOver,
        duplicate,
        rename,
        remove: removeTheme,
        discard,
      },
      overrides: {
        get: (mode: "light" | "dark", token: string) => work.overrides[mode]?.[token],
        set(mode: "light" | "dark", token: string, value: string) {
          deriveIfNeeded()
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
      boxes: {
        // `true` = collapsed by default in that mode; absent = expanded. Reads
        // the SAVED snapshot so the transcript reflects only persisted choices,
        // not unsaved edits open in the settings panel.
        collapsed: (type: string, mode: BoxMode) => boxesSaved()[type]?.[mode] ?? false,
        // Working value shown in the settings matrix (may be unsaved).
        draft: (type: string, mode: BoxMode) => boxes[type]?.[mode] ?? false,
        setCollapsed(type: string, mode: BoxMode, value: boolean) {
          setBoxes(type, (prev) => ({ ...prev, [mode]: value }))
        },
        dirty: boxesDirty,
        save: saveBoxes,
        discard: discardBoxes,
      },
      notifications: {
        agent: createMemo(() => store.notifications?.agent ?? defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        blocking: createMemo(() => store.notifications?.blocking ?? defaultSettings.notifications.blocking),
        setBlocking(value: boolean) {
          setStore("notifications", "blocking", value)
        },
        errors: createMemo(() => store.notifications?.errors ?? defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      debug: {
        showInternal: createMemo(() => store.debug?.showInternal ?? defaultSettings.debug.showInternal),
        setShowInternal(value: boolean) {
          setStore("debug", "showInternal", value)
        },
      },
      sounds: {
        agent: createMemo(() => store.sounds?.agent ?? defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        blocking: createMemo(() => store.sounds?.blocking ?? defaultSettings.sounds.blocking),
        setBlocking(value: string) {
          setStore("sounds", "blocking", value)
        },
        errors: createMemo(() => store.sounds?.errors ?? defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
    }
  },
})
