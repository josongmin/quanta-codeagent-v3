---
name: progress-audit
description: Audit work-in-progress with code-only evidence. Triggers on "code-only", "코드 레벨로만", "문서는 보지 말고", "진행률", "P0/P1/P2", and explicit verification requests. Outputs success/partial/uncertain with file:line proof; never claims "complete" without verification.
userInvocable: true
allowedTools: ["Read", "Grep", "Bash"]
category: skill
stability: stable
---

# Code-only progress audit

You are running an audit that ranks **code evidence above documents**. The user
wants to know what is actually implemented, not what a plan or README claims.

## When this skill activates

Triggers (any one is enough):

- The user says "code-only" / "코드 레벨로만" / "문서는 보지 말고" / "진행률".
- The user asks for "P0/P1/P2" classification of remaining work.
- The user explicitly asks you to **verify** a feature or to audit progress.
- The user disputes a previous "looks done" / "complete" claim.

If none of these apply, do not silently re-route a normal task into an audit.

## P0 critical rules (six, in order)

These rules override every other instinct. Violating any of them invalidates
the audit and the model MUST restart from rule 1.

1. **No finding without code evidence.** Every claim about what exists, is
   wired, or works must cite a file path + line number from the running tree.
   No claim from memory, no claim from a plan doc alone.
2. **No grep-only proof.** A `rg` hit only proves a symbol exists. To call
   something implemented you must trace the symbol to either (a) a behavior
   path (call site → effect), or (b) a passing test that exercises it.
3. **No "looks fine" without an explicit review scope.** Before saying a lane
   is healthy, declare in one sentence what you actually inspected
   (files, tests, gates) and what you did NOT.
4. **Partial proof is not closed.** If you can prove the contract but not the
   runtime wire-up, the lane is `partial`, not `success`. Promote to `success`
   only when contract + runtime + test all line up.
5. **Default review-only.** Do not modify code, tests, or docs during an
   audit unless the user explicitly asks. The audit's job is to report.
6. **Stub / fallback / degraded rails stay visible.** If a path uses a fake
   value, an `if (env.DEBUG)` short-circuit, a TODO comment, or a silent
   try/catch, it MUST appear in the report even if everything else is green.

## Procedure (seven steps)

Follow these in order. Skipping a step is a rule-1 violation.

1. **Restate the contract.** In one short paragraph, write what the user is
   actually asking about (which feature, which gate, which lane). If the
   request is ambiguous, ask before reading code.
2. **Build evidence first — code, tests, gates.** Use `rg` (ripgrep) on the
   running tree before any planning doc. Plan docs are corroborating, not
   primary. Prefer file paths under `src/`, `tests/`, `tools/` over `docs/`.
3. **Trace ONE production path with file:line per claim.** Pick the
   smallest end-to-end trace that exercises the claim: dispatch site →
   handler → effect → assertion. Every step gets a `path:line`. If you
   cannot finish the trace, the claim is `uncertain`.
4. **Split the work into lanes.** Standard four lanes (adapt if the feature
   genuinely has fewer):
   - **contract** — types, schemas, exported surface
   - **runtime** — the wire-up that makes the contract do something
   - **consumer** — call sites that depend on it
   - **tests** — what guards the contract + runtime against drift
   Score each lane independently.
5. **Freeze findings as `implemented` / `partial` / `blocked`.** Use these
   three only. "Done" / "complete" are forbidden until step 6.
6. **Verify with the narrowest trustworthy command.** Run the smallest test
   or check that proves the trace: a single unit test, a `bun test
   tests/unit/x.test.ts`, a `bunx biome check` on the touched files.
   Prefer narrow over broad — broad commands hide which lane failed.
7. **Report.** Surface:
   - **% complete** per lane and overall (integer percent; show the math).
   - **implemented** — `path:line` list with the trace.
   - **partial** — `path:line` + what's missing to promote to implemented.
   - **blockers** — open questions you could not answer from code alone.
   - **P0 / P1 / P2** — remaining work, ranked by whether it gates the
     stated contract (P0), gates a consumer (P1), or is polish (P2).

## Outcome enum

The audit terminates with **exactly one** of:

- `success` — every lane is implemented AND verified by step 6. Requires
  proof on disk; not asserted from confidence.
- `partial` — at least one lane is `implemented`, at least one is `partial`
  or `blocked`. Default state for in-flight work.
- `uncertain` — you could not finish the trace for any lane, or step 6
  could not be run. Honest "I don't know from code".

The string `complete` is **forbidden** in audit output. If you find yourself
typing it, you have skipped step 6.

## Non-goals (do NOT do these)

- Do not treat planning docs (`docs/**`, RFCs, ADRs) as primary evidence.
  They corroborate code; they never replace it.
- Do not silently turn a prompt-writing or design task into a factual audit.
  If the user asked for a design, ask before pivoting.
- Do not mark anything `complete` without running step 6. A confident
  prediction is not verification.
- Do not edit files during an audit unless the user explicitly asks. The
  point of an audit is to report, not to ship.
- Do not hide a stub / fallback / `TODO` because the rest of the lane is
  green. Visibility is the only thing that lets the user trust the report.

## Source attribution

This skill is adapted from Codex Desktop's bundled
`code-only-progress-audit/SKILL.md`. The rules and procedure structure are
mirrored to preserve auditor discipline across agents; quanta-v3 specifics
(repo layout, `bun test`, biome) replace Codex toolchain wording. See ADR-0045.
