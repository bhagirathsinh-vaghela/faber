import { children, createEffect, createMemo, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js"
import { Collapsible } from "./collapsible"
import { Icon, IconProps } from "./icon"
import { CopyButton } from "./copy-button"
import { useBoxDefaults } from "../context/box-defaults"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element
  children?: JSX.Element
  hideDetails?: boolean
  defaultOpen?: boolean
  // Box-type key (the tool name) used to look up the client-configured per-mode
  // collapse default. Auto-threaded from ToolProps via `{...props}`. When set
  // and a BoxDefaults provider is present, the configured default drives initial
  // open state and re-applies on mode switch; otherwise falls back to
  // `defaultOpen`.
  tool?: string
  forceOpen?: boolean
  locked?: boolean
  // Sequential box index, rendered inline at the start of the header row (the
  // shadcn/message-box convention: index is header metadata, not a stacked
  // line above the card).
  blockNumber?: number
  // Optional title-bar copy button. Prefer a body-level copy (next to the
  // visible content) instead: fenced-output tools get one free from CodeBlock,
  // and non-fenced tools render their own via the tool-body slot. This prop is
  // kept for non-tool callers (e.g. MessageBox) that have no separate body.
  copy?: () => string
}

export function BasicTool(props: BasicToolProps) {
  const defaults = useBoxDefaults()

  // The default open state for this box in the active mode, driven ENTIRELY by
  // the client's per-mode collapse checkboxes: ticked = collapsed, so
  // open = !collapsed. No hardcoded per-tool default — the setting is the only
  // source of truth. `defaultOpen` remains only for non-tool callers (MessageBox
  // etc.) and tests with no provider/type wired.
  const configured = createMemo(() => {
    if (defaults && props.tool) return !defaults.collapsed(props.tool, defaults.mode())
    return props.defaultOpen ?? false
  })

  // `manual` = the user's expand/collapse since the last mode switch; undefined
  // means untouched (follow the configured default). It resets on every mode
  // change so re-entering a mode re-applies that mode's default and discards
  // any manual override, per the design.
  const [manual, setManual] = createSignal<boolean | undefined>(undefined)
  if (defaults) createEffect(on(defaults.mode, () => setManual(undefined), { defer: true }))

  const open = createMemo(() => {
    if (props.forceOpen) return true
    return manual() ?? configured()
  })

  // Resolve children once into a stable accessor. Gating Collapsible.Content on
  // `props.children` truthiness via <Show> memoizes the resolved element and
  // freezes streaming updates inside it (e.g. bash output that grows over time).
  // The children() helper keeps the inner reactivity live while still letting us
  // check whether a body exists.
  const body = children(() => props.children)

  const handleOpenChange = (value: boolean) => {
    if (props.locked && !value) return
    setManual(value)
  }

  const hasActions = () => (isTriggerTitle(props.trigger) && (props.trigger as TriggerTitle).action) || props.copy

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange}>
      {/* Row wrapper holds the trigger button and the actions as SIBLINGS, so
          the interactive action controls (open-link, copy) never nest inside
          the trigger <button> (invalid HTML / a11y). Mirrors Tabs.Trigger. */}
      <div data-component="tool-trigger">
        <Collapsible.Trigger>
          <div data-slot="basic-tool-tool-trigger-content">
            <Show when={props.blockNumber !== undefined}>
              <span data-slot="basic-tool-block-number">{"#" + props.blockNumber}</span>
            </Show>
            <Icon name={props.icon} size="small" />
            <div data-slot="basic-tool-tool-info">
              <Switch>
                <Match when={isTriggerTitle(props.trigger) && props.trigger}>
                  {(trigger) => (
                    <div data-slot="basic-tool-tool-info-structured">
                      <div data-slot="basic-tool-tool-info-main">
                        <span
                          data-slot="basic-tool-tool-title"
                          classList={{
                            [trigger().titleClass ?? ""]: !!trigger().titleClass,
                          }}
                        >
                          {trigger().title}
                        </span>
                        <Show when={trigger().subtitle}>
                          <span
                            data-slot="basic-tool-tool-subtitle"
                            classList={{
                              [trigger().subtitleClass ?? ""]: !!trigger().subtitleClass,
                            }}
                          >
                            {trigger().subtitle}
                          </span>
                        </Show>
                        <Show when={trigger().args?.length}>
                          <For each={trigger().args}>
                            {(arg) => (
                              <span
                                data-slot="basic-tool-tool-arg"
                                classList={{
                                  [trigger().argsClass ?? ""]: !!trigger().argsClass,
                                }}
                              >
                                {arg}
                              </span>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                  )}
                </Match>
                <Match when={true}>{props.trigger as JSX.Element}</Match>
              </Switch>
            </div>
            <Show when={body() && !props.hideDetails && !props.locked}>
              <Collapsible.Arrow />
            </Show>
          </div>
        </Collapsible.Trigger>
        {/* Actions live OUTSIDE the trigger button so they are siblings, not
            interactive elements nested in a <button>. */}
        <Show when={hasActions()}>
          <div data-slot="basic-tool-actions">
            <Show when={isTriggerTitle(props.trigger) && (props.trigger as TriggerTitle).action}>
              {(action) => action()}
            </Show>
            <Show when={props.copy}>
              <CopyButton content={props.copy!} class="basic-tool-copy" />
            </Show>
          </div>
        </Show>
      </div>
      <Show when={!props.hideDetails && body()}>
        <Collapsible.Content>{body()}</Collapsible.Content>
      </Show>
    </Collapsible>
  )
}
