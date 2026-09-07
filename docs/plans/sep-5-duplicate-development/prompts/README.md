# Sep-05 remediation — copy/paste worker prompts

## Dispatch prerequisite

The SEP-5 campaign is closed. Do not dispatch these historical implementation
prompts unless a finding is explicitly reopened under SEP5-11 with new live
evidence and an owner-local RED rail.

This packet is tracked. The audit SHA
`59ad4f9b3850b89c0417ef3d12d0c27d64917ba1` is a historical truth snapshot,
not a reusable dispatch base. Before reusing any prompt, freeze the current
`HEAD`/`origin/main`, verify that both its ticket and prompt revision are in that
commit, and re-check the live implementation. A fresh worktree created from the
historical audit SHA is stale by definition.

Historical first-wave parallel lanes:

- SEP5-01
- SEP5-03
- SEP5-04A
- SEP5-05
- SEP5-06
- SEP5-07
- SEP5-08
- SEP5-09
- SEP5-10

Dependency gates:

- SEP5-02 starts only after SEP5-01 and SEP5-03 are integrated.
- SEP5-04B starts only after SEP5-04A is integrated.
- SEP5-12 is the final integration/closure lane.
- SEP5-00 may run first as a documentation-only truth correction. SEP5-11 is a
  register, not an implementation lane.

Do not run SEP5-01 and SEP5-02 against the same checkout concurrently. Do not
run SEP5-04A and SEP5-04B concurrently.

## SEP5-00 — audit truth correction

```text
Implement SEP5-00 end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, then read:
- docs/plans/sep-5-duplicate-audit/tickets/SEP5-00-audit-truth.md
- docs/plans/sep-5-duplicate-development/tickets/README.md

This is a documentation-only truth correction. Do not change runtime code.

Before editing:
1. Record git rev-parse HEAD, git rev-parse origin/main, and git status --short.
2. Recompute every numeric claim from current code/runtime arrays. The ticket's
   frozen numbers are a snapshot, not permanent truth.
3. Confirm whether docs/bugbash/sep-05-duplicate-development.md has concurrent
   uncommitted ownership. If it changed after your snapshot, stop and report the
   overlap instead of overwriting it.

Perform every Required edits item in the ticket. Keep facts, inference, and
recommendations separate. Do not promote focused tests to full-CI closure. Do
not edit docs/bugbash/aug-25-wave1.md or generated feature-catalog Markdown.

Verification:
- run every Derivation command, replacing the placeholder bun snippet with an
  exact reproducible command/helper;
- run bun test tests/unit/slice-boundary-config-parity.test.ts;
- run bun test tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts;
- validate every internal Markdown link;
- run git diff --check.

Return:
- DONE or NOT DONE;
- exact HEAD/base and dirty-path ownership;
- corrected claims with command receipts;
- changed files;
- tests/commands with exit codes;
- anything still unverified.

Do not push, merge, or alter unrelated dirty files.
```

## SEP5-01 — canonical `gh` execution

```text
Implement SEP5-01 end to end in /Users/songmin/quanta-codeagent-v3. This is an
implementation task, not another design pass.

Read AGENTS.md, then read:
- docs/plans/sep-5-gh-safety/tickets/SEP5-01-gh-execution-authority.md
- docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md

Preflight:
1. Freeze HEAD, origin/main, git status, and the ticket write set.
2. If any claimed file is dirty from another owner, stop on that exact overlap.
3. Reproduce the inherited-environment defect through the current public path.
   If current code already fixes it, do not create a second authority; report
   the changed truth with evidence.

Required outcome:
- one argv-only GhExecPort owner in src/tool/gh/runner.ts;
- canonical scrubbed environment, caller abort, bounded timeout, and escalating
  process-tree termination;
- from-pr and ci-bot become result-shape/composition adapters only;
- no shell-string execution and no copied env/kill policy;
- the ticket's behavioral, mutation, and anti-vacuum rails are implemented.

Required proof:
- capture baseline RED before the fix;
- prove red-on-mutation for removed env scrub and root-only kill, then restore;
- run every ticket Proof rails command;
- run typecheck, lint, lint:debt, god-code ratchet, and git diff --check;
- state explicitly whether full test:ci was run. Do not claim full closure if it
  was not.

Return DONE/NOT DONE, exact HEAD, changed files, baseline RED, mutation failure,
GREEN commands with exit codes, remaining direct gh spawns, and unverified risk.
Do not push or merge. Preserve unrelated work and never raise a ceiling or
allowlist.
```

## SEP5-02 — PR comment outbound safety

