---
task: configure-git-webserver
category: system-administration
difficulty: hard
tags: [system, version-control, web]
expert_min: 15
junior_min: 60
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/configure-git-webserver:20251031
---

# configure-git-webserver

**Goal** — Configure a git server so a client can `git clone user@server:/git/server`, commit `hello.html`, and `git push origin master`, with the pushed content auto-deployed to a webserver on port 8080 — so `curl http://server:8080/hello.html` returns `hello world`. (Auth setup is provided/out of scope.)

**Solution shape** — `solve.sh` (~75 lines): `apt-get install git nginx openssh-server`; creates a `git` system user (password `password`) with `.ssh/authorized_keys`; `git init --bare /git/server`; makes `/var/www/html` the web root; installs a `post-receive` hook that does `GIT_WORK_TREE=/var/www/html git checkout -f` to deploy on push; and configures/starts nginx to serve that dir on port 8080. Pure system-configuration shell — no app code.

**Verifier** — pytest runs `/tests/verify.sh`, which uses an `expect` script to `git clone` over SSH (localhost, password `password`), commit `hello.html`, `git push origin master`, then `curl http://localhost:8080/hello.html` and checks the body equals `hello world`. Pytest asserts `"TEST PASSED"` appears in the output. reward 0/1.

**Difficulty drivers** — Multi-service system integration: SSH access for a git user, a bare repo, the correct `post-receive` deploy hook (detached work-tree checkout), AND nginx listening on 8080 serving the deployed tree — every link in the chain must work end-to-end. "Hard" despite short expert time (15m) because a single mis-config (hook perms, nginx port/root, sshd, user perms) silently breaks the pipeline. High terminal-native: it's all live system state.

**quanta attack points** — `container_exec` for the whole setup (apt, user creation, hook install, nginx config, starting sshd/nginx) — exit-code-driven. Since the failure is end-to-end, the agent should self-run a clone→push→curl smoke test locally, which the exit-code loop supports well. Interactive SSH password prompts may need `pty_*` OR (as the verifier does) `expect`/key-based auth to script non-interactively. Main risk: services not actually running/persisted, wrong hook (deploy doesn't fire), or nginx not bound to 8080/root.
