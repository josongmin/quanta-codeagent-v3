---
task: install-windows-3.11
category: system-administration
difficulty: hard
tags: [virtualization, qemu, windows-3.11, vnc, sys-admin, retro-computing]
expert_min: 300
junior_min: 600
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/install-windows-3.11:20251031
---

# install-windows-3.11

**Goal** — Boot Windows 3.11 for Workgroups from `/app/isos/win311.img` in QEMU (5.2.0-compatible). Requirements: VNC display :1 on port 5901, an nginx web interface on port 80 for remote access, QEMU in **snapshot mode** (immutable base image), and a programmatic keyboard channel (QEMU monitor) so automated tests can inject keystrokes — VM left running in the background at the Win 3.11 desktop.

**Solution shape** — `solve.sh` (~150 lines, lots of logging): compiles QEMU 5.2.0 from source (`wget` tarball, `./configure --target-list=i386-softmmu`, `make`, install binary + rom/bin files) if absent; creates a dummy keymap; launches `qemu-system-i386` with `-drive …,snapshot=on -m 32 -vga cirrus -netdev user -device ne2k_pci -vnc :1 -device sb16 -monitor unix:/tmp/qemu-monitor.sock,server,nowait -snapshot -daemonize`; then starts `websockify` for web VNC and monitors the process. Note: the env ships nginx/supervisor/pulse configs under `environment/etc/`, and the grader expects **nginx on :80** (the sample script wires websockify:8080 instead — the port-80 web layer comes from the baked image/supervisord).

**Verifier** — pytest: a `qemu-system` process is running; `netstat` shows :5901 (VNC) and :80 (nginx) listening; QEMU cmdline has snapshot mode, the exact `win311.img` path, i386/x86_64 arch, `-m`, and a VGA device; the disk image SHA256 is in a known-good set; mtools (`mdir`/`mcopy`) extracts ≥5 of 7 Win 3.11 core files (WIN.COM, PROGMAN.EXE, KRNL386.EXE, …) matching hardcoded SHA256s; and it sends Windows keys (F1/Alt-Tab/F10/Alt-F4/Ctrl-Esc) via the monitor socket + `socat`, requiring ≥10% VNC-screenshot pixel change to prove the VM is live and keyboard-controllable. Binary 0/1.

**Difficulty drivers** — Deep sysadmin/virtualization: building a specific old QEMU, choosing a device combo an ancient guest tolerates, wiring snapshot mode + monitor socket + VNC + a web proxy, and getting a real guest to *boot to desktop* and respond to injected keystrokes. Multi-service orchestration (QEMU + VNC + nginx + supervisord) that must all be live simultaneously at grade time. Longest sysadmin task; retro-computing quirks abound.

**quanta attack points** — Mixed: `container_exec` for build/config/launch, but the *keyboard-control* requirement is inherently interactive — driving the QEMU monitor socket (via `socat`/`pty_*`) and confirming screen changes is closer to a `pty_*`/live-process workflow than one-shot exit codes. Highest terminal-native in batch (system state + long-running processes are the essence). Main risk: everything must stay running and responsive at grade time — an exit-code loop can't easily prove "booted to desktop and keystroke-reactive"; the agent needs screenshot/VNC feedback loops, and the nginx:80 requirement (vs the sample's websockify:8080) is an easy miss.
