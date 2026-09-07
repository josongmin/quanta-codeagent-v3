# Sep-07 SOLID/SE and duplicate-development audit — dispatch pack

## Verdict before dispatch

SEP5 and SEP6 close the findings known to those campaigns. They do not prove that
the current repository contains no other duplicate authority or SOLID/SE defect.
This campaign is a new-code and bounded-full-tree audit, not a rerun of retired
finding IDs.

Do not dispatch against a changing shared checkout. The current checkout must
first be reduced to one committed snapshot, or every worker must use a detached
worktree created from the same immutable commit. Uncommitted files are outside a
detached worktree and cannot be silently included in a completion claim.

## Stage and barrier plan

| Stage | Concurrency | Work | Barrier |
|---|---:|---|---|
| W0 | 1 | Freeze exact truth and generate path manifest | Clean immutable snapshot accepted |
| W1-alpha | 3 | A, B, C | Three receipts complete and snapshot-stable |
| W1-beta | 3 | D, E, F | Three receipts complete and snapshot-stable |
| W1-gamma | 2 | G, H | Two receipts complete and snapshot-stable |
| W2-X | 1 | Cross-shard duplicate/authority merge | All A-H manifests present |
| W2-M/P | 2 | Mutation/test-honesty and performance/complexity | X complete |
| W3-I | 1 | Final disposition, ticket plan, coverage proof | All prior receipts present |

With a four-agent pool, run at most three workers beside the coordinator. Never
run W2-X before all W1 receipts exist. W3-I is always serial.

## Path ownership

Each production path is owned by exactly one W1 lane. `src/shared/**`, root-level
tests, architecture configs, generated artifacts, feature catalog files, and
campaign documents are reserved for W2/W3 and must not be changed by W1.

| Lane | Exclusive production scope | Mirrored test scope |
|---|---|---|
| A | `src/agent`, `src/activity`, `src/attention`, `src/objective` | same-name unit/integration paths; root tests whose SUT owner is in A |
| B | `src/tool`, `src/runtime`, `src/plugin-isolation`, `src/codemode` | same-name paths; root tests whose SUT owner is in B |
| C | `src/mcp`, `src/lsp`, `src/protocol`, `src/ipc`, `src/connectors`, `src/integrations`, `src/remote`, `src/realtime` | same-name paths; root tests whose SUT owner is in C |
| D | `src/session`, `src/memory`, `src/storage`, `src/kernel`, `src/stream`, `src/artifact` | same-name paths; root tests whose SUT owner is in D |
| E | `src/llm`, `src/retrieval`, `src/runner`, `src/skill`, `src/rules` | same-name paths; root tests whose SUT owner is in E |
| F | `src/auth`, `src/security`, `src/permission`, `src/config`, `src/capability`, `src/migration` | same-name paths; root tests whose SUT owner is in F |
| G | `src/apps`, `src/host`, `src/sdk`, `src/ui`, `src/workflow`, `src/scheduler`, `src/reactor`, `src/observability`, `src/radar` | same-name paths; root tests whose SUT owner is in G |
| H | `src/media`, `src/voice`, `src/browser`, `src/git`, `src/patch`, `src/subagent`, `src/side-agent` | same-name paths; root tests whose SUT owner is in H |

Cross-lane imports are evidence, not write ownership. A lane records the foreign
consumer and sends the comparison to W2-X; it does not inspect the entire foreign
slice or propose edits there as if it owned it.

## Immutable common prompt

Copy the following block unchanged to every W1 worker. Append exactly one
`AUDIT_ASSIGNMENT|...` line from the assignment table.

