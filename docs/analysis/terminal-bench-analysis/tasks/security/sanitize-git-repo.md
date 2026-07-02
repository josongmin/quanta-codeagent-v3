---
task: sanitize-git-repo
category: security
difficulty: medium
tags: [security, system, version-control]
expert_min: 30
junior_min: 60
skill_class: ADVERSARIAL-SEC
terminal_native: high
docker_image: alexgshaw/sanitize-git-repo:20251031
---

# sanitize-git-repo

**Goal** — Scan the `dclm` git repo for leaked secrets (AWS access-key-id, AWS secret-access-key, GitHub tokens, HuggingFace tokens) and replace each with a fixed placeholder (`<your-aws-access-key-id>`, etc.), consistently, without touching any uncontaminated file.

**Solution shape** — `solve.sh` is a sequence of grep-then-sed passes: `grep -rE` to locate each secret class, then `find ... -not -path "./.git/*" -exec grep -l ... | xargs sed -i -E` to replace `AKIA[0-9A-Z]{16}` → placeholder, `gh[pousr]_[A-Za-z0-9]{20,}` → placeholder, `hf_[A-Za-z0-9]{29,}` → placeholder, plus two explicit `sed` calls for the AWS secret value in `ray_cluster.yaml` and `process.py` (case-insensitive). Regex/sed-driven, no separate program. ~10 commands.

**Verifier** — pytest (uses `git` module). For 3 contaminated files asserts none of the 5 fake secrets (case-insensitive) remain; asserts each contaminated file now byte-matches a reference decontaminated version in /tests; and diffs the working tree against a known base commit — any changed file NOT in the contaminated list raises (no collateral edits). reward 0/1.

**Difficulty drivers** — Secret-pattern recognition (AWS/GitHub/HF token regexes), consistent placeholder substitution, and the sharp constraint that ONLY the truly-contaminated files may change (verifier diffs against a base commit) — so blind repo-wide rewrites or `.git` edits fail. Must find all instances across file types (yaml/py/json). Real terminal grep/sed craft.

**quanta attack points** — `container_exec` for grep/sed/find and `git diff` to self-verify collateral. Main failure risk is over-broad substitution (a regex matching more than intended, or editing a non-contaminated file → the no-other-files-changed guard fails) or missing a secret variant (the two HF token forms, mixed-case AWS secret). The exit-code loop helps if the agent uses `git status`/grep to confirm scope before finishing. Genuinely terminal-native (shell text surgery over a repo).