```text
Implement SEP5-02 end to end in /Users/songmin/quanta-codeagent-v3 only after
SEP5-01 and SEP5-03 are integrated into your exact base.

Read AGENTS.md, then read:
- docs/plans/sep-5-gh-safety/tickets/SEP5-02-pr-comment-outbound-safety.md
- docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md

Freeze HEAD/origin/main/status, confirm SEP5-01's canonical GhExecPort is the
live gh authority, and confirm SEP5-03's shared fabricated corpus exists. Stop
if you would need to recreate or bypass either owner.

Implement the body-policy and automation contracts exactly as specified:
- redact before truncation;
- cap final UTF-8 bytes including marker;
- zero external calls on preparation failure;
- stable automation idempotency and concurrent reconciliation;
- explicit HITL comments retain create-new semantics and HITL gating.

Use captured fake GitHub ports only. Add the shared >=17 fabricated-secret
corpus, deterministic two-writer barrier, boundary byte rows, and all documented
mutation controls. Baseline RED and each type-correct mutation must fail the
named assertion before you restore the hunk.

Run every ticket Proof rails command plus typecheck, lint, lint:debt, god-code
ratchet, and git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, dependency receipts for SEP5-01 and SEP5-03,
files changed, raw-leak RED, duplicate-post RED, mutation receipts, GREEN exits,
and remaining unverified areas. Do not push/merge or alter unrelated dirty
files.
```

## SEP5-03 — secret detection parity

```text
Implement SEP5-03 end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, then read:
- docs/plans/sep-5-secret-detection/tickets/SEP5-03-secret-detector-parity.md
- docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md

Freeze HEAD/origin/main/status/write set. Re-run the URL-userinfo and named-kind
baseline probes. If current behavior differs from the ticket, update the factual
scope before coding; do not add redundant signatures.

Implement named scanner coverage and one shared fabricated test corpus without
forcing production redactors/scanners into an incompatible regex table. Require
>=17 secret rows, >=8 benign rows, exact named kinds, and composite detection
with entropy disabled. Preserve allowlist semantics and plaintext-only proxy
reachability claims.

Capture baseline RED. Prove red-on-mutation by removing a runtime signature
while leaving imports/types intact; the exact corpus row must fail. Implement
the remove-one-signature validator and its population floors. Reject a result
that passes only through generic entropy.

Run every ticket Proof rails command plus typecheck, lint, lint:debt, god-code
ratchet, and git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, files changed, corpus counts, baseline RED,
mutation receipt, named-kind GREEN results, negative-control results, and the
remaining HTTPS limitation. Do not use real credentials, push/merge, or change
unrelated dirty files.
```

## SEP5-04A — private atomic token writer

```text
Implement SEP5-04A end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, then read:
- docs/plans/sep-5-oauth-transaction/tickets/SEP5-04A-private-atomic-token-write.md
- docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md

Freeze HEAD/origin/main/status/write set. Respect the auth/storage slice fence:
do not import @/storage from @/auth and do not add a boundary exception.

Implement the auth-owned opaque-byte writer with same-directory unique wx temp,
0600 mode, full write, file fsync, close, rename, best-effort parent fsync, and
ownership-safe cleanup. Keep ChatGPT/MCP schema adapters byte-compatible.

Before the fix, capture the fixed-temp/concurrency RED. Implement the real-FS
32-writer barrier, reader completeness loop, four injected failure phases,
ordered operation trace, mode assertion, and diagnostic secret scan. Prove the
fixed-temp, rename-after-sync-failure, and non-exclusive-open mutations go RED,
then restore each hunk. Public token-store/MCP tests must exercise the writer.

Run every ticket Proof rails command plus typecheck, lint, lint:debt, god-code
ratchet, and git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, files changed, writer/temp counts, RED and
mutation receipts, durability/mode GREEN receipts, slice-boundary result, and
unverified platform behavior. Do not push/merge or expose token fixture bytes.
```

## SEP5-04B — cross-process ChatGPT refresh

```text
Implement SEP5-04B end to end in /Users/songmin/quanta-codeagent-v3 only after
SEP5-04A is integrated into your exact base.

Read AGENTS.md, then read:
- docs/plans/sep-5-oauth-transaction/tickets/SEP5-04B-chatgpt-refresh-transaction.md
- docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md

Freeze HEAD/origin/main/status and prove the SEP5-04A private atomic writer is
live. Preserve process-local single-flight, error classification, and current
in-memory fallback. Do not alter MCP's intentional fresh-auth outer mutex.

Implement acquire -> post-lock reread -> conditional issuer refresh -> atomic
persist -> owned release with bounded wait/abort. Use hashed non-secret lock
keys and a concrete exclusive private lock-file store.

Required tests:
- two independent in-process transaction objects sharing only lock/store;
- two Bun child processes sharing one token path/lock dir;
- one parent-owned counting localhost issuer;
- issuer count exactly 1, same winner token, valid final JSON, no live lock;
- acquire/abort/issuer/persist/corrupt-stale/release fault rows.

Capture the two-refresh baseline RED. Prove mutations for removed post-lock
reread, would-wait-as-success, and foreign release, then restore. A Promise.all
against one coordinator does not count as cross-process proof.

Run every ticket Proof rails command plus typecheck, lint, lint:debt, god-code
ratchet, and git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base and SEP5-04A dependency receipt, changed files,
issuer counts, mutation receipts, lock cleanup results, GREEN exits, and any
unverified crash/durability edge. Do not push/merge or log token bytes.
```

