# Working Note: Stream 3 — Auth Spike

**Status:** ✅ Complete  
**Last Updated:** 2026-03-22  
**Decision:** [ADR 002](../decisions/002-auth-byok-proxy.md)

### Status History
| Date | Status | Detail |
|------|--------|--------|
| 2026-03-21 | 🔴 Blocked | Needed fine-grained PAT with Copilot permission (classic PATs returned 404 on token exchange) |
| 2026-03-22 | ✅ Complete | Discovered token exchange NOT needed — `api.githubcopilot.com` accepts PATs directly. Zero-scope PAT works. |

## Spike Results (2026-03-22)

All verified against `api.githubcopilot.com`:

| Test | Result | Detail |
|------|--------|--------|
| Chat completions | ✅ | Standard OpenAI format, no transformation needed |
| Streaming | ✅ | Standard SSE (`data:` chunks) |
| Models endpoint | ✅ | 44 models: `claude-opus-4.6`, `gpt-5.4`, `gemini-3-pro-preview`, etc. |
| Token exchange needed? | ❌ No | `api.githubcopilot.com` accepts GitHub tokens directly |
| Zero-scope PAT | ✅ | Fine-grained PAT with zero permissions works |
| Classic PAT (no copilot scope) | ✅ | Works — API checks subscription, not scopes |
| Copilot Enterprise billing | ✅ | Counts against premium request quota |

### Key simplification
The proxy does NOT need the `copilot_internal/v2/token` exchange step. It just injects `Authorization: Bearer <PAT>` — same complexity as the current Anthropic proxy.

### Recommended token
Fine-grained PAT with **zero permissions**. Only needs: valid GitHub account + active Copilot subscription. Minimizes blast radius if token is compromised.

### Verified API details
```
POST https://api.githubcopilot.com/chat/completions
Headers:
  Authorization: Bearer <any-github-token>
  Copilot-Integration-Id: vscode-chat
  Editor-Version: Neovim/0.9.0
  Content-Type: application/json

Body: standard OpenAI chat/completions format (forwarded verbatim)
Response: standard OpenAI chat/completions format (returned verbatim)
Streaming: standard SSE (text/event-stream)
```

## Reference OSS Projects

| Project | Stars | Link | Key file |
|---------|-------|------|----------|
| copilot-openai-api | 43⭐ | [github.com/yuchanns/copilot-openai-api](https://github.com/yuchanns/copilot-openai-api) | `main.py` — pure proxy source |
| copilot-proxy | 38⭐ | [github.com/hankchiutw/copilot-proxy](https://github.com/hankchiutw/copilot-proxy) | |
| coxy | 36⭐ | [github.com/coxy-proxy/coxy](https://github.com/coxy-proxy/coxy) | Rewrite of copilot-proxy |
| go-copilot-api | 8⭐ | [github.com/teamcoltra/go-copilot-api](https://github.com/teamcoltra/go-copilot-api) | Go implementation |
| copilot-sdk-proxy | 3⭐ | [github.com/theblixguy/copilot-sdk-proxy](https://github.com/theblixguy/copilot-sdk-proxy) | Translates to SDK sessions |
