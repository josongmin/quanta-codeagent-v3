# Sep-06 role-contract architecture audit — dispatch pack

> **RETIRED FOR DISPATCH (2026-09-07):** final code reconciliation and the four
> retained repairs are complete. [`../tickets/README.md`](../tickets/README.md)
> has 0 active rows. Do not rerun the 30-row prompt pack or recreate removed
> findings without a new current-code reproduction.

## Goal

Audit duplicate development and architecture drift by **role contract**, not by
top-level slice. The campaign is read-only. It produces evidence-backed finding
cards and an implementation dependency graph; it does not change production code,
tests, catalog YAML, generated docs, tickets, GitHub state, or git history.

The repository has 49 library slices plus `apps`. Peer-library value imports are
normally fenced, so a valid consolidation must identify a dependency-legal owner,
a neutral leaf that both consumers may import, or a composition-root port. A
matching basename, similar control flow, or common executable is not a finding.

## Authority and precedence

W0 freezes the live checkout. Later lanes must use its receipt rather than the
historical SHA written in an audit document.

1. live `HEAD`, `origin/main`, merge-base, and worktree status;
2. `tests/unit/_arch/slice-boundary-configs.ts` for actual slice policy;
3. `docs/ARCHITECTURE.md` for architectural intent;
4. `docs/bugbash/sep-05-duplicate-development.md` for D0-D30 history;
5. `docs/plans/sep-5-duplicate-audit/tickets/SEP5-11-deferred-and-closed-register.md`
   for reopen rules;
6. `docs/bugbash/sep-06-solid-se-audit.md` for the active 30-row index;
7. `docs/bugbash/aug-25-wave1.md` for older architecture evidence.

If prose conflicts with live code, report the conflict. Do not silently choose
the prose or rewrite it during this campaign.

## Dispatch order

The current agent pool permits three workers in addition to the parent. Use
barriers; do not dispatch all eight W1 lanes at once.

| Stage | Dispatch | Barrier |
|---|---|---|
| W0 | W0 alone | parent accepts one truth receipt |
| W1-alpha | A, B, C | all three complete |
| W1-beta | D, E, F | all three complete |
| W1-gamma | G, H | both complete |
| W1b | I1, then I2, then I3 | serial; starts after all A-H |
| W2 | J, K, L | all three complete |
| W3 | parent merge | all prior receipts present |

Before dispatching workers in fresh worktrees, commit this prompt pack or provide
the complete prompt text directly. A worktree created from an older commit will
not see an uncommitted prompt file.

## Historical active-index ownership — retired

Every active Sep-06 row has exactly one finding owner. N9 is split into two
file-disjoint sub-items and is recombined by W3.

| Lane | Active IDs |
|---|---|
| A | S4 |
| B | S1 |
| C | N1, N5, N6, N11, N12, S15 |
| D | S3, S13 |
| E | N13, S11, S12 |
| F | N7 |
| G | N8, N10, S5, S9 |
| H | N3, N4, N15, S10 |
| I1 | S2 |
| I2 | S8 |
| I3 | S14 |
| J | N9a: bootstrap/resume/codemode, S7 excluding `src/shared/runtime-config.ts` |
| K | N9b: `parseToolSurfaceSlice`, S6, N14 |
| L | N16 |

Closed and conditional D-items listed in a lane were status/reopen context, not
additional findings. Every assignment below is retained as audit history only.

## Finding contract

One invariant equals one finding card. Each card must contain:

1. active ID and `confirmed | widened | reopened | closed | not-a-finding`;
2. one-sentence invariant;
3. canonical owner and every live competing owner;
4. reachable production entrypoint and consumer path;
5. expected versus actual behavior, with a concrete fixture when drift exists;
6. exact `path:line` evidence from the frozen HEAD;
7. legal dependency direction under the live slice config;
8. existing hellgate and what it actually proves;
9. missing RED, negative control, mutation, anti-vacuum floor, and production GREEN;
10. SEP5-11 state and exact reopen trigger, if applicable;
11. proposed implementation write set, without editing it;
12. unverified conditions and commands not completed.

