# Session overview

The overview is one list of your recent sessions that the server owns and every client renders the same way. It splits sessions into **Live sessions** (a turn running, including one blocked on a question or permission; a subagent or background job still owed; or a keep-warm ping armed) and **Recent sessions** (everything else, newest first, including a session whose last turn failed). From the list you can switch, stop, rename, star, archive and delete sessions. A Ctrl+Tab switcher cycles through it like Alt+Tab, and a notification center in the project rail lists what is waiting on you.

## How it works

### The server-owned recent list

`SessionRecent` is an in-memory LRU of root sessions that a real turn has touched, ordered by last activity and capped at 500 entries (`LIMIT`). Each entry is the full overview projection: title, directory, the agent of the last turn, and the live flags the overview sorts on.

| Field                    | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `turn`                   | the session's own turn is in flight                                        |
| `subagents`, `jobs`      | open debts owed to the session by its subagents and background jobs        |
| `question`, `permission` | a question or a permission prompt is pending                               |
| `error`                  | the last turn ended on an error; cleared on the next view or the next turn |
| `unseen`                 | a finished turn the user has not opened yet                                |
| `pingAt`, `pinged`       | next and last cache-ping time (see [keep-warm](keep-warm.md))              |
| `starred`                | exempt from the cap's eviction                                             |

Clients read the list from `GET /global/recent` and then receive `recent.updated` pushes. Emits are split by urgency: a transition (busy on or off, an unseen dot, a ping countdown appearing) publishes at once, while pure recency reordering rides a slow coalescing timer, so a long turn does not push a frame per assistant step.

The list is written to disk on a 5 second debounce and is lossy on purpose. The durable facts live elsewhere: `unseen` is written to the session record immediately, debt counts are re-read from the debt table on hydrate (`SessionRecent.seed`), and starred sessions are re-read from the session record (`Sessions.listStarred`). A dropped flush costs recency ordering, never truth.

### Attention ranking

Every status dot in the UI (overview rows, project tiles, sidebar rows, notification center) comes from one helper, `attention` in `packages/app/src/utils/attention.ts`. Precedence is fixed:

1. error
2. question
3. permission
4. busy (own turn, subagent, or background job; busy is layered so a subagent accent can cross-fade over the agent tint)
5. unseen

A project's dot is the strongest state across its sessions.

### Stars, archive, delete

A starred session is exempt from the 500 cap. The server refuses to archive or delete a starred session (`Session.refuseStarred`, `SessionStarredError`) until it is unstarred, and the refusal happens before the session is stopped, so a refused request leaves a running turn alone. Unstarring re-applies the cap immediately. Archive is offered only for sessions that are not live; archived sessions appear under "Show archived" and can be unarchived, which puts them back at their own last-activity position.

### Switching with Ctrl+Tab

Ctrl+Tab opens the overview as a switcher. Hold Ctrl, tap Tab to advance, release to pick. It opens on the first row that is not the session on screen, so from a live session it flips back to the last live session you viewed. Live sessions stay in their own section above recent ones. Inside a subagent session the same keys cycle that session's siblings instead.

While the dialog is open, row order is frozen so keyboard navigation cannot land on the wrong session when the server reorders the list. Row content (busy dot, countdown, title) stays live.

### Notification center

The notification center at the bottom of the project rail lists turn completions, errors, questions and permission requests. Busy sessions are deliberately absent: a running turn wants nothing from the user.

### Keys and surfaces

| Action            | Binding or surface                                                                  |
| ----------------- | ----------------------------------------------------------------------------------- |
| Open the overview | the home page (`alt+h`), or `mod+k` to open it as a dialog over the current session |
| Switch sessions   | `ctrl+tab` / `ctrl+shift+tab`                                                       |
| Stop a session    | `alt+q` or `ctrl+d` from the session header or a highlighted overview row           |
| Manage a session  | row menu: rename, star, archive, delete                                             |
| Filter            | "Show starred only", "Show archived"                                                |

Stop is the full stop: it aborts the in-flight turn, which also tears down the session's keep-warm pings, and returns to the overview when the stopped session was on screen. The composer's own Stop aborts only the turn.

## Configuration

None. The cap is a constant (`SessionRecent` `LIMIT`).

## Why

- **Server-owned list.** The first overview was computed in the browser by hydrating every project, so one page load fired provider, config, agent, command, stash and session-list requests about 30 times each (about 300 MB over the wire) for projects the user never opened. The server-owned LRU replaced that with one list and live pushes.
- **A dialog, not a route.** As a separate route, the overview unmounted the session you came from. As a dialog it drops straight back to where you were on dismiss.
- **One ranking helper.** Surfaces used to source their dots differently (server entry, a persisted client log, a mix) and disagreed; for example, opening a session by URL cleared the server flag and left the client one set.
- **500 entries.** The list also scopes each client's SSE subscription (see [realtime-sync](realtime-sync.md)). Raising the cap from 50 was safe only after liveness was decoupled from `unseen`, so an unread backlog cannot put hundreds of idle sessions into the streamed set. Rows are indexed by id so per-row lookups on the shared 1 Hz clock stay linear.
- **Stars.** Past the cap the oldest sessions drop off the overview, which was the only place to find them; a star keeps a session there.
- **Sections in the switcher.** A flattened, view-ordered switcher hid which sessions were still live, so the sections came back.

## Code

| Area                       | Pointer                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| Recent LRU                 | `packages/opencode/src/session/recent.ts` (`SessionRecent`)                  |
| Busy facts and debts       | `packages/opencode/src/session/busy.ts` (`SessionBusy`)                      |
| Recent route               | `packages/opencode/src/server/routes/global.ts` (`/recent`)                  |
| Overview body and switcher | `packages/app/src/components/dialog-overview.tsx` (`DialogOverview`)         |
| Home page                  | `packages/app/src/pages/home.tsx`                                            |
| Attention ranking          | `packages/app/src/utils/attention.ts` (`attention`)                          |
| Notification center        | `packages/app/src/components/notification-center.tsx`                        |
| Stop                       | `packages/app/src/hooks/use-stop-session.ts` (`useStopSession`, `isStopKey`) |
| Session actions            | `packages/app/src/hooks/use-session-actions.tsx`                             |
