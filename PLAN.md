# NanoClaw → GitHub Copilot SDK Migration Plan

## Problem Statement

NanoClaw is a personal AI assistant that runs Claude agents in isolated Linux containers. It currently uses `@anthropic-ai/claude-agent-sdk` (v0.2.76) for its agent runtime. We need to migrate to `@github/copilot-sdk` to leverage unlimited Copilot credits while preserving all existing functionality.

## Approach

The migration is **primarily scoped to the container agent runner** — the host-side orchestrator (message routing, container spawning, IPC, scheduling) is SDK-agnostic and needs only minor env var and credential changes. The Copilot SDK is architecturally different (client-server via JSON-RPC to Copilot CLI) vs Claude SDK (direct API calls), so the agent runner needs a full rewrite.

## Architecture Mapping

| NanoClaw Current (Claude SDK) | Target (Copilot SDK) |
|-------------------------------|----------------------|
| `query()` async generator | `CopilotClient` + `session.sendAndWait()` |
| `resume` + `resumeSessionAt` UUID | `client.resumeSession(sessionId)` |
| Claude Agent SDK `MessageStream` | `session.send()` + event listeners |
| `CLAUDE.md` memory files | `systemMessage` config + file mounts |
| `allowedTools` list | Built-in tools + `defineTool()` |
| MCP via `@modelcontextprotocol/sdk` | Native `mcpServers` config on session |
| `ANTHROPIC_API_KEY` / OAuth | `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` |
| Pre-compact hook | `session.compaction_start` event |
| Agent teams (`TeamCreate`) | **⚠️ NOT SUPPORTED** — see Feature Gaps |
| Credential proxy (Anthropic) | Credential proxy (GitHub token) |

## Feature Gaps (Not Supported by Copilot SDK)

| Feature | Impact | Mitigation |
|---------|--------|------------|
| **Agent Teams** (`TeamCreate`, `SendMessage` between agents) | Medium — used for parallel subagent orchestration | Implement via multiple sessions + custom IPC coordination |
| **CLAUDE.md auto-loading** | Low — hierarchical memory from directories | Inject as `systemMessage` content at session creation |
| **Pre-compact transcript archival** | Low — archives full conversation before compaction | Use `session.compaction_start` event + `session.getMessages()` to archive |
| **`resumeSessionAt` (branch-point resume)** | Low — resume at specific message UUID | Copilot SDK resumes full session; may not support branch-point |
| **Specific Claude model lock-in** | None — Copilot SDK supports Claude models via model selection. This is a feature, not a gap. |

---

## Work Streams (Parallelizable)

### Stream 1: Agent Runner Core Migration
**Owner:** Agent team A  
**Dependencies:** None (can start immediately)  
**Scope:** Rewrite `container/agent-runner/src/index.ts` to use Copilot SDK

#### Tasks:
- **1.1** Replace `@anthropic-ai/claude-agent-sdk` with `@github/copilot-sdk` in `container/agent-runner/package.json`
- **1.2** Rewrite agent runner entry point:
  - Replace `query()` with `CopilotClient.createSession()` + `session.sendAndWait()`
  - Map session resumption: `resume`/`resumeSessionAt` → `client.resumeSession(sessionId)`
  - Implement streaming output via `assistant.message_delta` events
  - Maintain stdin JSON input protocol (prompt, sessionId, groupFolder, etc.)
  - Maintain stdout marker-wrapped JSON output protocol
- **1.3** Implement IPC polling loop:
  - Poll `/workspace/ipc/input/` for follow-up messages during active session
  - Handle `_close` sentinel to gracefully end session
  - Feed follow-up messages via `session.send()`
- **1.4** Implement conversation archival:
  - Listen for `session.compaction_start` event
  - Call `session.getMessages()` to get full transcript
  - Write to `/workspace/group/conversations/` (same format as current)
- **1.5** Implement session index maintenance:
  - Maintain `sessions-index.json` for session summaries
  - Track session metadata (start time, message count, summary)

---

### Stream 2: MCP Server Migration
**Owner:** Agent team B  
**Dependencies:** None (can start immediately)  
**Scope:** Adapt nanoclaw MCP server for Copilot SDK's native MCP support