For duplicate-contract findings, two live owners and measured behavioral drift are
required. For dead-authority, lifecycle, or fence findings, use the relevant
owner/consumer invariant instead of fabricating a second owner.

Grep and source scans are navigation. A static guard is acceptable evidence only
when it matches a live call or structural pattern, has a non-zero population
floor, and has a type-correct red-on-injection control. A bare identifier, import,
comment, basename count, or zero-caller count cannot be the sole proof.

`DONE` means the lane's audit scope is completely classified. It does not mean a
product defect was fixed.

---

## W0 — truth freeze

```text
You are W0, the serial truth-freeze worker for the Sep-06 role-contract audit.
Work read-only in /Users/songmin/quanta-codeagent-v3. Read AGENTS.md first.

Read completely:
- docs/ARCHITECTURE.md
- tests/unit/_arch/slice-boundary-configs.ts
- docs/bugbash/sep-05-duplicate-development.md
- docs/bugbash/sep-06-solid-se-audit.md
- docs/bugbash/aug-25-wave1.md
- docs/plans/sep-5-duplicate-audit/tickets/SEP5-11-deferred-and-closed-register.md

Do not edit files, create tickets, publish GitHub activity, or implement fixes.

Freeze and return:
1. HEAD, origin/main, merge-base, branch, ahead/behind, and git status --short.
2. SHA-256 for every authority document above.
3. top-level src directory count, library-slice count excluding apps, slice-config
   count, and parity entrypoint count. Explain any mismatch; do not infer parity
   from directory counts alone.
4. the complete Sep-06 active index. The expected historical count is 30; if live
   parsing differs, mark STALE and enumerate the difference.
5. a coverage manifest assigning every active row exactly once to:
   A/B/C/D/E/F/G/H/I1/I2/I3/J/K/L. Split N9 into N9a and N9b exactly as specified
   in the dispatch pack.
6. a status reconciliation for D1->S1, D4->S4, D7->S13, D8->S8,
   D19->N1/S15, D27->S6, D28->N14, and D29->N11. State whether the old decision
   remains closed while a new invariant is active, or whether an explicit reopen
   trigger is satisfied.
7. closed/intentional do-not-implement register and conditional reopen register.

Output only a W0 TRUTH RECEIPT with DONE/NOT DONE/STALE, exact values, the coverage
table, conflicts, and unverified conditions. This receipt is the sole snapshot
input for later lanes.
```

## A — spawn policy and GitHub outbound authority

```text
You are lane A of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the parent's W0 TRUTH RECEIPT. If your checkout HEAD or
authority-document hashes differ, return STALE without continuing.

Historical assignment: S4.
Status context: D3 and D4 are closed; D13 and D25 are conditional; D12 and D24
remain different-contract closures.

Evidence universe:
- src/tool/gh/**
- src/apps/cli/from-pr-cmd-adapters.ts and the ci-bot GH path
- PR-output sink and GitHub integration adapters
- git runners used by storage, rewind, consolidation, and worktree flows
- plugin-isolation child process, MCP stdio transport, LSP process transport,
  and remote runner spawn/settlement paths
- focused tests for the exact paths above

Audit role contracts, not executable names:
1. Trace every production gh PR-comment entrypoint through body policy, redaction,
   byte cap, marker/idempotency policy, argv construction, env scrubbing, timeout,
   abort, process-tree kill, and POST reconciliation.
2. Decide whether S4 is a live policy bypass or an intentional HITL contract.
3. Reopen D13 only for a reproduced env leak, shell injection, orphan child, or
   missing timeout. Reopen D25 only for pump-death divergence under the same
   process fixture.
4. Regression-check D3/D4, but do not re-propose a generic spawn factory or one
   mega GitHub sink without a trigger.

Return LANE A DONE/NOT DONE/STALE and finding cards using the dispatch-pack finding
contract. Include exact owner/consumer paths, measured behavior, legal owner,
existing rails, proposed write set, and unverified conditions. Make no changes.
```

