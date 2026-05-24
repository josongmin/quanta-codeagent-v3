# `@quanta/darwin-vz-helper`

Native macOS **Virtualization.framework** (AVF) binding for quanta MCP
Skybridge — **Phase 3.3 scaffold** (ADR-0190).

Sibling crate to `crates/linux-sandbox-native` (ADR-0175 / 0184). Same
napi-rs surface shape; Apple-specific dependencies.

## Status

- **Phase 3.3** (this crate): typed surface + non-functional stubs
- **Phase 3.4** (deferred): real `VZVirtualMachine::start()` bring-up,
  DMG/kernel image management, vsock IPC bridging, AVF entitlements

## Surface

Two `#[napi]` entry points (consumed by
`src/mcp/skybridge/applevz-native.ts`):

- `spawn_vm_for_mcp(spec, policy) -> NapiVmSpawnResult`
- `availability() -> String` (JSON envelope)

Three `#[napi(object)]` value types:

- `NapiMcpVmPolicy` — declarative VM policy (profile + allowlists + mem/CPU)
- `NapiVmSpawnSpec` — what to launch (id + argv + env)
- `NapiVmSpawnResult` — handle envelope (vm_id + ipc + applied flag)

## Strategy

**Rust + napi-rs** (NOT Swift FFI). Uses the community
[`objc2-virtualization`](https://docs.rs/objc2-virtualization) crate —
Rust bindings to Apple's `Virtualization.framework`. Mirrors the
linux-sandbox-native pattern verbatim.

## Build (Phase 3.3)

```sh
cd crates/darwin-vz-helper
cargo check        # builds typed surface on darwin/linux dev hosts
cargo build --release  # produces .dylib on darwin
```

The npm wrapper packages (`@quanta/darwin-vz-helper-darwin-{arm64,x64}`)
ship the `.node` artifact via napi-rs CLI in Phase 3.4 CI.

## Fallback chain (TS-side)

`registry.ts` resolves the MCP sandbox via this order:

```
caller-injected → nativeAppleVzSandbox (this binding) → Lima/AppleVZ external CLI (ADR-0160) → passthrough
```

The TS adapter `src/mcp/skybridge/applevz-native.ts` degrades cleanly when
this package is absent or `availability()` reports unavailable.

## Phase 3.4 follow-up (separate ADR)

- Real `VZVirtualMachineConfiguration::validateWithError:` probe in
  `availability()`
- `VZLinuxBootLoader` kernel + initrd selection (boot image registry)
- Disk image management (QCow / RAW / DMG)
- `VZVirtioSocketDeviceConfiguration` (vsock IPC bridging)
- Process entitlements (`com.apple.security.virtualization`) + signing
- GitHub Actions matrix CI (`aarch64-apple-darwin`, `x86_64-apple-darwin`)
- npm publish per-platform packages

## See also

- ADR-0190 (this crate's scaffold)
- ADR-0175 / 0184 (sibling `linux-sandbox-native` — same pattern)
- ADR-0160 (Lima external CLI — the Phase 2 fallback below this binding)
- ADR-0155 (Skybridge typed policy — surface this binding plugs into)
