# Alert sounds and notifications

Faber plays a distinct sound for each kind of event that matters to someone running several sessions: a turn finished, a turn needs an answer, a turn failed, and a session was stopped, archived or deleted. Each ended turn produces exactly one event and so exactly one sound, and the "done" sound waits until the session has truly gone quiet, with no subagent or background job still owed. A bell in the titlebar mutes every alert sound on that client.

## How it works

### One event per ended turn

The server announces how a turn ended with exactly one event:

| How the turn ended                                                              | Event                                 | Sound slot (default clip)       |
| ------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| finished, and the session is fully quiet                                        | `session.idle`                        | Agent (`yup-03`)                |
| failed, or interrupted with Esc                                                 | `session.error`                       | Errors (`nope-05`)              |
| a person pressed Stop                                                           | `session.stopped` (`action: stop`)    | Session stopped (`bip-bop-02`)  |
| a person archived the session                                                   | `session.stopped` (`action: archive`) | Session archived (`bip-bop-05`) |
| a person deleted the session                                                    | `session.stopped` (`action: delete`)  | Session deleted (`bip-bop-08`)  |
| the server stopped it (instance dispose, a headless run ending, the boot sweep) | none                                  | none                            |

A question or a permission prompt plays the Blocking prompts sound (`alert-02`) and raises a banner.

`session.idle` rides the busy push. A finished turn leaves a note (`SessionBusy.finish`), and `session.idle` is published on the push that reads the session's own turn, its subagents and its jobs all at zero while that note is set. The busy dot going dark and the chime are the same reading. A failed or interrupted turn sends `session.error` at once and drops the note. A Stop drops it too, since stop, archive and delete have their own sounds.

`session.stopped` is published only when the stop, archive or delete route passes `announce` to `Session.stop`. A stop the server makes for its own reasons passes nothing and stays silent, as do the child sessions a Stop walks.

### On the client

The alert listener in `packages/app/src/pages/layout.tsx` plays sounds through one `chime` helper that returns early when muted.

- A finished or failed turn is announced for a root session, or for whatever session this client has open, so watching a subagent still gets its chime (`utils/announce.ts`).
- Sounds play on every client, including for the session currently on screen.
- OS notifications are separate from sounds: per-slot toggles in settings, and suppressed while the window is visible and focused.
- A question or permission banner remembers the request it announces. When `question.replied`, `question.rejected` or `permission.replied` arrives for that request (answered on any client, dismissed, withdrawn, or auto-accepted), the banner comes down on every client.

### Muting

The titlebar bell toggles `settings.sounds.muted`. It silences every alert sound on this client, whatever session is open. The value lives in the client's persisted settings (`localStorage`), so it survives a reload and other devices keep their own. Notifications, toasts and the settings previews are unaffected.

## Configuration

None in `opencode.json`. Sound choices per slot, notification toggles and the mute bell are client settings under Settings, General.

## Why

- **One event per turn.** Esc used to play the error sound and then the done sound, because the processor published `session.error` and the loop then published `session.idle`. Stopping a session chimed "turn done" on every client, because idle was a side effect of setting the status.
- **Done only when quiet.** A finished turn with a background job or subagent still running would be woken again by its result, so the done sound played while the busy dot was lit and again when the real work ended.
- **Sounds for the session on screen.** Silencing the done sound for the focused session was tried and reverted. The done sound now marks the session going fully quiet, which the screen does not always make obvious.
- **A stop sound.** Once stops stopped producing turn-end events, a Stop gave no audible confirmation.

## Code

| Area                          | Pointer                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Quiet detection, idle publish | `packages/opencode/src/session/busy.ts` (`SessionBusy.finish`)                         |
| Stop announcement             | `packages/opencode/src/session/index.ts` (`Session.stop`, `announce`, `Event.Stopped`) |
| Alert listener, `chime`       | `packages/app/src/pages/layout.tsx`                                                    |
| Which turns are announced     | `packages/app/src/utils/announce.ts` (`announced`)                                     |
| Sound playback                | `packages/app/src/utils/sound.ts` (`playSound`)                                        |
| Settings, defaults            | `packages/app/src/context/settings.tsx` (`sounds`, `notifications`)                    |
| Sound pickers                 | `packages/app/src/components/settings-general.tsx` (`SoundRow`)                        |
| Titlebar bell                 | `packages/app/src/components/titlebar.tsx`                                             |