#### Tasks:
- **2.1** Refactor `container/agent-runner/src/ipc-mcp-stdio.ts`:
  - Current: Standalone MCP server registered with Claude SDK
  - Target: Configure as `mcpServers.nanoclaw` in session config (type: "local", stdio)
  - Ensure all tools work: `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `register_group`, `get_available_groups`
- **2.2** Validate MCP tool I/O format compatibility:
  - Copilot SDK expects JSON-serializable tool returns
  - Verify IPC file write/read patterns still work inside container
- **2.3** Test MCP server lifecycle:
  - Verify MCP server starts/stops with session
  - Verify tool discovery works
  - Test error handling for failed tool calls

---

### Stream 3: Authentication & Credential System
**Owner:** Agent team C  
**Dependencies:** None (can start immediately)  
**Scope:** Replace Anthropic auth with GitHub token auth

#### ✅ Decision Made: BYOK + Copilot Auth Proxy

**See `INVESTIGATION-AUTH.md` (Approach 7) for full details.**

The auth strategy is decided: **BYOK mode + Copilot Auth Proxy on host**. This preserves nanoclaw's credential isolation model with zero tokens in the container.

**Architecture:**
- Container uses BYOK mode: `provider: { type: "openai", baseUrl: "http://host:3001/v1" }` — NO tokens
- Host proxy (`src/copilot-auth-proxy.ts`): exchanges PAT → short-lived Copilot API token, injects auth headers, forwards body verbatim to `api.githubcopilot.com/chat/completions`
- Copilot backend is natively OpenAI-compatible (source-verified via OSS projects)
- Uses Copilot Enterprise billing (premium requests)

**Spike status:** In progress. Token exchange requires a **fine-grained PAT with "Copilot" permission** (classic `ghp_` PATs return 404). Need to verify end-to-end with proper PAT.

#### Tasks:
- **3.1** ⏳ Spike: Verify token exchange + chat/completions + billing with fine-grained PAT
- **3.2** Rewrite `src/credential-proxy.ts` → `src/copilot-auth-proxy.ts`:
  - Token exchange: PAT → Copilot API token via `GET api.github.com/copilot_internal/v2/token`
  - Cache + auto-refresh (~1hr token lifetime)
  - HTTP proxy: inject `Authorization: Bearer <copilot-token>` + Copilot headers
  - Forward verbatim to `api.githubcopilot.com` (HTTPS)
- **3.3** Update agent runner (`container/agent-runner/src/index.ts`):
  - Add BYOK `provider` config to session creation
  - Remove `GITHUB_TOKEN` dependency — container needs no auth
- **3.4** Update container runner (`src/container-runner.ts`):
  - Remove Anthropic env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`)
  - Add `COPILOT_PROXY_URL=http://<host-gateway>:<port>/v1`
  - Inject no tokens
- **3.5** Update environment config:
  - `.env.example`: Replace Anthropic vars with `GITHUB_TOKEN` (fine-grained PAT with Copilot permission)
  - `src/env.ts`, `src/config.ts`: Parse `GITHUB_TOKEN`

---

### Stream 4: Container Image (Dockerfile)
**Owner:** Agent team D  
**Dependencies:** Stream 1 (package.json changes)  
**Scope:** Update container image for Copilot SDK runtime

#### Tasks:
- **4.1** Update `container/Dockerfile`:
  - Remove `claude-code` CLI global install
  - Add GitHub Copilot CLI installation (`@github/copilot` or system package)
  - Ensure Node.js 20+ (Copilot SDK requirement; currently using Node.js 22 — ✅ compatible)
  - Keep Chromium + browser automation deps (used by agent-browser skill)
- **4.2** Update entrypoint:
  - Current: Compiles TypeScript, reads JSON from stdin, runs agent
  - Target: Same pattern, but ensure Copilot CLI is available and starts with the agent runner
  - Note: CopilotClient manages CLI lifecycle, but CLI binary must be installed
- **4.3** Update container agent-runner build:
  - `npm install` in container with new `@github/copilot-sdk` dependency
  - Verify TypeScript compilation with new SDK types
- **4.4** Optimize image size:
  - Copilot CLI may add significant size
  - Consider multi-stage build if needed

---

### Stream 5: Memory System Adaptation
**Owner:** Agent team E  
**Dependencies:** Stream 1 (session creation API)  
**Scope:** Replace CLAUDE.md auto-loading with Copilot SDK system message

#### Tasks:
- **5.1** Implement memory loading in agent runner:
  - Read `CLAUDE.md` from `/workspace/group/` (group-specific memory)
  - Read `CLAUDE.md` from `/workspace/global/` (shared memory)
  - Read `CLAUDE.md` from any `/workspace/extra/*/` directories (additional mounts)
  - Concatenate into system message content
- **5.2** Configure system message on session:
  - Use `systemMessage: { content: combinedMemory, mode: "append" }` 
  - Preserve existing memory hierarchy (global → group → extras)
- **5.3** Handle memory updates during session:
  - If agent writes to CLAUDE.md, changes should persist (file is mounted read-write)
  - Copilot SDK's `workspacePath` may need configuration

---

### Stream 6: Tool Configuration
**Owner:** Agent team F  
**Dependencies:** Stream 1 (session creation API)  
**Scope:** Map Claude SDK tools to Copilot SDK equivalents

