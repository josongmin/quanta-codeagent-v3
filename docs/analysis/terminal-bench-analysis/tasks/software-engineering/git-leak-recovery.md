---
task: git-leak-recovery
category: software-engineering
difficulty: medium
tags: [git, security]
expert_min: 30
junior_min: 60
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/git-leak-recovery:20251031
---

# git-leak-recovery

**Goal** — A secret (`secret[...]` format) was committed to `/app/repo` then removed by history rewrite. (1) Recover it and write to `/app/secret.txt`; (2) scrub it so it can't be found *anywhere* in the repo (including unreachable objects); (3) leave unrelated files and commit messages untouched.

**Solution shape** — `solve.sh` (~40 lines): `cd /app/repo`, run `git fsck --lost-found`, grep the dangling commits for `secret\[...\]`, write the recovered value to `/app/secret.txt`. Then purge history: `git reflog expire --expire=now --all` + `git gc --prune=now --aggressive` to drop the unreachable objects, and re-scan `git fsck` + `rev-list --all` to confirm no `secret[` remains. Pure git-plumbing shell; no files added to the repo.

**Verifier** — pytest: `secret.txt` exists and equals exactly `secret[lost_and_found_in_git]`; `git log --all` (message grep and `-S secret[` content pickaxe) finds nothing; every dangling object from `fsck --lost-found` (`cat-file -p`) is secret-free; a known "chore: init …" commit still exists; and a `find | sha256sum` checksum of the repo's tracked files matches an expected hash (unrelated content unchanged). Binary 0/1.

**Difficulty drivers** — Git internals fluency: knowing that rewritten history leaves the secret in *dangling/unreachable* objects, how to surface them (`fsck --lost-found`), and how to genuinely evict them (reflog expire + aggressive gc/prune) rather than just rewriting refs. The dual constraint — remove the secret *and* preserve everything else byte-exact (checksum-gated) — punishes overly broad rewrites. Short but requires precise plumbing.

**quanta attack points** — Pure `container_exec` git plumbing. No interactivity, but very high terminal-native — this is exactly the shell-forensics work a terminal agent should excel at. The exit-code loop helps: the agent can re-run `git fsck`/`git log -S` itself to confirm the leak is gone before finishing, and the checksum test warns against collateral edits. Main risk is scrubbing too aggressively and altering unrelated tracked files (checksum fail).
