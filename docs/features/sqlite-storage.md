# SQLite storage and ordering

Sessions, messages and parts live in one SQLite database in WAL mode instead of hundreds of thousands of small JSON files. Each record is a JSON blob with its key and index fields lifted into real columns. The storage layer is written to tolerate a second server process opening the same file during a restart, and every id comes from one generator whose ids sort in creation order across clock changes and restarts.

## How it works

### One database

`Db.open` opens `storage/storage.db` under the data directory. One connection serves every table:

| Table     | Holds                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `session` | session records                                                                                                   |
| `message` | messages, keyed by session                                                                                        |
| `part`    | message parts; primary key `(message_id, id)`, `WITHOUT ROWID`, so a message's parts are one clustered range scan |
| `job`     | background jobs (see [background-jobs](background-jobs.md))                                                       |
| `debt`    | results owed across a restart (see [restart-recovery](restart-recovery.md))                                       |
| `meta`    | key-value metadata                                                                                                |

Records are stored in a `json` column; anything filtered or ordered on (ids, session and project ids, times, a starred flag) is lifted into a column with an index. WAL is a local-filesystem journal mode, so the data directory must not be on NFS.

| Pragma         | Value                                                     |
| -------------- | --------------------------------------------------------- |
| `busy_timeout` | 15000 ms, set first so it governs the journal-mode switch |
| `journal_mode` | `WAL`, issued only when not already set                   |
| `synchronous`  | `NORMAL`                                                  |
| `temp_store`   | `MEMORY`                                                  |
| `cache_size`   | 64 MB                                                     |

### Part writes

Streaming deltas go to the live event bus but are not written to disk per delta. A text or reasoning part is persisted once, at its block-end event. An aborted or finished turn persists whatever block is active, and a block that grows 256 KB past its last checkpoint is persisted early to bound what a hard crash can lose.

### Two writers

A `/restart` starts the new server beside the live one, so two processes share `storage.db` for a while.

- **Nothing writes on open.** `open` runs on the boot path before any retry wrapper, and a write there takes SQLite's single write lock against the live process. `PRAGMA optimize` is kept off this path for that reason.
- **Retries.** Writes go through `Db.retry`, which retries the busy family of errors (`SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_TIMEOUT`) up to five times with jittered exponential backoff, after `busy_timeout` has already elapsed. Jitter keeps blocked writers from waking together and colliding again.
- **Bounded sweeps.** The boot orphan sweep probes with a read first, which takes no write lock, and deletes in bounded slices that yield between them.
- **Read-modify-write in one transaction.** `Sessions.update` and `Messages.reconcile` read, mutate and write inside one `IMMEDIATE` transaction, so a commit from the other process cannot land between the read and the write and be discarded. `IMMEDIATE` takes the write intent at `BEGIN`, which turns a stale-snapshot failure into ordinary lock contention that the retry absorbs.
- **Checkpoint on shutdown.** `Db.close` runs `PRAGMA wal_checkpoint(TRUNCATE)` on a signalled stop, so the next process opens a database that needs no WAL recovery (recovery takes an exclusive lock, the source of `SQLITE_BUSY_RECOVERY` on a concurrent open).

### Migrating from JSON

`opencode migrate-storage` imports legacy JSON sessions, messages and parts into SQLite, in transactions of 5,000 rows. It copies the storage tree to a timestamped backup first unless `--skip-backup` is passed, leaves the JSON files in place, and never overwrites a row the live binary already wrote. Run it with the server stopped.

### Ids and ordering

All ids come from `Identifier` in `packages/util`, shared by the server and the web UI so there is exactly one sort order.

```text
msg_0001929f3c5a1001Xy3kP9qR2mT7vB
prefix, then 16 hex chars (the 8-byte time field), then 14 random base62 chars
```

The time field packs milliseconds times `0x1000` plus a per-millisecond counter.

| Property                         | How                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Monotonic under a backward clock | the generator only ever raises its floor; an earlier `Date.now()` keeps the previous millisecond and increments the counter |
| Monotonic across restarts        | `Identifier.seed` restores the whole field (millisecond and counter) from the newest persisted id                           |
| Counter overflow                 | spills into the next millisecond instead of wrapping                                                                        |
| Newest-first lists               | session ids are descending: the time field is stored as its complement                                                      |

The transcript is ordered by id alone. Ordering on `time.created` with the id as a tie-break depended on two values that come from separate clock reads (and, for a user message, from two machines).

## Configuration

None in `opencode.json`. The database lives in the data directory (`storage/storage.db`).

## Why

- **SQLite.** Running several streaming sessions at once starved the disk: every part was persisted by rewriting a whole JSON file per delta, times the number of sessions, across hundreds of thousands of tiny inodes.
- **Atomic writes before SQLite.** A process killed mid-write left torn JSON that made a session unopenable, so the JSON store moved to temp-file-and-rename writes.
- **Lost updates.** With two autocommit statements, 600 increments from two processes left 300, and both reported success.
- **Write lock on boot.** A boot sweep that held the write lock for 7.3 seconds against a 1.3 GB store, with a 5 second `busy_timeout`, killed a live turn in the other process. `PRAGMA optimize` at open measured 26 seconds of scanning on a store with no statistics.
- **8-byte time field.** The original 6-byte field overflowed and wrapped on 2026-08-14, after which every new id sorted before every older one and the prompt loop exited without calling the model. The field was widened to 8 bytes with a migration of old ids.
- **One generator, seeded fully.** Seeding only the millisecond after a restart reissued counters already spent, so two messages shared a time field and a reply sorted before its prompt.

## Code

| Area                | Pointer                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Connection, pragmas | `packages/opencode/src/storage/db.ts` (`Db.open`, `Db.retry`, `Db.close`)                                    |
| Tables              | `packages/opencode/src/storage/` (`sessions.ts`, `messages.ts`, `parts.ts`, `jobs.ts`, `debt.ts`, `meta.ts`) |
| Part persistence    | `packages/opencode/src/session/processor.ts` (`CHECKPOINT_CHARS`, `persistActive`)                           |
| Migration command   | `packages/opencode/src/cli/cmd/migrate-storage.ts`                                                           |
| Ids                 | `packages/util/src/identifier.ts` (`Identifier.create`, `Identifier.seed`)                                   |
