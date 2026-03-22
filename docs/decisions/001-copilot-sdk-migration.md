# ADR 001: Migrate to GitHub Copilot SDK

**Status:** Accepted  
**Date:** 2026-03-20  

## Context

NanoClaw uses `@anthropic-ai/claude-agent-sdk` (v0.2.76) for its agent runtime. We have unlimited Copilot Enterprise credits and $150/month Azure credits. Migrating to `@github/copilot-sdk` eliminates Anthropic API costs entirely.

## Decision

Migrate the container agent runner from Claude Agent SDK to GitHub Copilot SDK (`@github/copilot-sdk`). The host-side orchestrator (message routing, container spawning, IPC, scheduling) is SDK-agnostic and needs only minor env var changes.

Key mappings:
- `query()` → `CopilotClient` + `session.sendAndWait()`
- `resume` → `client.resumeSession(sessionId)`
- `CLAUDE.md` → `systemMessage` config
- `allowedTools` → built-in tools + `defineTool()`
- MCP via custom registration → native `mcpServers` config
- Agent teams (`TeamCreate`) → `customAgents` (partial — inter-agent messaging dropped for now)

## Consequences

- Agent runner needs full rewrite (already done — see `container/agent-runner/src/index.ts`)
- Auth system needs migration (see ADR 002)
- Default model configurable via `MODEL` env var (default: `claude-opus-4.6`)
- Feature gap: no inter-agent messaging (acceptable for now, can add via multi-session IPC later)
