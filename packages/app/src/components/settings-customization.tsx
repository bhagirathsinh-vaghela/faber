import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useTheme } from "@opencode-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { useSettings, monoFontFamily, fontWeights, clampWeight } from "@/context/settings"
import { THEME_CATALOG, FONT_OPTIONS, CODE_THEME_OPTIONS, type TokenEntry } from "@/utils/theme-catalog"
import { SettingsRow } from "./settings-row"

// Read a token's current effective value off the document (override or theme).
function computed(token: string): string {
  if (typeof document === "undefined") return ""
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  // getPropertyValue returns the RAW declared value, so a token whose default is
  // a var() chain or a color-mix() (e.g. the box bg/border tokens) comes back as
  // an unparseable expression. Resolve it to a concrete rgb() by letting the
  // browser evaluate it as a `color` on a throwaway element.
  if (!raw || (!raw.includes("var(") && !raw.includes("color-mix("))) return raw
  const probe = document.createElement("span")
  probe.style.color = `var(${token})`
  probe.style.display = "none"
  document.documentElement.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return resolved || raw
}

// Normalize any CSS color the browser understands to #rrggbb for the native
// picker, plus a 0-100 alpha. Uses canvas so it works for hex, rgb(), named,
// and var()-resolved values alike.
function parseColor(value: string): { hex: string; alpha: number } {
  const fallback = { hex: "#000000", alpha: 100 }
  if (typeof document === "undefined" || !value) return fallback
  const ctx = document.createElement("canvas").getContext("2d")
  if (!ctx) return fallback
  ctx.fillStyle = "#000"
  ctx.fillStyle = value
  const resolved = ctx.fillStyle // browser normalizes to #rrggbb or rgba(...)
  if (resolved.startsWith("#")) return { hex: resolved, alpha: 100 }
  const m = resolved.match(/rgba?\(([^)]+)\)/)
  if (!m) return fallback
  const parts = m[1].split(",").map((s) => s.trim())
  const [r, g, b] = parts
  const a = parts[3] !== undefined ? Math.round(parseFloat(parts[3]) * 100) : 100
  const hex = "#" + [r, g, b].map((c) => Number(c).toString(16).padStart(2, "0")).join("")
  return { hex, alpha: a }
}

// Compose #rrggbb + 0-100 alpha into a hex string (#rrggbb or #rrggbbaa).
function toHex(hex: string, alpha: number): string {
  if (alpha >= 100) return hex
  const a = Math.round((alpha / 100) * 255)
    .toString(16)
    .padStart(2, "0")
  return `${hex}${a}`
}

const ColorEditor: Component<{ entry: TokenEntry; value: string | undefined; onChange: (v: string) => void }> = (
  props,
) => {
  // Local live value drives the inputs during a drag so we never re-parse via
  // canvas or touch the store on every pointer tick. hex/alpha are cached and
  // updated locally; the CSS var is applied directly for instant feedback; the
  // store commit (persist + effect cascade) is debounced.
  const initial = parseColor(props.value || computed(props.entry.token))
  const [hex, setHex] = createSignal(initial.hex)
  const [alpha, setAlpha] = createSignal(initial.alpha)
  const [raw, setRaw] = createSignal(props.value ?? "")

  let timer: ReturnType<typeof setTimeout> | undefined
  const commit = (value: string) => {
    // Instant visual feedback without a store write / effect cascade.
    if (typeof document !== "undefined") document.documentElement.style.setProperty(props.entry.token, value)
    setRaw(value)
    clearTimeout(timer)
    timer = setTimeout(() => props.onChange(value), 120)
  }
  onCleanup(() => clearTimeout(timer))

  // Resync local inputs when the override is cleared externally (Reset), so the
  // swatch/fields snap back to the theme's value. The direct setProperty from a
  // live drag is removed by the store effect on reset, revealing the theme value.
  createEffect(() => {
    if (props.value === undefined) {
      // Drop any lingering inline prop from a live drag so computed() reads the
      // real theme value, then resync the fields to it.
      if (typeof document !== "undefined") document.documentElement.style.removeProperty(props.entry.token)
      const next = parseColor(computed(props.entry.token))
      setHex(next.hex)
      setAlpha(next.alpha)
      setRaw("")
    }
  })

  return (
    <div class="flex items-center gap-2">
      <input
        type="color"
        class="w-7 h-7 rounded cursor-pointer bg-transparent border border-border-weak-base"
        value={hex()}
        onInput={(e) => {
          setHex(e.currentTarget.value)
          commit(toHex(e.currentTarget.value, alpha()))
        }}
      />
      <input
        type="number"
        min={0}
        max={100}
        class="w-14 px-2 py-1 text-12-regular rounded bg-surface-base border border-border-weak-base text-text-strong"
        value={alpha()}
        title="Opacity %"
        onInput={(e) => {
          setAlpha(Number(e.currentTarget.value))
          commit(toHex(hex(), Number(e.currentTarget.value)))
        }}
      />
      <input
        type="text"
        placeholder="#rrggbb / rgb()"
        class="w-32 px-2 py-1 text-12-regular font-mono rounded bg-surface-base border border-border-weak-base text-text-strong"
        value={raw()}
        onChange={(e) => {
          const next = parseColor(e.currentTarget.value)
          setHex(next.hex)
          setAlpha(next.alpha)
          commit(e.currentTarget.value)
        }}
      />
    </div>
  )
}

