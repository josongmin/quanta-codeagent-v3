# RFC: N6 — PTY/tmux session attach

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-04
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0477 (pty-attach core) · 0478 (tmux-shellout adapter) — next free after 0476.

---

## 1. 요약 (Summary)

quanta can spawn shells (`bash` one-shot, `bash`+`timeout_behavior=background`, and the
subagent `exec_command`/`write_stdin` 6-tool router), but it cannot **attach to a
pre-existing, long-lived interactive terminal session** and it has **no PTY at all** —
every "PTY" in the codebase is actually `Bun.spawn` with piped stdio (no controlling
terminal, no `isTTY`, no resize). This RFC designs **N6 — PTY/tmux session attach**: a
gated tool seam that lets the agent (1) **attach** to an existing session by id/handle,
(2) **resize** it `(cols, rows)`, (3) **stream live stdin/stdout** across turns, with
REPL continuity. This is the concrete form of the §5 roadmap "PTY process server" niche.

**Crux resolution (the dep constraint).** The premise of the task was "a real PTY needs
`node-pty` (native), and installs are blocked → frame as a seam + tmux-shellout MVP."
The audit found a **better resolution**: **Bun 1.3.14 ships a native, zero-dep PTY**
(`Bun.Terminal` + `Bun.spawn({ terminal })`) exposing `write()`, `resize(cols, rows)`,
`setRawMode()`, termios flags, and a `data` callback
(`node_modules/bun-types/bun.d.ts:7010-7046`, `:7756-7884`). So **no dep is needed for a
native PTY**. The design therefore picks a **two-adapter** model behind one port:

1. **MVP-A — tmux-via-shell-out** (Phase 1): attach to a *named tmux session* through the
   `tmux` binary (`tmux send-keys` / `capture-pane` / `resize-window`). Zero deps, zero
   native PTY, works against sessions a human/CI started outside quanta. tmux is present
   on this host (`/opt/homebrew/bin/tmux`).
2. **MVP-B — native Bun PTY** (also Phase 1-eligible, since it needs no dep): allocate a
   real controlling terminal with `Bun.Terminal`, register it in a `PtyTable`, attach by
   handle id. This *upgrades* the existing fake-PTY `exec_command({pty:true})` path to a
   real tty.

Both are **default-OFF**, gated, `risk: "exec"`, cwd-jailed, and HITL-guarded. Native
node-pty is **no longer the crux** — it is fully avoided.

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

### 2.1 Cursor 3.5.33 — `agent.v1` PTY/tmux RPC surface (verified)

