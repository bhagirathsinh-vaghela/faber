# Projects and worktrees

In Faber a project is a directory. Each git worktree and each subfolder you open is its own project with its own tile on the project rail and its own session list. The set of open projects is owned by the server, shared by every client, and persisted across restarts. A directory's server-side instance (LSP, MCP clients, terminals, file watcher) stays alive while anything in it is live and is disposed shortly after the last user goes away. The dock shows the working tree's lines added and removed beside the branch name.

## How it works

### Directory identity

Project identity is the directory's realpath, not the git root-commit hash. Git detection is still used for the worktree root and VCS state.

| Directory              | Result                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| a repo's main checkout | one project                                                                               |
| a linked git worktree  | its own project; `worktree` is the checkout's own `--show-toplevel`, not the main repo    |
| a subfolder of a repo  | its own project and session list, still inheriting the repo root's `AGENTS.md` and skills |
| a folder outside git   | its own project (there is no shared "global" bucket)                                      |

Because `worktree` is the linked checkout's own top level, snapshots, diffs, reverts, edit permissions and path relativization for a worktree session all operate on that worktree's tree rather than the main repo's. Git worktree create, delete and reset remain available through their own routes.

### The shared open-project list

`OpenProjects` holds the projects shown on every client's rail and pushes changes over the event stream.

- A project is added as a side effect of first touching its directory (opening a session there, attaching to a root session, finishing a turn) or explicitly through `POST /global/projects/open`.
- It stays until a user closes it with `POST /global/projects/close`. Close is a view unlink only: it disposes nothing, and a busy or kept-warm session keeps running after its project is closed.
- Membership is written through to storage on open and removed on close, so the list survives restarts and crashes.
- Every list and push stats the directory and carries an `exists` flag. A project whose directory was deleted or moved renders red with a "Directory not found" panel and a Close button instead of disappearing.

Clicking a project tile previews its sessions in place without navigating; hovering does nothing.

### Instance lifetime

`Liveness` reference-counts the users of each directory's instance:

| User             | Counted while                             |
| ---------------- | ----------------------------------------- |
| a session's turn | the session, or a subagent in it, is busy |
| keep-warm        | the session's cache ping is armed         |
| a terminal       | a PTY in that directory is open           |

When the count reaches zero the instance is disposed after a 3 second grace window, which absorbs the gaps between turn end and ping arm, or between idle and the next prompt. Config writes no longer dispose instances; config changes reach sessions without one. The count is deliberately not derived from the overview's recent list, which is capped and holds root sessions only, so a busy subagent would read as no users.

### Branch diffstat

The dock's info line reads `cwd  branch (+52 -8)`: uncommitted lines against HEAD plus every line of untracked files, summed from `GET /file/status`. Untracked files count because files the agent creates are untracked, and plain `git diff --stat` would hide most of a turn's work. The count is hidden when the tree is clean and re-read (debounced 500 ms) on branch changes, file edits, watcher events and a session going idle, since a shell command changes files without an edit event.

## Configuration

None.

## Why

- **Shared list.** The web UI is one server driven from many devices, so the sidebar should show the same projects everywhere. It used to live in each browser's `localStorage`.
- **Directory identity.** Two folders outside git used to share one session list, and a linked worktree put a second tile for the main repo on the rail that showed the main repo's sessions. Keying by directory made the old sandbox model, which grouped sibling worktrees under one project, dead code, and it was removed.
- **Persistence.** The in-memory list was rebuilt after a restart from whichever sessions came back, so a project with no live session vanished.
- **Reference-counted disposal.** Disposal used to be unconditional: a config write disposed every instance, which stopped keep-warm pings and aborted in-flight turns. A session blocked on a question lost its warm prompt cache, so answering paid a cache-write miss. An open terminal now counts as a user because a PTY dies with its instance.

## Code

| Area              | Pointer                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| Open-project set  | `packages/opencode/src/project/open.ts` (`OpenProjects`)                               |
| Instance liveness | `packages/opencode/src/project/liveness.ts` (`Liveness`)                               |
| Instances         | `packages/opencode/src/project/instance.ts` (`Instance.disposeDirectory`)              |
| Identity          | `packages/opencode/src/project/project.ts` (`Project.fromDirectory`)                   |
| Routes            | `packages/opencode/src/server/routes/global.ts` (`/projects/open`, `/projects/close`)  |
| Worktree routes   | `packages/opencode/src/server/routes/experimental.ts` (`/worktree`, `/worktree/reset`) |
| Rail              | `packages/app/src/pages/layout.tsx`                                                    |
| Diffstat          | `packages/app/src/context/global-sync.tsx` (`refreshDiff`, `vcs_diff`)                 |
