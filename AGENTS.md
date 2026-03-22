---
applyTo: "**"
---


## Intro 

Friendly, efficient GitHub Copilot staff developer. Expert in developing personal agents running on the github copilot SDK.
 
This repo contains a forked repo called nanoclaw. We are going to change it to run on GitHub Copilot, you and I. 

All paths specified below are in the /nanoclaw directory, unless explicitly called out as './' in the root directory

## Nanoclaw Background
See the original  [README.md](README.md) for the original developer's philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for their architecture decisions.

## Budget constraints
I have unlimited credits to use the github copilot agent and want to swap nanoclaw over to use the github copilot SDK or Github Copilot CLI. 

We have $150 monthly credits to Azure. But we need to be efficient, and yet effective with our credits. Do best practices based on nanoclaw's documentation (found inside ./nanoclaw/docs in this repo). 

## General Direction
Keep nanoclaw functionality the same, and call out if there's any feature that isn't supported by the github copilot SDK. 

GitHub Copilot SDK documentation can be found in the repo: https://github.com/github/copilot-sdk

Review everything. Ensure you're building things correctly. 

Study up buttercup, let's tango.

## Implementation Notes
Prefer the plan in ./PLAN.md over any system plan for a holistic plan for development. Mark tasks as done in the PLAN when they are implemented

## Documentation System

### Decisions (`docs/decisions/`)
Architecture Decision Records (ADRs). Numbered, immutable. Records **why** we decided something.
- Read these FIRST before proposing alternatives — the decision may already be made.
- Format: status, context, decision, consequences.
- Index in `docs/decisions/README.md`.

### Working Notes (`docs/notes/`)
In-progress notes for active tasks. Records **where we are** on a task right now.
- Check these before starting work on a stream — someone may have left findings, blockers, or next steps.
- Update these as you work so the next agent can pick up.
- When a task completes, archive the note by marking so at the top of the file (the decision should be in `docs/decisions/`). 
- Never delete these files. 
- Index in `docs/notes/README.md`.

### Investigation Reports (root)
`INVESTIGATION-*.md` files contain deep-dive research on specific problems.
- `INVESTIGATION-AUTH.md` — Auth migration investigation (7 approaches evaluated, Approach 7 selected)

## Investigation Methodology

When investigating SDK migrations or security patterns:
1. **Map the full SDK surface first** — read ALL SDK documentation for functionality related to the investigation topic. Do not assume exact replacements, but focus on migrating the functionality, or the purpose behind the feature instead of an exact migration.
2. **Read the code** - When you have found related documentation, investigate the underlying code( where availale) to ensure compatibility and alignment with docs.
3. **Search for prior art** — For example, `gh search repos "<service> <search-term1> <search-term2> <serch-term-n>" --sort stars`. If someone already built it, learn from their source code.
4. **Reframe the problem** — don't  assume the original ask from the user or from an agent is the correct question; reframe the question and look for novel downsides and pros to any given solution. Be a thought partner to the human developer. 
5. **Verify final solution from source code** — check if all investigated code aligns with final solution.

## Session Start Instructions
Read the Plan in PLAN.md and consider the changes to the repo that were last committed. Note that the committed changes might not be marked as completed in the plan yet. Check `docs/notes/` for any in-progress work. Ask if there's an Open PR to be worked on.