```text
You are a read-only worker in the Sep-07 SOLID/SE and duplicate-development audit
for /Users/songmin/quanta-codeagent-v3. Read AGENTS.md, AGENT_CORE.md,
AGENT_PLAYBOOK.md, docs/ARCHITECTURE.md, and tests/README.md first.

Require the accepted W0 receipt. Before and after inspection, verify HEAD,
authority-document hashes, tracked diff hash, and untracked manifest hash. If any
value differs, output STALE and stop. Do not edit source, tests, docs, tickets,
catalog files, git state, or GitHub state.

Inspect every production file in your exclusive scope and map its mirrored tests.
Use rg only for navigation; inspect owner code and at least one reachable consumer.
Classify by role contract, not basename or similar syntax.

For each file record: primary role, public ingress, state owned, outbound effects,
dependency direction, production consumers, test owner, line count, largest
function, and candidate role-contract fingerprint. The fingerprint is:
authority/invariant/input/output/state/effect/failure-policy/lifecycle.

Audit all of these axes:
1. SRP/cohesion: unrelated reasons to change, god-module >1000, cohort 900-999,
   function >150, cognitive complexity, deep nesting, parameter explosion.
2. OCP: central switches or tables requiring unrelated edits for each extension.
3. LSP: subtype/adapter behavior stronger or weaker than its port, error/absence
   semantics drift, mutable escape hatches.
4. ISP: consumers forced through broad ports, optional-method bags, fake-heavy
   interfaces, read/write authority mixed unnecessarily.
5. DIP and slice fences: lower policy importing concrete infrastructure, peer
   library imports, app surface becoming a reusable owner, composition leakage.
6. Duplicate authority: two writable owners for the same invariant, copied state
   transition, parser/normalizer/validator/policy, cache, retry, lifecycle, or
   projection with a reachable consumer and measured drift.
7. SE correctness: fail-open behavior, invalid representability, stale cache,
   nondeterminism, concurrency/lifecycle leaks, unbounded IO/CPU/memory, hidden
   fallback, and partial-update durability.
8. Test honesty: assertion reaches production ingress, non-zero population floor,
   negative control, red-on-injection, deterministic cleanup, and no shape-only
   or identifier-only static scan.

A duplicate finding requires two live owners plus producer-contract-consumer
evidence and either measured behavioral drift or a concrete dual-write race. A
SOLID smell without a failure mode is inventory only, not a finding. Separate
introduced, worsened, and pre-existing attribution. Do not reopen retired SEP5 or
SEP6 findings unless the documented trigger is reproduced on the W0 snapshot.

Write only your assigned receipt path. Include: snapshot, complete file manifest,
coverage counts, inspected consumer paths, findings, candidate fingerprints for
W2-X, no-finding bounded areas, uninspected conditions, and exact proposed write
sets. End with DONE, STALE, BLOCKED, or INCOMPLETE. DONE means scope classified,
not fixed.
```

## W1 assignment lines

```text
AUDIT_ASSIGNMENT|lane=A|scope=agent,activity,attention,objective|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-A.md
AUDIT_ASSIGNMENT|lane=B|scope=tool,runtime,plugin-isolation,codemode|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-B.md
AUDIT_ASSIGNMENT|lane=C|scope=mcp,lsp,protocol,ipc,connectors,integrations,remote,realtime|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-C.md
AUDIT_ASSIGNMENT|lane=D|scope=session,memory,storage,kernel,stream,artifact|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-D.md
AUDIT_ASSIGNMENT|lane=E|scope=llm,retrieval,runner,skill,rules|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-E.md
AUDIT_ASSIGNMENT|lane=F|scope=auth,security,permission,config,capability,migration|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-F.md
AUDIT_ASSIGNMENT|lane=G|scope=apps,host,sdk,ui,workflow,scheduler,reactor,observability,radar|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-G.md
AUDIT_ASSIGNMENT|lane=H|scope=media,voice,browser,git,patch,subagent,side-agent|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-H.md
```

## W0 prompt — serial freeze

