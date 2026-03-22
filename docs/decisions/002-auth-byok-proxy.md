# ADR 002: Auth Strategy — BYOK + Copilot Auth Proxy

**Status:** Accepted  
**Date:** 2026-03-21  

## Context

NanoClaw's security model keeps real API credentials out of containers. The current Anthropic setup uses a credential proxy: container sends requests to `http://host:3001` (via `ANTHROPIC_BASE_URL`), proxy injects real API key, forwards to `api.anthropic.com`.

The Copilot SDK has no equivalent `COPILOT_API_BASE_URL` env var. Six alternative approaches were investigated and rejected (see `INVESTIGATION-AUTH.md`):
1. Direct token injection — insecure
2. Token server — token leaks into CLI subprocess env
3. Host-side `cliUrl` — tools execute on host, defeats sandboxing
4. `HTTPS_PROXY` — CONNECT tunnels prevent header injection
5. TLS MitM — too complex and fragile
6. Base URL override — doesn't exist in Copilot CLI

## Decision

Use **BYOK mode + Copilot Auth Proxy** — the exact same proxy pattern as Anthropic, with zero tokens in the container.

**How it works:**
1. Container uses BYOK: `provider: { type: "openai", baseUrl: "http://host:3001/v1" }` — no auth needed
2. Host proxy exchanges GitHub PAT → short-lived Copilot API token via `GET api.github.com/copilot_internal/v2/token`
3. Proxy injects `Authorization: Bearer <copilot-token>` + Copilot headers
4. Proxy forwards request body verbatim to `api.githubcopilot.com/chat/completions`
5. Copilot backend is natively OpenAI-compatible for `/chat/completions` (no body transformation needed)

**Key evidence:**
- Source-code verified in `yuchanns/copilot-openai-api` (43⭐) — pure proxy, no body transformation
- Additional validation: `hankchiutw/copilot-proxy` (38⭐), `coxy-proxy/coxy` (36⭐), and 4+ more OSS projects
- See `INVESTIGATION-AUTH.md` Approach 7 for full details and project links

**Auth requirements (verified via spike 2026-03-22):**
- Any valid GitHub token on an account with an active Copilot subscription
- No specific scope required — zero-permission fine-grained PATs work
- No token exchange step needed — `api.githubcopilot.com` accepts GitHub tokens directly
- Recommended: fine-grained PAT with zero permissions (minimizes blast radius)

## Consequences

- Credential proxy rewritten from Anthropic header injection to Copilot token exchange + injection
- Container needs zero credentials — BYOK bypasses GitHub auth entirely
- Agent runner adds `provider` config to session creation
- Container runner stops injecting any tokens, adds `COPILOT_PROXY_URL` instead
- Uses Copilot Enterprise billing (premium requests)
- Depends on `copilot_internal/v2/token` endpoint (used by all Copilot clients, stable)
- `.env` changes: `ANTHROPIC_API_KEY` → `GITHUB_TOKEN` (fine-grained PAT with Copilot permission)
