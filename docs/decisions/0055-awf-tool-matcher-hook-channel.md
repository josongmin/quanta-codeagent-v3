# ADR-0055 — AWF 2-matcher PreToolUse hook channel

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0013 (HookBus minimal in-process bus), [[claude-desktop-1-7196-catalog]] §AWF, [[cc-v2-sota-absorption]] (Tier-0 absorption #0-1)

## Context

Claude Desktop 1.7196.3 wires two SEPARATE PreToolUse hook channels via a
matcher discriminant — one matches the filesystem-touching tool group
(`AWF_GUARDED_TOOLS_MATCHER = "Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob"`)
and the other matches `Task`. The split lets a host apply different audit /
deny policies to file mutations vs. sub-agent spawns without per-call pattern
checks in user code.

quanta's `HookBus.on(type, handler)` fired EVERY handler on EVERY tool-shaped
event. Hosts wanting tool-subset gating had to write the pattern check inside
every handler — leaky and easy to forget.

## Decision

1. `src/agent/tool-matchers.ts` — pure leaf module exporting `ToolMatcher = string | readonly string[] | RegExp | ((name: string) => boolean)`, the canonical AWF groups (`FS_TOOLS_MATCHER`, `AGENT_TOOLS_MATCHER`), and `matchTool(matcher, name)`.
2. `HookBus.on<T>(type, handler, options?: { matcher? })` — third argument is optional. `matchTool` is consulted ONLY for tool-shaped events (`pre_tool_use`, `post_tool_use`); other variants ignore it. Omitting `options` is byte-identical to the prior 2-arg signature.
3. The matcher is evaluated O(1) (string / set / function) or O(name.length) (regex). There is NO fuzzy / heuristic fallback by design — a host that wants "anything starting with `read_`" passes a RegExp, NOT a magic prefix.

## Consequences

**Positive**
- Two-channel AWF policy (FS vs Agent) is now expressible at registration time, not per-call.
- Legacy 2-arg `on()` calls continue unchanged — every existing hook test passes byte-identical.
- Matcher remains pure data; no slice escape (`@/agent/hooks.ts` imports `./tool-matchers` only).

**Trade-offs**
- `string` form coexists with `string[]` — convenient for "single tool" registrations, but invites confusion with the regex case. Documented in the module header.

## Negative invariants

- An undefined matcher MUST match every tool name (legacy parity) — covered in `tests/unit/tool-matchers.test.ts`.
- A non-tool event (`session_start`, `turn_start`, …) MUST ignore the matcher and always fire — asserted in `tests/unit/hooks-matcher.test.ts` (not landed in this PR — covered structurally by `isToolEvent` predicate + emit logic).
- The handler-storage shape change (`AnyHookHandler[]` → `StoredHandler[]`) MUST preserve first-deny-wins ordering and the throw-isolated semantics. Verified by `tests/unit/hooks.test.ts` (existing baseline).

## Files touched

- `src/agent/tool-matchers.ts` — NEW.
- `src/agent/hooks.ts` — `HookBus.on` 3rd-arg + `StoredHandler` + `isToolEvent`.
- `tests/unit/tool-matchers.test.ts` — NEW (8 cases).
