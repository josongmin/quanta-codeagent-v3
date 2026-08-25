# GOAL-10 verification receipt

Date: 2026-08-26

Branch: `codex/goal-v2-closure`

Base: `93d1e40ee031ee4a8659f93833b2de400a6055c9`

## Result

CLI and web objective behavior is GREEN with the public `QUANTA_GOAL` preset default OFF. Runtime verification, generation-safe settlement, bounded wakeup control, session attach isolation, web submission serialization, and repeated blocker admission are implemented in GOAL-01 through GOAL-09. GOAL-10 adds public PTY evidence, installed-binary parity, catalog evidence, and full-repository regression proof.

Production live measurement and default-ON promotion are intentionally incomplete. No completion claim in this receipt includes those two promotion gates.

## Proof rails

| Rail | Result |
|---|---|
| `bun run typecheck && bun run typecheck:tests` | PASS; source 6.164s, tests 16.626s |
| `bun run lint && bun run lint:debt` | PASS; 301 warnings at the frozen 301 ceiling, no debt regression |
| `bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch` | 73 pass, 0 fail |
| `bun test tests/unit` | 38176 pass, 21 skip, 0 fail across 2978 files |
| `bun test tests/integration` | 3122 pass, 13 skip, 1 todo, 0 fail across 353 files |
| `bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` | 9 pass, 0 fail |
| installed `/Users/songmin/.local/bin/quanta` selected PTY parity | 3 pass, 0 fail; create, persisted show, default OFF |
| `bun fc validate && bun fc build && bun fc diff && bun fc check-evidence` | PASS; 1068 features, all evidence resolved, generated catalog clean |

The installed CLI was rebuilt through `bun run install:cli` as version `1.0.029` before the installed-binary parity run.

## Regressions found and closed during the final rail

- The first full unit run exposed 15 failures. All were repaired without increasing lint debt, god-code allowlists, or static-scan ceilings. The final full unit run is green.
- The first full integration run exposed three bootstrap-script failures in a valid linked Git worktree. The scripts incorrectly required a `.git` directory and the literal checkout basename. Both now use Git's worktree authority; the focused bootstrap battery is 4 pass, and the final full integration run is green.
- The PTY harness now exercises the production 15-second quiet floor, default-OFF registration, partially typed input suppression, foreground re-arm ordering, and detached-turn quiescence. It can run either source or a compiled binary without changing the scenario logic.

## Promotion boundary

- `QUANTA_GOAL` remains default OFF.
- No production decision-counter campaign or `tests/smoke/goal/` live promotion run is claimed.
- Default ON requires a separate live-measurement decision with zero overlap, duplicate, stale execution, unchecked completion, unavailable-to-completion leak, and fabricated evidence-reference violations.

The final commit SHA is emitted by the handoff after this receipt and the verified tree are committed; a commit cannot contain its own SHA without changing that SHA.
