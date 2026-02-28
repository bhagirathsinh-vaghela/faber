# Faber

Run a fleet of coding agents from any browser, even on mobile. Prompt caches stay hot across repo switches and compaction.

Faber is my agent harness, built on top of OpenCode (see NOTICE). I use it daily for production work.

What it adds:

- Durable background jobs and subagents whose results arrive exactly once, even across restarts.
- Prompt caching that survives repo switches and compaction: hit rate from 0% to 97.6% ([upstream OpenCode PR](https://github.com/anomalyco/opencode/pull/14743)).
- MCP tool schemas loaded on demand instead of sent with every request.
- A web UI built for running many sessions at once, from a desktop or a phone.

The commit history is being published in order, batch by batch. More on the way.

Licensed under Apache-2.0. See LICENSE and NOTICE.
