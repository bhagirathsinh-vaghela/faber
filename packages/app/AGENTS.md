## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- `opencode dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Responsive layout: three inputs, three questions

Every regression in this area came from one input answering another's question,
so each is allowed exactly one. Before adding a responsive rule, decide which
question is being asked:

| Question                                | Mechanism          | Looks like                                |
| --------------------------------------- | ------------------ | ----------------------------------------- |
| How many panes fit in the window?       | shell size class   | `compact:` `wide:` `expanded:`            |
| How much room does THIS component have? | container query    | `dock-wide:` `panel-wide:`                |
| Mouse or finger?                        | pointer capability | `any-pointer-coarse:` `any-pointer-fine:` |

**Never add a raw width media query or `matchMedia`.** The size class is
published once, on `<html>` as `data-size-class`, by `ui/util/shell.ts`, and the
variants select on that attribute rather than re-evaluating width. That is what
keeps a stylesheet from reaching a different verdict than the JS beside it, and
it is what makes a forced class reach rules that never learn it exists. A test
fails if a width media query reappears anywhere.

The key, thresholds, and classification live in `ui/util/size-class.ts`. The
pre-paint script (`public/oc-theme-preload.js`) cannot import it, so it carries
a copy that `shell-preload-parity.test.ts` pins to the module. A pinned layout
is per-tab (sessionStorage): each client connected to the server decides its
own view, and the toggle cycles auto → compact → expanded → auto so both ends
are reachable from any natural class.

Three constraints that are not obvious and have each caused a bug:

- **An element cannot match a container query it declares.** Put the
  `@container/x` on a bare wrapper and the styled classes one level in.
- **A container query cannot see an explicit choice**, since it only measures a
  box. The panel variants require both enough room and a shell that was not
  asked for something narrower, or forcing the compact layout leaves a wide dock
  rendering the roomy one.
- **Touch size is not a width question.** A tablet renders the roomy layout and
  is touched, so both layouts size for both inputs: the dense size is the base
  and a coarse pointer grows it.

`e2e/app/responsive.spec.ts` holds all of this, including the breakpoint edges
and a window too short for the panes its width would allow. It has been
mutation-tested: reverting any of the three constraints above fails a named
test.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