```text
You are W0. Work read-only. Read AGENTS.md first. Refuse to freeze a changing or
dirty shared checkout unless the coordinator explicitly defines tracked HEAD-only
scope. Capture HEAD, origin/main, merge-base, branch, ahead/behind, git status,
staged diff SHA-256, unstaged diff SHA-256, and SHA-256 for every untracked file.
Hash AGENTS.md, AGENT_CORE.md, AGENT_PLAYBOOK.md, docs/ARCHITECTURE.md,
tests/README.md, package.json, biome.json, tsconfig files, slice-boundary configs,
god-code detector/allowlist, and lint-debt ceiling.

Generate a sorted manifest of every src/**/*.ts file and assign it exactly once
to A-H or RESERVED(shared). Prove union equals the source universe and every pair
intersection is empty. Record source/test counts and existing god-code/lint debt
baselines. Write only docs/plans/sep-7-solid-se-audit/receipts/W0.md. End DONE only
when the snapshot is immutable and the manifest proof is exact.
```

## W2-X prompt — cross-shard authority and duplicate merge

```text
You are W2-X. Start only after W1-A through W1-H are DONE on the same W0 receipt.
Work read-only except your receipt. Validate receipt manifests and reject missing,
duplicate, stale, or uninspected files. Compare role-contract fingerprints across
all lane pairs and inspect both owners plus a real producer/consumer before
classifying a duplicate.

Own src/shared/** inspection now. Reject proposals that turn shared into a policy
dumping ground: a shared owner must be pure, dependency-legal, stable, and used by
at least two real consumers. Separate algorithm reuse from policy/state/lifecycle
authority. Deduplicate findings by invariant, retain attribution and proof limits,
and produce a dependency-ordered candidate graph. Write only
docs/plans/sep-7-solid-se-audit/receipts/W2-X.md.
```

## W2-M prompt — mutation and test-quality specialist

```text
You are W2-M. Require W2-X and the same W0 snapshot. Inspect tests for each retained
finding. Prove whether the current rail reaches the production ingress and would
turn RED if one required call, branch, owner, or manifest member were removed.
Check anti-vacuum floors, exact identity, cleanup, concurrency barriers, timeouts,
and deterministic fixtures. Design the narrowest non-vacuous regression rail and
an explicit red-on-injection mutation. Do not implement it. Write only
docs/plans/sep-7-solid-se-audit/receipts/W2-M.md.
```

## W2-P prompt — performance and structural-complexity specialist

```text
You are W2-P. Require W2-X and the same W0 snapshot. Validate retained performance
and SE findings with concrete reachable paths. Inspect god-code and lint-debt
authorities, hot-loop complexity, repeated parsing/allocation/IO, unbounded queues,
cache invalidation, and algorithmic scaling. Require a fixture, input scale, metric,
baseline, and regression threshold; do not report speculative slowness. Design a
ratchet that cannot be improved by hiding work or reducing test coverage. Do not
implement it. Write only docs/plans/sep-7-solid-se-audit/receipts/W2-P.md.
```

## W3-I prompt — serial integrator and ticket plan

```text
You are W3-I, the only final integrator. Require W0, W1-A..H, W2-X, W2-M, and W2-P
on one unchanged snapshot. Verify source-manifest union/intersection proof again.
Reject grep-only, smell-only, stale, duplicate-worded, unreachable, and unmeasured
claims. Recheck every P0/P1 owner and consumer directly.

Produce the final finding index and one implementation ticket per invariant under
docs/plans/sep-7-solid-se-audit/tickets/. Each ticket must name canonical owner,
exact files/functions, forbidden write set, dependency order, pre-patch RED,
implementation steps, migration/removal steps, focused tests, mutation proof,
type/lint/architecture/full-suite rails, performance ratchet where applicable,
rollback boundary, and unverified runtime conditions. Keep implementation, merge,
activation, and runtime proof as separate states. Do not edit production code.
Write the terminal receipt to receipts/W3-I.md and mark the campaign complete only
when every source file was classified and every retained finding has one ticket.
```

## Dispatch commands

Use the same committed snapshot for every worker. Example orchestration order:

```text
1. W0
2. A + B + C
3. D + E + F
4. G + H
5. W2-X
6. W2-M + W2-P
7. W3-I
```

If any worker returns STALE or INCOMPLETE, rerun W0 and invalidate every receipt
derived from the older snapshot. Do not merge receipts across snapshots.
