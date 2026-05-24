# @quanta/linux-sandbox-native

Native Linux Landlock + seccomp binding for the quanta OS sandbox
(ADR-0175 Phase 3). Loaded as an **optional** dependency by
`src/runtime/os-sandbox/landlock-native.ts`; when absent (non-Linux host,
older kernel, install opt-out), the runtime degrades cleanly to the
Phase 2 external-binary wrapper (`bwrap` / `landlock-cli`).

Mirrors Codex `codex-linux-sandbox` (in-process landlock crate). NOT a
re-implementation of `cursorsandbox` (which is a separate Rust binary).

## Status

**Scaffold** (2026-05-25). The napi-rs API surface is final; the Rust
function bodies are `unimplemented!()` / typed `native-impl-pending`
stubs. The TS adapter handles the unavailable case gracefully — falling
through to Phase 2 — so this scaffold is shippable as-is on the JS side.
The full landlock + seccomp + fork-exec wire is Phase 3.1.

## Build (when impl lands)

```sh
# Local Linux build
cd crates/linux-sandbox-native
cargo build --release

# napi-rs CLI (4-triple matrix, CI)
napi build --platform --release --target x86_64-unknown-linux-gnu
napi build --platform --release --target x86_64-unknown-linux-musl
napi build --platform --release --target aarch64-unknown-linux-gnu
napi build --platform --release --target aarch64-unknown-linux-musl
```

GitHub Actions matrix (Phase 3.1 ops follow-up): see ADR-0175
§Phase 3.1 deferral.

## Layout

```
crates/linux-sandbox-native/
  Cargo.toml          — napi/napi-derive/landlock/seccompiler deps
  build.rs            — napi-rs symbol generation
  src/
    lib.rs            — #[napi] entry points (spawn_sandboxed / availability)
    policy.rs         — typed policy → landlock Ruleset (Phase 3.1)
    seccomp.rs        — seccompiler filter compile (Phase 3.1)
  npm/
    linux-x64-gnu/    — per-triple npm package stub (publish target)
    linux-x64-musl/
    linux-arm64-gnu/
    linux-arm64-musl/
  package.json        — main npm package with optionalDependencies on 4 triples
```

## Contract

The TS adapter at `src/runtime/os-sandbox/landlock-native.ts` lazily
imports `@quanta/linux-sandbox-native`. The binding exposes:

- `spawn_sandboxed(spec, policy) -> NapiSpawnResult` — fork → apply
  landlock → apply seccomp → exec → wait → buffered result.
- `availability() -> string` — JSON `{ available, kernelVersion,
  abiSupported, reason? }`.

`NapiSandboxPolicy` mirrors `SandboxPolicy` (`src/runtime/os-sandbox/types.ts`)
with napi-rs snake_case conversion.

## Why napi-rs and not Bun.dlopen / libseccomp-rs / always-build?

See ADR-0175 §Alternatives rejected.
