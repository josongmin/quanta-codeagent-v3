# RFC: N6 Phase-1b — Bun-native PTY backend (owned PTYs)

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADR: 0479 (bun-native-pty-backend) — sibling of 0477/0478 (the N6 core + tmux adapter).
> Predecessor RFC: `docs/plans/jun-4-pty-attach.md` (the N6 port + tmux MVP — **LANDED**).

---

## 1. 요약 (Summary)

The N6 PTY/tmux attach seam shipped its **tmux backend** (`docs/plans/jun-4-pty-attach.md`
Phase-1). The closed `PtySessionPort` (`src/tool/pty/port.ts:69-84`), the 6 gated `pty_*`
tools (`src/tool/pty/tools.ts:143`), the `createTmuxAdapter` (`src/tool/pty/tmux-adapter.ts:74`),
and the composition-root `buildTmuxPtyBackend` (`src/host/runtime/pty-backend.ts:51`) are
**all live**, default-OFF behind `QUANTA_PTY_ATTACH`. But the RFC's *Phase-1b* — a **Bun
native PTY backend** — was deferred. Today the only `PtySessionPort` impl is tmux-shell-out,
which can only **attach to sessions a human/CI started outside quanta**; quanta cannot
mint a *real tty* for a process **it itself spawns**. Every quanta-spawned "PTY" is still a
piped `Bun.spawn` (`isTTY=false` — the §3 fake-PTY).

This RFC designs **`createBunPtyAdapter`** — a second `PtySessionPort` implementation over
`Bun.Terminal` + `Bun.spawn({ terminal })` (zero-dep, Bun 1.3.14 native PTY,
verified present in `node_modules/bun-types/bun.d.ts:7822-7902`, host runs Bun 1.3.14).
It serves the **owned-PTY** case: sessions quanta spawns get a *real controlling terminal*
(`isTTY=true`, real `resize`, real `setRawMode`, termios flags), addressed by the SAME
`pty:<seq>` handle model the port already declares. The security posture inverts the tmux
adapter's: **owned ⇒ no foreign-jail needed** (quanta spawned it under its own cwd/argv;
there is no "attach to someone else's privileged terminal" risk), so the `foreign-denied`
gate that dominates the tmux adapter simply does not apply.

It is **strictly additive**: the port contract is unchanged, the tmux adapter is untouched,
and a new `pty.backend` selector (default `"tmux"`) keeps the live default byte-identical.

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

The competitor shape was already extracted in the predecessor RFC
(`docs/plans/jun-4-pty-attach.md` §2). The load-bearing cue for *this* phase:

### 2.1 Cursor 3.5.33 — spawn-owned vs attach-foreign are distinct RPCs

`.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js`:

```
SpawnPtyRequest    { cwd: PATH, env:{key,value} }  →  SpawnPtyResponse { pty_id }   ← OWNED
AttachTmuxSession  { session_id }                  →  { pty_id }                     ← FOREIGN→pty
```

Cursor **spawns** a pty (owns it, knows its cwd/env/argv) on a different RPC from how it
**bridges a foreign tmux session** into a `pty_id`. Once spawned, the SAME
`SendInput`/`ResizePty`/`AttachPty(last_event_id)` ops apply — i.e. **one port, two
provenances**. This RFC's `createBunPtyAdapter` is exactly the `SpawnPty` half quanta is
missing: tmux is the foreign half (already landed), Bun PTY is the owned half.

### 2.2 Codex (codex-rs 0.135) — owned PTY is a real `openpty`

`.extracted_source/codex/_codex-rs-0.135-symbols.txt`: `openpty:` (`:8840`),
`ProcessResizePtyParams` (`:3886`), `ProcessTerminalSize` (`:5360`). Codex's owned PTY is a
real libc `openpty` with `(rows, cols)` resize — it pays a native dep (`portable_pty`).
**We don't:** `Bun.Terminal` gives `openpty`-grade semantics with zero deps
(`bun.d.ts:7822` `class Terminal` — `write` `:7835`, `resize(cols,rows)` `:7842`,
`setRawMode` `:7849`, termios `inputFlags/outputFlags/localFlags/controlFlags`
`:7877-7901`, `data`/`exit`/`drain` callbacks `:7780-7794`).

