# W3-I receipt

Status: **W3 closed on local `main`**. Findings `implemented`. Not W7 `verified` 39/39. Lock was **not** blocked. W4 is not started.

Merge order: **R14 → R02 → R12**, then reserved/I wiring. Single closeout commit.

## Findings

| ID | Result |
|---|---|
| G-F9 | CLI `buildCliRemoteSeams` → `selectRemoteRunner`; empty `{}` gone |
| G-F9.4 | contract rail `tests/contract/remote-cli-docker.test.ts`; this machine Docker live **executed**, Lima **skipped** (no `limactl`) |
| F-03..F-13, F-11 | flock + CAS + union + dirty-delta + atomic + ledger validate |
| F-12 malformed | `trust-persist.ts` refuses commit; original bytes kept |
| F-13.2 | two-process memory append union; `persistMemory` ENOENT/ENOTDIR-only empty read |
| C-F2 | objective/posture/skill verbs on wire + in-process |
| C-F11 | exhaustive payload validators; `approval:null` refused; `session.state.updated.status` required |

## I applied

R14: `src/apps/cli/index.ts` seams builder.

R02: agent trust `commit` + lock merge; host/CLI `commit` stubs; sticky-model flock hellgate; biome override for R14 owner tests + G-F9.4 contract file.

R12: protocol barrel `HOST_ONLY_SESSION_COMMANDS`; SDK `types.ts`/`session.ts` verbs. Kernel event-log already fail-closed on corrupt decode. `event-payload.ts` + snapshot decode require session status.

## Remaining (not W3)

- G-F5.4 EC2 실기 OPEN (W2 leftover)
- W0.6 R10 half (W4)
- W4–W6 packages
- Windows flock not claimed
- apple-vz empty seams (Skybridge stub)
- Global `prepush` not claimed as W3 closeout
- No W7 verified 39/39 claim