## B — secret detection and token persistence

```text
You are lane B of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on any snapshot drift.

Historical assignment: S1.
Status context: D1 is closed as parity-not-merge. D2, D10, D11, and D30 are closed
regression references, not implementation scope.

Evidence universe:
- src/security/redaction.ts
- src/shared/trajectory.ts
- src/security/secret-detection/** and PII scanner composition where relevant
- auth token stores, private atomic writer, ChatGPT refresh transaction, and MCP
  token persistence only to verify secret/persistence boundaries
- secret parity, redaction, trajectory, and token persistence hellgates

Tasks:
1. Build the live secret-signature matrix across redaction, trajectory, and scanner
   planes, including normalization, capture group, kind, false-positive, and URL
   userinfo behavior.
2. Use concrete corpus fixtures to measure drift; do not equate table text.
3. Inspect whether a dependency-legal neutral catalog can serve all planes. If the
   fence forbids a single owner, preserve fence-local tables and require parity.
4. Verify what existing hellgates actually execute. A corpus containing a name is
   insufficient if the runtime scanner/redactor is not called.
5. Do not reopen token writer or OAuth mutex work absent a new reachable failure.

Return LANE B DONE/NOT DONE/STALE and one card per invariant. Explicitly state
whether S1 is a merge finding, a parity-rail finding, or closed. Make no changes.
```

## C — protocol envelope, framing, transport lifecycle, and atomic durability

```text
You are lane C of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on snapshot drift.

Historical assignment: N1, N5, N6, N11, N12, S15.
Status context: D19 is closed for shared envelope plus local framing; D23 is
conditional; D29 preserved separate ports but N11 may be a new durability drift.

Evidence universe:
- src/shared/jsonrpc-envelope.ts and src/shared/jsonrpc/**
- src/mcp/jsonrpc.ts, src/mcp/isolated-client.ts, src/mcp/transports/http-sse.ts
- src/lsp/adapters/jsonrpc.ts and src/lsp/adapters/file-write-atomic.ts
- src/tool/debug/dap-codec.ts and CDP correlator implementations
- src/storage/atomic-write.ts
- directly relevant unit/integration tests

Tasks:
1. Separate envelope semantics, codec validation, message framing, request/reply
   correlation, connection lifecycle, and file durability into distinct contracts.
2. Trace N5 protocol negotiation/downgrade through a production isolated-client
   entrypoint. Trace N6 non-2xx SSE GET handling through the exit/reconnect consumer.
3. Compare MCP/LSP local JSON-RPC types field-by-field against both shared envelope
   models and identify real producer/consumer incompatibility.
4. Reproduce Content-Length limits and malformed/oversized frame behavior for LSP
   and DAP before proposing a shared framing core.
5. For N11 compare temp creation, file fsync, rename, directory fsync, cleanup, and
   crash-window behavior. Separate port ownership may remain; a false "identical"
   claim is not a reason to force port unification.
6. Reopen D23 only for a concrete lost reply or waiter leak under the same state
   transition fixture.

Return LANE C DONE/NOT DONE/STALE with separate finding cards. Never merge framing
merely because both use JSON-RPC or Content-Length. Make no changes.
```

## D — retrieval and external-inference adapters