Extracted from the redaction-classification map in
`.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js` (field names are
load-bearing; `SAFE`/`CODE`/`PATH` are Cursor's own privacy tags):

```
SpawnPtyRequest       { cwd: PATH, env: { key: SAFE, value: CODE } }
SpawnPtyResponse      { pty_id: SAFE }
AttachPtyRequest      { pty_id: SAFE, last_event_id: SAFE }   ← resumable stream
PtyEvent              { event_id: SAFE }                       ← monotone cursor
PtyData               { data: CODE }                          ← output chunk
SendInputRequest      { pty_id: SAFE, data: CODE }            ← live stdin
ResizePtyRequest      { pty_id: SAFE, rows: <msg>, cols: uint32 (field#4, T:13) }
PtyInfo               { pty_id: SAFE, shell: SAFE, cwd: PATH, process_args: CODE }
TerminatePtyRequest   { pty_id: SAFE }

TmuxSession           { session_id, session_name, display_name, cwd: PATH, shell, process_args }
CreateTmuxSessionRequest { session_name, display_name, cwd: PATH, env{key,value} }
AttachTmuxSessionRequest { session_id: SAFE }
AttachTmuxSessionResponse{ pty_id: SAFE }                     ← tmux→pty bridge
KillTmuxSessionRequest   { session_id: SAFE }
```

**The model Cursor uses (and we adopt):**
- A **PTY is the unit of attachment**, addressed by an opaque `pty_id`.
- **tmux is bridged INTO the pty model**: `AttachTmuxSession(session_id) → { pty_id }`.
  Once you have a `pty_id`, the *same* attach/resize/send-input/stream RPCs apply whether
  the underlying handle is a raw PTY or a tmux session. This is the key architectural
  cue: **one port, two backends.**
- **Resumable streaming**: `AttachPtyRequest.last_event_id` + monotone `PtyEvent.event_id`
  let a re-attach resume the output stream without replaying everything — essential for
  cross-turn continuity where the agent loop re-enters.
- **Resize is `(pty_id, rows, cols)`** — a first-class RPC, separate from spawn.
- **`PtyInfo`** exposes `shell` / `cwd` / `process_args` for the model to reason about what
  it is attached to (an enumeration/introspection surface).

### 2.2 Codex (codex-rs 0.135) — PTY + resize (verified)

From `.extracted_source/codex/_codex-rs-0.135-symbols.txt`:
- `openpty:` (`:8840 "failed to openpty: "`) — Codex allocates a **real** PTY via libc.
- `ProcessResizePtyParams` / `ProcessResizePtyResponse` (`:3886-4002`).
- `CommandExecResizeParams` + `CommandExecTerminalSize` (`:4154-4218`) and
  `ProcessTerminalSize` (`:5360`) — terminal size is a typed `(rows, cols)`-ish struct;
  resize is a dedicated JSON-RPC method, not a spawn arg.
- `"failed to resize PTY: "` (`:3570`) — resize is a discrete fallible operation.
- `resize_reflow.rs` (`:8672`) — Codex reflows its own TUI on size change.

**Takeaway:** Codex confirms the *real-PTY + dedicated-resize-RPC + typed terminal-size*
shape. Codex pays a native dep (`portable_pty`/libc `openpty`); **we don't have to**,
because Bun gives us `openpty` semantics with no dep.

### 2.3 Synthesis (what we absorb)

| Concept | Cursor | Codex | quanta N6 design |
|---|---|---|---|
| Unit of attach | `pty_id` | process id | opaque `handle` string |
| tmux bridge | `AttachTmuxSession→pty_id` | n/a | tmux adapter mints a `handle` |
| Resize | `ResizePtyRequest(rows,cols)` | `ProcessResizePtyParams` | `pty_resize(handle,cols,rows)` |
| Live stdin | `SendInputRequest(data)` | `write_stdin` | `pty_write(handle,data)` |
| Stream + resume | `last_event_id`/`event_id` | output_delta events | `pty_read(handle, sinceSeq)` |
| Introspect | `PtyInfo` | snapshot | `pty_list()` → handle/kind/cwd/title |

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 There is **no real PTY** anywhere. "PTY" is a misnomer for piped `Bun.spawn`.

- The subagent 6-tool layer *names* things PTY but **allocates none**. `exec_command`
  with `pty:true` simply keeps a `Bun.spawn(..., { stdin:"pipe", stdout:"pipe",
  stderr:"pipe" })` child alive in a module-scoped `PtyTable`
  (`src/subagent/handlers-6.ts:134-195`, slot type `:138-146`, spawn path `:275-340`).
  The child runs on **pipes, not a tty** — `isTTY=false`, so interactive REPLs that gate
  on a terminal (paged output, line-editing, color) behave differently than a human shell.
- `write_stdin` feeds bytes to that pipe (`src/subagent/tools-6.ts:110-126`), capped 64KB.
  The doc-comments literally say "feeds bytes to a live PTY" but it is a pipe
  (`src/subagent/agent-tools-6.ts:163-167`).
- **No resize anywhere.** `grep -rn "resize" src --include=*.ts` returns only the CLI
  *display* timeline panel (`src/apps/cli/timeline-panel.ts:88,91,319`) and a Seatbelt
  comment. There is **no** `ws_row`/`ws_col`/`cols`/`rows` resize on any spawned child.
- **No `node-pty` / `openpty` / `forkpty` import.**
  `grep -rn "node-pty\|openpty\|forkpty" src` → 0 hits.

### 3.2 The one-shot + background shell model (what exists, and its ceiling)

- `bash` tool (`src/tool/bash/index.ts:24-62`): one-shot `bash -lc`, `timeout_ms`,
  `mode:read|write` (Seatbelt wrap), and `timeout_behavior:kill|background`.
- `background` detaches into `BashBgRegistry` (`src/runtime/bash-bg-registry.ts`:
  `register` `:124-128`, `BgShellHandle` `:53`, `status running|...` `:47`), returning a
  `{ shellId }` the model later drains via `bash_await` / `bash_kill`.
- **Ceiling:** the bg registry is a *fire-and-resume one-shot*, not an interactive
  session. There is no way to (a) attach to a session quanta did **not** start, (b) keep
  a REPL warm and type into it turn after turn through a real tty, or (c) resize.

### 3.3 The §5 "PTY process server" niche — this RFC is its concrete form

This is the item the roadmap parked under §5 as a niche "PTY process server." N6 is its
concrete, default-OFF realization. It is **strictly additive**: it does not touch the
1-shot bash path or the 6-tool pipe path; it adds a new gated tool group.

---

## 4. 설계 (Design)

### 4.0 The dep-constraint resolution (the crux) — RESOLVED, no dep

| Path | Needs a dep? | Attaches to ext. sessions? | Real tty / resize? | Verdict |
|---|---|---|---|---|
| **tmux shell-out** (MVP-A) | **No** (uses `tmux` binary, present at `/opt/homebrew/bin/tmux`) | **Yes** (named tmux sessions started by anyone) | tmux owns the tty; `resize-window` works | **Phase 1 ship** |
| **Bun native PTY** (MVP-B) | **No** (`Bun.Terminal`, builtin in 1.3.14) | No (quanta-spawned only) | **Yes** — real openpty, `resize(cols,rows)`, `setRawMode` | **Phase 1 ship** |
| node-pty native | **Yes (blocked)** | n/a | yes | **Rejected — unnecessary** |

The originally-feared crux ("real PTY ⇒ native node-pty ⇒ blocked") **does not bind**:
Bun's builtin `Bun.Terminal` provides openpty-grade semantics with zero deps
(`bun.d.ts:7822-7884`: `write`, `resize(cols, rows)`, `setRawMode`, `inputFlags`/
`outputFlags` termios, `data`/`exit`/`drain` callbacks). tmux-shell-out is **still the
right MVP** for the *attach-to-existing* use case (the actual N6 ask), because a Bun
PTY can only wrap a process **quanta itself** spawned — it cannot adopt a terminal a
human or CI already has open, whereas `tmux attach`-semantics can.

**So the design is one port with two adapters**, mirroring Cursor's "tmux → pty_id":
- `TmuxAdapter` (MVP-A) — handle = `tmux:<session_name>`. Attach = verify the session
  exists; write = `send-keys`; read = `capture-pane`; resize = `resize-window`.
- `BunPtyAdapter` (MVP-B) — handle = `pty:<seq>`. Attach = look up in `PtyTable`; write =
  `terminal.write`; read = ring-buffer drained from the `data` callback; resize =
  `terminal.resize(cols, rows)`.

### 4.1 Attach model — by handle/id

An **opaque handle string** is the unit of attach (Cursor `pty_id` analogue), tagged by
backend: `tmux:<name>` or `pty:<seq>`. The agent never sees a raw pid or fd. A
`PtySessionPort` owns the registry:

```
interface PtySessionPort {
  list(): ReadonlyArray<PtyHandleInfo>          // Cursor PtyInfo / pty_list
  attach(handle: string): Promise<AttachResult> // idempotent; returns cursor seq
  write(handle: string, data: string, opts?: { appendNewline?: boolean }): Promise<void>
  read(handle: string, sinceSeq: number): Promise<{ chunks: PtyChunk[]; nextSeq: number }>
  resize(handle: string, cols: number, rows: number): Promise<void>
  detach(handle: string): Promise<void>         // stop streaming; session survives
  kill(handle: string): Promise<void>           // terminate (Cursor TerminatePty/KillTmux)
}
```

- **Idempotent attach** keyed by handle (Codex `createOrAttach` cue,
  `handlers-6.ts:8-12`): re-attaching an already-attached handle returns the current
  cursor, not an error. Cross-turn continuity falls straight out of this.
- **`sinceSeq` resumable read** = Cursor `last_event_id`/`event_id`. The agent loop
  persists the last `nextSeq` it consumed into session-state at the turn boundary and
  resumes from it next turn — no replay, no double-emit.
- **Jail + allow-list (security, see §8):** `attach`/`kill` only accept handles that are
  either (a) in quanta's own `PtyTable`, or (b) a tmux session whose name matches a
  configured allow-prefix (default `quanta-*`). Attaching an **arbitrary** foreign tmux
  session is gated behind an explicit `pty.allowForeignTmux` slot + HITL.

### 4.2 Resize `(cols, rows)`

A dedicated `pty_resize(handle, cols, rows)` op (Cursor `ResizePtyRequest`, Codex
`ProcessResizePtyParams`). Bounds-checked: `1 ≤ cols ≤ 1000`, `1 ≤ rows ≤ 1000` (reject
0 / absurd sizes that crash curses apps). Backend mapping:
- `BunPtyAdapter` → `terminal.resize(cols, rows)` (`bun.d.ts:7842`).
- `TmuxAdapter` → `tmux resize-window -t <name> -x <cols> -y <rows>`.

### 4.3 Live stdin / stdout streaming

- **stdin:** `pty_write(handle, data, appendNewline?)`. Same 64KB cap + `appendNewline`
  ergonomics already proven on `write_stdin` (`tools-6.ts:114-125`).
- **stdout:** a per-handle **ring buffer** (bounded, e.g. 256KB, head+tail like
  `capToolOutput`) drained continuously so a backend can't deadlock on a full buffer —
  reuse the `createStreamPump` pattern from `handlers-6.ts:222-261`. Each appended chunk
  gets a monotone `seq`. `pty_read(handle, sinceSeq)` returns chunks `> sinceSeq` plus
  `nextSeq`. For `TmuxAdapter`, "read" is `capture-pane -p -S -<N>` diffed against the last
  capture (tmux has no event stream, so we poll-on-read; the seq is a capture counter).

### 4.4 Lifecycle

- **attach ≠ own.** Detaching a tmux handle leaves the tmux session running (correct —
  it predates us). Detaching/closing a Bun-PTY handle we spawned **kills** it (we own it),
  honoring the existing 6-tool cleanup contract (`subagent.ts:127,164`,
  `handlers-6.ts:20-21`).
- **Cap:** reuse `MAX_PTY = 32` discipline (`handlers-6.ts:50`) as `MAX_ATTACHED`.
- **Session shutdown** drains via the same `closeAll()` idempotent teardown
  (`handlers-6.ts:183-194`).

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF)

