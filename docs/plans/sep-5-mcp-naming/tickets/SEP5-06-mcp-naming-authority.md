# SEP5-06 — MCP identifier and tool-name authority

**Priority:** P2
**Status:** PLANNED
**Depends on:** SEP5-00
**Finding coverage:** D6

## Goal

One MCP-owned contract must normalize server/tool segments used by health paths,
CLI surface keys, and bridged tool names. Callers may format their outer shape
but may not copy the character policy.

## Placement

Put the primitive in `@/mcp`, not `@/host`. MCP owns the namespace semantics;
host and apps are adapters. `@/agent` can consume `@/mcp` under the live fence.

## Proposed API

```ts
export const sanitizeMcpNameSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]+/g, "_")

export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${sanitizeMcpNameSegment(server)}__${sanitizeMcpNameSegment(tool)}`
```

Before finalizing, decide and test empty segments and collision behavior. Do not
silently add trimming, Unicode normalization, case-folding, or underscore
collapse; each would change existing names.

## Write set

| File | Change |
|---|---|
| `src/mcp/naming.ts` | Add canonical segment and tool-name functions |
| `src/mcp/index.ts` | Export the naming contract |
| `src/agent/mcp-tool-adapter.ts` | Import/re-export or consume canonical `mcpToolName` |
| `src/host/mcp-health.ts` | Replace local sanitizer with MCP primitive |
| `src/apps/cli/repl/mcp-surface-wire.ts` | Delete local sanitizer and stale `mcp-bridge.ts` comment |
| `src/agent/subagent-tool-namespace.ts` | Use the primitive only where the intended contract is actually MCP naming |
| `tests/unit/mcp/tool-name-collision-hellgate.test.ts` | Expand canonical collision cases |
| `tests/unit/cli/mcp-name-surface-parity.test.ts` | New health/CLI/tool projection parity battery |

## Required decisions

- Preserve current replacement of each maximal special-character run with one
  underscore.
- Preserve case.
- Preserve existing leading/trailing underscores.
- Treat collisions as a separate detection/error contract; sanitization alone
  cannot make `a-b` and `a/b` distinguishable.
- Do not reuse this function for unrelated filesystem paths or generic IDs.

## RED rails

- Table: spaces, `/`, `:`, dots, hyphens, repeated punctuation, Unicode, empty
  strings, and already-clean names.
- Health route key and CLI server key differ for the same server name.
- Bridged tool name applies a different transform to server and tool segments.
- Known collisions are not reported by the existing collision rail.
- Deleting the live call from any projection fails a runtime/table test, not
  merely a bare-name source scan.

## Test and ratchet implementation

- `name-surface-parity.test.ts` owns a table of at least 12 names covering all
  listed character classes. For each row, invoke the real MCP naming function,
  host health projection, CLI surface projection, and bridged tool projection;
  compare the server segment exactly across all three consumers.
- Freeze at least three collision groups such as `a-b`/`a/b`, repeated
  punctuation variants, and Unicode-only segments. Assert the collision owner
  rejects/reports every group; sanitization alone is not the expected result.
- Explicitly freeze empty server/tool segments, leading/trailing punctuation,
  case, repeated separator collapse, and already-clean names before changing
  production code.
- Mutation A restores the old local regex in one consumer with `*` instead of
  `+`; repeated-punctuation row must fail for that surface only. Mutation B
  bypasses `mcpToolName` for the tool segment; a special-character tool row must
  fail.
- Anti-vacuum assertions require `cases.length >= 12`, projection consumers = 3,
  and collision groups >= 3. Verify the production composition functions are
  called, not test-local copies of their formatting expressions.

## Proof rails

```sh
bun test tests/unit/mcp/tool-name-collision-hellgate.test.ts
bun test tests/unit/cli/mcp-name-surface-parity.test.ts
bun test tests/unit/mcp-surface-wire.test.ts
bun run typecheck
bun run lint:debt
bun test tests/unit/mcp-slice-boundary.test.ts
```

## Definition of done

- One MCP function owns character normalization.
- Agent, host, and CLI projections are behaviorally identical for shared cases.
- Collision handling remains explicit and fail-loud.
- No new import carve-out is required.

## Stop conditions

- The owner is placed in host or an app surface.
- Consolidation changes existing external tool names without a migration plan.
- Collision detection is replaced by silent suffixing or last-write-wins.
