---
task: git-multibranch
category: system-administration
difficulty: medium
tags: [system, version-control, web]
expert_min: 180
junior_min: 360
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/git-multibranch:20251031
---

# git-multibranch

**Goal** — Stand up a Git-over-SSH server at `git@localhost:/git/project` (password `password`) whose `post-receive` hook deploys the `main` and `dev` branches to separate Nginx HTTPS endpoints: `https://localhost:8443/index.html` (main) and `.../dev/index.html` (dev), self-signed cert, deploy within 3s of push.

**Solution shape** — Pure sysadmin, no app logic. `solve.sh`: creates the `git` user + password, sets up `~/.ssh/authorized_keys`, makes `/var/www/{html,dev}`, `git init --bare` at `/git/project.git`, writes a `post-receive` hook that checks out each pushed ref into a temp work-tree and copies `index.html` to the matching webroot, `chmod +x`, starts `sshd` and `nginx`, and keeps the container alive via tmux. Nginx `default.conf` (in environment) routes `/` → `/var/www/html` and `/dev` → `/var/www`. A dozen shell commands + one hook script.

**Verifier** — pytest writes a `verify.sh` that installs curl/expect/git, uses an `expect` script to clone over SSH (password auth), create+push `main` and `dev` branches with the specified `index.html` contents, then curls both HTTPS endpoints (`-k`, with retries) and asserts they return "main branch content" / "dev branch content". Prints TEST PASSED. Binary 0/1.

**Difficulty drivers** — Multi-service integration: SSH server + password auth, bare Git repo, a correct multi-branch `post-receive` deploy hook, Nginx TLS with a self-signed cert and per-branch routing, all wired to work end-to-end within a 3s deploy budget. Classic "make several daemons cooperate" sysadmin work; no algorithms but many moving parts that must all be right.

**quanta attack points** — `container_exec` for all the setup/daemon commands; interactive SSH password could need `pty_*` for manual testing, but the hook/deploy path is scriptable. Main risk: SSH auth config, hook not firing or copying to the wrong webroot, or Nginx cert/routing. High terminal-native — it's entirely system state. The exit-code loop helps only partially: the true test is an end-to-end clone/push/curl, so the agent should reproduce that flow itself rather than trust per-command exit codes.
