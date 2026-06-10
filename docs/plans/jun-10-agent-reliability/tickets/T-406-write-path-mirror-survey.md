# T-406: Write-path mirror-sweep survey (storage / file-history / checkpoint)

**RFC:** [04·W6](../04-rfc-stale-guard-worktree-parity.md) · **Priority:** P1 · **Size:** M · **Deps:** none (parallel to fixes) · **Posture:** survey-only

## Deliverable
Survey non-tool write paths for raw-`ctx.cwd` keying against worktree-recorded reads or missing guard integration: storage adapters, file-history restore, checkpoint three-way restore (`src/agent/per-tool-checkpoint/three-way-restore.ts`), shadow-odb write paths. Output: a findings doc per path (safe / unsafe + why); each unsafe finding spins off its own ticket (keeps the P0 wave unblocked by an open-ended sweep).

## Acceptance criteria
- [ ] Every surveyed path has a written safe/unsafe verdict with code evidence.
- [ ] Unsafe findings filed as follow-up tickets referencing this survey.
- [ ] House mirror rule list in 00-index updated if new write paths are discovered.
