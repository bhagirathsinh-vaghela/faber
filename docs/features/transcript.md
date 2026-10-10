# Transcript

The transcript renders every block the model API returns as its own card: user text, assistant text, thinking, and each tool call with its result. Cards are coloured by kind and numbered by message. Markdown streams without flicker, supports callout blocks, and highlights code once a block is finished. Older turns collapse their steps, and the list is virtualized so a very long session keeps a constant DOM size. Blocks injected for the model rather than the reader (rule reminders, the MCP catalog, mid-turn nudges) are hidden unless a debug switch is on.

## How it works

### One card per block

The rule is that every block arriving on the API is its own box. All cards share one base component, `TranscriptCard`, which owns the header layout: a block number, a title, a timestamp, an optional jump-to-message affordance, and a copy button. Card types fill in structured header fields rather than supplying their own DOM, so no card can grow a second header line or a different baseline.

The block number is per message, not per part. A text block and the tool calls it made in the same assistant message share one number.

### Streaming markdown

| Stage           | Behaviour                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| While streaming | only the settled prefix renders; an unclosed bold, link, code span or fence is withheld until it closes       |
| Code fences     | Shiki highlighting runs once when the part completes, through a bounded LRU keyed on theme, language and code |
| On completion   | the full text renders                                                                                         |

Without the settled-prefix rule, a half-typed construct shows as raw source (a literal `**` or a bare fence) and then jumps when it closes. Without the completion gate, Shiki re-lexed the whole fence on every streamed append, about ten times a second.

### Callouts

Chat markdown supports container directives that render as styled blocks:

| Directive            | Renders as                                                     |
| -------------------- | -------------------------------------------------------------- |
| `:::key`             | "Key point" aside                                              |
| `:::fix`             | "Correction" aside                                             |
| `:::anchor`          | "Anchor" aside                                                 |
| `:::tangent`         | "Tangent" aside                                                |
| `:::check[question]` | a `<details>` block: the question shows, the answer folds away |

Only container directives (a line starting with `:::`) are enabled. The `remark-directive` default also enables inline text directives, whose `:name` pattern matches ordinary prose such as `13:20` or `localhost:8080` and silently eats the text after the colon, so `remarkDirectiveContainerOnly` drops them. An unknown `:::name` falls back to plain rendering.

### Collapsed steps

The three most recent turns render with their steps expanded; older turns collapse to keep the DOM bounded. A manual expand or collapse of any box is stored per session in the layout context, so it survives the session page unmounting (a trip to the overview) and virtua unmounting a turn scrolled out of view. It is not persisted across reloads.

### Virtualization

Turns render through virtua's `Virtualizer`, so only the visible window plus overscan is mounted. Jumps (Home, End, deep links, previous and next prompt) go through `scrollToIndex`, which mounts an off-screen target before scrolling to it.

Following the tail is a synchronous `scrollTop` pin driven by a `ResizeObserver` on the transcript content, not virtua's own `scrollTo`, which re-applies an offset captured earlier and scrolls away from a growing tail. Follow state changes only on user gestures: scrolling off the bottom stops following, scrolling back resumes it.

### Hidden machinery

A synthetic part can be either a result the reader wants (a finished job, a restart notice) or text that steers the model (a reminder, the MCP catalog, a plan-mode transition, a tool-flow nudge). Parts of the second kind carry an `internal` flag, set where the block is written. The transcript hides internal parts; the model still receives them unchanged. Turning on **Show internal messages** (`settings.debug.showInternal`, the last row of the layout settings page) renders them in a plain box labelled INTERNAL, for reading what the model was actually sent.

### Keys

| Key                       | Action                      |
| ------------------------- | --------------------------- |
| `alt+9` / `mod+arrowup`   | previous user prompt        |
| `alt+0` / `mod+arrowdown` | next user prompt            |
| Home / End                | jump to the top or the tail |

## Configuration

None in `opencode.json`. Show internal messages is a client setting.

## Why

- **Virtualization.** The transcript used to mount every turn as live DOM forever, so long sessions grew toward the iOS tab-kill ceiling of about 100 MB.
- **Settled-prefix streaming.** An earlier parser re-parsed the whole buffer every 100 ms, which fragmented a single code block into several boxes; partial constructs also flashed as raw markdown.
- **The `internal` flag.** Rendering on the synthetic flag alone put reminder markers in the transcript as boxes the reader did not write and cannot act on. Setting the flag at the write site avoids guessing from text, which a reworded reminder would defeat.

## Code

| Area                    | Pointer                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Card base               | `packages/ui/src/components/transcript-card.tsx` (`TranscriptCard`)                          |
| Parts and turns         | `packages/ui/src/components/message-part.tsx`, `session-turn.tsx`                            |
| Markdown, callouts      | `packages/ui/src/components/markdown.tsx` (`remarkCallouts`, `remarkDirectiveContainerOnly`) |
| Callout names           | `packages/util/src/callout.ts` (`CALLOUTS`)                                                  |
| Virtualized list, steps | `packages/app/src/pages/session.tsx` (`Virtualizer`, `recentTurns`, `stepsExpandedDefault`)  |
| Box expand state        | `packages/app/src/context/layout.tsx` (`boxes`)                                              |
| Debug switch            | `packages/app/src/context/settings.tsx` (`debug.showInternal`)                               |
