# SEP5-12 — non-vacuous test and ratchet campaign

**Priority:** P1 release gate
**Status:** COMPLETE — implementation is on `main`; exact clean CI green
**Depends on:** every SEP5 implementation ticket that lands
**Finding coverage:** D1, D2, D3, D4, D5, D6, D10, D11, D15, D19, D27, D28

## Goal

Require each remediation to ship with a failing pre-fix behavioral rail, a
specific red-on-mutation control, a non-zero population floor, and proof that
the test runs in the repository's normal CI selection. A green test file that
is not selected, scans zero subjects, or only matches a symbol name is not a
ratchet.

## Ratchet contract

Every implemented ticket records these five receipts in its PR description or
merge evidence:

1. **Baseline RED:** test name, exact pre-fix failure, and command at the frozen
   base SHA.
2. **Structural mutation:** the smallest owner-local change that reintroduces
   the defect, plus the exact failing row/test.
3. **Anti-vacuum floor:** a numeric lower bound or closed-universe equality for
   the subjects/cases exercised.
4. **Production GREEN:** the same test through the real entrypoint or injected
   production seam, not only a copied helper.
5. **CI enrollment:** proof that `bun run test:ci` selects the file, followed by
   a complete exact-HEAD CI exit receipt.

Temporary mutation commits are never merged. Apply the mutation, record the
expected failure, restore only that owned hunk, and rerun GREEN. Do not use a
comment/import/bare-identifier search as the mutation proof.

## Ticket matrix

| Ticket | Primary test file | Baseline RED / mutation | Anti-vacuum floor |
|---|---|---|---|
| SEP5-01 | `tests/unit/cli/gh-exec-policy-hellgate.test.ts` | inherited sentinel; remove canonical scrub or replace tree killer with root-only kill | 3 public adapters; 6 argv edge cases; 1 real descendant |
| SEP5-02 | `tests/unit/tool/gh-pr-comment-outbound-policy.test.ts`; `tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts` | captured raw secret/duplicate post; bypass body policy or omit stable key | 1 HITL path; 1 automation path; shared secret corpus >= 17 |
| SEP5-03 | `tests/unit/secret-sink-parity-hellgate.test.ts` | URL userinfo absent; remove one named signature | secret cases >= 17; benign cases >= 8 |
| SEP5-04A | `tests/unit/auth/private-file-atomic.test.ts` | fixed temp collision/rename after sync failure; restore fixed temp name | writers >= 32; failure phases >= 4 |
| SEP5-04B | `tests/unit/auth/chatgpt-refresh-transaction.test.ts`; `tests/integration/chatgpt-refresh-cross-process.test.ts` | issuer count 2; remove post-lock re-read | 2 independent holders/processes; 1 shared path; 1 issuer endpoint |
| SEP5-05 | `tests/unit/migration/claude-config-entrypoint-parity.test.ts` | two decoders diverge; restore one local classification branch | valid fixture families >= 6; both distinct error policies |
| SEP5-06 | `tests/unit/cli/mcp-name-surface-parity.test.ts` | projection mismatch; restore old regex in one consumer | names >= 12; surfaces = 3; collisions >= 3 |
| SEP5-07 | `tests/unit/permission/thread-permission-entrypoint-parity.test.ts` | corrupt primitive differs; remove one enum literal from decoder | every closed-union member; invalid families >= 6; consumers = 2 |
| SEP5-08 | `tests/unit/shared/jsonrpc-envelope.test.ts` | MCP/LSP shape divergence; weaken literal/version check | positive variants >= 4; negative variants >= 8; adapters = 2 |
| SEP5-09 | `tests/unit/retrieval-authority-manifest.test.ts` | live legacy factory call; inject a legacy call into AST fixture | canonical factory calls >= 2; scanned production files > 0 |
| SEP5-10 | `tests/unit/knob-read-authority-parity.test.ts` | missing/orphan/duplicate authority; inject each manifest defect | inventory = recomputed closed universe; runtime knobs = recomputed closed universe |

## Exact mutation protocol

For each ratchet:

```sh
git rev-parse HEAD
bun test <ticket-test-files>
# apply one documented owner-local defect mutation
bun test <ticket-test-files>  # must fail at the named assertion
# restore only the mutation hunk; do not reset unrelated work
bun test <ticket-test-files>
git diff --check
```

The PR receipt must include the failing assertion text, not only a non-zero exit
code. If the mutation causes compile failure before reaching the targeted
assertion, the mutation does not prove the behavioral ratchet and must be
replaced with a type-correct defect injection.

## Behavioral fixture rules

- Secrets are fabricated and visibly tagged; no real credential bytes enter
  fixtures, snapshots, process listings, or failure messages.
- Process tests use bounded deadlines and kill their full fixture process tree
  in `finally` so a failed rail cannot leak children into later tests.
- Filesystem tests use a per-test `mkdtemp` directory, same-directory temp files,
  real POSIX mode checks where supported, and unconditional cleanup.
- Concurrency tests use a deterministic barrier/latch. A loop with lucky timing
  is supplementary stress, not the only proof.
- Cross-process OAuth proof uses two Bun child processes and one parent-owned
  counting HTTP endpoint. Two calls against one in-memory coordinator are only
  process-local proof.
