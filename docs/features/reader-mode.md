# Reader mode

Reader mode is a read-first layout for a session. It hides the composer and the pinned headers so the transcript fills the screen, while keeping the busy indicator and any pending question or permission visible. A small floating pill offers dictation; typing any character, a tap on empty space, a paste or a dictation brings the composer back over the read to reply, and sending drops it again. The mode is remembered per session in each browser tab.

## How it works

### Two states

| State                    | Entered by                                              | What shows                                                           |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Sticky read              | `alt+z`, or the book orb on the pill                    | transcript only; the pill floats a mic                               |
| Non-sticky reply overlay | a printable key, a tap on empty space, paste, dictation | the slim reader composer over the read, plus an exit orb on the pill |

A submit or a clear in the non-sticky overlay drops back to the clean read. `alt+z` or the exit orb leaves reader mode entirely. Entering the sticky read always starts clean, with no overlay raised.

### Typing lands in the composer

In the clean read the composer is hidden and inert, so nothing is focused to receive a keystroke. A bare printable key reveals the overlay and injects that character into the composer, which resolves a frame later. Paste, dictation and typing share one `landText` path for placing text on a composer that may be hidden. There is no keybind for opening an empty composer; that is a palette command (`reader.composer.summon`), because a bound Space would have been swallowed instead of typing a space.

Focus follows how the overlay was summoned: a keyboard summon always focuses the composer, while a tap focuses it only under a fine pointer, so a tap on a phone does not raise the soft keyboard over the text being read.

### The composer is hidden, not unmounted

The composer is hidden with `display: none` while the dock stays mounted. A question or permission renders as a sibling of the composer inside the dock, so the dock has to stay on screen to carry it. Hidden rather than unmounted, the draft survives and the dock keeps its size probe.

### The pill

`ReaderPill` is a vertical stack of orbs anchored above the composer area. Outside reader it shows a book orb that enters the sticky read. In reader the mic replaces it, and the exit orb appears above the mic while the reply overlay is up. Orbs are sized as fingertip targets on every device, and the stack can be dragged; its position addresses the bottom orb so the mic does not move when the exit orb appears.

The mic needs no dictation host of its own. The composer registers itself as the global fallback dictation target, and that registration survives the composer being hidden, so the pill's mic dictates into it (see [voice](voice.md)).

### Memory

Which sessions were left in reader is stored in `sessionStorage` under `opencode.reader.<sessionID>`. Leaving for the overview or reloading the tab restores the toggle; a new tab starts interactive, and a session seen for the first time opens interactive. Reader only applies on a session route; the overview ignores it.

Box collapse defaults have a separate column for reader mode in the layout settings, so a tool box can default to collapsed while reading and open while working.

### Keys and surfaces

| Action                 | Binding or surface                                          |
| ---------------------- | ----------------------------------------------------------- |
| Enter or leave reader  | `alt+z`, the book orb, or the exit orb                      |
| Reply without leaving  | type any character, tap empty space, paste, or dictate      |
| Open an empty composer | the command palette (`reader.composer.summon`)              |
| Dictate                | the mic orb on the pill                                     |
| Stop the running turn  | Escape, which works in reader even with no composer focused |

## Configuration

None in `opencode.json`. State is per tab.

## Why

- **One mode defined by intent.** Reader replaced an earlier "zen" mode that meant two things depending on the device: a slimmed dock under a mouse and no dock under a finger. That let the pointer decide the layout. Reader is a declaration that you are reading, which a mouse makes as readily as a thumb.
- **No "open in reader" default.** Opening every session with no composer is a trap on a phone, where the pill is the only way back, and reader cannot be declared before the transcript is on screen.
- **Two states instead of three.** An intermediate "revealed" state and a minimal flavor were more than the mode needed; they were folded into the sticky read and the non-sticky reply.
- **Per-tab memory.** Like the pinned size class, each client connected to the server decides its own view.

## Code

| Area                    | Pointer                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Reader state and memory | `packages/app/src/context/layout.tsx` (`readerMemory`, `enterReader`, `exitReader`, `reveal`)      |
| Reveal, focus, toggle   | `packages/app/src/pages/session.tsx` (`revealComposer`, `reader.toggle`, `reader.composer.summon`) |
| Pill                    | `packages/app/src/components/reader-pill.tsx` (`ReaderPill`)                                       |
| Composer text landing   | `packages/app/src/components/prompt-input.tsx`                                                     |