#### Tasks:
- **6.1** Map built-in tools:
  - Claude SDK tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch
  - Copilot SDK built-in: `read_file`, `edit_file`, `create_file`, `bash`, plus git operations
  - Identify gaps and create custom tools with `defineTool()` for any missing ones
- **6.2** Configure permission handling:
  - Current: Claude SDK has `allowedTools` list
  - Target: Use `onPermissionRequest: approveAll` (container is sandboxed, so all tools safe)
  - Or implement selective handler if granular control needed
- **6.3** Handle agent-browser tool:
  - Current: `agent-browser` CLI available globally in container
  - Target: Verify Copilot SDK can invoke it via bash tool
  - May need custom tool definition if direct integration preferred
- **6.4** Handle subagent tools (Task, TaskOutput, TaskStop):
  - Current: Claude SDK has native Task tools for subagent management
  - Target: Implement via `defineTool()` — create new sessions for subtasks
  - This is the main complexity from the agent teams gap

---

### Stream 7: Host-Side Orchestrator Updates
**Owner:** Agent team G  
**Dependencies:** Streams 3, 4 (auth + container image)  
**Scope:** Update host-side code for new SDK

#### Tasks:
- **7.1** Update `src/container-runner.ts`:
  - Update environment variables passed to container
  - Update container image name/tag if changed
  - Adjust any SDK-specific spawn arguments
- **7.2** Update `src/container-runtime.ts`:
  - Verify Docker/Apple Container runtime still works with new image
  - No fundamental changes expected
- **7.3** Update `src/index.ts` (orchestrator):
  - Update any references to Claude-specific config
  - Remove `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var
  - Add any Copilot-specific env vars
- **7.4** Update setup scripts:
  - `setup/index.ts`: Update dependency checks (Copilot CLI instead of Claude CLI)
  - `setup.sh`: Update installation steps
  - `scripts/`: Update any build/deploy scripts

---

### Stream 8: Testing & Validation
**Owner:** Agent team H  
**Dependencies:** All other streams  
**Scope:** Verify migration works end-to-end

#### Tasks:
- **8.1** Update unit tests:
  - `container-runner.test.ts` — update expected env vars, container args
  - `credential-proxy.test.ts` — update for GitHub token auth
  - `ipc-auth.test.ts` — update if auth format changes
  - All other tests should pass unchanged (SDK-agnostic)
- **8.2** Integration testing:
  - Test full message flow: receive message → spawn container → agent processes → send response
  - Test session resumption across container restarts
  - Test scheduled task execution
  - Test IPC communication (follow-up messages, task scheduling)
- **8.3** Tool verification:
  - Test all built-in tools (file ops, bash, web search)
  - Test MCP server tools (send_message, schedule_task, etc.)
  - Test agent-browser integration
- **8.4** Performance validation:
  - Compare response latency (Copilot SDK adds JSON-RPC layer)
  - Monitor token usage for $150/month budget
  - Test container startup time with new image
- **8.5** Security validation:
  - Verify credential proxy blocks token exposure
  - Verify mount isolation still works
  - Verify IPC namespace isolation

---

### Stream 9: Documentation & Cleanup
**Owner:** Agent team I  
**Dependencies:** All other streams  
**Scope:** Update all documentation

#### Tasks:
- **9.1** Update `AGENTS.md` with implementation status
- **9.2** Create `docs/COPILOT_SDK_DEEP_DIVE.md` (parallel to existing `SDK_DEEP_DIVE.md`)
- **9.3** Update `README.md` references (Claude → Copilot)
- **9.4** Update `CLAUDE.md` files (global + main) for new agent context
- **9.5** Update `.env.example` with new variables
- **9.6** Update `CONTRIBUTING.md` if contribution workflow changes
- **9.7** Update `future-AGENTS.md` to reflect completed migration
- **9.8** Remove or archive Claude SDK deep dive docs

---

## Dependency Graph

```
Stream 1 (Agent Runner Core) ──────────┐
Stream 2 (MCP Server) ─────────────────┤
Stream 3 (Auth & Credentials) ─────────┤
Stream 5 (Memory System) ──[depends]───Stream 1
Stream 6 (Tool Config) ────[depends]───Stream 1
                                        │
Stream 4 (Dockerfile) ──[depends]──Stream 1 (package.json)
                                        │
Stream 7 (Host Orchestrator) ─[depends]─Streams 3, 4
                                        │
