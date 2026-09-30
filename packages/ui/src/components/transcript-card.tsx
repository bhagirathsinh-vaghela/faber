import { children, createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import { Collapsible } from "./collapsible"
import { Icon, IconProps } from "./icon"
import { CopyButton } from "./copy-button"
import { SpeakButton } from "./speak-button"
import { createBoxOpen, useBoxDefaults } from "../context/box-defaults"
import { useDataOptional } from "../context/data"
import { useI18n } from "../context/i18n"
import type { SpeakTarget } from "../context/data"
import { messageTime } from "../util/time"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

export interface TranscriptCardProps {
  icon: IconProps["name"]
  // Structured CONTENT, never arbitrary DOM: a card type fills in the fields and
  // the base decides how a header is built, so no card can grow a second line, a
  // second actions cluster, or its own baseline. A richer header becomes a new
  // named field here, for every card at once.
  trigger: TriggerTitle
  children?: JSX.Element
  hideDetails?: boolean
  defaultOpen?: boolean
  // Box-type key (the tool name) used to look up the client-configured per-mode
  // collapse default. Auto-threaded from ToolProps via `{...props}`. When set
  // and a BoxDefaults provider is present, the configured default drives open
  // state until the user overrides it; otherwise falls back to `defaultOpen`.
  tool?: string
  // Identity of this box's manual expand/collapse in the app-held store. Both
  // are needed for the override to survive; a box with neither falls back to
  // component-local state.
  sessionID?: string
  boxID?: string
  forceOpen?: boolean
  locked?: boolean
  // Sequential box index, rendered inline at the start of the header row (the
  // shadcn/message-box convention: index is header metadata, not a stacked
  // line above the card).
  blockNumber?: number
  // The card's timestamp (ms). Rendered as the leftmost item of the right-hand
  // control cluster. Omitted when a caller has no meaningful time.
  time?: number
  // A scroll-to-this-message affordance, rendered as a SIBLING before the
  // trigger button (never inside it — button-in-button is invalid). Used by the
  // injected result/notice cards in the sticky context to carry the jump-to
  // affordance.
  jump?: JSX.Element
  // Optional title-bar copy button. Prefer a body-level copy (next to the
  // visible content) instead: fenced-output tools get one free from CodeBlock,
  // and non-fenced tools render their own via the tool-body slot. This prop is
  // kept for the user/assistant cards, which have no separate body copy.
  copy?: () => string
  // Title-bar read-aloud button, rendered in the actions cluster. The SpeakButton
  // hides itself when the host has no speech support or nothing is ready to read.
  speak?: () => SpeakTarget | undefined
  // Undo control rendered first in the actions cluster (leftmost). The caller
  // owns its confirm dialog; this slot only positions it in the card chrome.
  revert?: JSX.Element
  // The card's colour identity, named ONCE. A card type says which family it
  // belongs to and the base derives every token from it — border, fill, header
  // text — so no card can hold one of the three and drop the others. A card that
  // names none is a tool card and wears the neutral grey.
  accent?: CardAccent
  // A colour that overrides the family's accent when a card's state is not plain
  // success (a failed subagent, a failed tool). Border and fill derive from it,
  // since such a colour has no token set of its own. Content, not structure: it
  // changes a colour and nothing else about the card.
  tone?: string
  // The body is bare content rather than a padded tool slot, so the base insets
  // it. Content shape, not structure: the inset itself is the base's.
  bare?: boolean
  // The subtitle is a STAND-IN for the body, not a label beside the title: it
  // shows what the collapsed card is hiding, and leaves once the body itself is
  // on screen. It also keeps the body's own type rather than the header's, so a
  // prompt reads the same in both states.
  summaryOnly?: boolean
  // The part's state, in the tool-state vocabulary. While it is "pending"
  // (arguments streaming) or "running" and its session's turn is live, the
  // header sweeps, so a live card reads as live whether it is open or collapsed
  // and whether or not its body has anything to show yet. The turn gate is
  // needed because a turn killed mid-tool (a server restart) leaves its part
  // stored as "running" for good.
  status?: string
}

// Every colour a card can wear. A family owns a matching accent/border/fill set
// in the theme, so naming the family is enough for the base to reach all three.
export type CardAccent = "user" | "assistant" | "subagent" | "job" | "thinking" | "tool"

// Per-tool accent: a tool can name its own token, or fall back to its
// family's. The family is the default so the transcript is scannable by
// action type; a per-tool entry overrides it when a card needs to stand
// out from its siblings.
type ToolFamily = "readonly" | "write" | "execute" | "agent"
const TOOL_ACCENTS: Record<string, string> = {}
const TOOL_FAMILIES: Record<string, ToolFamily> = {
  read: "readonly",
  grep: "readonly",
  glob: "readonly",
  list: "readonly",
  codesearch: "readonly",
  lsp: "readonly",
  websearch: "readonly",
  webfetch: "readonly",
  mcp_search: "readonly",
  todoread: "readonly",
  write: "write",
  edit: "write",
  patch: "write",
  apply_patch: "write",
  multiedit: "write",
  batch: "write",
  bash: "execute",
  mcp: "execute",
  skill: "agent",
  todowrite: "agent",
  question: "agent",
  plan_enter: "agent",
  plan_exit: "agent",
  agent: "agent",
  system_notice: "agent",
}

function toolAccent(tool?: string): string | undefined {
  if (!tool) return undefined
  const direct = TOOL_ACCENTS[tool]
  if (direct) return direct
  const family = TOOL_FAMILIES[tool]
  if (family) return `var(--box-accent-tool-${family})`
  return undefined
}

function accentTokens(accent: CardAccent, tone?: string, tool?: string) {
  if (tone) return { "--box-accent-tool": tone }
  const resolved = accent === "tool" ? toolAccent(tool) : undefined
  const base = resolved ?? `var(--box-accent-${accent})`
  // A thinking card's border wears the Claude colour; its washes and fill are
  // the assistant card's (transcript-card.css colours the header labels).
  const line = accent === "thinking" ? "var(--box-accent-claude)" : base
  return {
    "--box-accent-tool": base,
    "--box-border-tool": `color-mix(in srgb, ${line} 80%, var(--box-backdrop, #010409))`,
    "--box-bg-tool": `color-mix(in srgb, ${base} 7%, var(--box-backdrop, #010409))`,
  }
}

export function TranscriptCard(props: TranscriptCardProps) {
  const defaults = useBoxDefaults()
  const i18n = useI18n()
  const transcript = useDataOptional()
  const streaming = () =>
    (props.status === "pending" || props.status === "running") &&
    !!props.sessionID &&
    !!transcript?.store.session_busy[props.sessionID]?.turn

  // The default open state for this box in the active mode, driven ENTIRELY by
  // the client's per-mode collapse checkboxes: ticked = collapsed, so
  // open = !collapsed. No hardcoded per-tool default — the setting is the only
  // source of truth. `defaultOpen` remains only for callers with no box-type key
  // and tests with no provider/type wired.
  const configured = createMemo(() => {
    if (defaults && props.tool) return !defaults.collapsed(props.tool, defaults.mode())
    return props.defaultOpen ?? false
  })

  const [resolved, setOpen] = createBoxOpen({
    sessionID: () => props.sessionID,
    boxID: () => props.boxID,
    fallback: configured,
  })

  const open = createMemo(() => {
    if (props.forceOpen) return true
    return resolved()
  })

  // Resolve children once into a stable accessor. Gating Collapsible.Content on
  // `props.children` truthiness via <Show> memoizes the resolved element and
  // freezes streaming updates inside it (e.g. bash output that grows over time).
  // The children() helper keeps the inner reactivity live while still letting us
  // check whether a body exists.
  const body = children(() => props.children)
  // A card with several children resolves to an array even when every branch
  // rendered nothing, and an array is truthy.
  const hasBody = () => body.toArray().some((node) => node !== undefined && node !== null && node !== false)

  const handleOpenChange = (value: boolean) => {
    if (props.locked && !value) return
    setOpen(value)
  }

  const arrowShows = () => hasBody() && !props.hideDetails && !props.locked
  // A summary stands in for the body, so it belongs to the collapsed state only.
  const summaryHidden = () => !!props.summaryOnly && open()
  // The right cluster holds the controls only, so it renders when a card has one
  // and is absent otherwise. The header reads: identity · icon · title … controls.
  const hasActions = () => props.trigger.action || props.copy || props.speak || props.revert || arrowShows()

  const content = (
    <div data-slot="transcript-card-trigger-content">
      {/* The split is by ORIGIN, not position. The left cluster is everything the
          card owns and always shows — the jump control, the index over the
          timestamp, the icon, and the title with whatever the card states about
          itself (a status, a duration). It is one element with one hover, since
          split up each part would summon the others from wherever the pointer
          happened to be. */}
      <div
        data-slot="transcript-card-identity"
        data-streaming={streaming() ? "true" : undefined}
      >
        {props.jump}
        <Show when={props.blockNumber !== undefined || props.time !== undefined}>
          <div data-slot="transcript-card-stamp">
            <Show when={props.blockNumber !== undefined}>
              <span data-slot="transcript-card-block-number">{"#" + props.blockNumber}</span>
            </Show>
            <Show when={props.time !== undefined}>
              <span data-slot="transcript-card-time">{messageTime(props.time!)}</span>
            </Show>
          </div>
        </Show>
        <Icon name={props.icon} size="normal" />
        <span
          data-slot="transcript-card-title"
          classList={{ [props.trigger.titleClass ?? ""]: !!props.trigger.titleClass }}
        >
          {props.trigger.title}
        </span>
      </div>
      <div data-slot="transcript-card-info">
        <div data-slot="transcript-card-info-structured">
          <div data-slot="transcript-card-info-main">
            <Show when={props.trigger.subtitle && !summaryHidden()}>
              <span
                data-slot="transcript-card-subtitle"
                data-summary={props.summaryOnly ? "true" : undefined}
                classList={{ [props.trigger.subtitleClass ?? ""]: !!props.trigger.subtitleClass }}
              >
                {props.trigger.subtitle}
              </span>
            </Show>
            <Show when={props.trigger.args?.length && !summaryHidden()}>
              <For each={props.trigger.args}>
                {(arg) => (
                  <span
                    data-slot="transcript-card-arg"
                    data-summary={props.summaryOnly ? "true" : undefined}
                    classList={{ [props.trigger.argsClass ?? ""]: !!props.trigger.argsClass }}
                  >
                    {arg}
                  </span>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      style={accentTokens(props.accent ?? "tool", props.tone, props.tool)}
      data-accent={props.accent ?? "tool"}
      data-body={props.bare ? "bare" : undefined}
    >
      {/* Row wrapper holds the trigger button and the actions as SIBLINGS, so
          the interactive action controls (open-link, copy) never nest inside
          the trigger <button> (invalid HTML / a11y). Mirrors Tabs.Trigger. */}
      {/* A locked card's header cannot toggle anything, so it carries no
          clickable affordance: the wash and the pointer would advertise a
          press that does nothing. */}
      <div data-component="transcript-card-trigger" data-locked={props.locked ? "true" : undefined}>
        {/* A card that can toggle gets a real button; a locked one gets an inert
            div carrying the same slot, so it looks identical and behaves like the
            text it is. A button that toggles nothing is the wrong element: the UA
            and the utility sheet both give any <button> a pointer, and a control
            in the tab order that does nothing on Enter is worse than no control.
            Every OTHER difference between the two still comes from the base. */}
        <Show when={props.locked} fallback={<Collapsible.Trigger>{content}</Collapsible.Trigger>}>
          <div data-slot="collapsible-trigger">{content}</div>
        </Show>
        {/* Actions live OUTSIDE the trigger button so they are siblings, not
            interactive elements nested in a <button>. */}
        <Show when={hasActions()}>
          <div data-slot="transcript-card-actions">
            {props.revert}
            <Show when={props.trigger.action}>{(action) => action()}</Show>
            <Show when={props.speak}>
              <SpeakButton content={props.speak!} class="transcript-card-speak" />
            </Show>
            <Show when={props.copy}>
              <CopyButton content={props.copy!} class="transcript-card-copy" />
            </Show>
            {/* One home for the chevron on every card, and decoration rather than
                a control: the header button beside it already toggles this card
                and announces the state. A second focusable copy would be a tab
                stop that duplicates the trigger while announcing no state of its
                own, so it stays a mouse affordance the pointer can aim at. */}
            <Show when={arrowShows()}>
              <Collapsible.Arrow onClick={() => handleOpenChange(!open())} />
            </Show>
          </div>
        </Show>
      </div>
      <Show when={!props.hideDetails && hasBody()}>
        <Collapsible.Content>{body()}</Collapsible.Content>
      </Show>
    </Collapsible>
  )
}
