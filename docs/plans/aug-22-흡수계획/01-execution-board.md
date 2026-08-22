# Aug-22 execution board

**Status:** execution SSOT for R6 work packets. This file schedules work; each RFC owns the packet's
domain contract, exact write-set, RED rail, and acceptance receipt.

**Frozen source:** `9d5369d310bba9cfcdf2508ca62e6274f184cdd4`. Re-freeze before execution. If
`origin/main` moves, update the receipt SHA and re-run the packet's owner-local RED baseline before
writing code.

## 1. Worktree and evidence protocol

Each packet runs in a dedicated clean worktree and `codex/aug22-<packet>-<slug>` branch.

1. Record `git rev-parse HEAD`, `git status --short --branch`, and `git diff --stat`.
2. Refuse to start if the packet write-set overlaps dirty/untracked files in that worktree.
3. Run the named RED rail before implementation. If it is already GREEN, stop and classify the
   packet as ALREADY, VACUOUS, or WRONG-RAIL; do not add production code.
4. Edit only the packet write-set. Do not use `git add -A`; stage explicit paths.
5. Run owner-local unit/integration tests, then the shared architecture/static ladder.
6. Record current-SHA front-door receipt and negative control. Unit-only green is not merge proof.
7. Integrator rebases/merges in the owner order below. Worker branches do not merge, push, or edit
   another packet's files without reassignment.

Generated files, locks, package manifests, feature catalog YAML/MD, and ADRs are out of scope unless
the packet explicitly lists them. If implementation requires one, stop and amend the RFC/write-set
before editing it.

## 2. Packet completion record

Every packet closes with this machine-checkable receipt:

```text
packet:
source_sha:
result_sha:
write_set_actual:
red_command:
red_failure_signature:
owner_local_commands:
architecture_commands:
front_door_command:
front_door_observation:
negative_control:
gate_off_receipt:
remaining_parks:
```

Missing `red_failure_signature`, `front_door_observation`, or `gate_off_receipt` means NOT DONE.
When a packet is docs/schema-only and has no product consumer yet, its RFC must explicitly designate
it `FOUNDATION`, and merge eligibility requires a non-vacuous composition RED rail in the immediate
consumer packet.

## 3. Shared verification ladder

Run targeted tests first. In a clean worktree, every merge candidate then runs:

```sh
bun run typecheck
bun test tests/unit/god-code-ratchet.test.ts --parallel=1
bun test tests/unit/slice-boundary-config-parity.test.ts \
  tests/unit/slice-boundary-up-import-proof.test.ts \
  tests/unit/surface-coupling-ratchet.test.ts \
  tests/unit/terminal-defaults-ratchet.test.ts --parallel=1
bun run lint
```

Add the touched slice tests from this set, never replace them with the generic four above:

```sh
bun test tests/unit/agent-slice-boundary.test.ts \
  tests/unit/session-slice-boundary.test.ts \
  tests/unit/git-slice-boundary.test.ts \
  tests/unit/activity-slice-boundary.test.ts \
  tests/unit/runtime-slice-boundary.test.ts \
  tests/unit/permission-slice-boundary.test.ts \
  tests/unit/skill-slice-boundary.test.ts \
  tests/unit/observability-slice-boundary.test.ts \
  tests/unit/protocol-slice-boundary.test.ts \
  tests/unit/runner-slice-boundary.test.ts \
  tests/unit/host-slice-boundary.test.ts \
  tests/unit/kernel-slice-boundary.test.ts --parallel=1
```

Run only the touched entries plus dependencies for an intermediate packet; the integrator runs the
full listed set after each shared-owner chain. `bun run lint` or unrelated tests failing from a
pre-existing main defect must be recorded separately and reproduced on the frozen base; it is not
silently waived or attributed to the packet.

## 4. Dependency DAG

```text
parallel leaf foundations
  A1 question broker       B1-B3 review source      D1-D3 activity/runtime      G1 VCS grammar
          |                         |                        |                         |
          v                         v                        v                         v
  A2-A3 question wiring      B4 front door              D4-D5 live UI          G2-G4 inline facts
          |                                                  |                         |
          +-------------------- shared assembly -------------+                         |
                                     |                                                 |
                     C0-C2 objective authority                                        G5 BLOCKED
                                     |
                              C3-C4 goal UX
                                     |
                              E1-E4 posture
                                     |
                              E5 question guard
                                     |
                              F1-F5 skill runtime

Deferred: B5 exact last-turn; C5 evaluator; setup hooks; full access; uninstall/suggest;
G5 report until owner release; semantic count labels; child-shell reap.
```

Foundation packets may develop in parallel only while their write-sets remain disjoint. Shared
composition/protocol/surface packets are integrated serially even if worker branches were prepared
in parallel.

## 5. Shared-owner locks

