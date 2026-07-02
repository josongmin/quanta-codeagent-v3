---
task: qemu-alpine-ssh
category: system-administration
difficulty: medium
tags: [sys-admin]
expert_min: 30
junior_min: 480
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/qemu-alpine-ssh:20251031
---

# qemu-alpine-ssh

**Goal** — Boot `/app/alpine.iso` in QEMU, bring up networking and an SSH server inside the Alpine VM, so that from the host `ssh -p 2222 root@localhost` with password `password123` drops into a root shell. (Alpine default: root, no password.)

**Solution shape** — Bash + expect. Launches `qemu-system-x86_64` with the ISO, a qcow2 disk, `-nic user,hostfwd=tcp::2222-:22` (host 2222 → guest 22), `-daemonize -display none`, and a serial console exposed over telnet (`127.0.0.1:6665`). An `expect` script waits for the login prompt via telnet, logs in as root, then drives an in-guest `setup_ssh.sh`: `ip link set eth0 up` + `udhcpc`, `apk add openssh`, `ssh-keygen -A`, `sed` to enable `PermitRootLogin yes`/`PasswordAuthentication yes`, `echo "root:password123" | chpasswd`, `rc-update add sshd` + `service sshd restart`. No files delivered to disk — the work is live VM state driven through a serial/telnet console.

**Verifier** — pytest: from the host, `sshpass -p password123 ssh -o StrictHostKeyChecking=no -p 2222 root@localhost "uname -r"` must succeed and return kernel `6.6.4-1-lts`. This proves a real Alpine VM is booted and reachable over the port-forwarded SSH with the set password. reward binary 0/1.

**Difficulty drivers** — Classic sysadmin: nested virtualization inside the container, correct QEMU networking/port-forward flags, and — the crux — **driving an interactive guest console** (serial-over-telnet) to configure SSH before you have SSH. Requires knowing Alpine specifics (`apk`, `udhcpc`, `ssh-keygen -A`, OpenRC `rc-update`/`service`), sequencing the boot wait, and long-running process management. The huge junior estimate (480 min) reflects how many pieces must all line up.

**quanta attack points** — This is a top `pty_*` case: the essence is **interactively driving a booting VM's console** (expect/telnet) — a coding-only `container_exec` cannot type into the guest login before SSH exists. The agent must background QEMU, poll the console for a login prompt, and script the in-guest setup. The exit-code "iterate until tests pass" loop helps at the end (retry `sshpass` until the guest sshd answers) but the interactive console-driving in the middle is the real test of a terminal agent. Main risk: no PTY handling → cannot configure the guest → SSH never comes up.
