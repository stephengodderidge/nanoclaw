# Working Note: Remote Control — Future Implementation

**Status:** 📋 Reference — not active work  
**Created:** 2026-03-23  
**Related:** `docs/decisions/003-remove-remote-control.md`

## What We Had

Claude's `claude remote-control` gave users a browser URL (`claude.ai/code?bridge=<token>`) that connected to the running agent. NanoClaw wrapped this with:
- `/remote-control` chat command → spawns process → returns URL to chat
- `/remote-control-end` → kills the process
- State persistence across nanoclaw restarts (PID + URL saved to disk)
- Auto-accept of the confirmation prompt

## What Copilot SDK Offers

The SDK has no turnkey browser UI, but provides the building blocks:

### Headless Server Mode
The Copilot CLI can run as a TCP server that SDK clients connect to:

```typescript
// Start CLI as headless server (run independently, e.g., in a container)
// copilot --headless --port 4321

// Connect from your backend
const client = new CopilotClient({
  cliUrl: "localhost:4321",  // Connect to running server over TCP
  useLoggedInUser: false,
});
```

### Key Properties
- **Network-accessible** — CLI and SDK can run on different machines
- **Multi-tenant** — multiple SDK clients can share one CLI server
- **Persistent** — CLI has its own lifecycle, independent of client apps
- **Full agent support** — all Copilot agentic features work over TCP
- **No built-in auth between SDK and CLI** — secure the network path yourself

### TUI Server Mode
For terminal-based remote access (not browser):
```bash
copilot --ui-server --port 4321
```
SDK can control which session is displayed with `getForegroundSessionId()` / `setForegroundSessionId()`.

## Implementation Approach (If We Build It)

### Architecture
```
User's Browser
  ↕ (WebSocket / HTTP)
NanoClaw Web Server (new component)
  ↕ (Copilot SDK via cliUrl)
Copilot CLI (headless, TCP :4321)
  ↕ (JSON-RPC)
Model Provider (via BYOK proxy)
```

### Components Needed

1. **Web Server** — Express/Fastify app serving a chat UI
   - WebSocket endpoint for real-time message streaming
   - Session management (create, resume, list)
   - Auth layer (who can access which sessions)

2. **Chat UI** — Browser-based frontend
   - Message display with markdown rendering
   - Input field with send/abort
   - Session selector
   - Tool call visibility (file edits, bash commands)

3. **Session Bridge** — Connects web server to Copilot SDK
   - Creates `CopilotClient` with `cliUrl` pointing to headless CLI
   - Maps HTTP/WebSocket requests to `session.send()` / `session.sendAndWait()`
   - Streams `assistant.message_delta` events to WebSocket clients

4. **CLI Process Manager** — Manages the headless CLI lifecycle
   - Start/stop CLI process
   - Health checks
   - Port allocation

### Integration with NanoClaw

Option A: **Standalone service** — separate process, nanoclaw sends URL to chat
```
/remote-control → nanoclaw starts web server → returns http://host:8080/session/abc
```

Option B: **Embedded in nanoclaw** — add routes to existing host process
```
/remote-control → nanoclaw creates session, returns http://host:8080/chat?session=abc
```

### Considerations

- **Security**: The web UI would need auth. Could use a short-lived token in the URL (like the old claude.ai bridge pattern) or require login.
- **Scope**: Could start minimal (text chat only) and add features over time (file tree, terminal, tool visibility).
- **Existing solutions**: Check if any open-source Copilot SDK web UIs exist before building from scratch. Search: `gh search repos "copilot-sdk web ui" --sort stars`.
- **Container implications**: The headless CLI would run on the host (not in the agent container), since containers already use BYOK mode.
