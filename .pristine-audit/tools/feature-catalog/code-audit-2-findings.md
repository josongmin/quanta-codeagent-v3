# CODE-AUDIT-2 — sec 04/05/06/07 source files

Read-only literal-signal audit (no heuristics). Scope: 331 source files referenced
by `tools/feature-catalog/features/0[4567]-*/*.yaml` (collected via the YAML
`code:` block extractor specified in the audit brief). Signals are grep / awk
literal matches only — file:line cited for every finding.

## Counts per severity

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH     | 3 |
| MEDIUM   | 7 |
| LOW      | 5 |

No CRITICAL findings were observed in the audited focus areas:
- No `throw new Error("not implemented" | "unimplemented" | "TODO" | NotImplemented)` in any sec-04/05/06/07 source.
- No `{}`-body empty `catch` blocks in any audited file. The only silent-catch
  patterns are documented `try { proc.kill() } catch {}` cleanup closures in
  `src/runtime/guarded-spawn.ts` (lines 8/28/138 — JSDoc-only, not live code) and
  the directory-mkdir best-effort path at `src/skill/migration.ts:62`
  (`.catch(() => {})` on an idempotent `mkdir({ recursive: true })`).
- No hardcoded absolute paths (`/Users/`, `/home/`, `/tmp/`, `/var/`) in any
  audited `*.ts` source — sole hit is `tests/.../make-pr-easy-to-review/SKILL.md:54`
  which is documentation showing a `gh pr diff > /tmp/pr.diff` example.
- No score-leak / prompt-injection vector found in `memory-distill.ts`,
  `phase2-llm.ts`, or `writer.ts` (negative grep for score/relevance/priority
  fields being injected into prompt strings).

## Top 5 high-leverage findings (ordered by impact)

### 1. HIGH — Stale line reference in recovery-cap ADR comment
`src/agent/recovery.ts:12` claims caps are documented in `loop.ts:1557-1560`,
but those lines in `src/agent/loop.ts` (now 2202 LOC) belong to the
summarize/resume branch (`// summarize / resume — no L4 behavior wired here yet`)
— wholly unrelated to the same-turn recovery cap rationale. The actual
documentation has drifted. This is the textbook "stale ADR comment" failure
mode the brief calls out for sig-11. Memory load-bearing: recovery caps are
referenced by `tests/unit/recovery-hellgate.test.ts`.

### 2. HIGH — TODO seam in production loop adjacent path
`src/llm/model-swap.ts:29` — `TODO(absorb #7): wire SubmitRetryBotMessage
equivalent into loop/CLI` is in a Tier-0 retry-orchestration path. The seam is
default-OFF per `cursor-3.2-absorption` memory (ADR-0064), but the comment does
not state the default-OFF invariant locally; future maintainers cannot tell from
the file alone whether the path is wired.

### 3. HIGH — TODO seam in permission-cascade
`src/agent/admissibility-gate.ts:88` — `TODO(absorb #2): expose rememberPatterns /
isMaybeDangerous in the …` permission-gate model-facing schema. Security-touched
(this is the L4 cascade). Same module is the explicit "security-sensitive,
no scoring leak" focus called out by the brief. Pair-up: `src/permission/
gate-pattern-wire.ts:120/123` carry the matching TODO, and L120 says the surface
is `still pending — see ADR-0061 §TODO`, where `§TODO` is a placeholder
section reference (no real ADR file present — `find -iname "*adr*"` yields only
yamls + scan-adrs.ts, no `docs/adr/`).

### 4. MEDIUM — `runAgentInner` 565-line god-function (loop.ts)
`src/agent/loop.ts:1637-2202` — single `const runAgentInner = async (config:
AgentConfig): Promise<AgentOutcome> => { … }` arrow function is 565 lines. The
2nd- and 3rd-largest functions in the same file (`maybeCompact` 144 lines @
613-757; `streamConsume` 126 lines @ 411-537) also exceed the 100-line bar.
`runAgentInner` is the central dispatch loop for context-management +
resilience signals, so the size is the dominant readability-of-load-bearing-code
risk in the audited surface.

### 5. MEDIUM — `buildSystemPrompt` 383-line builder (prompt.ts)
`src/agent/prompt.ts:38-421` — `export const buildSystemPrompt = (…)`. The
prompt builder is the sec-04 context-management seam where compaction + repo-
rules + reminders compose; its size couples drift risk across every absorption
round (memory log records 16 absorption rounds touching this surface).

## Remaining findings (compact)

- MEDIUM — `src/agent/subagent-runner.ts:305` reaches indent depth 7 (max in
  audited sources). Triple-await-inside-conditional-ternary inside a subagent
  worktree call: `wt(…, async (worktreePath) => { … run(child) … }).value`.
- MEDIUM — `src/llm/stream-timeout.ts:134/225` carry `eslint-disable-next-line
  no-await-in-loop` comments. The sequential-await is intentional (timeout
  re-arm), but the disables are uncommented past the leading `//`.
