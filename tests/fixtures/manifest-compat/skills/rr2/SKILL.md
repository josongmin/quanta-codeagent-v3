---
name: rr2
description: Escalation Semantica review-and-repair skill for `/rr2 [scope]`. Use when the user wants urgent P0-P1 review tied to correctness, fail-closed behavior, SSOT or authority violations, determinism, or concrete performance-critical regressions, and expects the agent to freeze pre-patch findings, repair the narrowest owning surface structurally, rerun the owning proof rail, and add regression tests or lint guards that prevent the same failure class from recurring. Do not use for style review, broad P2+ cleanup, or planning-only audits.
argument-hint: "[scope]"
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Bash
  - Edit
metadata:
  short-description: Urgent Semantica review, repair, and prevention
---
# RR2

`/rr2 scope` is a strict Semantica escalation protocol for urgent review plus repair.

Language:

- Responses in Korean
- Code, comments, and commit body in English

Goals:

- P0/P1 first
- Findings before patch narrative
- Evidence before opinion
- Structural owner fix before local band-aid
- Repaired claim before prevention closure
- Proof limits before completion claim

Trigger boundary:

- use `rr2` for urgent review plus repair
- use `rr` instead when the user wants review-only
- do not use `rr2` for style, naming, formatting, docs polish, or speculative cleanup
- do not widen into broad repo audit unless one urgent invariant forces it

---

# P0

Never violate:

1. No heuristic reasoning, heuristic fixes, or heuristic proof
2. No finding without code evidence
3. No grep-only proof
4. No performance claim without one concrete hot path
5. No review-only exit when a safe narrow repair path is available
6. No patch without freezing the pre-patch finding first
7. No completion claim without post-patch proof
8. No bugfix closeout without prevention if a suitable test or lint rail exists

Rule anchor:

- `R-SAFE-05`: no heuristics
- `R-SAFE-01~03`: no silent failure, no silent fallback, fail-closed
- `R-TEST-20/21/33/34`: semantic proof, negative rails, typed fail-closed, bugfix regression matrix
- `R-ARCH` and SSOT rules: structural ownership over compat drift

Anti-confabulation:

- do not infer runtime behavior that was not reproduced
- do not infer severity from nouns like `SSOT`, `authority`, or `performance` without a traced path
- if evidence is partial, say `unverified` or `open question`
- if a rail was not inspected, name it instead of hand-waving
- if no concrete P0/P1 remains after inspection, say that and stop

LLM miss patterns to counter:

- stopping after the first plausible bug and missing sibling sites
- over-trusting existing docs, comments, snapshots, or green tests
- checking the success path but skipping fail-open, stale, empty, or degraded paths
- fixing a leaf symptom while leaving the shared owner broken
- proving the happy case but not the negative mutation
- underestimating blast radius across builders, validators, caches, and projections
- naming `performance` without locating the repeated cost multiplier

Compression:

- keep the final answer terse
- report at most the top 3 urgent findings unless the user asks for exhaustiveness
- one invariant = one finding; merge wording duplicates
- omit empty sections
- no motivational or narrative filler
- never expand into long recap, methodology dump, or audit diary

---

# Re-anchor

Read before review or repair:

- `AGENTS.md`
- `AGENT_CORE.md`
- `AGENT_PLAYBOOK.md`
- `AGENT_REFERENCE.md`
- `AGENT_RULE_CATALOG.md`
- `.codex/CODEX-RULES.md`
- `.codex/CODEX-START-PROMPT.md`
- `.ai/guide-development.md`

Read conditionally before repair when scope requires it:

- `tests/README.md` for root-vs-owner-local test placement or admission review
- `tools/buildctl/README.md` for build, verification, queue, bundle, or closeout rails
- `tools/README.md` for operator/toolchain behavior review

If any always-required file, or any scope-required conditional file, is missing
or unreadable, fail closed.

---

# Preflight

```bash
scripts/check-persona-target-policy.sh --expect-agent
```

If the direct-shell persona check fails, recover repo-bound review and repro
commands through canonical bootstrap:

```bash
scripts/cg-agent-session --exec -- scripts/check-persona-target-policy.sh --expect-agent
```