- Config slot `pty.attach` / env `QUANTA_PTY_ATTACH` (mirrors `subagent.enable6Tools` /
  `QUANTA_SUBAGENT_6TOOLS` shape, `manifest.ts:163`). **Default-OFF on every surface**
  (it is `risk:"exec"` and touches sessions outside our spawn jail).
- Sub-slot `pty.allowForeignTmux` (default false) — see §8 security.
- Sub-slot `pty.backend` = `"tmux" | "bun" | "both"` (default `"tmux"` for the
  attach-to-existing MVP).

### 5.2 Tool(s)

A grouped tool family (Cursor's RPC set collapsed to 6 model-facing tools), all gated by
the one knob:

```
pty_list   (read-only)  — enumerate attachable handles (PtyInfo)
pty_attach (exec)       — attach by handle, return cursor seq
pty_write  (exec)       — live stdin
pty_read   (read-only)  — resumable stdout since seq
pty_resize (exec)       — (cols, rows)
pty_kill   (exec)       — terminate (only owned / allow-listed handles)
```

`pty_attach` group leader; the rest are `group:[...]` siblings — same row pattern as
`spawn_agent`'s group (`manifest.ts:159-168`).

### 5.3 Feature catalog (fc)

Add one fc entry **"pty-attach"** on the tool-access axis (the manifest), and a matching
feature-axis catalog node so the two-way drift guard
(`tests/unit/tool-surface-manifest-hellgate.test.ts`) stays green — recall that guard
caught `apply_patch_structured` as an fc-orphan. Every new tool name MUST get a manifest
row or CI fails (`manifest.ts:13-21`).

### 5.4 Manifest row (risk: exec)

```ts
{
  name: "pty_attach",
  group: ["pty_list", "pty_write", "pty_read", "pty_resize", "pty_kill"],
  origin: "@/tool/pty",
  gate: { kind: "config-slot", slot: "pty.attach", env: "QUANTA_PTY_ATTACH" },
  default: {},                       // OFF on every surface (no key ⇒ opt-in everywhere)
  risk: "exec",
  adr: "0477",
  note: "Attach to a long-lived PTY / named tmux session (resize + live stdio across turns). " +
        "Default-OFF (exec risk, touches sessions outside the spawn jail). tmux-shellout MVP; " +
        "Bun native PTY backend opt-in. Foreign-tmux attach behind pty.allowForeignTmux + HITL.",
}
```

`pty_list`/`pty_read` are `read-only`; the four mutating ops are `exec`. Dangerous
writes (e.g. `pty_write` of `rm -rf` into an attached shell) flow through the **existing**
command-shape HITL classifier the way `exec_command` already does
(`manifest.ts:167` "dangerous cmds hit HITL").

### 5.5 Slice / fence (where it lives)

- New slice `src/tool/pty/` — contracts (zod schemas, import only `zod` like
  `tools-6.ts:17-20`) + `PtySessionPort` interface + the two adapters
  (`tmux-adapter.ts`, `bun-pty-adapter.ts`) + a module-scoped `PtyTable` (lift/share the
  `handlers-6.ts:151-195` table shape).
- The cwd-jail port + HITL come **injected** (closed-port DI), exactly like
  `handlers-6.ts`'s `CwdJailPort` (`:208-213`) — the slice imports no `@/agent`,
  `@/storage`, or `@/security` code; the composition root wires real impls.
- Tool registration sits behind the gate in the assembler (`@/host/runtime/
  agent-config-assembler` maybeWire slot) + CLI seed (`seedEnvVarsForSurface`), the same
  two sites every gated tool uses.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, backend-agnostic via a Fake adapter)