- MEDIUM — `as unknown as` casts in 6 audited files (`memory-embedder.ts:63`
  EmbeddingsClient; `consolidate/reader.ts:33` nodeFs; `consolidate/store.ts:
  206-207` SQLite row rows; `subagent-persistence-store/hydrating-scheduler.ts:
  116` SubagentResult; adapter `anthropic.ts:364` + `openai.ts:393` raw event
  streams; `session/envelope-encoder.ts:154` Uint8Array iterable). All have
  contextual justification (port boundary / sqlite stmt rows / adapter event
  forwarding), but they're weak-types on hot paths.
- MEDIUM — TODO seams in 4 absorption-marker comments outside core loop:
  `src/agent/session-resources.ts:157`, `src/agent/plan-exit.ts:17`,
  `src/observability/work-metrics.ts:7/13/147`, `src/tool/factory.ts:136`.
  Each is a default-OFF seam tagged `absorb #N` with the wiring postponed.
- MEDIUM — `src/llm/fallback.ts` reaches indent depth 5 @ line 91 and
  `src/agent/recovery.ts` depth 5 @ line 151 — both inside resilience-decision
  branches the brief explicitly flagged ("error-handling quality matters").
- LOW — `src/skill/discover.ts:145/159` — `console.warn` calls (sole non-CLI
  `console.*` hits in the audit). Each has an explicit JSDoc justification:
  `// leaf slice cannot import a structured logger` (L140/155). Trade-off
  documented; not actionable.
- LOW — `src/agent/issue-hint/normalize.ts:12`, `src/apps/cli/status-pills.ts:107`,
  `src/session/paths.ts:74` — `biome-ignore lint/suspicious/noControlCharactersInRegex`
  with reason strings (ANSI strip / id control-byte guard). All justified inline.
- LOW — `src/subagent/task-tools.ts:144` — `eslint-disable-next-line
  require-yield` on a generator stub. Justified by single-emit envelope.
- LOW — ADR number drift between code and yaml: `src/agent/branch-search/**` +
  `src/agent/branch-search-runner.ts` all reference `ADR-0084`, but
  `tools/feature-catalog/features/04-context-management/token-estimator-chars-
  quarter.yaml:22` and `06-tier1/runner-run-once.yaml:27` reference `ADR-0083`
  for the same multi-modal / branch-search cluster. Memory log
  `may-22-b2-c1-branch-search-mode-expansion` confirms this is the documented
  drift, not a new bug.
- LOW — `src/agent/compaction.ts:44/51` — `IMAGE_CHAR_ESTIMATE = 6000` and
  `DOCUMENT_CHAR_ESTIMATE = 12000` are magic numbers, but each carries an
  inline ADR-0083 rationale comment ("chars-per-quarter token proxy").

## Method (reproducibility)

1. Source set: `for f in tools/feature-catalog/features/0[4567]-*/*.yaml; do
   awk '/^  code:/{f=1;next} /^  [a-z]+:/{f=0} f && /^    -/' "$f" | awk
   '{print $2}'; done | sort -u` → 331 paths.
2. Per signal: literal `grep -nE` (TODO/FIXME/HACK; `biome-ignore|eslint-disable
   |@ts-ignore|@ts-expect-error|@ts-nocheck`; `as any|as unknown`;
   `console\.(log|error|warn|info|debug)`; `throw new Error\(".*not.implemented
   …"\)`; `catch.*\{[[:space:]]*\}`; absolute-path prefixes; `ADR-?[0-9]+`).
3. Long-function detection: `awk` brace-balancing inside the listed focus files.
4. Indent depth: `awk` leading-whitespace per file.
5. No file modified — read-only audit per scope.
