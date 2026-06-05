# ADR-0486: PTY / tmux session attach — a gated, port-inverted attach-to-existing-terminal slice (N6)

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0471 (untrusted-source envelope — `pty_read` output is host-process content; this slice mirrors the same "third-party DATA into the transcript" posture for foreign panes, though it is NOT `deriveProvenance→mcp`)
  - HARD_DENY denylist (the `bash` `command`-shape policy corpus — `pty_write` re-uses it verbatim via `extractShellCommand`, so an attached shell is not a denylist-evading exec channel)
  - The gated-port composition pattern of the sibling slices (`imageGen` / `officeAuthoring` / `progressUpdate`) — N6 is the 4th port the round-3 activation hellgate pins.
- **참조**:
  - `src/tool/pty/port.ts` — the closed `PtySessionPort` (6 NO-THROW methods: `list`/`attach`/`write`/`read`/`resize`/`detach`/`kill`), the tagged-handle type (`tmux:<name>` | `pty:<seq>`), the `PtyResult<T>` envelope + closed `PtyErrorCode`, and the uniform caps (`PTY_MAX_WRITE_BYTES` 64 KiB, `PTY_MAX_ATTACHED` 32, `PTY_RING_BYTES` 256 KiB, `PTY_MIN_DIM`/`PTY_MAX_DIM` 1..1000).
  - `src/tool/pty/tools.ts` — `ptyTools(port) → Tool[]` (the 6 model-facing tools), the surrogate-safe `capOutput` head+tail truncation (`PTY_MAX_READ_OUTPUT` 32 KiB), the `fromPort` NO-THROW boundary, and `pty_write`'s `extractShellCommand` HARD_DENY hook.
  - `src/tool/pty/tmux-adapter.ts` — `createTmuxAdapter(opts) → PtySessionPort` (MVP-A) over an injected `TmuxExec`; the `allowPrefix` jail, `capture-pane` poll+diff into a monotone seq, the out-of-order-capture no-op guard, and the bounded `lastCapture` map.
  - `src/tool/pty/index.ts` — `@/tool/pty` barrel (port types + `createTmuxAdapter` + `ptyTools`).
  - `src/tool/index.ts` — `DefaultToolPorts.ptySession?: PtySessionPort` slot + the conditional `if (ports.ptySession !== undefined) base.push(...ptyTools(...))` registration.
  - `src/host/runtime/pty-backend.ts` — composition-root backend: `bunTmuxExec()` (`Bun.spawn(["tmux", …])`, argv-array/no-shell, NO-THROW) + `buildTmuxPtyBackend()`.
  - `src/host/runtime/agent-arg-builder.ts` — the gate: `...(cfg.ptyAttach ? { ptySession: buildTmuxPtyBackend() } : {})`.
  - `src/tool/surface/manifest.ts` — the SSOT tool-surface entry (`pty_attach` + group, `config-slot` gate on `DefaultToolPorts.ptySession` / `QUANTA_PTY_ATTACH`, `risk: "exec"`, opt-in on every surface).
  - `src/shared/runtime-config.ts` — `ptyAttach: env["QUANTA_PTY_ATTACH"] === "1"` (strict opt-in knob).
  - Tests: `tests/unit/pty-attach-hellgate.test.ts` (slice + tmux-adapter), `tests/unit/composition-root-gated-port-activation-r3-hellgate.test.ts` (the N6 `describe` — knob-on/off byte-identity + dispatch activation).
  - Feature catalog: `tools/feature-catalog/features/09-integration/n6-pty-attach.yaml`.

## 맥락

quanta could spawn shells — the one-shot `bash` tool, `bash` background mode, and the subagent 6-tool pipe router — but had **no real PTY** and could not attach to a pre-existing, long-lived interactive terminal. A REPL, a dev server, an `ssh` session, or a `tmux` window that a human or CI started **outside** quanta is exactly the kind of process an agent needs to drive across turns: write to its stdin, read its live stdout incrementally, resize its window, and (only when it owns or is allow-listed for it) terminate it. One-shot `bash` cannot model this — it spawns, runs to completion, and returns; there is no persistent handle, no resumable output cursor, no resize, and no way to reach a session quanta did not spawn.

The dependency crux that historically blocked this — `node-pty` is a native addon with a build toolchain — is sidestepped: **tmux** is an external binary already on the host (drive it via `send-keys` / `capture-pane` / `resize-window`), and Bun 1.3.14 ships a native PTY (`Bun.Terminal`) for a future real-tty backend. Zero new deps. This is the Codex PTY process-server absorption (its "tmux → pty_id" attach cue), reshaped onto quanta's closed-port + default-OFF discipline rather than a long-running daemon.

The danger is the inverse of the benefit: an attached terminal is a **live shell-input channel** to a session that may live **outside the spawn jail**. Surfacing it naively would be a denylist-evading exec channel and an unbounded transcript/resource sink. So the design is gated, fail-closed, and port-inverted from the start.