### 2.3 Synthesis (what Phase-1b absorbs)

| Concept | Cursor | Codex | quanta Bun adapter |
|---|---|---|---|
| Owned spawn | `SpawnPty(cwd,env)` | `openpty` + spawn | `Bun.spawn(argv, { terminal })` |
| Real tty | yes | yes (`openpty`) | yes (`Bun.Terminal`, `isTTY` true) |
| Resize | `ResizePty(rows,cols)` | `ProcessResizePtyParams` | `terminal.resize(cols, rows)` (`:7842`) |
| Live stdin | `SendInput(data)` | `write_stdin` | `terminal.write(data)` (`:7835`) |
| Stream + cursor | `last_event_id`/`event_id` | output_delta | ring buffer drained from `data` cb → monotone `seq` |
| Dep cost | bundled | native | **zero** |

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 The N6 port + tmux backend are **LANDED** (predecessor RFC shipped)

- `PtySessionPort` — `src/tool/pty/port.ts:69-84`: `list / attach / write / read / resize /
  detach / kill`, all NO-THROW (`PtyResult<T>`, `:59-61`). Caps declared:
  `PTY_MAX_WRITE_BYTES=64Ki` (`:87`), `PTY_MAX_ATTACHED=32` (`:88`),
  `PTY_RING_BYTES=256Ki` (`:89`), `PTY_MIN_DIM=1` / `PTY_MAX_DIM=1000` (`:90-91`).
- Handle model — `PtyHandle = "tmux:<name>" | "pty:<seq>"` (`port.ts:16-19`),
  `PtyBackendKind = "tmux" | "bun"` (`:19`), `PtyHandleInfo.owned: boolean` (`:29`),
  `PtyHandleInfo.kind` (`:23`). **The `"bun"` backend kind + `pty:<seq>` handle prefix +
  `owned` flag are ALREADY in the contract** — they were reserved for this phase. No type
  change is needed to add the Bun adapter.
- tmux adapter — `createTmuxAdapter` (`src/tool/pty/tmux-adapter.ts:74`); the foreign-jail
  gate (`allowForeign` default false, `allowPrefix` default `"quanta-"`,
  `foreign-denied`) is the adapter's dominant security concern (`:88-97`).
- 6 gated tools — `ptyTools(port)` (`src/tool/pty/tools.ts:143`).
- Composition root — `buildTmuxPtyBackend()` (`src/host/runtime/pty-backend.ts:51`),
  wired only when `cfg.ptyAttach` is true (`src/host/runtime/agent-arg-builder.ts:622`:
  `...(cfg.ptyAttach ? { ptySession: buildTmuxPtyBackend() } : {})`).
