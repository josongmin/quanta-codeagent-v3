---
task: openssl-selfsigned-cert
category: security
difficulty: medium
tags: [coding, file-operations, security, system]
expert_min: 20
junior_min: 120
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/openssl-selfsigned-cert:20251031
---

# openssl-selfsigned-cert

**Goal** — Create a self-signed TLS cert with OpenSSL under `/app/ssl/`: 2048-bit RSA key (perms 600), 365-day cert (O="DevOps Team", CN="dev-internal.company.local"), combined key+cert PEM, a `verification.txt` (subject, validity dates, SHA-256 fingerprint), and a `/app/check_cert.py` that loads the cert and prints CN + expiry (YYYY-MM-DD) + "Certificate verification successful".

**Solution shape** — Short (~30 effective lines) bash. `openssl genrsa 2048` → `chmod 600` → `openssl req -new -x509 -days 365 -subj "/O=.../CN=..."` → `cat key crt > server.pem` → three `openssl x509 -noout` calls (`-subject`, `-dates`, `-fingerprint -sha256`) appended to `verification.txt`. Then a heredoc Python `check_cert.py` that shells to `openssl x509` to extract CN + `notAfter`, reformats the date, and does `ssl.load_cert_chain` before printing success. Pure tooling/config, no app logic authored.

**Verifier** — pytest: `/app/ssl` dir; key perms ≤600 and "2048 bit"; cert contains CN and (case-insensitive) org and validity spans exactly 365 days; PEM contains both PRIVATE KEY and CERTIFICATE and parses; `verification.txt` has CN, org, a date (YYYY-MM-DD or OpenSSL format), and a 32-pair colon SHA-256 fingerprint; running `check_cert.py` exits 0 and prints the success line, CN, and a YYYY-MM-DD date.

**Difficulty drivers** — Low conceptual depth but many exact-format requirements: correct openssl flag combos, `-subj` DN syntax, precise 365-day validity, file permission bits, fingerprint format, and date reformatting in the Python checker. Breadth of small correct details, not hard reasoning. Junior est. 2h reflects unfamiliarity with openssl CLI.

**quanta attack points** — `container_exec` fits perfectly — each openssl/chmod step returns an exit code and the outputs are directly inspectable; no interactivity, so no `pty_*`. Main risk: subtle format mismatches (DN string, 365-day boundary, date parsing in check_cert.py) or forgetting chmod 600. The iterate-until-pass loop is strong: every requirement maps to a checkable command, so the agent converges quickly.
