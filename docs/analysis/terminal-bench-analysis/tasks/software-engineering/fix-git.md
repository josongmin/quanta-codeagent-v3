---
task: fix-git
category: software-engineering
difficulty: easy
tags: [coding, version-control]
expert_min: 5
junior_min: 20
skill_class: DEBUG-FIX
terminal_native: high
docker_image: alexgshaw/fix-git:20251031
---

# fix-git

**Goal** — A repo has "lost" changes: work was committed in a detached-HEAD state (no branch), then `master` was checked out, orphaning the commit. Find the dangling commit and merge its changes into `master`.

**Solution shape** — `solve.sh`: reads `.git/logs/HEAD`, `awk`s out the commit hashes and `sed -n '4p'` to grab the orphaned commit's hash from the reflog, creates `recovery-branch` at that hash, checks out `master`, and `git merge -X theirs` to bring the orphaned file changes in. ~4 lines of git. (setup.sh in env constructs the orphan via `reset --hard` + detached commit.)

**Verifier** — pytest compares md5 hashes of `/app/personal-site/_includes/about.md` and `_layouts/default.html` against the known-good patch files in `/app/resources/patch_files/`. reward 0/1.

**Difficulty drivers** — Conceptually easy for someone fluent in git internals (reflog / detached HEAD / dangling commits) — hence 5m expert. The trap is realizing the changes live in an unreferenced commit recoverable only via reflog or `fsck --lost-found`, not on any branch. Pure version-control recovery, no coding.

**quanta attack points** — `container_exec` for `git reflog`/`git log`/`git fsck`/checkout/merge — all exit-code-driven, no interactivity (`pty_*` not needed). The exit-code loop is a strong fit: the agent can iterate git recovery commands and the file-hash check is easy to self-verify by diffing against `resources/patch_files/`. Main risk: `-X theirs` vs `ours` merge-strategy direction, or picking the wrong reflog entry so the recovered file contents don't hash-match.
