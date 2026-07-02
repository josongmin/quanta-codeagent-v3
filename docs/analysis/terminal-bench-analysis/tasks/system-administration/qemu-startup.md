---
task: qemu-startup
category: system-administration
difficulty: medium
tags: [sys-admin]
expert_min: 30
junior_min: 480
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/qemu-startup:20251031
---

# qemu-startup

**Goal** — Boot `/app/alpine.iso` in QEMU in the background so that `telnet 127.0.0.1 6665` reaches the Alpine login prompt; leave the VM running and block until it's ready.

**Solution shape** — `solve.sh` launches `qemu-system-x86_64` with `-cdrom /app/alpine.iso`, a qcow2 disk, `-daemonize -display none -vga none`, user NIC with ssh hostfwd, and crucially `-serial mon:telnet:127.0.0.1:6665,server,nowait` to expose the serial console over telnet on 6665. Then writes an `expect` script that telnets to 6665 and waits for the `login:` prompt (timeout 300) to block until boot completes. Short but requires exact QEMU serial-telnet flags.

**Verifier** — pytest via `expect`. Spawns telnet to localhost:6665, waits for `localhost login:`, sends `root`, waits for `# ` shell prompt, runs `uname -r`, logs to `/tmp/data.txt`, and asserts the kernel string `6.6.4-1-lts` appears — proving the VM booted, telnet console works, and root login succeeds. reward 0/1.

**Difficulty drivers** — Knowing the exact QEMU serial-over-telnet incantation (`-serial mon:telnet:...,server,nowait`), correct boot media/disk setup so Alpine reaches a login prompt, running headless + daemonized as a persistent background service, and (per the ISO) root login enabled. Wrong serial routing = no telnet console. Boot-config sysadmin; junior estimate 480 min reflects the obscure flags.

**quanta attack points** — `container_exec` to launch QEMU daemonized and to probe `telnet 127.0.0.1 6665` for the login prompt; the agent must keep the VM alive across the turn (background/daemonize) and block until ready. Main failure risk is the serial-console routing (frame appears nowhere reachable by telnet) or the VM not persisting. `pty_*` is a plausible aid for driving the interactive telnet/login to confirm readiness, but the solution's `expect`-style block can also run via container_exec. Strongly terminal-native (a live headless VM + console plumbing).