// Weight editor bound to a font: a discrete font (only static faces) renders a
// picker of its real weights; a variable font renders a numeric input clamped to
// its axis with a range hint. Either way the user cannot land on a weight the
// font can't render, so nothing snaps.
const WeightControl: Component<{ font: string; value: number; onChange: (v: number) => void; compact?: boolean }> = (
  props,
) => {
  const caps = createMemo(() => fontWeights(props.font))
  return (
    <Show
      when={"list" in caps() ? (caps() as { list: number[] }) : false}
      fallback={
        <div class="flex items-center gap-2">
          <input
            type="number"
            min={(caps() as { min: number }).min}
            max={(caps() as { max: number }).max}
            step={(caps() as { step: number }).step}
            class="w-20 px-2 py-1 text-13-regular rounded-md bg-surface-base border border-border-weak-base text-text-strong"
            value={props.value}
            onChange={(e) =>
              e.currentTarget.value && props.onChange(clampWeight(props.font, Number(e.currentTarget.value)))
            }
          />
          <Show when={!props.compact}>
            <span class="text-11-regular text-text-weak">
              {(caps() as { min: number }).min}–{(caps() as { max: number }).max}, step{" "}
              {(caps() as { step: number }).step}
            </span>
          </Show>
        </div>
      }
    >
      {(list) => (
        <Select
          options={list().list}
          current={list().list.find((w) => w === props.value) ?? clampWeight(props.font, props.value)}
          value={(w) => String(w)}
          label={(w) => String(w)}
          onSelect={(w) => w && props.onChange(w)}
          variant="secondary"
          size="small"
          triggerVariant="settings"
          triggerStyle={{ "min-width": "88px" }}
        >
          {(w) => <span style={{ "font-weight": w ?? 400 }}>{w ?? ""}</span>}
        </Select>
      )}
    </Show>
  )
}

const SizeInput: Component<{ value: number; onChange: (v: number) => void }> = (props) => (
  <div class="flex items-center gap-1">
    <input
      type="number"
      min={8}
      max={48}
      step={0.5}
      class="w-20 px-2 py-1 text-13-regular rounded-md bg-surface-base border border-border-weak-base text-text-strong"
      value={props.value}
      onInput={(e) => e.currentTarget.value && props.onChange(Number(e.currentTarget.value))}
    />
    <span class="text-11-regular text-text-weak">px</span>
  </div>
)

