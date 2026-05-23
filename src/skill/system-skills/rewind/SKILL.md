---
name: rewind
description: Restore workspace to a previously captured shadow snapshot. Triggers on "rewind", "undo", "rollback", "go back", "revert changes".
userInvocable: true
allowedTools:
  - Bash
  - Read
  - shadow_snapshots
  - shadow_rewind
  - shadow_restore_partial
category: skill
stability: stable
tools:
  - shadow_snapshots
  - shadow_rewind
  - shadow_restore_partial
---

# rewind — snapshot restoration

When the user says "rewind" / "undo last change" / "go back" / "rollback" — they want their
workspace restored to a previously captured shadow snapshot. This skill orchestrates the
3 shadow tools to do it safely.

## Decision tree

1. **List snapshots first.** Always call `shadow_snapshots` BEFORE any restore so the user
   sees what's available. Show them the N most recent (default 10).

2. **Pick the target.**
   - User said "verified" / "last passing" / "before X failed" → `shadow_rewind {target:"verified"}`
     (uses last `markVerified` anchor — only present if the auto-verify bridge is wired)
   - User said "last" / "last registered" / no preference → `shadow_rewind {target:"last"}` (default)
   - User named a specific file(s) → `shadow_restore_partial {paths:[...], target:"last"|"verified"}`
   - User wants to preview FIRST → `git --git-dir=$(...) diff HEAD <ref>` via Bash (read-only)

3. **Untracked policy.**
   - DEFAULT to `untracked:"preserve"` — never discard user's new files silently.
   - Use `untracked:"discard"` ONLY if user explicitly asks for "fully clean" / "match snapshot exactly".

4. **Confirm before destructive.** `shadow_rewind` is HITL `always-confirm`; the human will
   see your call and approve. Surface the snapshot id + target + untracked policy in your
   confirmation prompt so they know what they're approving.

5. **Safety net is automatic.** Every rewind creates a `pre-rewind-<ts>` ref BEFORE
   destruction. If the user regrets it, `shadow_snapshots` shows the pre-rewind ref, and
   they can rewind to it.

## When NOT to use

- File is uncommitted to user's own `.git` AND was never registered to shadow → no anchor
  exists; tell the user (don't pretend you can rewind).
- Merge in progress (`MERGE_HEAD` exists) → the tool will reject (typed error); guide the
  user to finish or abort the merge first.

## Examples

- "rewind" → list + use last/last default.
- "undo the last thing you did" → same as rewind.
- "go back to before the test broke" → if verified anchor present, target=verified; else
  list snapshots and ask user which one.
- "restore just src/foo.ts" → shadow_restore_partial.
