# Tool upgrades

Faber reworks most of the built-in tools the model calls. Edits match text exactly and keep a file's encoding and line endings. Read tracking survives a server restart and compaction, and re-reading an unchanged range returns a short stub. Grep has output modes, asymmetric context, a default result cap and a timeout. The LSP tool takes a symbol name instead of a line and column. Webfetch checks the host on every redirect hop. Every path argument expands `~`, and every shell command can read which session ran it.

## How it works

### Summary

| Tool           | Change                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit`         | Exact match plus smart-quote normalization; keeps UTF-16LE (with BOM) and CRLF; refuses an empty `oldString` on a non-empty file; inserts `newString` literally; returns a structured patch |
| `write`        | Creates missing parent directories; reports "created" or "updated"                                                                                                                          |
| `read`         | `<file_unchanged>` stub for a repeat read of the same range; read state persisted on the tool part; PDF `pages` ranges                                                                      |
| `grep`         | `output_mode`, `before_context` / `after_context`, `head_limit` (default 250) with `offset`, 20 s timeout with partial results, structured metadata                                         |
| `webfetch`     | Redirects followed one hop at a time with a host check on each                                                                                                                              |
| `lsp`          | Address a symbol by `symbol` name; `workspaceSymbol` takes a real query; servers live as long as the project is open                                                                        |
| All path tools | `~` expansion through `Filesystem.resolve`                                                                                                                                                  |
| `bash`         | Exports `OPENCODE_SESSION_ID`, `OPENCODE_MESSAGE_ID`, `OPENCODE_AGENT`, `OPENCODE_SERVER_URL`                                                                                               |

### Edit: exact match

`replace` in `tool/edit.ts` looks for `oldString` verbatim. If that fails, `findActualString` retries with typographic quotes (U+2018, U+2019, U+201C, U+201D) folded to ASCII and returns the substring actually in the file. There is no other fallback: no whitespace, indentation or similarity matching. A missing match is an error (`oldString not found in content`); more than one match without `replaceAll` is an error that tells the model to add surrounding lines.

Encoding and line endings come from `detectFileProperties` in `util/encoding.ts`. A file that starts with the `FF FE` byte order mark is decoded as UTF-16LE and written back with the mark. In a CRLF file, matching runs on LF-normalized text (the read tool never shows `\r`), and `applyLineEnding` restores CRLF on write.

Replacement text goes through `swap`, which uses a function replacer, so `$$`, `$&` and similar sequences in `newString` are written as typed instead of being read as replacement patterns.

### Read tracking

`FileTime` keeps, per session and file, the mtime, a content hash and the read range. Edit and write refuse a file whose content changed since it was last read.

| Behaviour                        | Mechanism                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survives restart and compaction  | mtime and hash are persisted on the read, edit, write and `apply_patch` tool parts; `FileTime.seed` rebuilds the map each turn from the compaction-filtered history |
| No spurious re-reads             | When the mtime moved, the current bytes are hashed and compared; identical content passes                                                                           |
| Own writes do not trip the guard | `FileTime.restamp` records the real post-write mtime and hash                                                                                                       |
| Read de-duplication              | A repeat read with the same `offset` and `limit` of an unchanged file returns `<file_unchanged>path</file_unchanged>`                                               |

A read dropped by compaction is also dropped from the map, so the next read returns real content instead of a stub for text the model no longer has.

### Read: PDF pages

`read` takes `pages` (`"3"`, `"1-5"`, `"10-"`) for PDFs. Pages are rendered to JPEG at 150 DPI with `pdftoppm` and returned as image attachments, at most 20 pages per call. Without `pages`, the whole PDF is attached as before.

### Grep

`grep` wraps ripgrep with three output modes (`files_with_matches` by default, `content`, `count`). Results are paginated by `offset` and `head_limit`; `head_limit: 0` means unlimited. A search that runs past 20 seconds is aborted and returns what it found so far, flagged as partial. Metadata carries `numFiles`, `filenames`, `totalBeforePagination`, `appliedLimit` and `appliedOffset`.

### Webfetch redirects

`util/fetch.ts` fetches each hop with `redirect: "manual"` and follows a redirect only when it stays on the same host (ignoring a `www.` prefix), up to 10 hops. A cross-host hop, an https-to-http downgrade or a port change stops the fetch and is reported to the model, which can fetch the new URL deliberately. Both webfetch variants use this follower. The variant registered for the `anthropic` provider also saves binary responses to a temp file the model can open with `read`, and answers the caller's `prompt` over the page with the title agent's small model, returning the raw text if that call fails.

### LSP by symbol

With `symbol`, the LSP tool resolves the position itself from document symbols, falling back to the workspace index when the name lives in another file. Line and character still work and are validated per operation. `workspaceSymbol` takes a query with `limit` and `offset`, and the cap applies after merging every language server.

The language server pool lives at module scope, keyed by root, and is dropped only when its project closes or the process exits.

### Session environment for shell commands

`bash` exports the session id, message id, agent name and, when the server is listening, its origin. Command templates can also use `$SESSION`, replaced with the session id as a whole word.

## Configuration

| Setting                                | Effect                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| `OPENCODE_EXPERIMENTAL_LSP_TOOL` (env) | Registers the `lsp` tool (also enabled by `OPENCODE_EXPERIMENTAL`) |
| `lsp` (config)                         | Language server definitions                                        |

PDF page ranges need `pdftoppm` (poppler) on `PATH`; the tool reports how to install it when it is missing.

## Why

- **Exact edit.** The previous edit tool ran a nine-stage fuzzy replacer chain (line-trimmed, whitespace-normalized, indentation-flexible, block-anchor and similar matchers). It was replaced with exact matching plus smart-quote normalization, inspired by Claude Code's edit tool. An empty `oldString` used to overwrite a whole file.
- **Persisted read state.** Read tracking lived in a process-local map. After a restart the model "thought it had read a file but the next edit" was refused; after compaction, the stub hid content the model no longer had.
- **Content hashes.** An mtime bump from a formatter, an editor save, cloud sync or the tool's own re-stamp forced a pointless re-read before every edit.
- **LSP by symbol.** Line and character "are obtainable only by reading or grepping the file first. By then the answer is usually already in hand", so the tool went unused. Keeping servers alive avoids a cold start per idle gap; gopls rebuilds a View per LSP session, which on a large Go workspace takes tens of seconds.
- **Redirect checks.** Before the per-hop follower, "a redirect could bounce off-host to any server with the request headers attached, with no hop limit."
- **Session environment.** Scripts guessed the session id from the busy set or file mtimes, a guess that is "wrong at the moment two sessions are mid-turn."
- **Slimmer tool metadata.** Edit metadata used to store the whole-workspace diagnostics map; in a large monorepo a single edit part reached 39 MB and was re-serialized on every poll. The model never saw that metadata, so it was dropped.
- **PDF pages.** Inspired by Claude Code's PDF page range support.

## Code

| Area              | Pointer                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Edit              | `packages/opencode/src/tool/edit.ts` (`replace`, `findActualString`, `normalizeSmartQuotes`)                            |
| Encoding          | `packages/opencode/src/util/encoding.ts` (`detectFileProperties`, `encodeContent`, `applyLineEnding`)                   |
| Literal insertion | `packages/opencode/src/util/text.ts` (`swap`)                                                                           |
| Read tracking     | `packages/opencode/src/file/time.ts` (`FileTime.read`, `FileTime.restamp`, `FileTime.seed`, `FileTime.hash`)            |
| Read and PDF      | `packages/opencode/src/tool/read.ts` (`readPdf`, `parsePageRange`)                                                      |
| Grep              | `packages/opencode/src/tool/grep.ts` (`DEFAULT_HEAD_LIMIT`, `RIPGREP_TIMEOUT_MS`)                                       |
| Redirects         | `packages/opencode/src/util/fetch.ts`; `packages/opencode/src/tool/webfetch.ts`, `webfetch-anthropic.ts`                |
| LSP               | `packages/opencode/src/tool/lsp.ts`; `packages/opencode/src/lsp/index.ts` (`LSP.symbolPosition`, `LSP.workspaceSymbol`) |
| Paths             | `packages/opencode/src/util/filesystem.ts` (`Filesystem.resolve`)                                                       |
| Shell env         | `packages/opencode/src/tool/bash.ts`                                                                                    |
