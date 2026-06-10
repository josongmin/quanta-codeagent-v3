# T-403: scripted_replace stale-guard integration (uncovered BASE tool)

**RFC:** [04·W3](../04-rfc-stale-guard-worktree-parity.md) · **Priority:** P0 (widest hole — bypass in ALL cases, worktree or not) · **Size:** M · **Deps:** none · **Posture:** ON (restores default-ON control; intended behavior change)

## Deliverable
Wire the stale-read guard into `scripted_replace`: pre-commit `guardWrite` deny (typed `StaleReadError`) + `resolveEditBase` target resolution, mirroring edit's contract. Today the tool has **zero** `readFileState`/`guardWrite`/`resolveEditBase` integration while being a BASE tool (always registered) and mutating.

## Evidence anchors
`src/tool/surface/manifest.ts:109` (BASE_TOOL_NAMES member), `src/tool/scripted-replace.ts:305` (`writeFile(input.file, r.next, ctx.cwd)`); grep-verified zero guard references in file.

## Acceptance criteria
- [ ] Read file → external mtime bump → scripted_replace on it → typed stale deny (no worktree needed — this hole is unconditional).
- [ ] Worktree variant: same-file assertion as T-401/402.
- [ ] Unread/new file still allowed.
- [ ] Behavior change pinned by its own test + changelog note (stale scripted_replace writes that silently succeeded now deny — intended).
- [ ] Smoke suite green (canary for latent stale-write reliance).
