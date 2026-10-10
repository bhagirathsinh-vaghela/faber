# Background jobs

Every shell command the model runs is a durable job. Faber writes a job record, spawns the command detached with its output going to a log file, and races the process against a 5-second grace window. A command that finishes inside the window returns inline like an ordinary tool call. One that runs longer hands back a job id and a log path, keeps running, and reports its result into the session when it ends, even if the server restarted in between. The model never has to guess how long a command will take.

Upstream blocked the turn until the command exited or a 2-minute timeout killed it, which forced the model to predict runtime up front.

## How it works

### The race

`BackgroundSpawn.run` handles every bash call the same way:

1. Write the job record and the debt it owes its session in one SQLite transaction (`BackgroundJob.create`). The record is written before the spawn: a crash in between leaves a record naming no process, which the reconciler discards. The reverse order would leave a live process nothing can find.
2. Open the log file and spawn `/bin/sh -c <wrapper>` with stdin closed, stdout and stderr appended to the log, and `detached: true` so the job leads its own process group and outlives the server.
3. Record the process identity: pid, start time and process group id. Pids are recycled, so a later kill or liveness check proves the pid still names this job before signalling it. The command line is not part of the identity because it changes as the process execs.
4. Race `proc.exited` against `GRACE_MS` (5 seconds). The window is a ceiling, not a wait: an `ls` returns in milliseconds.

If the process wins, its output goes back as the tool result and the debt is paid. If the timer wins, the tool returns:

```text
Command still running after 5s; it continues in the background.
job_id: <uuid>
log: <data dir>/job/<uuid>.log
hard deadline: killed if it runs past 30m. ...

The result will arrive on its own when the command finishes. Read the log with tail or grep for progress; do not poll for completion.
```

The bash tool description tells the model not to judge runtime and not to poll.

### The wrapper and the deadline

`BackgroundJob.wrap` builds a POSIX shell script that runs the user's command under the user's login shell (`<shell> -lc '<command>'`) inside a process group of its own, using `setsid` where it exists (Linux) and `set -m` otherwise (macOS). The outer shell is plain `sh` because zsh refuses job control when not interactive. The wrapper:

- starts a watchdog that sleeps for the hard deadline, then sends TERM to the command's group and KILL two seconds later;
- traps TERM, INT and HUP and forwards them to the command's group, so killing the wrapper takes the whole subtree with it;
- writes the command's exit code to `<id>.exit` before exiting.

The deadline is enforced by the job itself, so it holds with no server running. Deadlines are stored as absolute timestamps on the record rather than timers, because a `setTimeout` dies with its process.

### Settling and delivery

A finished job's result reaches its session through one of three paths, all ending in the same settle step:

| Path             | When                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live exit handle | The server that spawned the job is still up; the result lands the moment the job exits                                                                   |
| Exit-file watch  | A replacement server adopted the job; the `.exit` file appearing is the signal                                                                           |
| Reconcile sweep  | Every 5 minutes (`BackgroundOrchestrator.SWEEP_MS`) and at boot; catches deadlines that passed while the server was down, orphaned records, missed exits |

`BackgroundReconcile.run` decides every record's fate from disk and the process table only, so the same pass is correct at boot, on a timer, or after a stop. Settling is a guarded write that only succeeds while the record is still `running`, and only the caller that made the transition may deliver. The result itself is paid by `Recovery` inside the transaction that writes the delivering message (see [restart recovery](restart-recovery.md)), so a result is delivered exactly once even when two passes race.

A result arrives as a synthetic user message rendered as a card. Small output (up to 50 lines and 4,000 bytes, `BackgroundNotify.MAX_LINES` / `MAX_BYTES`) lands whole; larger output lands as a pointer to the log. Statuses are reported as they happened: a missing exit code is reported as unknown rather than failed, and a job ended by its own watchdog is reported as a timeout.

### Progress check-ins

Each job has a soft deadline: the caller's `estimate`, capped at half the hard deadline and at 3 minutes (`SOFT_CAP_MS`). Once a running job passes it, the session gets a check-in, then another every 3 minutes (`BackgroundJob.NUDGE_MS`) until the job ends or hits its hard deadline. Check-ins report elapsed time and how long ago the log last grew. The first one spells out that no action is needed; repeats are shorter. Only the server holding the recovery lease sends them.

### Killing

`bash` with `kill: <job_id>` stops a job and everything it spawned. A session can only kill its own jobs. A Stop on a session kills every job it launched and reports how each ended.

### Retention

Job records live in the `job` table in SQLite; logs and exit files live in `<data dir>/job/`. A finished job that is no longer owed to a session is removed after 7 days or once it falls outside the newest 500 (`MAX_AGE_MS`, `MAX_RECORDS`). Jobs still owed are kept.

### UI and API

| Surface                            | Detail                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `/jobs` page and jobs button       | Running jobs plus the 50 most recent finished ones, with a live log tail |
| `GET /job`                         | Same list; commands clipped to about a line                              |
| `GET /job/:id`, `GET /job/:id/log` | Full record and log for one job                                          |
| `job.updated` event                | Published when a job is spawned or settles                               |

## Configuration

| Key                           | Default | Meaning                                                                                        |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `background.job.hard_timeout` | `30m`   | Default hard deadline, as a duration (`30m`, `1h30m`, `90s`, `2h`) or a bare number of seconds |

Per call, the bash tool accepts `timeout` (overrides the hard deadline) and `estimate` (can only pull the first check-in earlier).

```json
{
  "background": { "job": { "hard_timeout": "1h" } }
}
```

## Requirements and limits

- macOS and Linux only: the wrapper needs POSIX `sh`, plus `setsid` or `set -m`.
- Stdin is closed, so an interactive command (a password prompt, a REPL) fails immediately instead of hanging.

## Why

- **Race instead of predict.** A model cannot know a command's runtime; racing the real process removes the guess. The grace window is short enough that a slow command cannot stall a turn and long enough that ordinary read-decide-act commands stay inline (`BackgroundSpawn.GRACE_MS` comment).
- **Durable records.** An in-memory registry forgets jobs on restart while the processes keep running, leaving untracked orphans. Records, deadlines and output all live on disk so a replacement server can adopt, kill or collect them.
- **Output to a file, never a pipe.** A pipe dies with the process holding it; a file is still being appended to when a replacement server opens it.
- **Configurable deadline.** 30 minutes was too strict for projects whose builds run longer.

## Code

- `packages/opencode/src/tool/bash.ts`: `BashTool`, parameter parsing, the inline/background result
- `packages/opencode/src/background/spawn.ts`: `BackgroundSpawn.run`, `GRACE_MS`, `SOFT_CAP_MS`
- `packages/opencode/src/background/job.ts`: `BackgroundJob.wrap`, `BackgroundJob.stop`, `BackgroundJob.nudge`, `BackgroundJob.cleanup`
- `packages/opencode/src/background/process.ts`: `BackgroundProcess` identity and signalling
- `packages/opencode/src/background/reconcile.ts`: `BackgroundReconcile.run`, `BackgroundReconcile.observe`
- `packages/opencode/src/background/orchestrator.ts`: `BackgroundOrchestrator.init`, `sweep`, `nudgeAll`
- `packages/opencode/src/background/notify.ts`, `deliver.ts`: result and check-in text, check-in delivery
- `packages/opencode/src/storage/jobs.ts`: `Jobs` table
- `packages/opencode/src/server/routes/job.ts`: `JobRoutes`
- `packages/app/src/pages/jobs.tsx`, `packages/app/src/components/jobs-button.tsx`
