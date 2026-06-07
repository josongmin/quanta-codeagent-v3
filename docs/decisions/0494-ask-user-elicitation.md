# ADR-0494: ask_user — generalized structured elicitation

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/tool/ask-user/` (port + tool + barrel)
  - `src/tool/index.ts` (DefaultToolPorts.askUser + conditional registration)
  - `src/tool/surface/manifest.ts` (GATED entry, QUANTA_ASK_USER)
  - Tests: `tests/unit/ask-user-hellgate.test.ts`
  - Reuses: `src/mcp/elicitation/` (the 7-kind request vocabulary, ADR-0197)
  - Absorbs: Claude Code 2.1.167 elicitation/AskUserQuestion (docs/plans/jun-7-draft-ide-integration-spec-claude.md §19)

## Context

quanta's host↔agent human touchpoint was the BINARY `onConfirm` (allow / deny / deny_and_steer). MCP
servers had rich structured elicitation (`@/mcp/elicitation`, 7 request kinds) but ONLY server→user — the
AGENT itself could not put a structured question to the user mid-task (free text, yes/no, a pick, a
number). Claude Code exposes exactly this (the elicitation surface + AskUserQuestion).

## Decision

A new agent-callable tool `ask_user` (mirroring the `advisor` tool's shape) routed to a host
`AskUserPort`. The request vocabulary mirrors the MCP elicitation kinds (string / boolean / number /
integer / select / multiselect) so ONE host prompter can serve both surfaces, but the port is defined in
`@/tool/ask-user` (plane-clean: no `@/mcp` import in the `@/tool` leaf). NO-THROW: bad input, an empty
options list for select/multiselect, or a port that throws all collapse to a typed `ok:false`. The tool is
`isReadOnly:true`, `hitlTier:"none"` (it IS the human touchpoint, not a permission gate), and exposes no
shell extractor (never routed through HARD_DENY).

## Default posture

OFF. Gate `QUANTA_ASK_USER` + `DefaultToolPorts.askUser`. Absent ⇒ the tool is NOT registered
(byte-identical default menu). A headless host wires a port that returns typed `headless-denied`, so the
agent never blocks on an absent human.

## CLI wiring (LIVE, 2026-06-07)

Wired in the **app layer** (`src/apps/cli/ask-user-wire.ts` + `buildTooling` `extraTools` in
`src/apps/cli/internal.ts`), NOT the host layer — the terminal-defaults ratchet forbids `src/host/runtime`
(non-app) from owning process stdio. `buildCliAskUserTool(env)` returns the tool ONLY when `QUANTA_ASK_USER`
is on AND stdin is a TTY; it reuses the SAME interactive prompter the MCP elicitation surface uses
(`buildCliElicitationPrompterFactory` → readline-on-stdin / prompt-to-stderr, TTY-gated), wrapped by the
PURE `askUserPortFromPrompter` (no stdio of its own). Off / non-TTY (piped, headless) ⇒ `null` ⇒ the tool
is absent (byte-identical menu — the agent never sees a question it could not answer). So
`QUANTA_ASK_USER=1 claude` on a terminal gives the agent a working structured-question channel. The generic
`DefaultToolPorts.askUser` seam (`@/tool`) remains for non-CLI hosts (web/ide) to inject their own prompter.
Adapter + kind-routing + empty-enum→empty-options mapping proven by
`tests/unit/ask-user-cli-wire-hellgate.test.ts`.

## Correctness invariants (hellgate-proven)

1. Happy path: each kind routes to the port and renders the typed value.
2. Typed refusals (`headless-denied` / `cancelled` / `validation-error`) and a thrown port both surface
   ok:false — never an exception past the loop.
3. select/multiselect with empty options ⇒ ok:false BEFORE the port is reached.
4. Aborted signal / malformed input ⇒ ok:false.
5. Tool contract: read-only, hitlTier none, concurrency-safe.

## ROI / tradeoff

Generalizes the binary confirm into a structured question with high reuse of the existing elicitation
machinery. The composition-root adapter bridging `AskUserPort` → the `@/mcp/elicitation` host prompter is
the documented follow-up wire (keeps the leaf fence clean).
