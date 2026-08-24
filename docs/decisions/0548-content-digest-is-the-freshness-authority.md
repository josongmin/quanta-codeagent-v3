# ADR-0548 — Content is the freshness authority, mtime is a hint, and a subagent's observations are its own

Status: Accepted (2026-08-24)
Slice: `src/tool/stale-read-guard/state.ts` · `src/tool/read/index.ts` · `src/tool/edit/index.ts` · `src/agent/subagent-runner-child-config.ts`
Feature: `file-observation-content-authority` (feature-catalog §2-tool-system)
Related: ADR-0474 (the mtime stale-read guard this extends) · ADR-0398 (`expected_hash` precondition) · the jul-13 edit-fresh-hash baseline refresh

## Context

### mtime was the admission authority, and mtime is forgeable

The stale-read guard records the mtime a file carried when the agent read it and blocks a later write only on a **strict forward move**. Its own comment states the rule: "only a FORWARD move is evidence of an external write after the read."

That makes the guard bypassable by anything that changes a file's **content** without advancing its timestamp — and none of it is exotic: `cp -p`, `rsync --times`, `tar -x`, `git checkout` on some filesystems, a build step that restores mtimes, or two writes landing in the same tick on a second-granularity filesystem. Measured on the shipping guard, a same-mtime swap and a backward-mtime swap were both allowed.

### A subagent had no guard at all

`subagent-runner-child-config.ts` never mentioned `readFileState`. The child config carried none, so every subagent mutation skipped the guard entirely.

The obvious fix — hand the child the parent's instance — is wrong in a second way. A read is **an observation by one agent**. A child inheriting the parent's observations would believe it had read files it never saw and would overwrite them; and one sibling re-reading a file would launder another sibling's stale baseline back to fresh.

## Decision

**Content wins when both sides have a digest.** `ReadFileState` gains a whole-file `contentDigests` map. `checkFresh(path, mtime, digest?)` compares digests when a digest was recorded AND one is supplied: equal ⇒ fresh (even if the mtime moved forward — a `touch`, a mode change, or a rewrite to identical bytes must not veto the next edit), different ⇒ stale (even if the mtime did not move). With no digest on either side the forward-mtime rule runs unchanged, so a caller that cannot cheaply hash keeps today's behavior byte-for-byte.

**Only a full read issues an observation.** A ranged read describes a window, not the file; recording its hash would baseline the guard against content that was never the file's content.

**No extra IO on the wired paths.** The read tool already holds the whole file in `outcome.text` (the offset/limit window is applied later, at render). The edit tool already read the source in `planEdit` to match `old_string`, and `planned.before` is exactly that content. Both hash something already in memory.

**Each child gets a NEW `ReadFileState`,** never the parent's, and never `undefined` when the parent has one.

## Consequences

- **This is not "atomic CAS".** A check-then-rename on an ordinary filesystem leaves an external-writer TOCTOU window between the digest comparison and the rename. This narrows Quanta's own self-inflicted staleness; real isolation remains the worktree/ownership boundary and the OS sandbox.
- The paired control is load-bearing: an unchanged digest must stay fresh under a forward mtime, or the "fix" degenerates into "block everything" — which satisfies the bypass tests and makes the tool unusable.
- `apply_patch`'s multi-target preflight still runs on mtime: its port surface (`statTarget`) reports `{exists, resolvedPath, mtimeMs}` and has no content in hand, so adding a digest there means a real extra read per target. Recorded as the remaining gap rather than guessed at.
- **Hash overhead, measured** (`sha256Hex`, tight loop, this machine): 1 kB → 0.7 µs, 10 kB → 3.9 µs, 100 kB → 34 µs, 1 MB → 350 µs per hash. An earlier run reported 4.9 µs at 1 kB; that figure was per-call harness overhead, not hashing — it is inconsistent on its face (1 kB and 10 kB cannot cost the same for 10× the bytes), and the numbers here are the corrected measurement of record. That hash is the WHOLE cost of this wiring, because it adds **zero extra IO**: the read tool already holds the entire file in `outcome.text`, and the edit tool already read the source in `planEdit` to match `old_string` (`planned.before`). Both hash bytes already in memory — no extra `stat`, `open`, or `read` on any wired path.
- Verified end-to-end through the real `read` and `edit` tools with an external writer that moves the mtime BACKWARD — the case the old rule called fresh. Removing either link (the read's `recordContent`, or the edit's digest argument) restores the bypass.
