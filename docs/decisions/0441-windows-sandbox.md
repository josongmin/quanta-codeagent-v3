# ADR-0441 — Windows OS-sandbox backend (pure compiler + native boundary)

**Status:** Accepted (2026-06-02)
**Type:** New capability slice — closes the Windows surface-parity gap in the OS sandbox. RFC: `docs/plans/jun-2-misc/07-windows-sandbox.md`.
**Scope:** new `src/runtime/os-sandbox/windows.ts` (pure compiler) + `src/runtime/os-sandbox/windows-native.ts` (native boundary) + ~1-line type-union edit + a single win32 selection block in `default.ts` + index exports. No other plane mutated. **Default-OFF.**
**ROI honesty:** this is the lowest-ROI / most platform-specific slice in the jun-2 batch. Native Windows (non-WSL) usage is low, and *real* isolation is impossible without a native helper exe (L3 backlog). The value here is (1) surface parity with macOS/Linux, (2) an honest `availability()` report, (3) auto-activation once the helper ships — no wire change needed.

## Context

quanta's OS sandbox selects a per-platform backend in `default.ts`:

- macOS → Seatbelt (`compileSeatbeltProfile` + `sandbox-exec -p`) — real.
- Linux → native landlock+seccomp → bubblewrap → landlock-cli → passthrough — real.
- **Windows (win32) → no branch. Plain passthrough** (`unsupported-platform:win32`).

So on Windows the agent's shell ran UNSANDBOXED regardless of profile: `read-only`/`workspace-write` enforced nothing. macOS/Linux users were isolated; Windows users were not. Worse than the brief assumed: the `SandboxBackend` union had **no** Windows arm at all — it was absent from the types *and* the selection, a full passthrough hole (not a "declared-but-unimplemented" stub).

Codex research (`windows-sandbox-rs`, codex-rs 0.135): a separate **broker helper process** (`fs sandbox helper`) receives an encoded policy over stdin and spawns the target under a restricted/low-integrity context; FS uses writable-descendants-under-read + a `deny_read_resolver`; network goes through a **managed egress proxy** (not AppContainer firewall). quanta follows the same lightweight combination: restricted token + Low integrity + deny-read resolver + egress proxy (ADR-0428), NOT AppContainer.

## Decision

Ship **L1 (pure compiler) + L2 (native boundary + selection wire)**. Defer **L3 (the helper exe build)** to a separate backlog track, exactly as Linux's native napi addon build was split from its TS adapter (ADR-0175).

### L1 — pure compiler `windows.ts`

`compileWindowsSandboxSpec(policy, workspace): WindowsSandboxSpec | null` mirrors `compileSeatbeltProfile` structure exactly:

- `off` / `danger-full-access` → `null` (caller passes through verbatim; no wrap, no degradeReason).
- profile → `{ restrictedToken, integrityLevel: "low", writePaths, readPaths, denyReadPaths, allowNetwork, memoryMb?, timeoutMs? }`.
- `read-only` → empty `writePaths` (FS write fully denied via Low integrity). `workspace-write[-net]` → workspace + extras in `writePaths`. `-net` / `allowNetwork` override → `allowNetwork: true` (identical rule to seatbelt/landlock).
- `extraReadPaths`/`extraWritePaths`: absolute (drive-letter `C:\`, UNC `\\`, rooted `/`,`\`) kept verbatim; relative joined to workspace with `\`.
- `seccompMode` IGNORED (Linux-only; documented on the type).
- `denyReadPaths` is empty in v1 — **explicit policy input only, NO secret-directory heuristics** (no-heuristics rule). The array + helper plumbing are the extension point.
- `serializeWindowsSpec(spec)` → JSON. **JSON-over-stdin, not argv** — sidesteps all path quoting (spaces / `"` / `\` / UNC) by construction; mirrors Codex's "encode fs sandbox helper message".

**Pure: no I/O, no `Date.now`, no `Math.random`** → unit-testable on any OS. This is the testable core of the slice.

### L2 — native boundary `windows-native.ts` + selection wire

Mirrors `landlock-native.ts` 1:1:

- `detectNativeWindows(cfg)` — cheap probe, never throws, `null` when the helper is absent.
- `nativeWindowsOsSandbox(cfg)` — always returns an `OsSandbox`; binding `null` ⇒ degraded passthrough (`native-binding-unavailable`); binding throws ⇒ exitCode 127 + `native-binding-threw` (never throws); off/danger ⇒ pure passthrough.
- Closed-port DI: tests inject `binding` / `bindingLoader`; production lazily `import("@quanta/windows-sandbox-native")` (the optional helper shim — **not built yet**, so it resolves to `null` for every user today).
- The chosen native model is the **broker helper exe** (`quanta-win-sandbox.exe`, RFC option A) over napi: matches Codex's broker-process, called via one `Bun.spawn`, avoids the napi prebuild matrix, and isolates main-process crashes.

`default.ts` gains a `win32` branch in `spawnImpl` + `availabilityImpl`: helper present ⇒ native path / `windows-restricted-token` backend; helper absent ⇒ **byte-identical passthrough** with a LOUD, actionable `degradeReason` (`win32-sandbox-helper-missing — install quanta-win-sandbox.exe …`). The combined `DefaultOsSandboxConfig` namespaces the Windows DI under `windows.*` (the Landlock and Windows `binding` shapes differ, so a flat intersection is unsatisfiable).

`SandboxBackend` gains the `"windows-restricted-token"` arm so `availability()` reports the backend honestly.

## Default-OFF / byte-identical

The helper exe does not exist yet, so **every win32 user falls to passthrough** — same `sandboxApplied: false`, same exit/stdout/stderr as before. The ONLY observable change is the `degradeReason` string becomes actionable (`win32-sandbox-helper-missing`) instead of `unsupported-platform:win32`, and `availability()` warns about the missing helper instead of "unsupported platform". `profile: "off"` stays a pure passthrough with no degradeReason on every platform.

## Negative invariants (do NOT)

- Do **not** claim isolation without the native helper. Pure Node/Bun cannot call `CreateRestrictedToken` / `SetTokenInformation` / `CreateProcessAsUser` / Job Object — the boundary degrades loudly, it does not pretend.
- Do **not** require admin. No AppContainer profile registration, no service install (Codex doesn't either).
- Do **not** synthesize a deny-read list from path heuristics (no "looks like `.aws`/`.ssh`" guessing). Explicit policy input only.
- Do **not** fail-closed on un-enforceable network by default — warn (`win32-network-policy-not-enforced`) and proceed; fail-closed is an opt-in knob (`windows.failClosedOnNetwork`).
- Do **not** cover WSL — that's the Linux (landlock) backend already.

## Consequences

- Windows reaches surface parity in types + `availability()`; isolation activates automatically once the L3 helper ships (no wire change).
- L3 (Rust `windows-sandbox-rs`-style cross-compiled helper exe + win32-gated integration tests) remains backlog until a Windows-native usage signal justifies the build cost.
- Tests: `tests/unit/os-sandbox-windows-hellgate.test.ts` — 30 OS-independent cases (pure compiler / native boundary / selection wire + byte-identical) + 1 win32-gated integration marker. `os-sandbox-hellgate.test.ts` HELL-C17 updated for the new actionable win32 warning.
