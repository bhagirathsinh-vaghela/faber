# Restart recovery

Faber treats a server restart as routine. Everything a session is owed (a subagent's answer, a background job's output) is a row in one SQLite debt table, and one collector pays each row exactly once. After a restart, a crash or a reboot:

- turns that were cut off resume with a short note, subagents included;
- owed results are delivered;
- sessions whose prompt cache is still warm get their keep-warm pings re-armed.

The [supervisor](../supervisor.md) is the usual way to restart the server, but recovery does not depend on it: any `opencode serve` start runs the same pass.

## How it works

### Facts, then one reader

Code paths that do work only write facts to the database:

| Fact                                                                 | Written by                                        |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Turn marker on the session (`at`, `pid`, `boot`, `nonce`, `resumes`) | Each turn, when it starts; cleared when it ends   |
| `time.stopped` on the session                                        | A user Stop                                       |
| Debt row (`responder`, `kind`, `caller`, `created`, `asks`)          | A job launch, or any message sent into a subagent |
| User message with no reply                                           | A prompt, a delivered result, a check-in          |

`Recovery` reads those facts and acts. Its header describes it as level-triggered: every pass re-derives the whole picture, so a missed event costs latency, never a lost result.

### The debt ledger

A debt row says that a responder (a job id or a child session id) owes its caller an outcome. A job's row is written in the same transaction as the job record. A subagent's row is opened by the first message into it, and each later message joins the open row (`asks` counts them). A row is removed only by the message that delivers the outcome, inside the transaction that writes that message (`Recovery.deliver`), or when the caller or responder is deleted. Two passes, or two server processes, racing on one debt therefore deliver it once.

`GET /session/:sessionID/debts` lists a session's open debts with their live state.

### Cut turns

A turn marker names the process running the turn by pid and process start time. A marker whose process is gone is a turn that a crash or restart cut (`Recovery.cut`). A clean finish, an error, a Stop and an Esc all clear the marker, so none of them is mistaken for a crash.

For each cut turn, `Recovery.resume`:

1. Claims the marker in a transaction, so a turn that started since is left alone.
2. Closes any question the turn was waiting on as unanswered.
3. Delivers a resume prompt and starts a turn. A root session is told that any question, permission or tool call it was waiting on is gone and to redo what still matters, and that subagents it launched are still running and will report back. A subagent is told its result is still awaited.

A session that fails to resume 3 times in a row (`Recovery.CAP`) is left alone; a subagent that gives up reports itself to its parent as failed.

### The pass

`Recovery.pass` runs only in the process holding the recovery lease, a row in the database's meta table that the holder renews on every step. In order:

1. On the first pass, remove headless runs the restart cut.
2. Re-arm keep-warm pings on root sessions whose cache is still warm and whose keep-warm intent is set.
3. Resume every cut turn.
4. Pay every debt whose responder is done: a settled job, or a child with no turn, no marker, no open debts of its own and no waiting message.
5. Start a turn for any session with an unanswered message.

A pass runs every 60 seconds (`SWEEP_MS`), whenever a session goes idle, and on demand (`Recovery.poke`). `Recovery.collect` pays one session's debts immediately when a turn ends or a job exits, without waiting for the lease.

### Boot and the lease

A plain `opencode serve` waits 60 seconds (`GRACE_MS`) before competing for the lease. The supervisor sets `OPENCODE_LIVE=1` only on the server it keeps on the main port, which starts recovery immediately. The staging build the supervisor health-checks on the alternate port never sets it and is killed long before its grace expires, so it never acts on the live server's sessions.

Background jobs are adopted on every start, independent of the lease: `BackgroundOrchestrator.sweep` settles whatever is on disk (see [background jobs](background-jobs.md)).

## Configuration

There are no recovery-specific config keys. Re-arming applies to sessions whose persisted keep-warm intent is set; see [keep-warm](keep-warm.md).

## Why

- **One ledger.** Resume, delivery and re-arming used to be spread across the supervisor's replay, per-process watchers and an in-memory pending list, so a restart could lose a result or deliver it twice. Moving them to one database loop with one debt table removed both failure modes.
- **Process identity in the marker.** A marker written by a live process is never treated as cut; a marker whose process is gone always is. A Stop clears the marker, so a stopped session is never resumed as if it had crashed.
- **Tell a resumed turn everything in flight is gone.** The resume note states that any question, permission or in-progress tool call is gone (`Recovery.resumeText`).
- **Indexed queries at boot.** Recovery once parsed every message's JSON and never finished on a store with 133k messages; it now uses indexed columns.
- **Staging builds stay inert.** The `OPENCODE_LIVE` flag and the boot grace exist so the supervisor's health-check build never runs recovery against the live server's sessions (`Recovery.GRACE_MS` comment).

## Code

- `packages/opencode/src/session/recovery.ts`: `Recovery.pass`, `Recovery.resume`, `Recovery.deliver`, `Recovery.collect`, `Recovery.lease`, `CAP`, `SWEEP_MS`, `GRACE_MS`
- `packages/opencode/src/storage/debt.ts`: `Debt`
- `packages/opencode/src/session/prompt.ts`: turn marker written in the prompt loop
- `packages/opencode/src/session/index.ts`: `turn`, `keepWarm` fields on `Session.Info`
- `packages/opencode/src/cli/cmd/serve.ts`: `ServeCommand`, `OPENCODE_LIVE`
- `packages/opencode/src/server/routes/session.ts`: `/:sessionID/debts`