## SEP5-05 — Claude config decoder

```text
Implement SEP5-05 end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, then read the SEP5-05 ticket and SEP5-12 test campaign. Freeze
HEAD/origin/main/status/write set before editing.

Extract one pure migration-owned MCP/hooks decoder. Keep both entrypoints' file
I/O, size cap, warning, absent/malformed, and non-ENOENT policies separate. Do
not expose credential-bearing MCP env and do not create a second public domain
model.

Implement >=6 successful fixture families through both real entrypoints, the
separate five-case error-policy table, unknown/property inputs, and population
floors. Capture baseline divergence. Prove mutations for restoring one local
classification branch and reversing explicit/inferred precedence, then restore.

Run all ticket Proof rails plus typecheck, lint, lint:debt, god-code ratchet, and
git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, changed files, fixture/error-policy counts,
baseline and mutation receipts, GREEN exits, and preserved contract differences.
Do not push/merge or alter unrelated work.
```

## SEP5-06 — MCP naming authority

```text
Implement SEP5-06 end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, the SEP5-06 ticket, and SEP5-12. Freeze HEAD/origin/main/status
and claimed files. Put naming semantics in @/mcp; add no host/app owner or slice
exception.

Freeze current external naming behavior before extraction: empty segments,
case, leading/trailing punctuation, repeated runs, Unicode, and collision
handling. Make health, CLI, and bridged-tool projections call one MCP owner.
Do not silently rename external tools or resolve collisions by suffix/overwrite.

Implement >=12 naming rows, exactly 3 consumer projections, and >=3 collision
groups through real production seams. Prove mutations for one consumer's old
regex and bypassed tool-segment normalization, then restore. Imports/bare names
are not wiring proof.

Run all ticket Proof rails plus typecheck, lint, lint:debt, god-code ratchet, and
git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, changed files, frozen compatibility decisions,
case/consumer/collision counts, mutation receipts, GREEN exits, and any external
rename risk. Do not push/merge or alter unrelated work.
```

## SEP5-07 — permission decoder authority

```text
Implement SEP5-07 end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, the SEP5-07 ticket, and SEP5-12. Freeze HEAD/origin/main/status
and claimed files. Keep the pure primitive decoder inside @/permission and
preserve each persistence consumer's public error/result contract.

Freeze exact closed-union members, required fields, array behavior, unknown-key
policy, and fail-closed defaults before extraction. Generate a positive row for
every enum member and >=8 invalid families through decoder, store, and posture
entrypoints. Expected literals must not be derived from the switch under test.

Capture baseline drift if present. Prove mutations for removing a valid literal,
accepting arbitrary strings, and permissively defaulting a missing field. Each
must fail the named row before restoration. Assert full union cardinalities and
exactly two persistence consumers.

Run all ticket Proof rails plus typecheck, lint, lint:debt, god-code ratchet, and
git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, changed files, frozen schema policy, population
counts, RED/mutation receipts, fail-closed GREEN exits, and remaining migration
risk. Do not push/merge or alter unrelated work.
```

## SEP5-08 — JSON-RPC envelope core

```text
Implement SEP5-08 end to end in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, the SEP5-08 ticket, and SEP5-12. Freeze HEAD/origin/main/status
and claimed files. Put only protocol-neutral envelope shape/guard in @/shared.
Keep MCP/LSP framing, byte caps, recovery, lifecycle, and correlators separate.

First freeze current compatibility in both adapters. Implement >=4 positive and
>=8 negative envelope rows through the shared guard and both real decoder
surfaces. Keep the existing MCP newline and LSP Content-Length suites as
independent framing proof.

Capture baseline shape divergence. Prove type-correct mutations for accepting
wrong versions, accepting result+error, and bypassing the shared guard in one
adapter. The specific malformed row must fail, then restore the hunk. An import
assertion is not production wiring proof.

Run all ticket Proof rails plus typecheck, lint, lint:debt, god-code ratchet, and
git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, changed files, compatibility table, case and
adapter counts, mutation receipts, framing GREEN exits, and unresolved protocol
differences. Do not push/merge or alter unrelated work.
```

