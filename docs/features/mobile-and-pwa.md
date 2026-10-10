# Mobile and PWA

The web UI embedded in the server binary installs as a Progressive Web App on desktop browsers, iPhone, iPad and Android. Phones and tablets are full clients of the same server as the desktop, so most of this page is about WebKit on touch devices.

## How it works

### Installing

Open the server URL in a browser and use its install action (Install app, or Add to Home Screen on iOS). Installation needs a secure origin, so a server reached over plain HTTP from another device must sit behind HTTPS. The manifest (`site.webmanifest`) requests `standalone` display with a `window-controls-overlay` override, so an installed desktop PWA draws its own titlebar into the `env(titlebar-area-*)` strip instead of sitting under the browser's native title bar.

Install icons are labelled with the first component of the server host's name, so PWAs saved from different servers can be told apart. The icon URLs carry a content hash because Chrome refreshes an installed app's icon only when the URL changes.

An installed PWA has no address bar, so the titlebar shows a reload button in that mode only.

### Size classes

`packages/ui/src/util/size-class.ts` is the single definition of the shell size classes:

| Class      | Rule                                          |
| ---------- | --------------------------------------------- |
| `compact`  | narrower than 600 px                          |
| `medium`   | at least 600 px wide                          |
| `expanded` | at least 840 px wide and at least 480 px tall |

The thresholds follow the Material window size classes; height demotes a wide but short window (a landscape phone) that has no room for a third pane. The class is published on the root element as `data-size-class`, and Tailwind variants select on that attribute, so CSS cannot reach a different verdict than the JavaScript beside it. The signal comes from `matchMedia`, so dragging a window does no work until a threshold is crossed.

A titlebar control pins the layout per tab, walking auto, compact, expanded, auto. The pin lives in `sessionStorage` (`opencode-size-class`), so it survives a reload of that tab and does not leak into other tabs. A pre-paint script (`oc-theme-preload.js`) applies the class before any bundle loads; a parity test keeps its copy of the thresholds in step with the module.

The documented rule for responsive code is one question per mechanism:

| Question                    | Answered by                   |
| --------------------------- | ----------------------------- |
| What fits in this box?      | container queries             |
| How big should a target be? | the pointer (`any-pointer`)   |
| Which shell layout?         | the size class, unless pinned |

### Touch targets

Controls default to a 32 px dense size and widen to 40 px when a coarse pointer is available (`--control-height`). The composer's send and stop buttons go further, to 44 px. The query is `any-pointer`, so a laptop with a touchscreen gets the larger target. Keyboard hints beside question actions appear only where a fine pointer implies a keyboard.

### Soft keyboard

On iOS, WebKit shrinks the visual viewport for the keyboard but not the layout viewport, so a `100dvh` root becomes scrollable and iOS scrolls the titlebar away to reveal the caret. The app sizes the root to `visualViewport.height` on touch WebKit, so the transcript absorbs the lost height and the titlebar and dock stay put.

The platform owns the keyboard: a tap on the editor raises it like any text field. On touch devices the editor takes focus only from a tap on itself, so pressing the mic or submit, or closing an overlay, does not bring the keyboard up behind it.

### First tap

A button that takes focus blurs the composer, and WebKit spends that tap on the blur instead of the click, so controls beside a focused composer needed two presses. `Button` and `IconButton` cancel the focus shift for every caller. Controls with `aria-haspopup` are exempt, since they need focus to hand it to their menu.

Sends and answers paint optimistically on the press. Because answering swaps the next queued permission or question into the same spot within a frame, those paths drop further presses for 350 ms and ignore a held Enter or Space, so a double-click cannot answer a request the user never saw.

### Service worker

`sw.js` serves everything under `/assets/` cache-first. Those files are content-hashed and immutable, so a cached entry cannot be stale. The shell assets are precached at install; route chunks are cached on first fetch. The cache key strips the `oc_retry` query that the chunk-retry path adds, so a retry hits the cached file. Navigations and API traffic are never cached, and `index.html` is `no-cache`, so a rebuilt UI is picked up on the next load.

## Configuration

None in `opencode.json`. The layout pin is per tab.

## Why

- **One size class.** Five subsystems each held their own idea of screen size at four thresholds that disagreed. A tablet took compact chrome from one and roomy content from another, and nothing could force a size all of them would honour.
- **Pointer, not width, for target size.** A narrow desktop window kept finger-sized buttons for a mouse, and a full-width tablet handed a 24 px target to a finger.
- **Letting the platform own the keyboard.** The dock used to suppress the keyboard (`inputmode="none"`) and raise it from a button. That meant fighting WebKit for a focus it would not grant twice, and the button needed two presses after the keyboard's own hide key.
- **Caching assets.** The worker started as a no-op that existed only for installability. On WebKit a chunk that fails to load is memoized as a rejected module and can only be fixed by a reload, which then needed the same connection that just failed.
- **Per-tab pin.** The pin was in `localStorage`, so one tab's choice leaked into every tab on the machine.

## Code

| Area                      | Pointer                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Size classes              | `packages/ui/src/util/size-class.ts` (`SIZE_QUERIES`, `measureSizeClass`, `SIZE_CLASS_KEY`) |
| Reactive shell signal     | `packages/ui/src/util/shell.ts`                                                             |
| Pre-paint script          | `packages/app/public/oc-theme-preload.js`                                                   |
| Viewport fit, SW register | `packages/app/src/entry.tsx`                                                                |
| Service worker            | `packages/app/public/sw.js`                                                                 |
| Manifest                  | `packages/app/public/site.webmanifest`                                                      |
| Icon labelling, serving   | `packages/opencode/src/server/web.ts`                                                       |
| Titlebar, reload button   | `packages/app/src/components/titlebar.tsx`                                                  |