const FontSelect: Component<{
  value: string
  onChange: (v: string) => void
  label: (o: (typeof FONT_OPTIONS)[number]) => string
}> = (props) => (
  <Select
    options={[...FONT_OPTIONS]}
    current={FONT_OPTIONS.find((o) => o.value === props.value)}
    value={(o) => o.value}
    label={(o) => props.label(o)}
    onSelect={(o) => o && props.onChange(o.value)}
    variant="secondary"
    size="small"
    triggerVariant="settings"
    triggerStyle={{ "font-family": monoFontFamily(props.value), "min-width": "160px" }}
  >
    {(o) => <span style={{ "font-family": monoFontFamily(o?.value) }}>{o ? props.label(o) : ""}</span>}
  </Select>
)

export const SettingsCustomization: Component = () => {
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  // Inline name prompt for Save-as / Rename / Duplicate. `naming` holds which
  // action is in flight; `nameInput` is the field value.
  const [naming, setNaming] = createSignal<"saveAs" | "rename" | "duplicate" | null>(null)
  const [nameInput, setNameInput] = createSignal("")

  const commitName = () => {
    const name = nameInput().trim()
    const action = naming()
    if (!name || !action) return setNaming(null)
    if (action === "saveAs") settings.themes.saveAs(name)
    if (action === "rename") {
      const id = settings.themes.activeID()
      if (id) settings.themes.rename(id, name)
    }
    if (action === "duplicate") {
      const id = settings.themes.activeID()
      if (id) settings.themes.duplicate(id, name)
    }
    setNaming(null)
    setNameInput("")
  }

  const mode = () => theme.mode()

  const groups = createMemo(() => {
    const q = query().toLowerCase().trim()
    if (!q) return THEME_CATALOG
    return THEME_CATALOG.map((g) => ({
      group: g.group,
      entries: g.entries.filter(
        (e) => e.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q) || e.token.includes(q),
      ),
    })).filter((g) => g.entries.length > 0)
  })

  // Token-backed reads/writes for the Fonts pane. Heading + inline-code sizes and
  // the inline-code weight are override tokens (unlike body size/weight, which are
  // appearance fields). Size tokens carry a px unit; weight tokens are unitless.
  const tokenNum = (token: string, fallback: number): number =>
    parseFloat(settings.overrides.get(mode(), token) ?? computed(token)) || fallback
  const tokenSize = (token: string) => tokenNum(token, 14)
  const setTokenSize = (token: string, px: number) => settings.overrides.set(mode(), token, `${px}px`)
  const setTokenWeight = (token: string, weight: number) => settings.overrides.set(mode(), token, `${weight}`)

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-3 pt-6 pb-4">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-baseline gap-2 min-w-0">
              <h2 class="text-16-medium text-text-strong shrink-0">{language.t("settings.tab.customization")}</h2>
              <span class="text-12-regular text-text-weak truncate">
                {settings.themes.activeName()}
                <Show when={settings.themes.dirty()}>
                  <span class="text-text-warning-base"> •</span>
                </Show>
              </span>
            </div>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="small" onClick={() => settings.overrides.resetAll(mode())}>
                {language.t("settings.customization.resetAll")}
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={!settings.themes.dirty()}
                onClick={() => settings.themes.discard()}
              >
                {language.t("settings.customization.discard")}
              </Button>
              <DropdownMenu>
                <DropdownMenu.Trigger as={Button} variant="primary" size="small" disabled={!settings.themes.dirty()}>
                  {language.t("settings.customization.save")}
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="mt-1">
                    <Show when={settings.themes.activeID()}>
                      <DropdownMenu.Item onSelect={() => settings.themes.saveOver()}>
                        <DropdownMenu.ItemLabel>Save to “{settings.themes.activeName()}”</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </Show>
                    <Show when={!settings.themes.activeID()}>
                      <DropdownMenu.Item onSelect={() => settings.themes.saveToCustomized()}>
                        <DropdownMenu.ItemLabel>Save as “{settings.themes.activeName()}”</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </Show>
                    <DropdownMenu.Item
                      onSelect={() => {
                        setNameInput("")
                        setNaming("saveAs")
                      }}
                    >
                      <DropdownMenu.ItemLabel>Save as new theme…</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
              <Show when={settings.themes.activeID()}>
                <DropdownMenu>
                  <DropdownMenu.Trigger as={Button} variant="secondary" size="small">
                    ⋯
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="mt-1">
                      <DropdownMenu.Item
                        onSelect={() => {
                          setNameInput(`${settings.themes.activeName()} copy`)
                          setNaming("duplicate")
                        }}
                      >
                        <DropdownMenu.ItemLabel>Duplicate…</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() => {
                          setNameInput(settings.themes.activeName())
                          setNaming("rename")
                        }}
                      >
                        <DropdownMenu.ItemLabel>Rename…</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() => {
                          const id = settings.themes.activeID()
                          if (id) settings.themes.remove(id)
                        }}
                      >
                        <DropdownMenu.ItemLabel>Delete</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </Show>
            </div>
          </div>
          <Show when={naming()}>
            <div class="flex items-center gap-2">
              <input
                type="text"
                autofocus
                placeholder="Theme name"
                class="flex-1 px-3 py-1.5 text-13-regular rounded-md bg-surface-base border border-border-weak-base text-text-strong"
                value={nameInput()}
                onInput={(e) => setNameInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName()
                  if (e.key === "Escape") setNaming(null)
                }}
              />
              <Button variant="primary" size="small" onClick={commitName}>
                {language.t("common.save") ?? "Save"}
              </Button>
              <Button variant="ghost" size="small" onClick={() => setNaming(null)}>
                {language.t("common.cancel") ?? "Cancel"}
              </Button>
            </div>
          </Show>
          <div class="flex items-center justify-between gap-4">
            <span class="text-12-regular text-text-weak">
              {language.t("settings.customization.modeNote")} <b class="text-text-strong">{mode()}</b>
            </span>
            <input
              type="text"
              placeholder={language.t("settings.customization.search")}
              class="w-56 px-3 py-1.5 text-13-regular rounded-md bg-surface-base border border-border-weak-base text-text-strong"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <Show when={!query().trim()}>
          <div class="flex flex-col gap-1">
            <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.fonts.title")}</h3>
            <div class="bg-surface-raised-base px-4 rounded-lg divide-y divide-border-weak-base">
              <div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 pb-2 pt-3 text-11-regular text-text-weak">
                <span />
                <span class="w-40 text-left">{language.t("settings.fonts.col.font")}</span>
                <span class="w-24 text-left">{language.t("settings.fonts.col.size")}</span>
                <span class="w-24 text-left">{language.t("settings.fonts.col.weight")}</span>
              </div>

              <div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 py-3">
                <span class="text-14-medium text-text-strong">{language.t("settings.fonts.body")}</span>
                <div class="w-40">
                  <FontSelect
                    value={settings.appearance.font()}
                    onChange={(v) => settings.appearance.setFont(v)}
                    label={(o) => language.t(o.label)}
                  />
                </div>
                <div class="w-24">
                  <SizeInput
                    value={settings.appearance.fontSize()}
                    onChange={(v) => settings.appearance.setFontSize(v)}
                  />
                </div>
                <div class="w-24">
                  <WeightControl
                    font={settings.appearance.font()}
                    value={settings.appearance.fontWeight()}
                    onChange={(v) => settings.appearance.setFontWeight(v)}
                    compact
                  />
                </div>
              </div>

              <For each={[1, 2, 3, 4, 5, 6]}>
                {(level) => (
                  <div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 py-3">
                    <span class="text-14-medium text-text-strong">{`H${level}`}</span>
                    <span
                      class="w-40 text-11-regular text-text-weaker italic"
                      style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                    >
                      {language.t("settings.fonts.inheritsBody")}
                    </span>
                    <div class="w-24">
                      <SizeInput
                        value={tokenSize(`--markdown-heading-${level}-size`)}
                        onChange={(v) => setTokenSize(`--markdown-heading-${level}-size`, v)}
                      />
                    </div>
                    <div class="w-24">
                      <WeightControl
                        font={settings.appearance.font()}
                        value={settings.appearance.headingWeight(level)}
                        onChange={(v) => settings.appearance.setHeadingWeight(level, v)}
                        compact
                      />
                    </div>
                  </div>
                )}
              </For>

              <div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 py-3">
                <span class="text-14-medium text-text-strong">{language.t("settings.fonts.codeBlock")}</span>
                <div class="w-40">
                  <FontSelect
                    value={settings.appearance.codeBlockFont()}
                    onChange={(v) => settings.appearance.setCodeBlockFont(v)}
                    label={(o) => language.t(o.label)}
                  />
                </div>
                <span class="w-24 text-11-regular text-text-weaker italic">
                  {language.t("settings.fonts.fromCodeTheme")}
                </span>
                <span class="w-24" />
              </div>

              <div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 py-3">
                <span class="text-14-medium text-text-strong">{language.t("settings.fonts.inlineCode")}</span>
                <div class="w-40">
                  <FontSelect
                    value={settings.appearance.inlineCodeFont()}
                    onChange={(v) => settings.appearance.setInlineCodeFont(v)}
                    label={(o) => language.t(o.label)}
                  />
                </div>
                <div class="w-24">
                  <SizeInput
                    value={tokenSize("--markdown-inline-code-size")}
                    onChange={(v) => setTokenSize("--markdown-inline-code-size", v)}
                  />
                </div>
                <div class="w-24">
                  <WeightControl
                    font={settings.appearance.inlineCodeFont()}
                    value={tokenNum("--markdown-inline-code-weight", 500)}
                    onChange={(v) => setTokenWeight("--markdown-inline-code-weight", v)}
                    compact
                  />
                </div>
              </div>
            </div>

            <h3 class="text-14-medium text-text-strong pb-2 pt-4">{language.t("settings.fonts.codeTheme.title")}</h3>
            <div class="bg-surface-raised-base px-4 rounded-lg">
              <SettingsRow
                title={language.t("settings.fonts.codeTheme.title")}
                description={language.t("settings.fonts.codeTheme.description")}
              >
                <Select
                  options={[...CODE_THEME_OPTIONS]}
                  current={CODE_THEME_OPTIONS.find((o) => o.value === settings.appearance.codeTheme())}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(o) => o && settings.appearance.setCodeTheme(o.value)}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                  triggerStyle={{ "min-width": "180px" }}
                >
                  {(o) => <span>{o?.label ?? ""}</span>}
                </Select>
              </SettingsRow>

              <SettingsRow
                title={language.t("settings.fonts.diffTheme.title")}
                description={language.t("settings.fonts.diffTheme.description")}
              >
                <Select
                  options={[...CODE_THEME_OPTIONS]}
                  current={CODE_THEME_OPTIONS.find((o) => o.value === settings.appearance.diffTheme())}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(o) => o && settings.appearance.setDiffTheme(o.value)}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                  triggerStyle={{ "min-width": "180px" }}
                >
                  {(o) => <span>{o?.label ?? ""}</span>}
                </Select>
              </SettingsRow>
            </div>
          </div>
        </Show>

        <For each={groups()}>
          {(group) => (
            <div class="flex flex-col gap-1">
              <h3 class="text-14-medium text-text-strong pb-2">{group.group}</h3>
              <div class="bg-surface-raised-base px-4 rounded-lg">
                <For each={group.entries}>
                  {(entry) => {
                    const override = () => settings.overrides.get(mode(), entry.token)
                    return (
                      <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                        <div class="flex flex-col gap-0.5 min-w-0">
                          <span class="text-14-medium text-text-strong">{entry.label}</span>
                          <span class="text-11-regular font-mono text-text-weak">{entry.token}</span>
                          <Show when={entry.shared}>
                            <span class="text-11-regular text-text-warning-base">
                              {language.t("settings.customization.shared")} {entry.shared}
                            </span>
                          </Show>
                        </div>
                        <div class="flex items-center gap-2 flex-shrink-0">
                          <ColorEditor
                            entry={entry}
                            value={override()}
                            onChange={(v) => settings.overrides.set(mode(), entry.token, v)}
                          />
                          <Show when={override() !== undefined}>
                            <Button
                              variant="ghost"
                              size="small"
                              onClick={() => settings.overrides.reset(mode(), entry.token)}
                            >
                              {language.t("settings.customization.reset")}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