- Source inventories use the TypeScript compiler AST or runtime reflection.
  Text scanning is allowed only for a prohibited syntax/site inventory and must
  include an injected offending fixture plus a non-zero scanned-file floor.

## Existing rails to extend, not duplicate

- Enroll `gh` subprocess sites in
  `tests/unit/runtime/exec-cluster-spawn-env-scrub-ban-hellgate.test.ts`; retain
  its injected-offender and non-zero spawn-site checks.
- Reuse process-tree fixtures/patterns from
  `tests/unit/runtime/process-tree-kill-hellgate.test.ts` and
  `tests/unit/runtime/bench-exec-tree-kill-hellgate.test.ts`.
- Reuse captured GitHub ports from
  `tests/unit/integrations/github/pr-output-sink-reconcile-hellgate-r4.test.ts`;
  no real GitHub call belongs in unit tests.
- Extend `tests/unit/redaction-parity-hellgate.test.ts` from its frozen 14-case
  corpus to at least 17 cases by adding service-account, JWT, and URL-userinfo
  coverage. Bearer and GitLab rows already exist and must remain.
- Keep `tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts` as a
  descending ceiling. Tighten after actual removals; never raise it.

## CI enrollment rail

Add `tests/unit/sep5-ratchet-enrollment.test.ts` only if `test:ci` does not select
new files automatically. Its implementation must parse the resolved test
selection/configuration and assert that every landed ticket's primary test file
is selected. It must not merely search `package.json` for a filename.

The enrollment test has its own controls:

- expected file list length equals the number of landed implementation tickets;
- every expected path exists;
- a synthetic missing path is rejected;
- removing one expected path from a cloned resolved selection fails for exactly
  that path.

## Proof sequence

Ticket owner runs:

```sh
bun test <ticket-local files>
bun run typecheck
bun run lint
bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts
git diff --check
```

Final integrator runs on a newly frozen, clean exact HEAD:

```sh
bun test tests/unit/sep5-ratchet-enrollment.test.ts
bun run test:ci
```

If the enrollment file is demonstrably unnecessary because the resolved CI
runner already selects every matching unit/integration file, record that
resolved selection as the receipt and do not add a redundant scanner.

## Definition of done

- Every landed SEP5 implementation has all five ratchet receipts.
- Every mutation is type-correct and fails the intended assertion.
- Every inventory has a numeric floor or exact closed-universe equality.
- The final exact HEAD passes local focused rails and the complete CI command.
- No lint-debt, raw-env, architecture, or god-code ceiling increases.

## Stop conditions

- The only RED proof is a compile error, bare-name regex, empty test selection,
  timeout, or killed parent process.
- A real network service or real credential is required for a unit ratchet.
- A mutation can pass because the production entrypoint is not wired to the
  tested owner.
- Full CI lacks a terminal exit/footer receipt.

## Verification update — 2026-09-06

Verification was run from a detached clean worktree at delivered closeout
`9139626f93763ce3b52f2b05a2224e30ebde0dd6`. It contains the SEP5
implementation, the required runner scan-reach floor tighten, the
verification-lifecycle repairs below, and the terminal ticket updates.

| Rail | Result |
|---|---|
| Focused SEP5 bundle (23 explicit files) | `273 pass, 0 fail` |
| OAuth related bundle including silent-failure ratchet | `46 pass, 0 fail` |
| Slice boundaries (auth/llm/integrations/tool) | `39 pass, 0 fail` |
| `typecheck:all` | PASS |
| `lint` / `lint:debt` | PASS; existing warnings only; complexity debt 0 |
| god-code ratchet | `9 pass, 0 fail` |
| `bun fc validate` / `bun fc diff` | 1069 resolved / no drift |
| Complete clean `test:full:ci` receipt | PASS, chunks `37/37`, manifest files `3850` |
| Complete clean `bun run test:ci` receipt | PASS, gates `21/21`, stable clean snapshot |

Three failures found during closeout were repaired at their actual owners:

1. `tests/unit/eval-cancellation-hellgate.test.ts` completed both assertions,
   then a shard retained an open handle. `src/shared/abortable.ts` now has one
   terminal settle path that clears the timer and removes the abort listener on
   both outcomes, plus a post-registration abort recheck. The injected
   registration-race rail proves cleanup and settlement.
2. `tests/unit/project-env-astropy-real-e2e.test.ts` could reuse an editable uv
   artifact after `git clean -fdx` removed native extensions. The project-env
   authority now uses `--reinstall-package astropy --no-cache` only for the
   exact native-extension repo override. The real upstream base+candidate rail
   passed three consecutive standalone runs and the final full campaign.
3. The default-off completeness guard discovered
   `QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE` but its generic reflection
   vocabulary never supplied either legal enum token, falsely classifying the
   live field as a dead read. The guard now probes `RESTART` and `TRUNCATE`, so
   it proves the live mapping and the unset `undefined` default. Its focused
   rail passed `10/10`, and the repaired rail passed in the complete full suite.

Final `bun run test:ci` passed all 21 gates, including full-suite, PTY,
non-vacuity, real-toolchain (`41 pass, 2 visible capability skips, 0 fail`), web
frontend (`807/807`), and contract (`13/13`). Missing host capabilities were
reported as `dlv`, `gopls`, and `lldb-dap`; they were not silently counted as
executed coverage. Local, tracking, and remote `main` all resolved to the exact
closeout SHA when the receipt was recorded.