```text
You are lane D of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on snapshot drift.

Historical assignment: S3 and S13.
Status context: D15 is conditional public-compat retirement; D7 is conditional and
allows only a neutral injected transport after proving both STT contracts live.

Evidence universe:
- src/retrieval/embedders/**, src/retrieval/engines/embedder/**, rerank/reranker,
  retrieval factories/barrels, and live runner assembly
- src/agent/memory-embedder.ts and its production composition
- src/media/stt/** and src/voice/transcriber/**
- corresponding contract, dimension, normalization, error, and factory tests

Tasks:
1. Inventory production callers, public exports, dimensions, normalization,
   batching, retry, timeout, error shapes, model defaults, and headless fallbacks for
   every embedding stack.
2. Distinguish a public compatibility facade from a second live authority. Do not
   delete or merge a public stack without a consumer/deprecation manifest.
3. Reproduce measured dim or normalization drift through reachable consumers.
4. For STT, prove both ports are live and compare multipart construction, endpoint,
   model, auth, timeout, and error semantics. Preserve SpeechToTextPort and
   TranscriberPort unless their domain contracts are actually identical.
5. A shared HTTP core is valid only if it reduces two live owners and both slices
   can depend on it legally without a peer-import exception.

Return LANE D DONE/NOT DONE/STALE with separate S3/S13 cards and explicit
delete/deprecate/share/keep decisions. Make no changes.
```

## E — composition, boot, tool registry, and slice isolation

```text
You are lane E of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on snapshot drift.

Historical assignment: N13, S11, S12.
Status context: D16, D17, and D21 are conditional. R8-style assemble versus
per-turn-fold contracts must not be force-merged.

Evidence universe:
- src/apps/** composition paths relevant to agent, CLI, web, bench, and probe
- src/host/runtime/** and bootstrap assembly
- src/runner/assemble/**
- src/tool/index.ts and tool registry builders/consumers
- src/side-agent/worker-charter-runner.ts and its slice-boundary exceptions
- composition, surface-coupling, tool-registry, and memory-auto hellgates

Tasks:
1. Trace N13 memoryAuto from typed configuration to CLI and web production boot;
   identify the canonical collaborator-minting owner and actual missing edge.
2. Enumerate production imports of eager defaultTools and distinguish compatibility
   exports from module-load authority. A declaration alone is not reachability.
3. Inspect the side-agent whole-slice allow for @/llm and @/tool. Prove which exact
   files require each value import and whether allowImportFiles can narrow it.
4. Reopen D16 only for a concrete missing/duplicated tool against an agreed
   capability manifest. Reopen D17 only for measured mode-independent field drift.
5. Reopen D21 only with a written common session-bootstrap I/O contract and a
   behavioral parity RED. Keep TTY and WebSocket adapters separate.

Return LANE E DONE/NOT DONE/STALE with one card per invariant, legal composition
owner, exact production path, and proposed write set. Make no changes.
```

## F — event exhaustiveness and retry policy

```text
You are lane F of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on snapshot drift.

Historical assignment: N7.
Status context: D26 is conditional; no central AgentEvent mega-table is authorized.

Evidence universe:
- AgentEvent and related closed unions at their type owner
- stream assembly, stdout, JSONL recorder, app renderers, agent state, and item stream
- src/llm/retry/decorator-policy.ts and its callers
- exhaustiveness and retry-policy tests

Tasks:
1. Freeze the live union members and classify every consumer as exhaustive switch,
   intentional filter, pass-through, or silent drop.
2. Reopen D26 only when a new event is silently dropped by a consumer that should
   handle it. Prefer per-consumer assertNever or explicit allowed-filter policy.
3. Trace N7 HITL kinds into retry classification. Reproduce whether they incorrectly
   become consult_markers and cause a retry, including expected/actual attempt count
   and externally visible effect.
4. Distinguish compile-time exhaustiveness from runtime decoded unknown values.

Return LANE F DONE/NOT DONE/STALE with N7 and any D26 reopen card separately.
Include the exact missed consumer and a non-vacuous rail plan. Make no changes.
```

## G — permission runtime and command classification