A `FakePtyBackend` implementing `PtySessionPort` over an in-memory scripted terminal lets
hellgate run with **no real tmux/process** (deterministic, CI-safe):
- **attach idempotency:** attach×2 same handle → same cursor, no error.
- **resumable read:** write A,B,C; `read(since:0)`→ABC,nextSeq=3; `read(since:2)`→C only;
  no double-emit (the Cursor `last_event_id` invariant).
- **resize bounds:** `(0,0)`, `(−1,40)`, `(99999,99999)` → rejected typed error; `(80,24)`
  ok. Verify the backend receives the exact `(cols,rows)`.
- **write caps:** 64KB+1 rejected; `appendNewline` appends exactly one `\n`.
- **handle jail:** `attach("tmux:somebody-elses-prod")` with `allowForeignTmux=false` →
  fail-closed `cause:"foreign_tmux_denied"`; with the slot true → routes to HITL.
- **cap:** `MAX_ATTACHED+1` attach → `cause:"pty_cap"` (mirror `handlers-6.ts:307`).
- **lifecycle:** detach tmux handle → session still `list`-visible; kill owned bun handle
  → gone + child reaped; `closeAll()` idempotent (call twice).
- **default-OFF:** with `QUANTA_PTY_ATTACH` unset, none of the 6 tools register
  (assert against the real assembler).

