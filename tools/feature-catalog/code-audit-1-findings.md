# CODE-AUDIT-1 — Source files referenced by catalog YAMLs (sections 01-03)

**Date**: 2026-05-25
**Scope**: 295 unique src/ files cited in `evidence.code:` lists across
`tools/feature-catalog/features/{01-agent-loop,02-tool-system,03-permission-safety}/*.yaml`.
**Mode**: READ-ONLY. NO HEURISTICS — every finding cites file:line with grep / AST signal.
**Method**: extracted candidate srcs from yamls via `awk`, then ran 11 objective signals
(TODO/FIXME, biome-disable, `as any`/`as unknown as`, console pollution, stub throws,
empty catches, magic numbers, long functions, hardcoded paths, deep nesting, stale ADRs).

## Summary

| Severity | Count |
| --- | --- |
| CRITICAL | 0 |
| HIGH | 9 |
| MEDIUM | 6 |
| LOW | 1 |
| **Total** | **16** |

**Headlines**:
- **Zero `as any` code casts** across all 295 audited files. Every textual occurrence is in a JSDoc / comment, often explicitly documenting that the surrounding code is *protected against* `as any` bypass (e.g. `side-conversation/run.ts:111,144,194,252,295`).
- **Zero stub `throw … not implemented`** — no façade methods that claim integration but raise.
- **Zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`** in real code (3 hits in `tool/file-tree-summary/index.ts` are noise-detector data literals).
- **Zero TODO/FIXME/HACK/XXX in security-critical paths** with the exception of the 9 `TODO(absorb #N)` markers below — all 9 are *self-disclosed deferred-wire seams* (see HIGH section), not silent debt.
- **Every empty `catch {}` (44 instances) carries a single-line rationale comment** — none is a truly silent swallow. The `runtime/guarded-spawn.ts` family + `lsp-bridge`/`mcp/client`/`permission/recorder` follow the same `// best-effort` / `// observability bugs must not change gate behavior` pattern.
- **121 distinct `ADR-XXXX` citations in source, 100% present in `docs/decisions/`** (no stale refs).
- **No hardcoded `/Users/…`/`/home/…`/`C:\` paths in code** — 6 matches all sit in comments or are negative-example strings (`permission/policy-rules.ts:62-63`, `tool/glob/index.ts:30`).

## CRITICAL — 0 findings

No stub throws, no empty catch in load-bearing paths, no hardcoded user-specific paths. Pass.

## HIGH — 9 findings (`TODO(absorb)` markers — deferred-wire seams)

These are not bugs, but they need calling out because the catalog YAMLs in sections 01-03 list these files under `evidence.code` (i.e. the catalog says the feature is integrated). The source files themselves admit the wire is incomplete. Hardening recommendation: either ship the wire, or annotate the related catalog yaml `integration_state` / equivalent so readers don't mistake "evidence exists" for "wired into loop".

| # | File:line | Marker | Self-described gap | Cross-ref catalog yaml |
| --- | --- | --- | --- | --- |
| H1 | `src/agent/admissibility-gate.ts:88` | TODO(absorb #2) | `rememberPatterns` / `isMaybeDangerous` not yet on model tool/schema surface | `03-permission-safety/61-permission-remember-patterns.yaml` |
| H2 | `src/agent/plan-exit.ts:17` | TODO(absorb #3) | "Standalone-callable. NOT wired into the loop" | `01-agent-loop/plan-exit-flow.yaml`, `01-agent-loop/62-plan-exit-three-way.yaml` |
| H3 | `src/agent/session-resources.ts:157` | TODO(absorb #6 cont.) | `diffMap` only fills if a tool routes numstat — no current tool does | `01-agent-loop/work-metrics.yaml` (sec 04 ref) |
| H4 | `src/agent/side-conversation/run.ts:307` | TODO(absorb #3 cont.) | plan-exit-flow not wired into side-conv | `01-agent-loop/side-conv-*.yaml` |
| H5 | `src/llm/model-swap.ts:29` | TODO(absorb #7) | `/retry-with <model>` CLI command not implemented | catalog refs in 76/79 yamls |
| H6 | `src/permission/gate-pattern-wire.ts:33` | comment "still pending — see ADR-0061 §TODO" | model-facing pending-permission schema absent | `03-permission-safety/96-gate-pattern-wire.yaml` |
| H7 | `src/permission/gate-pattern-wire.ts:120` | TODO | LLM-facing pending-permission surface is TODO | same as H6 |
| H8 | `src/permission/gate-pattern-wire.ts:123` | TODO(absorb #2) | dispatch cascade not wired — returned ids are pure value | same as H6 |
| H9 | `src/tool/factory.ts:136` | TODO(absorb #1) | streaming-dispatch not driving `tool_use_start/delta/end` callbacks live | `02-tool-system/factory.yaml` family |

Signal: `rg -n "TODO\(absorb" <sec123-srcs>` — 9 hits, all in production source files cited by catalog yamls.

## MEDIUM — 6 findings (long functions, declared but not split)

Functions >100 LOC in the audit set. Each is intentional (long bodies have section-marker comments + ADR refs), but breaking them up would aid review. None are "spaghetti" — they read top-to-bottom with explicit phase markers.

| # | File:line | Function | LOC | Notes |
| --- | --- | --- | --- | --- |
| M1 | `src/storage/shadow-odb/default.ts:310` | `defaultShadowOdb` | 647 | factory returning ~12 closures; could be split into per-op factories |
| M2 | `src/agent/loop.ts:1637` | `runAgentInner` | 566 | the main agent loop. Trade-off documented at line 1635 ("restructuring every return path") |
| M3 | `src/apps/cli/raw-line-reader.ts:193` | `readLine` | 524 | terminal-state machine; outside sec 01-03 critical-path |
| M4 | `src/agent/loop.ts:613` | `maybeCompact` | 145 | compaction orchestrator |
| M5 | `src/agent/stream-callbacks.ts:161` | `createStreamDispatcher` | 152 | refactor target — recent commit `047238f` already extracted this; further split possible |
| M6 | `src/agent/admissibility-gate.ts:198` | `reviewAndDecide` | 105 | central decision fn, dense but linear |

Signal: AST-light brace-balanced scanner counting `function name(`/`const name = () => {`. 17 functions >100 LOC total; remaining 11 are <150 LOC and judged acceptable.

## LOW — 1 finding

| # | File:line | Issue |
| --- | --- | --- |
| L1 | `src/agent/session-resources.ts:55` | `// biome-ignore lint/style/noNonNullAssertion: call site guards 'config.store'` — single justified biome suppression in sec 01-03 srcs; rationale present but the underlying non-null-assertion (`config.store!`) could be replaced with an early `if (!config.store) throw …`. Acceptable as-is. |

Signal: `rg -n "(eslint\|biome)-(disable\|ignore)"` — 9 hits in audit set; 8 are in tools/CLI files outside sec 01-03 hot path (file-tree-summary, rule-indicator, parse-test-failure, xlsx-read, status-pills, schema.ts, moved-code/parse-unified-diff, file-tree-summary noise checks). All carry an inline rationale.

## Negative findings (signals checked, zero hits)

| Signal | Hits in sec01-03 srcs |
| --- | --- |
| `throw new (Error\|TypeError) … not implemented` | 0 |
| `throw new … (unimplemented\|todo\|stub\|fixme)` | 0 |
| `@ts-(ignore\|expect-error\|nocheck)` in real code | 0 (3 string-literal data hits in file-tree-summary noise checks) |
| `console.(log\|warn\|error\|debug\|info)` outside `apps/cli` | 0 |
| Hardcoded `/Users/…`/`/home/…`/`C:\` paths in code (not comments) | 0 |
| Truly silent `catch {}` (no comment, no logging) | 0 — every one of 44 has rationale |
| Stale ADR references | 0 (121 cited / 192 exist, all cited ADRs resolve) |
| `as any` code casts (real, not in JSDoc) | 0 |

## Methodology notes

- Source list assembly: `for f in tools/feature-catalog/features/0[123]-*/*.yaml; do awk '/^  code:/{f=1;next} /^  [a-z]+:/{f=0} f && /^    -/' "$f" | awk '{print $2}'; done | sort -u` → 296 entries → 295 src/ paths (1 `AGENTS.md` excluded). All 295 exist on disk.
- Empty-catch detection used a balanced-brace Python scanner that strips JS/TS comments before testing whether the body is empty, to avoid false negatives on `catch { /* rationale */ }`.
- Long-function detection used a balanced-brace scanner aware of string literals, template literals (incl. `${…}` nesting), and line/block comments — not a regex line-counter.
- ADR registry: `ls docs/decisions/ | grep -oE '^[0-9]{4}'` → 192 unique numeric ids. Source citations: `rg -no 'ADR-[0-9]+' <sec123-srcs> | awk -F: '{print $NF}' | sort -u` → 121 unique. Set difference is empty.

## Conclusion

The src files referenced by sections 01-03 of the feature catalog are **clean code by every objective signal except for 9 self-disclosed deferred-wire TODOs**. There is no hidden debt: every suppression carries a rationale, every silent catch has a comment, every long function reads linearly, every ADR citation resolves. The actionable finding is the H1-H9 list — those are *real* gaps between "catalog says wired" and "source admits not wired", and they should be reconciled either by completing the wire or by marking the catalog yaml accordingly.