- Knob — `runtimeConfig().ptyAttach` ← `QUANTA_PTY_ATTACH==="1"`
  (`src/shared/runtime-config.ts:339,658`). Manifest row + 597-char note already cite **both**
  backends as the intended end-state (`src/tool/surface/manifest.ts:586-597`: *"Two zero-dep
  backends behind one PtySessionPort: tmux shell-out … and Bun native PTY (Bun.Terminal —
  real tty/resize)"*).

### 3.2 The Bun PTY backend is **NOT IMPLEMENTED** — only tmux exists

- `grep -rn "Bun.Terminal\|bunPty\|BunPtyAdapter\|createBunPtyAdapter\|bun-pty" src` → **0
  hits**. The `bun-pty-adapter.ts` file the predecessor RFC §9 named does not exist
  (`ls src/tool/pty/` → `index.ts port.ts tmux-adapter.ts tools.ts` only).
- The Bun PTY type IS available: `node_modules/bun-types/bun.d.ts:7046` (`terminal?:
  TerminalOptions | Terminal` on `SpawnOptions`), `:7177` (`Subprocess.terminal`),
  `:7822-7902` (`class Terminal`). Host Bun = 1.3.14 (`bun --version`).
- The §3.1 *fake* PTY still stands for the owned case: the subagent 6-tool layer keeps a
  piped `Bun.spawn` (`stdin/stdout/stderr:"pipe"`) alive and *calls it* PTY
  (predecessor RFC §3.1, `src/subagent/handlers-6.ts`). `isTTY=false` there — no real tty,
  no resize. This is the exact gap the Bun adapter closes for quanta-spawned processes.

### 3.3 Verdict — **NOT superseded.** Honest gap: owned-PTY backend is absent.

The port reserved the `bun`/`pty:` slots; nothing fills them. The tmux adapter cannot mint
a tty for an owned process (its whole premise is "the session already exists"). This RFC is
the second of the two backends the manifest note promised.

---

## 4. 설계 (Design)

### 4.0 Mirror the existing port contract EXACTLY (no contract change)

`createBunPtyAdapter` returns a `PtySessionPort` (`port.ts:69-84`) — same 7 methods, same
NO-THROW `PtyResult<T>`, same caps constants. **No new method, no new error code, no new
handle shape.** The only additive surface is the spawn entry point (how an owned handle is
born), which is NOT a port method (the tmux adapter likewise mints handles outside the port —
its handles pre-exist; ours are spawned). The spawn op lives on the adapter's *concrete*
type, called by the composition root / a future `pty_spawn` tool, not by the 6 attach tools.

```ts
// concrete adapter type (superset of PtySessionPort) — the port methods are identical
export interface BunPtyAdapter extends PtySessionPort {
  /** Spawn an OWNED process under a real tty. Returns its `pty:<seq>` handle.
   *  NOT a PtySessionPort method (handles are minted here, then attached via the
   *  port like any other). NO-THROW: a spawn failure → PtyResult err. */
  spawn(argv: readonly string[], opts: BunPtySpawnOpts): Promise<PtyResult<AttachResult>>
}
export interface BunPtySpawnOpts {
  readonly cwd: string                 // cwd-jail port resolves/validates this (DI, §4.4)
  readonly env?: Readonly<Record<string, string>>
  readonly cols?: number               // default 80 (Bun TerminalOptions default)
  readonly rows?: number               // default 24
}
```

### 4.1 Spawn-owned vs attach-foreign — the security inversion

| | tmux adapter (foreign) | Bun adapter (owned) |
|---|---|---|
| Provenance | session pre-exists (human/CI) | quanta `Bun.spawn`-ed it |
| `owned` flag | `false` (`tmux-adapter.ts:108`) | **`true`** |
| Primary risk | injecting keystrokes into someone's privileged terminal | none beyond the cwd-jail the spawn already passed |
| Gate | `foreign-denied` allow-prefix (`tmux-adapter.ts:88-97`) | **N/A** — there is no foreign session to deny |
| `kill` semantics | refuse foreign (only allow-listed) | always allowed (we own the child) |
| `detach` semantics | session SURVIVES (predates us) | session survives detach; `kill` reaps the child |

The crux: **the tmux adapter's dominant gate (`foreign-denied`) is simply absent in the Bun
adapter, because an owned PTY has no foreign provenance.** The Bun adapter's only trust
boundary is the **cwd-jail at spawn time** (the same chokepoint `Bun.spawn` already passes
in the rest of the codebase) — once a process is spawned under the jail, attaching/writing/
resizing it is no riskier than the existing 6-tool `write_stdin`. There is no widen here: the
Bun adapter is strictly *less* privileged than the tmux one (it cannot reach outside what
quanta spawned).

### 4.2 Ring-buffer output (the `data` callback → monotone seq)

`Bun.Terminal` pushes output via the `data(terminal, data: Uint8Array)` callback
(`bun.d.ts:7780`) — a real **event stream** (unlike tmux's poll-on-`capture-pane`, which the
tmux adapter diffs into a seq, `tmux-adapter.ts:82-86`). The Bun adapter drains it
continuously into a **bounded ring buffer** (`PTY_RING_BYTES=256Ki`, `port.ts:89`):

```
new Bun.Terminal({ cols, rows, data: (_t, bytes) => ring.push(decode(bytes)) })
```

- Each appended chunk gets a monotone `seq` (a counter, NOT the byte offset). `read(handle,
  sinceSeq)` returns chunks `> sinceSeq` plus `nextSeq` — satisfies the port's `ReadResult`
  (`port.ts:44-48`) and Cursor's `last_event_id` resume invariant.
- **Bounded:** head+tail truncation at 256Ki so a process that floods output while nobody
  reads cannot grow memory unbounded (the predecessor RFC §6.2 leak invariant). When the ring
  truncates the head, a `seq` gap is recorded so `read` can signal "you missed N bytes"
  (vs silently dropping) — fidelity: **byte-exact stream** (the manifest note's promised
  upgrade over tmux's snapshot fidelity).
- `drain` callback (`bun.d.ts:7794`) backpressures `write` so a large `pty_write` cannot
  overrun the kernel pty buffer; the adapter awaits `drain` before reporting the write done.

### 4.3 Resize / write — direct Bun.Terminal calls

- `resize(handle, cols, rows)` → bounds-check `1..1000` (`PTY_MIN_DIM`/`PTY_MAX_DIM`,
  `port.ts:90-91`) → `terminal.resize(cols, rows)` (`bun.d.ts:7842`). Reject `(0,0)` etc.
  with `invalid-size` (`port.ts:53`) — the SAME error code the tmux adapter uses, so the
  6 tools' error handling is backend-agnostic.
- `write(handle, data, { appendNewline })` → 64Ki cap (`PTY_MAX_WRITE_BYTES`) → `too-large`
  on overflow → `terminal.write(data + maybeNewline)` (`bun.d.ts:7835`). Same `appendNewline`
  ergonomics as the tmux adapter / `write_stdin`.

### 4.4 Closed-port DI (no `Bun.spawn` / `new Bun.Terminal` inside the slice)

`@/tool/pty` imports only `zod` + this slice (`port.ts:6-13` fence). So the adapter does NOT
call `Bun.spawn` / `new Bun.Terminal` directly — those are **injected** behind a minimal
factory port, exactly as `createTmuxAdapter` takes an injected `TmuxExec`
(`tmux-adapter.ts:74`) and the real `Bun.spawn(["tmux",…])` lives in the composition layer
(`src/host/runtime/pty-backend.ts:31-45`):

```ts
// injected at the composition root — the slice never touches a Bun global
export interface PtyFactoryPort {
  open(opts: { cols: number; rows: number;
               onData(bytes: Uint8Array): void;
               onExit(code: number): void }): {
    write(d: string): number; resize(c: number, r: number): void
    setRawMode(b: boolean): void; close(): void
  }
  spawn(argv: readonly string[], cwd: string,
        env: Readonly<Record<string,string>>, terminal: unknown): { kill(): void; pid: number }
  /** cwd-jail — validates/normalizes the spawn cwd (closed port, same as 6-tool CwdJailPort). */
  jailCwd(cwd: string): { ok: true; cwd: string } | { ok: false; reason: string }
}
```

The real `PtyFactoryPort` (`new Bun.Terminal(...)` + `Bun.spawn(argv, { terminal })`) is
built in `src/host/runtime/pty-backend.ts` next to `bunTmuxExec`, so the slice stays
fence-clean and fully testable over a `FakePtyFactory` (in-memory scripted terminal) with
**no real process / no Bun global** — same discipline the tmux adapter uses with a fake
`TmuxExec`. No `Date.now`/`Math.random`/`process.env` in the slice (a `clock` for any
seq/timestamp is injected if needed; the seq is a pure counter so none is required).

### 4.5 Lifecycle — owned ⇒ kill on close

- `attach(pty:<seq>)` — idempotent lookup in a module-scoped `PtyTable` (the predecessor RFC
  named `table.ts`; lift the `MAX_ATTACHED` discipline). Re-attach returns the current cursor.
- `detach` — stops streaming; the child **survives** (consistent with the port doc, `port.ts:81`).
- `kill` — terminate the child + close the `Terminal` (we own it; no allow-list needed).
- Session shutdown — `closeAll()` reaps every owned child + closes every `Terminal`
  (idempotent), honoring the existing "tear down PTY children FIRST" teardown invariant.
  `Terminal` is `AsyncDisposable` (`bun.d.ts:7869` `[Symbol.asyncDispose]`) so `await using`
  is the natural close path in the composition layer.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

- **No new top-level env.** Reuse `QUANTA_PTY_ATTACH` (`runtime-config.ts:339,658`) — the
  whole `pty_*` family stays behind one gate.
- Add a **backend selector** sub-knob `QUANTA_PTY_BACKEND = "tmux" | "bun" | "both"`,
  **default `"tmux"`** (the current live behavior). With the selector at its default, the
  composition root builds ONLY `buildTmuxPtyBackend()` — byte-identical to today. `"bun"` /
  `"both"` opt into the new adapter. (The predecessor RFC §5.1 reserved `pty.backend` with
  default `"tmux"`; this RFC fills it.)

### 5.2 Tool(s) — same 6 tools, optional `pty_spawn`

The 6 `pty_*` tools (`tools.ts:143`) are **unchanged** — they call `PtySessionPort` methods
that both adapters satisfy. Optionally add ONE new gated tool **`pty_spawn(argv, cwd?, cols?,
rows?)`** that mints an owned handle via `BunPtyAdapter.spawn` (only registered when the
backend is `bun`/`both`). It joins the existing `pty_attach` group row. If `pty_spawn` is
deferred, owned handles can still be born from the composition root (e.g. upgrading the
6-tool `exec_command({pty:true})` to a real tty) and then attached via `pty_attach` — so the
adapter is useful even before the spawn tool lands.

### 5.3 Composition root (the only real wiring)

`src/host/runtime/pty-backend.ts` gains `buildBunPtyBackend()` (the real `PtyFactoryPort`
over `Bun.Terminal`/`Bun.spawn`) + a `buildPtyBackend(selector)` that returns tmux / bun / a
**composite** `PtySessionPort` (dispatches by handle prefix: `tmux:`→tmux adapter,
`pty:`→bun adapter) for `"both"`. `agent-arg-builder.ts:622` changes from
`buildTmuxPtyBackend()` to `buildPtyBackend(runtimeConfig().ptyBackend)`. Default selector
`"tmux"` ⇒ identical to today.

### 5.4 fc + manifest

- The manifest `pty_attach` row (`manifest.ts:586-597`) already documents both backends — no
  note change required beyond (optionally) adding `pty_spawn` to the `group` array if that
  tool lands.
- fc: the existing `pty-attach` feature node gains the Bun backend in its `evidence.code`
  (the new adapter file) + a `knobs` entry for `QUANTA_PTY_BACKEND`. The two-way drift guard
  (`tests/unit/tool-surface-manifest-hellgate.test.ts`) stays green: a new `pty_spawn` tool,
  if added, MUST get a manifest group entry or CI fails (the `apply_patch_structured`
  fc-orphan lesson).

### 5.5 Slice / fence

- New file `src/tool/pty/bun-pty-adapter.ts` — `createBunPtyAdapter(factory: PtyFactoryPort):
  BunPtyAdapter`. Imports only the port + `zod` (fence-clean). Add `PtyFactoryPort` +
  `BunPtyAdapter` + `BunPtySpawnOpts` to `port.ts` (type-only additions) and re-export from
  `index.ts`.
- New file in composition: extend `src/host/runtime/pty-backend.ts` with the real factory +
  `buildPtyBackend(selector)`.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (`tests/.../bun-pty-adapter.hellgate.test.ts`, over `FakePtyFactory`)

A scripted in-memory `PtyFactoryPort` (no real process) makes every case deterministic/CI-safe:
- **owned flag:** a spawned handle's `list()` entry has `owned:true`, `kind:"bun"`,
  `handle` matches `^pty:\d+$`.
- **resumable read (event-stream):** scripted `data` callbacks push A,B,C; `read(since:0)`→
  ABC,nextSeq=3; `read(since:2)`→C only; no double-emit (Cursor `last_event_id` invariant).
- **ring bound + gap signal:** push 1MB while nobody reads → ring stays ≤256Ki (head+tail
  truncation); a subsequent `read` reports the `seq` gap (missed-bytes signal, not silent drop).
- **resize bounds:** `(0,0)`,`(-1,40)`,`(99999,99999)` → `invalid-size`; `(80,24)` ok and the
  fake terminal records the exact `(cols,rows)` (Bun's `resize(cols,rows)` order, `:7842`).
- **write cap:** 64Ki+1 → `too-large`; `appendNewline` appends exactly one `\n`.
- **NO foreign gate:** there is no `foreign-denied` path for a `pty:` handle (assert the
  adapter never emits it — the owned posture is structurally distinct from tmux's).
- **kill/detach ownership:** `detach` leaves the child alive (still `list`-visible); `kill`
  reaps it + closes the terminal; `closeAll()` idempotent (call twice → 0 live children).
- **error mapping:** factory `open`/`spawn` throw → typed `backend-error` `PtyResult`, never
  an exception at the port boundary (NO-THROW invariant, `port.ts:67`).
- **DI purity:** the adapter touches no Bun global / no `process.env` / no `Date.now` (assert
  by running the whole battery with all globals stubbed to throw).

### 6.2 Backend-parity differential

Run the **predecessor RFC's port-contract hellgate** against BOTH the tmux fake and the bun
fake adapters (same assertions: idempotent attach, seq monotonicity, cap enforcement, NO-THROW)
to prove the Bun adapter is a drop-in `PtySessionPort` — the composite `"both"` router then
cannot behave differently per backend except where provenance legitimately differs (owned vs
foreign gate).

### 6.3 e2e (real Bun PTY — no external dep, unlike tmux e2e)

Unlike the tmux e2e (gated on `which tmux`), the Bun PTY e2e needs **nothing external**:
1. `buildBunPtyBackend().spawn(["bash","-c","tty; read x; echo got:$x"], { cwd })`.
2. `pty_read` shows a real `/dev/…` tty path (proving `isTTY=true`, NOT a pipe — the §3.2
   fake-PTY gap closed).
3. `pty_write("hello\n")` → `pty_read` shows `got:hello`.
4. `pty_resize(120,40)` → write `tput cols` → output `120`.
5. `pty_kill` → child reaped (`list` no longer shows it).

---

## 7. 단계 (Phasing)

- **Phase 1b-α — the adapter (no tool, no spawn-tool).** `bun-pty-adapter.ts` +
  `PtyFactoryPort` type + `buildBunPtyBackend()` in the composition layer +
  `FakePtyFactory` hellgate + parity differential (§6.2). `QUANTA_PTY_BACKEND` selector,
  default `"tmux"` ⇒ byte-identical. Owned handles minted from the composition root.
- **Phase 1b-β — `pty_spawn` tool.** Add the gated `pty_spawn` tool (manifest group entry +
  fc) so the model can mint owned ttys directly. Real-Bun e2e (§6.3).
- **Phase 1b-γ — upgrade the §3.2 fake-PTY.** Route the 6-tool `exec_command({pty:true})`
  through the Bun adapter so it allocates a *real* tty (the natural merge point the
  predecessor RFC §7 Phase-1b named). Opt-in; the pipe path stays the default.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Single-sourcing on `Bun.Terminal` (primary risk).** The adapter depends on a Bun 1.3.x
  builtin. Mitigation: the tmux adapter stands alone (default backend), so a future Bun that
  dropped `Bun.Terminal` degrades to tmux-only, not a broken `pty_*` family. The
  `PtyFactoryPort` indirection means a node-pty / libc fallback could be substituted with no
  slice change if Bun's API ever regresses.
- **Owned ⇒ "no jail" misread.** The inversion (§4.1) is "no *foreign* jail," NOT "no
  jail." The cwd-jail at spawn (`PtyFactoryPort.jailCwd`) is mandatory — a `pty_spawn` with a
  cwd escaping the workspace must be `foreign-denied`/rejected exactly as `bash`'s jail does.
  Dangerous `pty_write` content still flows through the host's existing command-HITL
  classifier (manifest note, `:597`).
- **Ring-buffer truncation vs fidelity.** Bun's `data` stream is byte-exact, but a flooded
  ring still truncates. We surface a `seq` gap rather than silently drop (vs tmux's inherent
  snapshot lossiness) — documented as "byte-exact with explicit gap markers."
- **Alternative — wait for node-pty to be allowed.** Rejected: Bun gives openpty semantics
  today with zero deps; node-pty adds a blocked native build for no capability gain.
- **Alternative — keep only the piped fake-PTY for owned processes.** Rejected: it is
  `isTTY=false`, breaking interactive REPLs (paging, line-editing, color) — the exact thing a
  real owned tty fixes.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented)**
- `src/tool/pty/bun-pty-adapter.ts` — `createBunPtyAdapter(factory)` → `BunPtyAdapter`.
- `src/tool/pty/port.ts` — type-only additions: `PtyFactoryPort`, `BunPtyAdapter`,
  `BunPtySpawnOpts` (no change to `PtySessionPort`).
- `src/host/runtime/pty-backend.ts` — `buildBunPtyBackend()` (real `Bun.Terminal`/`Bun.spawn`
  factory) + `buildPtyBackend(selector)` composite router.
- (optional) `pty_spawn` tool in `src/tool/pty/tools.ts` + manifest group entry.
- `tests/.../bun-pty-adapter.hellgate.test.ts` + the backend-parity differential + real-Bun e2e.
- `docs/decisions/0479-bun-native-pty-backend.md`.

**Touched (gate/wiring only)**
- `src/host/runtime/agent-arg-builder.ts:622` — `buildTmuxPtyBackend()` →
  `buildPtyBackend(runtimeConfig().ptyBackend)`.
- `src/shared/runtime-config.ts` — add `ptyBackend` (`QUANTA_PTY_BACKEND`, default `"tmux"`).
- fc `pty-attach` node — add Bun backend evidence + the new knob.

**Audited ground truth (cited, NOT modified)**
- `src/tool/pty/port.ts:16-91` — port + reserved `bun`/`pty:`/`owned` slots + caps.
- `src/tool/pty/tmux-adapter.ts:74-133` — the landed foreign adapter (gate precedent).
- `src/host/runtime/pty-backend.ts:31-51` — the composition-layer DI precedent (`TmuxExec`).
- `src/host/runtime/agent-arg-builder.ts:617-622` — the gated `ptySession` wire.
- `src/shared/runtime-config.ts:335-339,658` — the `ptyAttach` knob.
- `src/tool/surface/manifest.ts:586-597` — the manifest row promising both backends.
- `node_modules/bun-types/bun.d.ts:7046,7177,7759-7902` — **Bun native PTY (zero-dep crux).**
- `.extracted_source/cursor/.../cursor-agent-exec/dist/main.js` — Cursor SpawnPty vs AttachTmux.
- `.extracted_source/codex/_codex-rs-0.135-symbols.txt:3886,5360,8840` — Codex openpty+resize.