```text
You are lane G of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on snapshot drift.

Historical assignment: N8, N10, S5, S9.

Evidence universe:
- src/permission/**
- src/agent/admissibility-gate/** only for permission-store injection
- src/tool/container-exec/**
- bash/shell command parsing and source classification used by these paths
- relevant permission, lock, container-exec, and classifier hellgates

Tasks:
1. Trace the PermissionStore instance from each composition root to the
   admissibility gate. Prove whether fallback getDefaultPermissionStore can select a
   different authority in production, tests, bench, or resume.
2. Reproduce lock-timeout behavior with competing writers and distinguish in-memory
   authorization correctness from durable-state loss or last-write-wins drift.
3. Trace container_exec through Layer-1 source classification and prove the exact
   path that skips classifySource, if reachable.
4. Exercise bash -c/env/printenv wrapper shapes through the real parser/classifier;
   do not report string matches that cannot reach execution.
5. Propose required injection or fail-closed ownership at the narrowest owner. Do
   not create a new global singleton or peer-library value edge.

Return LANE G DONE/NOT DONE/STALE with separate cards for N8/N10/S5/S9, concrete
fixtures, blast radius, existing rails, and proposed write sets. Make no changes.
```

## H — loop abort, resume, compaction, and turn determinism

```text
You are lane H of the Sep-06 role-contract architecture audit. Work read-only.
Read AGENTS.md and require the W0 TRUTH RECEIPT; return STALE on snapshot drift.

Historical assignment: N3, N4, N15, S10.
Evidence universe is strictly src/agent/loop/** plus tests that directly execute
those files. Do not inspect agent/types or top-level *-wire files; those belong to
W1b.

Tasks:
1. Trace mid-stream abort and interrupted outcomes through capture, persistence,
   parked state, and /resume reconstruction. Produce an event sequence showing the
   missing or preserved partial assistant content.
2. Compare /summarize-now and proactive compaction accounting. Prove whether the
   missing recordSendCount changes a reachable threshold or only telemetry.
3. Trace Date.now turn provenance into replay/cassette/persisted output and identify
   the existing or missing injected clock owner.
4. Keep abort, persistence, compaction accounting, and clock authority as separate
   invariants even if they meet in the same loop.

Return LANE H DONE/NOT DONE/STALE with event timelines, exact path:line evidence,
existing hellgates, and minimal owner-local RED plans. Make no changes.
```

## I1 — AgentConfig authority surface

```text
You are W1b lane I1. Start only after A-H are all complete. Work read-only.
Read AGENTS.md and require the W0 receipt plus A-H receipts; return STALE on snapshot
drift.

Historical assignment: S2.
Evidence universe: src/agent/types.ts, src/agent/types/**, wire-slot type files, and
direct producers/consumers needed to classify AgentConfig fields. Do not audit
top-level *-wire implementation bodies or mention first-line helpers.

Inventory AgentConfig fields by responsibility, mutation frequency, required versus
optional status, producer count, consumer count, and authority owner. Identify
clusters that are structurally independent ports versus fields that must remain an
atomic config snapshot. Measure the live slot count; do not inherit the historical
206-224 estimate. A large interface is not itself a finding: show concrete illegal
coupling, incompatible lifecycle, dual authority, or change amplification.

Return LANE I1 DONE/NOT DONE/STALE with one S2 card per demonstrated invariant,
candidate boundary, migration direction, compatibility risk, and non-vacuous proof
plan. Do not propose a generic options bag. Make no changes.
```

## I2 — mention first-line normalization