## SEP5-09 — retrieval authority retirement

```text
Implement SEP5-09 Phase 0 and the evidence-authorized retirement in
/Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, the SEP5-09 ticket, and SEP5-12. Freeze HEAD/origin/main/status,
package exports, repository consumers, and claimed files. Do not assume the
ticket's candidate deletion list is authorized until the manifest classifies
every symbol.

Build a TypeScript-compiler-AST inventory that counts live call expressions,
not imports/comments/types/bare identifiers. Require >=2 canonical production
factory calls, >0 scanned files, zero live legacy assembler calls, and explicit
classification of every public legacy export. Delete dead paths; add a narrow
runner adapter only for a proven compatibility consumer. Preserve pure ranking
algorithms and Result/throw semantics at their boundary.

Prove mutations for an injected type-correct legacy call, a bare reference that
must not satisfy the call floor, and an empty scan population. Also prove live
search-index and pipeline behavior through their canonical runtime seams.

Run all ticket Proof rails plus typecheck, lint, lint:debt, god-code ratchet, and
git diff --check. State whether full test:ci ran. Empty globs are failures.

Return DONE/NOT DONE, exact base, consumer/export manifest, deletion vs adapter
decision per symbol, changed files, mutation receipts, runtime GREEN exits, and
any unknown external compatibility. Stop rather than delete if public contract
status remains unknown. Do not push/merge or alter unrelated work.
```

## SEP5-10 — knob authority burn-down

```text
Implement SEP5-10 in reviewed batches in /Users/songmin/quanta-codeagent-v3.

Read AGENTS.md, the SEP5-10 ticket, and SEP5-12. Freeze HEAD/origin/main/status
and recompute every inventory/runtime/raw-env count before editing. Historical
353/192/45/49 values are snapshot evidence, not permanent constants.

Add the closed read-authority taxonomy and manually validate each current read
site. Do not bulk-guess owners. Preserve startup-seed and call-time semantics;
route session-registry cleanup through injected typed paths; resolve CLI and
runner overlaps only with help/seed/read or discovery/mutation behavioral proof.

Implement runtime-reflected closed-universe validation. Inject missing authority,
duplicate key, and orphan runtime knob into cloned inventories and require exact
rejection. Add the conflicting-process.env session-path mutation. Keep all seven
CLI and four runner/runtime rows until individually retired with proof.

After actual raw-read removals, recompute and lower the raw-env ceiling to the
new actual count. Never raise it. Inject one prohibited raw read and prove the
new ceiling fails.

Run all ticket Proof rails plus typecheck, lint, lint:debt, god-code ratchet, and
git diff --check. State whether full test:ci ran.

Return DONE/NOT DONE, exact base, before/after counts, per-key authority decisions,
changed files, mutation receipts, GREEN exits, and deferred ambiguous keys. Do
not push/merge, add credentials to inventory, or alter unrelated work.
```

## SEP5-12 — final integrator and closure

```text
Act as the final integrator for the Sep-05 remediation in
/Users/songmin/quanta-codeagent-v3. Do not assume worker claims are current.

Read AGENTS.md, the execution index, every landed SEP5 ticket, and:
- docs/plans/sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md

Freeze exact HEAD, origin/main, branch, status, and all remaining dirty paths.
Inventory the actual landed commits and map each to SEP5-01 through SEP5-10.
For every landed implementation require all five receipts: baseline RED,
type-correct mutation, anti-vacuum floor, production GREEN, CI enrollment.

Do not repair missing product behavior by weakening a test, raising a ceiling,
adding an allowlist, or excluding a file. If a receipt is missing, reproduce it
or mark that ticket NOT DONE. Verify old authorities have zero live callers
where deletion was required and intended consumer paths reach the canonical
owner.

Run focused tests for every landed ticket, then:
- bun run typecheck
- bun run lint
- bun run lint:debt
- bun test tests/unit/god-code-ratchet.test.ts
- git diff --check
- bun run test:ci

Require a terminal exit/footer receipt for full CI. A timeout, killed parent,
partial shard set, or focused green is not closure. If a dedicated SEP5 CI
enrollment test is unnecessary, prove the resolved test selector includes every
new test file; otherwise implement the non-vacuous enrollment test specified in
SEP5-12.

Update ticket status/evidence only from current exact-HEAD proof. Preserve
unrelated dirty work. Do not push or merge unless explicitly instructed.

Return:
- overall DONE or NOT DONE;
- exact HEAD/base/status;
- per-ticket status and commit/file mapping;
- five-receipt matrix;
- focused/global/full-CI command exits;
- remaining blockers, owners, and exact next command.
```
