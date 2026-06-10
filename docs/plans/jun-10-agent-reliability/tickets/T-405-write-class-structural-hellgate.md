# T-405: Manifest-derived write-class structural hellgate

**RFC:** [04·W5](../04-rfc-stale-guard-worktree-parity.md) · **Priority:** P0 · **Size:** M · **Deps:** T-401..T-404 · **Posture:** test-only

## Deliverable
1. Integration hellgate, gate ON + `activeWorktree` set, for **each write-class tool** (edit, write, apply_patch, scripted_replace, notebook_edit): stale-deny case, same-file allowed case, no-worktree byte-identical control, new-file-allowed control.
2. **Structural test that derives the write class from the manifest** (mutating + file-writing) and asserts each member calls the shared resolver/guard seam. A hardcoded tool-name list is exactly how scripted_replace escaped — the enumeration must be computed, so a future write tool cannot ship outside the control.

## Acceptance criteria
- [ ] Hellgate covers all five tools × four cases.
- [ ] Structural test fails if a new mutating file-writing tool lacks the guard seam (verified by a fixture-injected fake tool).
- [ ] Suite green on top of T-401..404.
