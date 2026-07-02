---
task: vulnerable-secret
category: security
difficulty: medium
tags: [security, file-operations]
expert_min: 20
junior_min: 120
skill_class: ADVERSARIAL-SEC
terminal_native: med
docker_image: alexgshaw/vulnerable-secret:20251031
---

# vulnerable-secret

**Goal** — A C executable (`/app/vulnerable`, source `vulnerable.c` in env) hides a secret in `FLAG{...}` format. Interact with the binary to extract the flag and write it to `/app/results.txt`. Expected flag: `FLAG{b4ff3r_0v3rfl0w_m4st3r_k3y_2024}`.

**Solution shape** — `solve.sh` demonstrates a classic stack buffer-overflow: probes normal input, then builds a payload of 64 `'A'` bytes + `\x01\x00\x00\x00` (little-endian) to overwrite an adjacent `authenticated` flag, pipes it into `./vulnerable`, greps the `Secret:` line from output, and writes it to `/app/results.txt`. Small shell + inline python payload gen.

**Verifier** — pytest: `/app/results.txt` exists, its stripped content EXACTLY equals `FLAG{b4ff3r_0v3rfl0w_m4st3r_k3y_2024}`, and format checks (`FLAG{`…`}`, len>10). reward 0/1.

**Difficulty drivers** — Requires binary-exploitation reasoning: read/reverse the C to find the vulnerable `gets`/buffer + adjacent auth variable, compute the exact overflow offset (64 bytes here), and construct a byte payload with correct endianness to flip the auth gate. Modest — source is provided and the overflow is textbook — but demands the overflow mental model. Env has the compiled binary + gcc.

**quanta attack points** — `container_exec` to inspect `vulnerable.c` / `objdump` / `strings` and pipe crafted payloads (non-interactive stdin is fine — the solution just `echo -n "$payload" | ./vulnerable`). No TUI, so `pty_*` unnecessary. The exit-code loop helps once the agent scripts payload→run→grep and iterates offsets; the flag string is in the binary so `strings` alone could shortcut it. Main risk: wrong overflow offset/endianness, or reading a decoy `strings` match instead of the auth-gated `Secret:` output.
