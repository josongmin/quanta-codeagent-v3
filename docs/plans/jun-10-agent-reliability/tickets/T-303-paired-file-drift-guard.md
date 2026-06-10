# T-303: Paired-file drift guard (manifest↔lockfile mtime snapshot)

**RFC:** [03·W3](../03-rfc-post-edit-regression-guards.md) · **Priority:** P1 · **Size:** M · **Deps:** none · **Posture:** ON (advisory; `QUANTA_PAIRED_FILE_GUARD=off` killswitch)

## Deliverable
Deterministic pair table: `package.json`↔(`bun.lockb`|`package-lock.json`|`yarn.lock`|`pnpm-lock.yaml`), `Cargo.toml`↔`Cargo.lock`, `pyproject.toml`↔(`poetry.lock`|`uv.lock`), `go.mod`↔`go.sum`; extensible registry for project-declared pairs (schema↔migrations). Mechanism (R4-M5 corrected):
- On manifest edit → **snapshot the paired lockfile's mtime directly**;
- At turn end → **re-stat the lockfile directly** (NOT the read-paths sweep — never-read lockfiles are invisible to `state.paths()`): unchanged → closeout reminder "lockfile not regenerated — run <pkg-mgr> install or state why not"; changed → suppressed.
- Workspace-aware: pair per manifest directory, not repo-global.
Package-manager identification reuses `src/agent/env-context.ts:25-31`.

## Acceptance criteria
- [ ] Hellgate: edit package.json → finish without re-lock → reminder present.
- [ ] `bun install` between edit and finish → suppressed.
- [ ] Monorepo workspace fixtures (per-directory pairing).
- [ ] Killswitch `=off` → byte-identical. Exact-path table only (FP-zero envelope justifying default-ON; registered in 00-index posture table).
