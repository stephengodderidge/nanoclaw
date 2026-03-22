# Auth Migration: Anthropic → Copilot SDK

## Problem

NanoClaw keeps real API credentials out of containers using a credential proxy. The container sends HTTP requests to the proxy; the proxy injects the real credential and forwards to the upstream API. The agent never sees the real key.

The Copilot SDK has no `ANTHROPIC_BASE_URL` equivalent — the CLI talks directly to GitHub's HTTPS endpoints. We need to replicate the proxy pattern without it.

## Solution: BYOK + Copilot Auth Proxy

> **Decision record:** [ADR 002](docs/decisions/002-auth-byok-proxy.md)

The Copilot SDK's BYOK mode supports `http://` base URLs. The Copilot backend at `api.githubcopilot.com` natively accepts OpenAI chat/completions format. Combined, these enable the exact same proxy architecture:

```
ANTHROPIC (before):
  Container                          Host Proxy (:3001)             Upstream
  ANTHROPIC_BASE_URL=               receives HTTP request →        api.anthropic.com
    http://host:3001                 injects x-api-key →
                                     forwards

COPILOT (after):
  Container                          Host Proxy (:3001)             Upstream
  BYOK baseUrl=                     receives HTTP request →        api.githubcopilot.com
    http://host:3001/v1             exchanges PAT → token →
                                     injects Bearer token →
                                     forwards
```

**Zero tokens in the container.** The only difference from the Anthropic pattern is that the proxy does a token exchange step (PAT → short-lived Copilot API token) before forwarding.

### How it works

1. **Container** uses BYOK mode — `provider: { type: "openai", baseUrl: "http://host:3001/v1" }`. No credentials needed.
2. **Host proxy** holds the GitHub PAT and exchanges it for a short-lived Copilot API token (~1hr) via `GET api.github.com/copilot_internal/v2/token`. Caches and auto-refreshes.
3. **Proxy** receives plain HTTP requests from the container, injects `Authorization: Bearer <copilot-token>` plus Copilot-specific headers, forwards the request body verbatim to `https://api.githubcopilot.com/chat/completions`.
4. **Response** returned verbatim — no transformation needed.

### Why the Copilot backend works as an OpenAI endpoint

The Copilot backend at `api.githubcopilot.com/chat/completions` natively accepts OpenAI format. Multiple OSS projects have validated this by building proxies that forward requests verbatim:

| Project | Stars | Approach | Source verification |
|---------|-------|----------|-------------------|
| [yuchanns/copilot-openai-api](https://github.com/yuchanns/copilot-openai-api) | 43⭐ | FastAPI proxy | `main.py` — `/chat/completions` is a pure forward, zero body transformation |
| [hankchiutw/copilot-proxy](https://github.com/hankchiutw/copilot-proxy) | 38⭐ | HTTP proxy | Proxies to `api.githubcopilot.com/chat/completions` |
| [coxy-proxy/coxy](https://github.com/coxy-proxy/coxy) | 36⭐ | TypeScript proxy | Rewrite of copilot-proxy |
| [suhaibbinyounis/github-copilot-api-vscode](https://github.com/suhaibbinyounis/github-copilot-api-vscode) | 64⭐ | VS Code extension | Local OpenAI-compatible API gateway |

These proxies exist to wrap Copilot's non-standard auth — not to translate the wire format. The `/chat/completions` bodies are OpenAI-compatible natively.

### Required headers on forwarded requests

```
Authorization: Bearer <github-token>
Copilot-Integration-Id: copilot-chat
Content-Type: application/json
```

Note: `Copilot-Integration-Id` is required (400 without it). Valid values include `copilot-chat` and `vscode-chat` (verified via spike). `Editor-Version` is optional.

### Token requirements

Verified via spike (2026-03-22):

- **Any valid GitHub token** on an account with an active Copilot subscription
- Classic PATs (`ghp_`), OAuth tokens (`gho_`), and fine-grained PATs (`github_pat_`) all work
- **No scopes required** — tested with a zero-permission fine-grained PAT. The Copilot API checks subscription status, not token scopes.
- **Recommendation:** Use a **fine-grained PAT with zero permissions**. If the token is ever compromised, it can't access repos, orgs, or anything else — only Copilot completions.
- The `copilot_internal/v2/token` exchange endpoint is NOT needed — `api.githubcopilot.com` accepts GitHub tokens directly with `Authorization: Bearer <token>`

### Security properties

| Property | Status |
|----------|--------|
| GitHub PAT in container | ✅ Never |
| Copilot API token in container | ✅ Never |
| Any credential in container | ✅ None |
| Parity with Anthropic proxy | ✅ Identical pattern |
| Copilot Enterprise billing | ✅ Premium requests |
| Tools execute in container | ✅ BYOK runs CLI locally |

---

## Rejected Approaches

Six alternatives were evaluated before discovering the BYOK approach:

| # | Approach | Why rejected |
|---|----------|-------------|
| 1 | **Direct token injection** — pass `GITHUB_TOKEN` to container env | Token visible to agent via `echo $GITHUB_TOKEN`. No credential isolation. |
| 2 | **Token server** — host serves token via HTTP, agent fetches at startup | Token ends up in CLI subprocess env (`COPILOT_SDK_AUTH_TOKEN`). Accessible via `/proc/*/environ`. |
| 3 | **Host-side `cliUrl`** — run CLI on host, connect from container | Tools execute on host, not in container. Defeats sandboxing. Custom tool forwarding rejected as unmaintainable. |
| 4 | **`HTTPS_PROXY`** — forward proxy intercepts traffic | CONNECT tunnels for HTTPS prevent header injection. Proxy can't see or modify encrypted traffic. |
| 5 | **TLS MitM proxy** — terminate TLS, inject auth, re-encrypt | Works but requires CA cert management and TLS termination. Fragile if GitHub changes endpoints. Too complex. |
| 6 | **Base URL override** — `COPILOT_API_BASE_URL` env var | Doesn't exist in the Copilot CLI. Would be ideal if GitHub added it. |

### Why approaches 1–6 missed the solution

All six were framed as "how to get the CLI authenticated inside the container." The breakthrough was reframing: "make the CLI not need auth at all" — BYOK mode bypasses CLI auth entirely, and the proxy handles it externally.

Key lessons for future investigations:
1. **Map the full SDK surface** — BYOK mode with `http://` base URLs was documented but overlooked
2. **Ask "is the backend OpenAI-compatible?"** — this unlocks the proxy approach immediately
3. **Search for prior art** — 10+ OSS projects had already validated the approach
