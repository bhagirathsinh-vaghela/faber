# Real-time sync and load performance

One Faber server is driven by many clients at once (a desktop browser, a phone on cellular, a tablet), and each stays live over one Server-Sent Events stream. This page covers what keeps that stream small, how a client recovers after a dropped connection, and how a cold open paints before the network answers.

## How it works

### The event stream

Clients open `GET /global/event`, an SSE stream of every bus event. The server sends a heartbeat event every 30 seconds and reaps a connection with no traffic for 90 seconds, which clears half-dead sockets left by a backgrounded mobile tab.

| Mechanism            | What it does                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text deltas          | `message.part.updated` carries a `delta` the client appends; the accumulated `text` is blanked on the wire (`blankStreamedText`)                  |
| Delta coalescing     | text and reasoning deltas are buffered and published as one event per `experimental.stream_flush_ms` (default 100 ms), force-flushed at block end |
| Lean session updates | token, cost and cache counters stream as small events instead of the full session record                                                          |
| Scoped subscription  | `POST /global/subscribe` sets a per-connection interest set; session-scoped events for other sessions are dropped                                 |
| Replay buffer        | each frame carries an SSE `id`; a reconnect sends `Last-Event-ID` and receives the frames it missed                                               |

Scoping is fail-open: a connection that never subscribes receives everything, and an event whose session cannot be read passes. Only message, part, diff, session error, compaction and todo events are scoped. Everything else passes, including permission and question events, so a prompt waiting on you reaches every client regardless of what it shows. The client's interest set is the open session, the live root sessions, and the direct children of both, which is why the [session overview](session-overview.md) keeps liveness tight.

### Reconnecting

`EventReplay` keeps the last 10,000 frames or 30 minutes, whichever is smaller, stored in delta form so a long answer does not make the buffer quadratic. Frame ids are prefixed with a per-process epoch, so a cursor from before a server restart is recognized as foreign rather than resolving to an unrelated frame. On reconnect the server replays what it has, queuing live events until the backlog is written so a newer frame cannot overtake an older one, then sends `server.connected` with `resumed` set to whether the replay covered the whole gap.

The client also heals from REST on every connect. It fetches only the messages newer than the newest one it holds (a since-id delta) rather than the full history, and re-reads pending questions and permissions. `navigator.onLine` flapping (common on machines with a VPN) revalidates the stream instead of dropping it.

### Instant paint

Every launch of an iOS PWA is a cold boot. The client writes the tail of the session on screen (last 40 messages) to IndexedDB on a timer, comparing a fingerprint of the tail so an idle session writes nothing. On the next open the transcript paints from that snapshot, then reconciles through the since-id delta. Snapshots carry a version and are dropped on a shape change rather than merged. IndexedDB is used instead of the `localStorage`-backed persistence layer because a transcript with tool output can reach megabytes.

### Load size

| Change                           | Effect                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Models only for usable providers | bootstrap describes the providers a directory can actually use, not the whole catalog     |
| Trim transcripts not on screen   | a phone no longer holds hundreds of messages from sessions it is not showing              |
| In-memory session index          | session list and children answer from memory instead of reading every session file        |
| Compression                      | JSON and text responses over about 1 KB are compressed with brotli or gzip; SSE stays raw |

### Embedded UI

`packages/opencode/script/pack-web.ts` packs the built app into `web-assets.json`, precompressed to brotli and gzip, and the binary embeds it. `packages/opencode/src/server/web.ts` serves the variant the client accepts. Content-hashed files are served `immutable` for a year; everything else is `no-cache` with a weak ETag computed over the uncompressed body, so one validator covers every encoding. `POST /global/web/reload` re-reads `web-assets.json` from disk, so a rebuilt UI goes live without restarting the server.

## Configuration

| Key                            | Default | Meaning                                                            |
| ------------------------------ | ------- | ------------------------------------------------------------------ |
| `experimental.stream_flush_ms` | `100`   | delta coalescing interval in ms; `0` publishes every delta at once |

## Why

- **Deltas.** Every chunk used to republish the whole part, so a reply of about 3 KB moved about 60 KB over the wire.
- **Lean session updates.** The full session record sent on every step was the session stream's dominant recurring cost on cellular.
- **Scoped subscription.** A client viewing one session still parsed every other session's streaming tokens.
- **Replay buffer.** Without SSE ids a disconnect is unrecoverable at the protocol level. A REST refetch cannot restore a part that was mid-stream and can leave the transcript short. The window is sized for the gaps a phone produces (a tunnel, a dead zone, a long stretch in another app).
- **Snapshot on a timer.** Writing on tab hide never survived a reload, because the page is torn down before the IndexedDB transaction commits.
- **Smaller bootstrap.** Bootstrap once shipped 4.5 MB to describe the 21 models of the connected providers, and a phone once held 798 messages to show four.
- **SSE uncompressed.** Compressing a live stream buffers it and stalls events.

## Code

| Area                         | Pointer                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| SSE route, subscribe, replay | `packages/opencode/src/server/routes/global.ts` (`/event`, `/subscribe`, `/web/reload`) |
| Replay buffer                | `packages/opencode/src/bus/replay.ts` (`EventReplay`, `blankStreamedText`)              |
| Scoping filter               | `packages/opencode/src/bus/global.ts` (`GlobalInterest.wants`)                          |
| Heartbeat, compression       | `packages/opencode/src/server/server.ts`                                                |
| Delta coalescing             | `packages/opencode/src/session/processor.ts` (`stream_flush_ms`)                        |
| Embedded assets              | `packages/opencode/src/server/web.ts`                                                   |
| Client stream                | `packages/app/src/context/global-sdk.tsx`                                               |
| Client store, healing        | `packages/app/src/context/global-sync.tsx`, `packages/app/src/context/sync.tsx`         |
| On-device snapshot           | `packages/app/src/utils/snapshot.ts`                                                    |
