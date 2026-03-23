# Working Note: Skills, State & Memory Migration (.claude → Copilot)

**Status:** 🟡 In Progress — revised approach, implementing  
**Last Updated:** 2026-03-23  
**Branch:** `s6/skills-auto-discovery`

### Status History
| Date | Status | Detail |
|------|--------|--------|
| 2026-03-23 | 🟡 In Progress | Investigated skill auto-discovery, identified need for both .copilot mount and .github/skills |
| 2026-03-23 | 🔴 Revised | Critical review found issues with initial approach — overcomplicated, missed SDK params, unclear on session persistence. Rewrote. |

## Context

Migrating from Claude's `.claude/` directory convention to Copilot equivalents. The `.claude/` directory served multiple purposes in nanoclaw:
- **Skills**: `.claude/skills/<skill-name>/SKILL.md` — auto-discovered by Claude CLI
- **Session state**: persisted between container runs (needed for `resumeSession`)
- **Memory**: agent preferences and learned context
- **Settings**: `settings.json` with env vars and feature flags

## Guiding Principle

**Use Copilot CLI conventions wherever they exist.** A contributor familiar with the Copilot CLI should recognize the directory layout without reading nanoclaw's source. Fall back to SDK params only where nanoclaw's design (multi-group isolation, container sandboxing) has no convention equivalent.

## Decisions

### 1. Skills → `.github/skills/` convention + `skillDirectories` param

**Convention:** Copilot CLI auto-discovers skills from `.github/skills/<name>/SKILL.md` in the working directory. This is the project-level convention (vs `~/.copilot/skills/` for global user skills).

**Approach:** Copy `container/skills/*` into the group's working directory at `.github/skills/` before container launch. Also pass `skillDirectories` in the session config pointing to the same location — belt and suspenders.

**Why `.github/skills/` not `~/.copilot/skills/`:**
- Skills are project-specific (nanoclaw agent capabilities), not user-global
- Keeps `~/.copilot/` clean for actual state (sessions, config)
- Follows GitHub convention that project config lives in `.github/`
- Skills are inside the existing `/workspace/group` mount — no extra mount needed

**Why copy instead of mount:**
- Group working dir (`/workspace/group`) is already mounted read-write
- Can't cleanly overlay a read-only mount inside a read-write mount
- Copying (same pattern as original nanoclaw) is simpler
- Allows future per-group skill customization

### 2. Session state → `~/.copilot/` mount (standard location)

**Convention:** The Copilot CLI stores all state under `~/.copilot/`:
- `~/.copilot/session-state/{sessionId}/` — conversation checkpoints, plan.md, artifacts
- `~/.copilot/config/` — CLI configuration

**This is critical for session resumption.** The agent runner calls `client.resumeSession(sessionId)`, which reads checkpoint files from `~/.copilot/session-state/`. Without persistent storage here, resumed sessions start fresh — breaking the conversation continuity nanoclaw depends on.

**Approach:** Mount a per-group persistent directory to `/home/node/.copilot`:
- Host: `data/sessions/<group>/.copilot/`
- Container: `/home/node/.copilot` (standard home dir location)
- Read-write: Yes

**Why not use `configDir` to redirect elsewhere?** The SDK has a `configDir` param that overrides `~/.copilot/`. But using it hides where state actually lives — someone debugging in the container wouldn't find it at the expected location. Convention over configuration.

### 3. Memory → `systemMessage` injection (no convention fits)

**Current approach is correct.** The `buildSystemMessage()` function reads memory files from:
1. `/workspace/global/AGENTS.md` (shared across non-main groups)
2. `/workspace/extra/*/AGENTS.md` (additional mounted directories)

These are injected via `systemMessage: { mode: 'append' }`. Group-level instructions are auto-loaded by the Copilot CLI from the working directory (as `.github/copilot-instructions.md` or `AGENTS.md`).

**No changes needed.** This is nanoclaw-specific multi-source memory with no single Copilot convention equivalent. The `systemMessage` API is the correct tool.

**Future enhancement:** Groups could adopt `.github/copilot-instructions.md` for their group-level instructions (auto-loaded by CLI from working dir). This is additive — doesn't conflict with `systemMessage`.

### 4. Settings → Remove entirely (confirmed)

Claude's `settings.json` held feature flags (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, etc.). **The Copilot CLI reads no config files from `~/.copilot/`.** All configuration is passed via SDK RPC params at session creation. The commented-out `settings.json` code can be removed in a future cleanup pass.

Additionally: `CopilotClient` must be created with `useLoggedInUser: false` to prevent the CLI from attempting stored OAuth / `gh` CLI auth lookups inside the container (BYOK mode needs no GitHub auth).

## Resolved Questions

| Question | Answer |
|----------|--------|
| Does Copilot CLI need a `settings.json` equivalent? | **No.** Config goes through SDK session params. |
| Should we pre-populate `~/.copilot/config.json`? | **No.** Let the CLI manage its own config. |
| Memory file convention? | **Already solved** by `systemMessage` injection. CLI also auto-loads `.github/copilot-instructions.md` from working dir. |

## Implementation Checklist

### container-runner.ts changes
1. Replace `.claude/` directory path with `.copilot/`
2. Remove `settings.json` creation (lines 124-146)
3. Change skills copy destination: `.claude/skills/` → `.github/skills/` (inside group dir, not sessions dir)
4. Update mount: `/home/node/.claude` → `/home/node/.copilot`
5. Remove comment references to Claude

### agent-runner index.ts changes
1. Add `skillDirectories: ['/workspace/group/.github/skills']` to session config
2. No other changes needed (systemMessage, BYOK provider, MCP all correct)

### Cleanup
- Remove any remaining `CLAUDE_` env var references
- Update comments referencing `.claude/`

## Reference: Migration Path

### Before (Claude)
```
Host: container/skills/agent-browser/SKILL.md
  ↓ (copied at container launch)
Host: data/sessions/<group>/.claude/skills/agent-browser/SKILL.md
  ↓ (mounted as /home/node/.claude)
Container: /home/node/.claude/skills/agent-browser/SKILL.md
  ↓ (auto-discovered by Claude CLI from ~/.claude/)
Agent uses agent-browser skill

Host: data/sessions/<group>/.claude/settings.json
  ↓ (mounted as /home/node/.claude)
Container: /home/node/.claude/settings.json
  ↓ (Claude CLI reads feature flags)
Agent teams, memory, etc. configured
```

### After (Copilot)
```
Host: container/skills/agent-browser/SKILL.md
  ↓ (copied at container launch)
Host: groups/<group>/.github/skills/agent-browser/SKILL.md
  ↓ (already mounted as part of /workspace/group)
Container: /workspace/group/.github/skills/agent-browser/SKILL.md
  ↓ (auto-discovered by Copilot CLI from working directory convention)
  ↓ (also referenced via skillDirectories session param)
Agent uses agent-browser skill

Host: data/sessions/<group>/.copilot/
  ↓ (mounted into container)
Container: /home/node/.copilot/
  ↓ (Copilot CLI reads/writes session-state/, checkpoints, config)
Session resumption works across container restarts
```
