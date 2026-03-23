# ADR 003: Remove Remote Control Feature

**Status:** Accepted  
**Date:** 2026-03-23

## Context

NanoClaw had a `/remote-control` chat command that spawned Claude's `claude remote-control` CLI process. This provided a browser-based web UI at `claude.ai/code?bridge=<token>` where users could interact with the agent directly — a full web terminal connected to the agent's working directory.

During the Copilot SDK migration, we investigated whether GitHub Copilot offers an equivalent. The Copilot SDK provides headless TCP server mode (`cliUrl`) for programmatic access, but no turnkey browser UI. Replicating the feature would require building a custom web frontend.

## Decision

Remove the remote control feature entirely. Delete `src/remote-control.ts`, its tests, and the `/remote-control` command handling from `src/index.ts`.

See `docs/notes/remote-control-future.md` for implementation considerations if this feature is rebuilt in the future.

## Consequences

- Users lose browser-based direct agent interaction via chat commands
- Simplifies the codebase by removing a Claude-specific integration point
- Future implementation would be more capable (custom UI, auth, multi-user) built on the Copilot SDK's headless server architecture