Stream 8 (Testing) ────[depends]───ALL STREAMS
Stream 9 (Documentation) ─[depends]─ALL STREAMS
```

**Fully parallel (start immediately):** Streams 1, 2, 3  
**Parallel after Stream 1:** Streams 4, 5, 6  
**After auth + container:** Stream 7  
**After all implementation:** Streams 8, 9  

## Estimated Effort Distribution

| Stream | Complexity | Files Affected |
|--------|-----------|----------------|
| 1. Agent Runner Core | **High** | `container/agent-runner/src/index.ts`, `package.json` |
| 2. MCP Server | **Medium** | `container/agent-runner/src/ipc-mcp-stdio.ts` |
| 3. Auth & Credentials | **Medium** | `src/credential-proxy.ts`, `src/env.ts`, `src/config.ts`, `.env.example` |
| 4. Dockerfile | **Low-Medium** | `container/Dockerfile` |
| 5. Memory System | **Low** | Agent runner (part of Stream 1 file) |
| 6. Tool Config | **Medium** | Agent runner (part of Stream 1 file) |
| 7. Host Orchestrator | **Low** | `src/container-runner.ts`, `src/index.ts`, `setup/` |
| 8. Testing | **High** | All test files |
| 9. Documentation | **Low** | `docs/`, `README.md`, `AGENTS.md` |

## Key Decisions

| # | Decision | Options | Recommendation | **Decision** |
|---|----------|---------|----------------|-------------|
| 1 | **Auth strategy** | Proxy pattern (secure) vs direct token injection (simpler) | Keep proxy pattern | ✅ **BYOK + Copilot Auth Proxy** — zero tokens in container, same pattern as Anthropic. See INVESTIGATION-AUTH.md Approach 7. |
| 2 | **Default model** | claude-opus-4.6, claude-sonnet-4.5, gpt-5, configurable | Configurable via env var | ✅ **Configurable via `MODEL` env var, default `claude-opus-4.6`** |
| 3 | **Agent teams replacement** | Use customAgents, full multi-session IPC, drop entirely | Use customAgents | ✅ **Use `customAgents` for delegation, drop inter-agent messaging for now** |
| 4 | **Copilot CLI in container** | Global install vs bundle with agent runner | Global install in Dockerfile | ✅ **Global install in Dockerfile** — matches current `claude-code` pattern |

### Decision 3 — Deep Dive: Agent Teams Migration Strategy

#### What we're doing now
Map Claude SDK's `Task`/`TaskOutput`/`TaskStop` tools to Copilot SDK's native `customAgents` pattern:

```typescript
const session = await client.createSession({
  customAgents: [
    {
      name: "researcher",
      description: "Explores codebases and answers questions",
      tools: ["grep", "glob", "view"],
      prompt: "You are a research assistant...",
    },
    {
      name: "editor", 
      description: "Makes targeted code changes",
      tools: ["view", "edit", "bash"],
      prompt: "You are a code editor...",
      infer: false, // Only invoked explicitly
    },
  ],
});

// Sub-agent lifecycle visible via events:
session.on("subagent.started", (e) => console.log(`▶ ${e.data.agentDisplayName}`));
session.on("subagent.completed", (e) => console.log(`✅ ${e.data.agentDisplayName}`));
```

#### What we're dropping (for now)
- `TeamCreate` — create named agent teams with multiple members
- `SendMessage` — direct message between team members
- `TeamDelete` — tear down agent teams

#### Future enhancement: Full multi-agent orchestration
When inter-agent messaging is needed, here's the architecture to implement:

**Pattern: Multi-session coordinator with shared IPC**

```
CopilotClient (single instance)
├── Session "leader" (main agent)
│   ├── Has custom tool: spawn_worker(name, prompt)
│   ├── Has custom tool: get_worker_result(name)
│   └── Has custom tool: send_to_worker(name, message)
│
├── Session "worker-research" (spawned by leader)
│   ├── Restricted tool set
│   └── Writes results to /workspace/ipc/teams/{team-id}/results/
│
└── Session "worker-editor" (spawned by leader)
    ├── Restricted tool set
    └── Writes results to /workspace/ipc/teams/{team-id}/results/
```

**Implementation notes for future agents:**
1. The leader session uses `defineTool()` to create `spawn_worker`, `get_worker_result`, and `send_to_worker` tools
2. Each worker is a separate `CopilotSession` with its own `customAgents` config and restricted tools
3. Communication happens via the existing file-based IPC pattern (JSON files in shared directories)
4. The leader polls for worker results, similar to how the host polls for container IPC
5. Workers share the same `CopilotClient` instance (supported — client manages a `Map<string, CopilotSession>`)
6. Key challenge: workers run inside the same container, so isolation is logical (tool restrictions) not physical (container boundaries)
7. Session IDs should follow a naming convention: `{group}-{team-id}-{role}` for debuggability
8. Consider using `session.send({ mode: "enqueue" })` for sequential task chaining within a single worker