### 6.2 Lifecycle / leak

- Spawn N bun-PTY handles, `closeAll()`, assert 0 live children (no orphans — the
  `subagent.ts:164` "tear down PTY children FIRST" invariant).
- Drain-without-read: write 1MB to a handle nobody reads → ring buffer stays bounded
  (head+tail truncation), no unbounded memory.

### 6.3 e2e (tmux-gated — skip if `which tmux` fails)

Guarded by a `tmux`-present probe (it IS present here):
1. `tmux new-session -d -s quanta-e2e 'cat'` (a REPL-ish process).
2. `pty_list()` → contains `tmux:quanta-e2e`.
3. `pty_attach` → `pty_write("hello\n")` → `pty_read` shows `hello` echoed.
4. `pty_resize(120,40)` → `tmux display -p '#{window_width}'` == 120.
5. `pty_kill` → session gone.

Live tmux e2e runs only where the binary exists (matches the smoke-fixture tier-1/live
split); CI default path is the Fake adapter hellgate.

---

## 7. 단계 (Phasing)

- **Phase 1 — tmux-shellout MVP (no dep, the N6 ask).** `src/tool/pty/` slice +
  `TmuxAdapter` + 6 gated tools + manifest/fc rows + Fake-adapter hellgate + tmux e2e
  (gated). Default-OFF. **This is the shippable unit** and directly satisfies
  "attach to an existing session."
- **Phase 1b — Bun native PTY backend (also no dep).** Add `BunPtyAdapter` over
  `Bun.Terminal`; upgrade the §3.1 fake-PTY `exec_command({pty:true})` to optionally mint
  a *real* tty handle that `pty_*` tools can then attach/resize. Opt-in via `pty.backend`.
