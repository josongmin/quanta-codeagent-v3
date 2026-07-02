---
task: crack-7z-hash
category: security
difficulty: medium
tags: [decrypt, security, file-operations]
expert_min: 5
junior_min: 10
skill_class: ADVERSARIAL-SEC
terminal_native: high
docker_image: alexgshaw/crack-7z-hash:20251031
---

# crack-7z-hash

**Goal** — Recover the word inside `secret_file.txt` in the password-protected `secrets.7z` archive and write it to `/app/solution.txt`.

**Solution shape** — Straight tool-chaining, no code authored. `solve.sh` installs `libcompress-raw-lzma-perl`, runs the bundled John-the-Ripper `7z2john.pl` to extract the archive hash into `secrets.hash`, runs `john` on it to crack the password (`1998`), installs `7zip`, extracts the archive with `7z x -p1998`, then `cat`s the recovered `secret_file.txt` (contents `honeybear`) into `solution.txt`. A handful of shell commands, no scripts.

**Verifier** — pytest: `solution.txt` exists and its stripped content == "honeybear". Binary 0/1.

**Difficulty drivers** — Low intrinsic difficulty (expert est. 5 min): the workflow is a well-known 7z→john→extract recipe. The only friction is knowing the John toolchain layout (`7z2john.pl`, `run/john`) and the perl LZMA dependency. No algorithmic content; it's a tooling-familiarity task.

**quanta attack points** — Classic `container_exec` chain — each install/crack/extract step returns a clean exit code, ideal for the "iterate until it works" loop. No interactive TUI needed (`john` runs to completion non-interactively). Main risk is minor: missing the perl dependency for `7z2john.pl` or not locating the John binaries. High terminal-native because the whole task is orchestrating system security tools, not authoring logic.
