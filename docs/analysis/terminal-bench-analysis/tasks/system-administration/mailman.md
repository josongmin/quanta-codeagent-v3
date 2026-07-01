---
task: mailman
category: system-administration
difficulty: medium
tags: [email-server, mailing-list]
expert_min: 60
junior_min: 180
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/mailman:20251031
---

# mailman

**Goal** — Stand up a working mailing-list server for `reading-group@local.edu` using the pre-installed postfix + mailman3: join/leave-by-email (with confirmation) and posting announcements to subscribers, with config saved at `/etc/mailman3/mailman.cfg`.

**Solution shape** — ~140-line bash: real service configuration, not app authoring. Sets `/etc/mailname`; `postconf -e` tunes postfix (myhostname/mydomain, loopback-only, `transport_maps`/`local_recipient_maps` wired to mailman's `postfix_lmtp`); creates mailman var/log/lock dirs; writes `mailman.cfg` (LMTP on 8024, SQLite db, FHS paths, archivers off); chowns to `list:list`; starts mailman, waits for init, `create`s the list, uses `withlist` to set `SubscriptionPolicy.open`, regenerates postfix aliases, starts postfix, and waits for ports 25/8024 before running the provided `/app/eval.py`.

**Verifier** — pytest against the live services: direct local delivery (send to `bobgreen@local.edu`, confirm it lands in `/var/mail/bobgreen`); the mailman list exists via the mailman API; and a full join→confirm→announce→leave→confirm flow driven over real SMTP (`smtplib` to localhost:25), reading confirmation mails from users' mbox files and replying to confirm. Uses retries/backoff for async delivery. reward binary 0/1.

**Difficulty drivers** — Classic sysadmin integration: two daemons (postfix MTA + mailman3 LMTP) that must be correctly wired via transport/recipient maps, subscription policy, and file ownership — a single misconfig (wrong LMTP port, missing alias regen, bad perms, service not listening) breaks the end-to-end mail flow. Debugging spans postfix logs, mailman logs, and mbox contents. Requires domain knowledge of both tools.

**quanta attack points** — Genuinely terminal-native: `container_exec` for postconf/service/mailman CLI and log inspection; no TUI so `pty_*` isn't needed, but the state lives in running services and files, not a single script output. Main failure risk: postfix↔mailman transport wiring or subscription policy being subtly wrong so confirmation/announce mail never delivers, or services not bound to 25/8024. The exit-code loop helps via the bundled `eval.py` (agent can iterate to green before the hidden test), but failures are async and multi-service, so diagnosis leans on reading MTA/mailman logs rather than a stack trace.