```text
You are W1b lane I2. Start after I1 completes. Work read-only.
Read AGENTS.md and require the frozen W0 receipt; return STALE on snapshot drift.

Historical assignment: S8. D8 is now closed by the shared first-line owner and
is no longer a dispatchable assignment.

Evidence universe:
- src/agent/mention-runner/skill-resolver.ts
- src/agent/plugin-app-resolver/** relevant resolvers
- src/apps/cli/at-autocomplete/provider.ts
- src/host/runtime/internal/mention-source-deps.ts
- direct mention/resolve/autocomplete tests

Enumerate every live firstLineOf/safeLookup implementation and production consumer.
Run the same fixtures through each reachable behavior: leading/trailing spaces,
empty string, LF, CRLF, lone CR, thrown lookup, missing entry, and warning sink.
Separate pure first-line normalization from caller-owned warning/error policy.
Propose a leaf only after proving both consumers may import it without violating
the live slice config. Respect ADR-0330 constraints.

Return LANE I2 DONE/NOT DONE/STALE with the behavior matrix, measured drift,
canonical leaf or keep-local decision, existing rails, and mutation/anti-vacuum
plan. Make no changes.
```

## I3 — agent composition-wire growth

```text
You are W1b lane I3. Start after I2 completes. Work read-only.
Read AGENTS.md and require W0 and prior W1b receipts; return STALE on snapshot drift.

Historical assignment: S14.
Evidence universe: top-level src/agent/*-wire.ts and *-bridge.ts, their direct
composition callers, docs/ARCHITECTURE.md composition rules, and existing wire/slice
hellgates. Do not reopen loop internals already owned by H.

Inventory each wire by collaborators constructed, slices value-imported, lifecycle
owned, state retained, and production composition caller. Classify it as domain
orchestration, closed-port adapter, compatibility bridge, or misplaced composition.
Do not treat a filename suffix as proof. Determine whether new wire growth is
already prevented and whether moving an existing wire would create worse
cross-surface coupling. Prefer an exact no-new-wire or approved-registry guard over
a mass move without behavioral benefit.

Return LANE I3 DONE/NOT DONE/STALE with only concrete ownership violations or a
bounded no-finding result, plus exact guard population and red-on-injection plan.
Make no changes.
```

## J — god-code and 150-line cliffs

```text
You are W2 lane J, an architecture lens. Start only after all W1/W1b lanes finish.
Work read-only. Require W0 and prior receipts; return STALE on snapshot drift.

Historical assignment: N9a and S7 excluding src/shared/runtime-config.ts. K exclusively
owns runtime-config, including N9b parseToolSurfaceSlice.

Evidence universe:
- src/host/bootstrap/bootstrap-session.ts
- src/runner/orchestrate/resume-fsm.ts
- src/codemode/runtime.ts
- the live 900-999 production-module cohort except runtime-config
- tools/god-code/detect.ts and tools/god-code/allowlist.json
- god-code ratchet tests

Recompute function-body and module lengths with the repository detector. Identify
semantic responsibilities and consumer boundaries rather than mechanically
extracting line-count helpers. For each exact-150 function, propose an owner-local
split that lowers the body materially, preserves state ordering, and does not add a
cross-slice import. For S7, distinguish stable large modules from modules advancing
toward the ceiling. Never propose raising an allowlist or cohort ceiling.

Return LANE J DONE/NOT DONE/STALE with exact current measurements, split seams,
write-set conflicts with prior findings, and ratchet updates required only to remove
stale entries or lower counts. Make no changes.
```

## K — typed knob authority and scanner bypasses

```text
You are W2 lane K, an architecture lens. Start after all W1/W1b lanes finish. Work
read-only. Require W0 and prior receipts; return STALE on snapshot drift.

Historical assignment: N9b, S6, N14.
Exclusive file owner versus J: src/shared/runtime-config.ts, including
parseToolSurfaceSlice.

Evidence universe:
- src/shared/runtime-config.ts
- knob inventory, readAuthority taxonomy, CLI-seeded gates, and runtime config tests
- src/agent/session-resource-registry/auto-sweep.ts
- src/apps/cli/internal.ts only for live raw/computed env reads
- scanners and debt ceilings governing process.env access

Tasks:
1. Recompute literal and computed process.env reads. Prove whether process.env[CONST]
   evades the live guard and identify every reachable bypass.
2. For each affected key, map declaration, parser, typed field, default, CLI seed,
   runtime consumer, and inventory home/readAuthority. Do not equate inventory home
   with current typed ownership.
3. Recompute the runtime-config-home and typed-field intersection instead of trusting
   228/0 historical counts.
4. Measure parseToolSurfaceSlice with the repository detector and design a cohesive
   owner-local split below the cliff without moving knob authority.
5. Prefer runtime reflection under a synthetic env over source-text matching. Any
   scanner extension needs a call/structural pattern, floor, and injected bypass.

Return LANE K DONE/NOT DONE/STALE with per-key authority rows, exact counts, N9b
split seam, existing guard gaps, and proposed write sets. Make no changes.
```

