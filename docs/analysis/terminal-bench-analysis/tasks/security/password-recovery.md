---
task: password-recovery
category: security
difficulty: hard
tags: [system, file-operations, troubleshooting]
expert_min: 100
junior_min: 300
skill_class: ADVERSARIAL-SEC
terminal_native: high
docker_image: alexgshaw/password-recovery:20251031
---

# password-recovery

**Goal** — Digital-forensic recovery: a deleted `launchcode.txt` held a `PASSWORD=` value, 23 chars, starts `8XD` ends `W54`, uppercase+digits only. Carve the password out of the filesystem and write each matching candidate (one per line) to `/app/recovered_passwords.txt`. Multiple guesses allowed.

**Solution shape** — Bash carving. The setup (`environment/setup.sh`) had zipped the secret, split the zip into two fragments, scattered them at the 1 MB and 3 MB offsets of a 4 MB random `.dat` disk image under `/app/varsea/disks/...`, and interleaved noise at 2 MB. The solution `find`s the `.dat`, `grep -aob "8XD"` and `"W54"` to locate byte offsets, `dd`-windows bytes around each, `tr -c 'A-Z0-9'` to isolate alnum runs, picks the longest fragment containing each anchor, then brute-force-concatenates trimmed first/last parts of length 23 into `recovered_passwords.txt`. All raw byte surgery — no unzip (the zip is fragmented/broken).

**Verifier** — pytest: `recovered_passwords.txt` exists, non-empty, and contains the exact string `8XDP5Q2RT9ZK7VB3BV4WW54` among its lines. reward binary 0/1.

**Difficulty drivers** — The recognizable structure is destroyed: the file is deleted, zipped, split across non-contiguous image offsets with noise between fragments, buried in a decoy directory tree of random binaries. The agent must reason about binary carving (`grep -a`, byte offsets, `dd` windows), tolerate that the two halves don't sit adjacently, and enumerate the correct 23-char reconstruction. High expert time (100 min) reflects real forensic depth.

**quanta attack points** — Heavy `container_exec`: `find`/`grep -aob`/`dd`/`strings` are all one-shot exit-code steps, and the final output file is directly checkable, so the iterate-until-tests-pass loop is useful for the final brute-force enumeration. Main risk is the *localization* — realizing the secret is a fragmented zip inside a random disk image and choosing the right carving window; a naive `strings | grep PASSWORD` fails because the value is split. Genuinely terminal-native forensic work.