If reviewing local work, capture:

```bash
git status --short
git diff --cached --stat
git diff --cached
git diff --stat
```

Before treating that git output as truth, resolve the scope owner:

- if the reviewed artifact lives in the current repo, current-repo git state is the review truth
- if the reviewed artifact lives in another git checkout, run the same git capture against that owning checkout
- if the reviewed artifact is outside any git repo, state `non-git scope` explicitly and do not treat unrelated repo dirty state as truth
- if surrounding repo drift is mentioned, label it as surrounding context only

Rules:

- If the index is non-empty, `git diff --cached*` is the ship-candidate truth
- Use unstaged `git diff --stat` only as surrounding drift, not commit truth
- If staged and unstaged changes diverge, report both explicitly
- If direct-shell persona policy fails, report it explicitly and carry the recovery result separately
- If direct-shell persona failed but bootstrap recovery passed, prefer subsequent repo-bound shell reads and repros through `scripts/cg-agent-session --exec -- ...`, or explicitly state why direct shell was still used
- Do not call preflight clean unless the `cg-agent-session --exec` persona check passes

If the direct-shell persona check fails but the bootstrap recovery passes:

- treat the direct-shell persona rail as failed
- treat the recovered `cg-agent-session --exec` rail as the usable persona truth
- continue only with the recovered rail or with an explicit reason for any remaining direct-shell use
- for non-git scope or non-repo-owned file edits, keep the recovered rail as the preflight truth and disclose any direct-shell file read/edit as outside the repo-bound rail
- do not label the session `preflight clean`; label it `recovered`

If both the direct-shell persona check and the bootstrap recovery check fail,
state must be:

- `blocked`
- `unverified`

---

# Startup

```text
request:
scope:
task_class:
repair_mode:
proof_rails:
prevention_target:
```

Task class:

- `X1`: local diff escalation
- `X2`: file or module escalation
- `X3`: concrete production-path escalation
- `X4`: closeout claim escalation
- `X5`: ambiguous
- `X6`: architecture, RFC, prompt, or skill escalation

Repair mode:

- `required`: default when the user asked to solve, harden, or close the issue
- `blocked`: safe edit path absent or out-of-scope owner
- `review-only`: only when the user explicitly forbids edits

Rules:

- If the scope is ambiguous, freeze and clarify instead of guessing
- Default to `required` repair mode for urgent P0/P1 requests
- Prefer one concrete path over a wide grep dump
- Review code and tests before docs, unless the user explicitly asks for docs
- For `X6`, docs or prompts may be primary, but any break claim still needs live touchpoints, real consumers, or explicit absence proof
- Freeze 1 to 3 must-hold invariants before editing; do not enumerate a giant checklist
- `Startup` and `Ledger` are internal scaffolds; do not dump them to the user unless asked

---

# Triage filter

Prioritize only urgent classes:

- `P0`: ship-blocking correctness, fail-open, authority, SSOT, safety, or deterministic-state break
- `P1`: strong regression risk, missing invariant proof, or concrete performance-critical path risk

Downgrade to open question unless proven:

- speculative performance concern without a traced hot path
- maintainability complaint without failure potential
- style, naming, or formatting feedback
- hypothetical future drift with no present invariant breach

Performance review rule:

- A performance finding requires one traced path, one concrete repeated cost, and one structural reason the code permits it
- micro-optimizations without user-visible or rail-visible impact are out of scope unless they close a P0/P1 root cause

---

# Ledger

Always keep:

```text
prev:
curr:
next:
visited:
overall_progress:
state:
```

---

# Evidence posture

Evidence order:

1. changed hunks
2. targeted tests and verification rails
3. real consumers and call sites
4. docs or plans only if explicitly requested

Diff-first rule:

If the owning checkout has local changes:

1. if the index is non-empty, review `git diff --cached` first as the ship candidate
2. review unstaged `git diff` only as surrounding drift
3. identify the owning invariant
4. trace outward only as needed
5. avoid repo-wide expansion unless authority requires it

If the reviewed scope has no owning checkout:

1. capture line-referenced pre-patch excerpts, `nl -ba` output, or an explicit saved before/after text slice as the changed-hunk substitute
2. do not use unrelated repo git drift as the changed-hunk source
3. name the non-git truth source explicitly in the closeout

Grep rule:

- grep is allowed only for navigation
- grep may seed a trace, but not close a finding
- findings require live code inspection plus execution-path or invariant evidence

Finding threshold:

A valid finding must include:

- severity
- file:line
- broken behavior, regression risk, or proof gap
- why the current code permits it
- one concrete follow-up

If any piece is missing, downgrade it to an open question.

---

# Gap-hunt pass

Before closing findings, and again after the first repair, run one adversarial
pass against the same scope.

Check these failure lenses:

1. sibling-pattern lens: same constructor, helper, validator, builder, adapter, or projection repeated elsewhere
2. fail-open lens: error, missing, unknown, partial, stale, or empty state accidentally accepted
3. negative-proof lens: a core condition removed or mutated should fail, but may still pass
4. authority-drift lens: two truths, stale cache, stale snapshot, derived field drift, or compat shim shadowing the owner
5. blast-radius lens: callers, deserializers, public boundaries, caches, and reports that still assume the old behavior
6. performance lens: repeated parse, full scan, nested loop, duplicate IO, duplicate allocation, or repeated recomputation on a hot path

Rules:

- do not stop at the first finding if one more lens can be checked cheaply
- after patching one site, run the sibling-pattern lens at minimum
- if a second lens finds another urgent issue, merge by invariant or report separately
- if no second issue appears, say nothing extra; do not pad the output

---

# Repair flow

1. Freeze scope
2. Capture pre-patch findings against the current state
3. Identify the owning invariant and root cause
4. Patch the narrowest owner surface that removes the root cause structurally
5. Update the full blast radius required by that owner change
6. Re-run only the owning proof rail needed to support the repaired claim
7. Add prevention through a regression test, lint, or both
8. Re-run the new prevention rail
9. Report pre-patch finding, applied repair, post-patch proof, and residual risk separately

Repair rules:

- default to repair, not review-only
- do not widen into unrelated cleanup
- do not preserve a weak compat shim when a stronger SSOT owner fix is available
- if the root cause is outside the writable or safe scope, stop at evidence-backed findings and mark repair `blocked`
- the final verdict cannot exceed the weakest unresolved post-patch proof state
- after the first repair, run at least the sibling-pattern lens before declaring closure

Structural fix rule:

- prefer the owning type, boundary, validator, constructor, port, or canonical builder over leaf call-site patching
- if multiple sites repeat the same bug class, patch the shared owner once when that is safe
- if only a leaf site is changed, explain why the shared owner was not the correct repair surface

---

# Prevention closure

Choose the prevention rail by failure class:

- add an owner-local regression test when the failure is behavioral, runtime, boundary, cache, or semantic-invariant driven
- add a lint or guard when the failure is static, syntactic, structural, or cheaply machine-detectable before runtime
- add both when the user-facing bug is behavioral but the underlying forbidden pattern is statically recognizable

Prevention rules:

- name the exact invariant being locked
- prefer owner-local tests first; root placement must satisfy `tests/README.md` and root admission rules
- do not add shape-only or token-presence tests
- do not add a lint with known owner-local false positives unless you bound it first
- if no suitable prevention rail exists, state why it is not suitable instead of silently skipping prevention
- if the bug class is repeated across sibling sites, prefer a lint or shared-owner test over one more leaf-only test

Examples of suitable prevention:

- `R-TEST-34` regression matrix for a reproduced bug
- typed fail-closed rail for boundary errors
- a targeted lint or gate script for repeated panic, fallback, or forbidden constructor patterns

---

# Runtime reproduction

Reproduce execution when:

- the user asks for it
- the claim depends on runtime-only behavior
- code inspection cannot close the invariant
- a prevention test requires the original trigger to be demonstrated

If execution was not reproduced, state that explicitly.

For `X6`, `execution_reproduced: not-applicable` is allowed only when live
touchpoints, real consumers, or explicit absence proof are named.

Canonical verification rail:

- if Rust build, test, or runtime behavior is reproduced in this repo, classify the rail using `AGENT_CORE.md` and `AGENT_PLAYBOOK.md`
- allowed rail labels: `local direct`, `check`, `local exact exec`, `heavy single-step`, `bundle/preset`
- use repo front doors accordingly: raw `cargo` or `scripts/cg-cargo` for `local direct`; `scripts/cg-dispatch` for `check`, `local exact exec`, `heavy single-step`, `bundle/preset`
- if `heavy single-step` or `bundle/preset` is used, capture and report a tracking key: `bundle_id`, `request_fingerprint`, or `frontier_family_id`
- for prompt, doc, skill, or non-code scopes, a text-only verification rail is valid: line-referenced before/after excerpts, owning-scope diff, or explicit saved text slices
- do not claim compile, test, or runtime proof for prompt, doc, or skill repair unless such a rail was actually run

Temporary instrumentation:

Temporary instrumentation is allowed only if all are true:

- explicitly declared
- non-persistent
- removed before closeout
- used only to prove one concrete invariant

---

# Forbidden

- compliment sandwich
- speculative severity inflation
- style-only review while P0/P1 risk exists
- grep-hit count presented as proof
- "add tests later" or "lint later" closeout
- silent prevention skip when a suitable rail exists
- collapsing `not yet proven` into `definitely broken`
- collapsing `fixed locally` into `fixed structurally`

---

# No-findings gate

`no concrete findings` is allowed only when one concrete proof shape holds:

- `X1`/`X2`/`X3`/`X4`: at least one concrete execution path, changed-hunk-to-consumer path, or closeout rail was traced
- `X6`: at least one concrete claimed invariant was traced to live code touchpoints, real consumers, or explicit absence proof

and all are true:

- urgent P0/P1 classes were actually checked
- targeted rails were inspected
- proof limits are explicitly bounded

If those are not true, use:

- `review depth insufficient`
- `unverified`

---

# Output contract

Return only this shape:

```text
문제점 및 해결한거:
- [P0|P1] path:line — problem
  status: resolved | unresolved
  fix:
  evidence: scope_owner=...; truth_source=...; proof=...
```

Status rules:

- use `resolved` only when the reviewed issue was actually closed in this turn and the evidence reflects the post-fix state
- use `unresolved` when the issue remains open, is blocked, is `unverified`, is `review depth insufficient`, or proof is still partial
- do not emit a separate `resolved` section

Rules:

- Use exactly one top-level section: `문제점 및 해결한거`
- Put the evidence on the same bullet item as the problem and fix
- If no concrete P0/P1 remains after sufficient proof, return `문제점 및 해결한거:` then `- none`, `status: resolved`, `fix: none`, and one `evidence:` line
- If no concrete P0/P1 is being reported because proof is insufficient, return `- none`, `status: unresolved`, `fix: none`, and put `review depth insufficient` or `unverified` in `evidence:`
- Keep `scope_owner` and `truth_source` inside the single `evidence:` line rather than as separate lines
- Include `status:` inside each finding
- Use flat bullets only; no nested bullet trees
- Keep pre-patch risk visible even after repair
- Merge duplicates by invariant
- Keep the whole answer concise; do not add any heading, recap, footer, or follow-up section
- For `X6`, if execution was not reproduced, put the live touchpoint or absence proof inside `evidence`

---

# Self-break

Before closing, ask:

- Did I prove the finding from live code?
- Did I freeze the pre-patch state before editing?
- Did I repair the owner rather than patch around the symptom?
- Did I rerun the narrow proof rail that matches the claim?
- Did I close recurrence with a suitable test or lint rail, or explicitly justify why not?
- Did I preserve proof limits instead of overstating completion?

---

# Completion gate

Close only when all are true:

1. Scope is explicit
2. Findings or no-findings verdict is evidence-backed
3. Pre-patch findings are preserved
4. Post-patch proof is stated
5. Prevention closure is stated
6. Review depth and proof limits are disclosed

Allowed end states:

- `repaired and closed`
- `repaired with residual risk`
- `findings reported`
- `review depth insufficient`
- `blocked`
- `unverified`