## L — dead authority and dual SSOT

```text
You are W2 lane L, an architecture lens. Start after all W1/W1b lanes finish. Work
read-only. Require W0 and prior receipts; return STALE on snapshot drift.

Historical assignment: N16. Use the referenced aug-25 #34/#36/#57 material only as
historical routing; live source is authoritative.

Evidence universe:
- src/agent/primary-rail/** and direct imports
- runner/bench repair admission and finish-gate implementations
- production apps/bench execution path and focused primary-rail tests
- feature/knob authority that selects these paths

Trace the real production path from configured knob/input to repair admission,
candidate clearing, finish decision, emitted result, and persisted evidence. Compare
decidePrimaryRailFinishGate with the live runner implementation field-by-field and
branch-by-branch. A zero production caller is not sufficient: prove intended
authority, reachable alternate owner, semantic divergence, and the consequence of
deleting or wiring the dead owner. Separate dead compatibility exports from dual
runtime SSOT.

Return LANE L DONE/NOT DONE/STALE with a call graph, decision table, concrete drift
fixture, delete/wire/keep decision, and owner-local non-vacuous rail plan. Make no
changes.
```

## W3 — parent invariant merge and ticket gate

```text
You are the W3 parent integrator. Work read-only. Do not implement, edit docs, create
GitHub issues, commit, push, or merge.

Require final receipts from W0, A-H, I1-I3, and J-L. Re-check HEAD, origin/main,
authority-document hashes, and git status. If they differ from W0, mark the campaign
STALE; do not merge evidence from different snapshots.

Merge procedure:
1. Prove coverage of all 30 active Sep-06 rows exactly once. Recombine N9a/N9b into
   N9 only after preserving their distinct file owners.
2. Deduplicate on (canonical authority, invariant, reachable production consumer),
   not wording or basename.
3. Keep the strongest evidence among duplicate reports. Discard grep-only copies.
   Within a surviving finding, the weakest missing required proof limits closure and
   severity.
4. Validate every closed/intentional/conditional decision against SEP5-11. A child
   invariant may remain active while its older generic-consolidation parent remains
   closed; state both explicitly.
5. Regrade severity from demonstrated blast radius. Do not inherit P0/P1/P2 labels
   without live evidence.
6. Draft implementation tickets only for evidence-backed P0/P1 findings. Keep
   confirmed P2 items in an active register with trigger, owner, and proof gap; do
   not silently drop them.
7. Build a write-set conflict graph. Any overlapping product/test file makes the
   corresponding implementation tickets serial unless an explicit ownership split
   removes the overlap.
8. Every ticket draft must specify canonical owner, dependencies, exact write set,
   reachable baseline RED, negative control, type-correct mutation, anti-vacuum
   floor, production GREEN, focused commands with verified existing paths, slice
   fence checks, and full-CI enrollment.

Final output:
- DONE/NOT DONE/STALE and exact snapshot;
- 30-row disposition matrix;
- P0/P1 ticket drafts in dependency order;
- P2 active register;
- closed/not-a-finding register with reasons;
- implementation write-set conflict graph and serial/parallel waves;
- commands actually run with exit codes;
- unverified conditions. Never turn static, compile-only, partial, or missing output
  into campaign closure.
```