## 결정

A single closed `PtySessionPort` (`src/tool/pty/port.ts`) over **one** attach model with **two** backends, fronted by **6** thin model-facing tools, registered **only** when the composition root wires a backend behind the `QUANTA_PTY_ATTACH` knob.

**Port inversion (`PtySessionPort`).** One opaque tagged handle (`tmux:<name>` or `pty:<seq>`) and one set of ops — `list` / `attach` / `write` / `read` / `resize` / `detach` / `kill` — apply regardless of backend. Every method is **NO-THROW**: it resolves a typed `PtyResult<T>` (`{ ok:true, value }` or `{ ok:false, code, message }`) where `code` is a **closed** `PtyErrorCode` (`not-found` / `foreign-denied` / `cap-exceeded` / `invalid-size` / `too-large` / `backend-error`). The slice imports only `zod` (contracts) + itself; the real tmux/Bun backends, the cwd-jail, and HITL are **injected**, so `@/tool/pty` is fence-clean and fully testable over a Fake backend with no real process or tmux.

**The tmux adapter (`createTmuxAdapter`, MVP-A).** Attaches to **named** tmux sessions through an injected `TmuxExec` (`run(args) → { ok, stdout }`) — the shell-out itself is NOT in the slice. WHY the design choices:

- **`capture-pane` poll + diff.** tmux has no event stream, so `read` captures the pane and diffs it against the per-handle `lastCapture` snapshot into a single monotone `seq` chunk (first capture = whole text; grown capture = appended tail only; unchanged = no chunk). This synthesizes the resumable cursor over a stateless binary.
- **Out-of-order-capture no-op guard.** Two concurrent `read`s both `await` `capture-pane` and can resolve out of order; the state read runs after the await. If a capture is **not** a forward move (equal text, or the stored text already extends ours) the adapter treats it as a no-op — keeps the at-least-as-new snapshot and emits nothing — so a stale capture can never **rewind** the cursor and re-emit consumed output.
- **`send-keys -l -- data`.** `-l` is literal (no key-name interpretation); `--` stops tmux from flag-parsing model `data` that begins with `-` (arg-injection into tmux's own argv — there is no shell, args are an array, but tmux still parses options). A submit is a **separate** explicit `Enter` key, so `appendNewline` can never be smuggled into the payload.

**The 6 tools (`ptyTools`).** Thin NO-THROW wrappers over the injected port. `pty_list` / `pty_read` are **read-only** + concurrency-safe; `pty_attach` / `pty_write` / `pty_resize` / `pty_kill` are **exec-risk** + not concurrency-safe. WHY the non-trivial bits:

- **`pty_write.extractShellCommand = (input) => input.data`** (the security crux). `pty_write` feeds bytes straight into a live shell's stdin — equivalent to `bash`'s `command`. Surfacing `data` lets the dispatch seam populate `ToolAction.shellCommand`, so the policy's **HARD_DENY** corpus (`rm -rf /`, `curl|sh`, fork-bombs…) screens the typed bytes through the **same** denylist as `bash` — including in bypass mode, where HARD_DENY still wins. The submit newline is irrelevant to the verdict: the payload is what runs.
- **`capOutput` (surrogate-safe head+tail truncation).** A 200 KiB scrolled pane must not explode the transcript, so a `pty_read` payload is capped to `PTY_MAX_READ_OUTPUT` (32 KiB) head+tail with a `… [N chars truncated] …` marker. The cut points snap off a UTF-16 surrogate boundary (`sliceHeadWhole`/`sliceTailWhole`) so a naive `slice` can never emit a **lone surrogate** that re-encodes to U+FFFD — mirroring Codex's Rust `String::from_utf8_lossy` well-formed guarantee.
- The 64 KiB write cap is enforced in the tool **before** the backend is reached (`Buffer.byteLength` check → `too_large`), and `fromPort` maps any thrown rejection from a misbehaving backend to a single typed `error` result so the dispatch loop can never reject.

**Composition-root backend (`pty-backend.ts`).** `bunTmuxExec()` wraps the only effect — `Bun.spawn(["tmux", ...args])` — in argv-array (no shell), captures stdout, and NEVER throws: a missing `tmux` binary or non-zero exit yields `{ ok:false, stdout:"" }`, which the adapter turns into a typed `backend-error` / `not-found`. `buildTmuxPtyBackend()` constructs the adapter at the security default (`allowPrefix: "quanta-"`, foreign denied) — a host that wants foreign sessions opts in behind its own HITL, not here. Construction is IO-free (no spawn until a tool dispatches).

**The SSOT manifest gate + the knob.** The single source of truth for whether the model can see these tools is `src/tool/surface/manifest.ts`: the `pty_attach` entry (with its `group` of the other 5) declares a `config-slot` gate on `DefaultToolPorts.ptySession` / `QUANTA_PTY_ATTACH`, `risk: "exec"`, and `opt-in` on **every** surface (cli/bench/web/ide/headless) — it never auto-seeds. `src/shared/runtime-config.ts` parses the knob strictly: `ptyAttach: env["QUANTA_PTY_ATTACH"] === "1"`. The actual wire is one line in `agent-arg-builder.ts`: `...(cfg.ptyAttach ? { ptySession: buildTmuxPtyBackend() } : {})`, and `buildDefaultTools` appends `ptyTools(ports.ptySession)` only when the slot is present.

**Default-OFF / byte-identical.** Knob unset ⇒ no port ⇒ the 6 `pty_*` tools are **not** registered ⇒ the tool menu is byte-identical to the pre-N6 default. The gate is purely additive.

## 결과

- The agent can now attach to a long-lived interactive terminal it did not spawn — write stdin, read resumable stdout across turns, resize, and (only for owned / allow-listed handles) kill — closing the "no real PTY / can't attach to an existing session" gap, with zero new dependencies.
- A foreign tmux session is **fail-closed**: denied with `foreign-denied` **before** tmux is ever touched, unless a host explicitly opts in (`allowForeign`) behind its own HITL.
- An attached shell is **not** a denylist-evading exec channel: `pty_write` content flows through the exact same HARD_DENY corpus as `bash`.
- The `@/tool/pty` slice stays fence-clean and CI-safe: every hellgate runs over a Fake `PtySessionPort` / fake `TmuxExec` with no real tmux or process.
- The round-3 composition-root activation hellgate pins that `QUANTA_PTY_ATTACH=1` actually populates the slot through the **real** `buildBaseFromArgs`, and that a dispatch reaches the **production** tmux gate (foreign-name ⇒ typed `foreign-denied`, no crash, no `tmux` binary required) — not a faked seam.

## Trade-offs / Negative invariants

- **Port-inversion fence (hard).** `@/tool/pty` imports only `zod` + itself; the spawn (`Bun.spawn`) lives in `pty-backend.ts` at the composition layer. If the slice ever reaches for a process global or a concrete tmux/Bun call, the fence is broken — the adapter must remain drivable over an injected `TmuxExec`. (Hellgate: every tmux-adapter case scripts a fake `TmuxExec` and asserts on its recorded `calls`.)
- **Surface-manifest SSOT gating.** The model's visibility of `pty_*` is decided **only** by the manifest `config-slot` gate + the knob. The composition-root hellgate's byte-identity arm (`OFF ⇒ pty_* ABSENT, set byte-identical to baseline`) is the ratchet: any path that registers a pty tool without the slot present is a regression.
- **Default-OFF byte-identical (hard).** No knob ⇒ no port ⇒ no tools, byte-for-byte the pre-N6 menu. The gate can only **add** tools when opted in; it can never change the default surface.
- **Fail-closed allow-prefix jail.** Only `quanta-`-prefixed sessions are attachable/killable; a foreign handle returns `foreign-denied` **without** a single tmux call (`t.calls.length === 0` in the hellgate). `allowForeign` is the **only** override, and it lives behind the host's HITL, not in the slice default.
- **HARD_DENY parity for `pty_write`.** `extractShellCommand` is load-bearing: drop it and the typed bytes bypass the `bash` denylist. The submit newline does not change the verdict — the payload is what runs.
- **Resource / lifecycle safety (mined from hellgate).** (1) 64 KiB write cap rejected **before** the backend (`fake.writes.length === 0`). (2) Resize bounds 1..1000 reject 0 / negative / absurd **pre-exec** (`t.calls.length === 0`). (3) `pty_read` head+tail caps a 200 KiB pane under 80 KiB with a truncation marker, surrogate-safe. (4) `lastCapture` is bounded at `maxAttached` (default `PTY_MAX_ATTACHED` 32, clamped ≥1): a `read` admitting a **new** handle past the cap is `cap-exceeded`; detach/kill free a slot — so a long session reading many distinct handles cannot grow the map without limit. (5) `detach` is a deliberate no-op on session liveness — a tmux session **predates** us and **survives** detach; only `kill` (owned / allow-listed) terminates.
- **Resumable-cursor monotonicity (the `last_event_id` invariant).** `read(sinceSeq)` never double-emits and a non-advancing capture never rewinds the cursor — the out-of-order-capture no-op guard is the subtle fence the concurrency hellgate exists to protect.
- **Deferred (documented, not faked).** The Bun-native `bun-pty-adapter` (Phase-1b real tty) and a live `which tmux`-gated e2e are explicitly out of scope; the slice is structured so adding the Bun backend is a new `PtySessionPort` impl behind the same port, requiring no tool or manifest change.