| Owner lock | Serialized packet order | Reason |
|---|---|---|
| `runner/assemble/session-authorities/{types,build,index}.ts` | A2 -> D4 -> C2 -> E2/E3 -> F1 | One session authority graph; no parallel constructors |
| `agent/features.ts` and session feature shape | A2/A3 -> E5 -> F2/F3 | Remove fallback handles before adding live readers/guards |
| `protocol/session/{commands,codec,builders}.ts` + kernel scheduler/reducer/ports | A4 -> C3 -> E4 -> F5 | One command union and projection version at a time |
| CLI slash registry/composition | A4 -> D4 -> C3 -> E4 -> F4/F5 | Avoid concurrent command-table and session-handle edits |
| host bootstrap/context binding | C2 -> E3 -> F1 | Objective restore, then behavior-live posture, then skills |
| `tool/{types,registry}.ts` | F3 only; E5 consumes agent guard instead | Prevent generic dynamic-tool substrate from split ownership |
| `session/{types,store}.ts` | C2 -> future B5 | Objective snapshot lands before exact-turn boundary extension |
| `runner/batch/report*` | current dirty owner -> G5 | No RFC-07 report edits until explicit release/rebase |

An integrator must rebase the next packet onto the merged predecessor and rerun its RED baseline.
Resolving conflicts by retaining both old and new constructors/readers is forbidden.

## 6. Merge waves

### Wave 0 — freeze and rails

- Revalidate all current owners and constructor counts.
- Add only the new `objective` slice config/test when C0 begins; existing activity/runtime/protocol
  fences are already live.
- Install RED rails in the packet that owns the behavior. Do not merge a permanent test-only branch
  whose sole purpose is to stay RED.

### Wave 1 — disjoint foundations

- RFC-01 A1.
- RFC-02 B1–B3.
- RFC-04 D1–D3.
- RFC-07 G1 and, independently, G2 schema/classifier if its files remain disjoint.

### Wave 2 — attention and activity delivery

- RFC-01 A2–A5.
- RFC-04 D4–D5 rebased after A2 because both touch session assembly/CLI ownership.

### Wave 3 — durable state cutovers

- RFC-03 C0–C4.
- RFC-05 E1–E5.
- RFC-06 F1–F5.

These merge in that order. Each removes the old behavior owner before the next authority is added.

### Wave 4 — isolated observability persistence

- RFC-07 G2–G4 may merge without report changes.
- G5 starts only after the current report owner publishes a clean SHA and the packet is rebased.

### Wave 5 — prerequisite-gated work

Open a new execution plan rather than extending the preceding packet when a PARK condition closes.
The new plan must re-freeze producers and consumers; the parked estimate is not implementation
authority.

## 7. Capacity and planning estimate

These are engineering ranges for planning, not completion claims. They include owner-local tests and
packet receipts, but exclude a blocked prerequisite and unrelated base failures.

| RFC | Authorized active packets | Estimate | Critical risk |
|---|---:|---:|---|
| RFC-01 attention | A1–A5 | 5–7 engineer-days | real child resume/front-door command |
| RFC-02 diff source | B1–B4 | 3–5 engineer-days | NUL-safe attr and default parity |
| RFC-03 objective | C0–C4 | 8–12 engineer-days | atomic import/writer/persistence cutover |
| RFC-04 worktree | D1–D5 | 5–8 engineer-days | pre-completion delivery, multi-surface store ownership |
| RFC-05 posture | E1–E5 | 7–10 engineer-days | replacing live mode cell without split-brain |
| RFC-06 skills | F1–F5 | 7–10 engineer-days | all frozen consumers cut over together |
| RFC-07 observability | G1–G4 | 4–7 engineer-days | canonical attempt envelope ownership |
| Integration/rebase | shared-owner chains | 4–6 engineer-days | protocol/host/CLI conflicts and full ladder |

Total authorized work is roughly **43–65 engineer-days**. With four workers, the leaf foundations
can overlap, but C→E→F and the shared-owner integration remain serial. Expected critical path is
approximately **29–44 working days** with one continuous integrator. This range must be revised if
a base RED, dirty owner or prerequisite stop fires; it is not compressed by running conflicting
session/protocol edits in parallel.

Suggested staffing:

| Lane | Initial packets | Later assignment |
|---|---|---|
| L1 domain/session | A1, then A2–A5 | C0–C2 support |
| L2 git/review | B1–B4 | G1 or integration support |
| L3 activity/runtime | D1–D3, then D4–D5 | C5 prerequisite only if separately admitted |
| L4 observability | G1–G4 | report G5 only after owner release |
| Integrator/authority owner | shared-owner rebases | C0–C4 -> E1–E5 -> F1–F5 |

If only four total people are available, the integrator is one of the four and L2 absorbs G1 after
B1–B3. Do not create a fifth concurrent shared-owner lane to match the table.

## 8. Global stop rules

Stop the affected packet and update its RFC if any condition occurs:

- a named current owner/path no longer exists or a new competing writer/constructor appears;
- the RED rail passes on the frozen base or fails for an unrelated reason;
- a leaf requires a new peer/Layer-2 import or broad slice allowlist;
- exact routing would require inference from PID, cwd, ancestry, newest event, path or prose;
- persistence cannot commit before live publication, or a mutation needs rollback across two
  independent stores;
- a front door can report success while its execution-time consumer retains stale state;
- implementation needs a PARKED producer, current dirty owner, destructive filesystem action, or
  security posture not admitted by its RFC;
- a touched module/function crosses the god-code threshold; split it within the same packet.

The disposition after a stop is one of: revise the packet/write-set, split a prerequisite packet,
PARK, or DROP. Compatibility shims, shadow stores, optional-success no-ops and heuristic fallbacks
are not permitted unblockers.