- **Phase 2 — native node-pty (only if a dep is ever allowed).** Pure substitution behind
  the same `PtySessionPort` for platforms/edge-cases Bun's terminal doesn't cover
  (currently none identified; Bun covers macOS+Linux POSIX). **Likely never needed** —
  documented for completeness, not planned.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **The no-dep constraint (was the crux) — RESOLVED.** Both MVPs need **zero** new deps:
  tmux is an external binary already on the host, and Bun's PTY is builtin. node-pty is
  avoided entirely. If a future Bun release dropped `Bun.Terminal`, MVP-A (tmux) still
  stands alone, so we are not single-sourced on the Bun API.
- **Security of attaching arbitrary sessions (primary risk).** Attaching a foreign tmux
  session = injecting keystrokes into a terminal the user may have privileged/auth state
  in. Mitigation, fail-closed by default:
  - allow-prefix (`quanta-*`) on tmux session names; foreign attach gated behind
    `pty.allowForeignTmux` **and** per-attach HITL.
  - `pty_write` content runs through the existing dangerous-command HITL classifier
    (`manifest.ts:167`) — typing `rm -rf /` into an attached shell prompts.
  - cwd-jail port injected for any *spawn* path (Bun PTY) exactly as `handlers-6.ts:208`.
- **tmux capture-pane is poll-based, not an event stream.** Unlike Cursor's `PtyEvent`
  push, tmux gives us snapshots. We model `seq` as a capture counter and diff captures.
  Risk: bursty output between polls can be missed if scrollback overflows; mitigation =
  bounded scrollback + read-on-demand + documenting tmux as "snapshot fidelity," Bun PTY
  as "byte-exact stream fidelity."
- **Resource/lifecycle.** `MAX_ATTACHED` cap + bounded per-handle ring buffer + idempotent
  `closeAll()` on session shutdown (reuse `handlers-6.ts` discipline). Detach-vs-kill
  ownership rule prevents both orphaned children and accidentally killing a human's tmux.
- **Alternative considered & rejected — extend `bash_await`/bg-registry into interactivity.**
  The bg registry is a one-shot resume primitive (`bash-bg-registry.ts`), not a tty; bolting
  resize + bidirectional streaming onto it would muddy a clean abstraction. A dedicated
  `pty` slice keeps the fence clean (the SOLID/slice-fence posture this codebase enforces).
- **Alternative — reuse the 6-tool `exec_command({pty:true})` path directly.** Rejected for
  Phase 1 because that path can't attach to *existing* sessions (its whole premise is "I
  spawned this child"). Phase 1b *upgrades* it to a real tty, which is the natural merge
  point, but the attach-to-existing capability is tmux's alone.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented):**
- `src/tool/pty/` — new slice:
  - `contracts.ts` — zod schemas (imports only `zod`).
  - `port.ts` — `PtySessionPort`, `PtyHandleInfo`, `PtyChunk`.
  - `tmux-adapter.ts` — MVP-A (`tmux send-keys/capture-pane/resize-window`).
  - `bun-pty-adapter.ts` — Phase 1b (`Bun.Terminal`).
  - `table.ts` — `PtyTable` / `MAX_ATTACHED` (lifted from `handlers-6.ts:151-195`).
  - `tools.ts` — the 6 gated tools.
- `docs/decisions/0477-pty-attach.md` (core) + `0478-tmux-shellout-adapter.md`.

**Touched (gate-wiring only):**
- `src/tool/surface/manifest.ts` — new `pty_attach` group row (§5.4).
- feature-catalog node + `tests/unit/tool-surface-manifest-hellgate.test.ts` (drift guard).
- `@/host/runtime/agent-config-assembler` (maybeWire slot) + CLI `seedEnvVarsForSurface`.
- new `tests/.../pty-attach.hellgate.test.ts` + gated tmux e2e.

**Audited ground truth (cited, NOT modified):**
- `src/subagent/handlers-6.ts:134-340` — the *fake* PTY (`Bun.spawn` pipes, no tty).
- `src/subagent/tools-6.ts:53-126` — `exec_command`/`write_stdin` contracts.
- `src/tool/bash/index.ts:24-62` + `src/runtime/bash-bg-registry.ts` — one-shot + bg shell.
- `node_modules/bun-types/bun.d.ts:7010-7046, 7756-7884` — **Bun native PTY (no-dep crux resolution).**
- `.extracted_source/cursor/.../cursor-agent-exec/dist/main.js` — Cursor PTY/tmux RPC surface.
- `.extracted_source/codex/_codex-rs-0.135-symbols.txt:3570-5361, 8840` — Codex openpty + resize.
