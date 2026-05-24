# ADR-0194: Darwin VZ native scaffold (Skybridge Phase 3.3 — napi-rs binding to Virtualization.framework)

- **상태**: Accepted (Phase 3.3 scaffold — typed surface + 20-case fake-binding hellgate + workspace member; Phase 3.4 = real `VZVirtualMachine` bring-up + DMG image management + vsock IPC + AVF entitlements)
- **날짜**: 2026-05-25
- **관련**: ADR-0136 (OS sandbox helper foundation), ADR-0155 (MCP Skybridge typed policy — Phase 1), ADR-0160 (Lima / Apple-VZ external CLI — Phase 2 fallback), ADR-0175 (linux-sandbox-native scaffold — sibling crate Phase 3), ADR-0193 (linux-sandbox-native real impl — sibling Phase 3.1)
- **참조**: `crates/Cargo.toml` (workspace), `crates/darwin-vz-helper/{Cargo.toml, src/{lib,vm_config,boot_loader}.rs}`, `src/mcp/skybridge/applevz-native.ts`, `src/mcp/skybridge/registry.ts`, `tests/unit/mcp-skybridge-applevz-native-hellgate.test.ts`

## 맥락

ADR-0155가 Skybridge typed policy + 4-arm `SkybridgeProfile` 닫힌 enum을 박았고, ADR-0160이 Lima/AppleVZ external CLI Phase 2 fallback을 박았다. Phase 3 = **native binding으로 microVM sub-second boot + vsock IPC**.

ADR-0193가 sibling `crates/linux-sandbox-native/` Rust + napi-rs 패턴을 박고 cargo build verify까지 마쳤다. Darwin 측에서 정확히 같은 패턴을 mirror — Apple `Virtualization.framework` (AVF) napi binding.

산업 참조:
- **Claude Desktop yukonSilver** (proprietary): Skybridge가 정확히 AVF microVM 사용. 우리가 흡수하는 SOTA target.
- **Lima**: AVF + qemu + multi-OS guest. Swift FFI. ADR-0160 fallback에서 wrapper로 사용.
- **`objc2-virtualization` crate**: AVF의 community Rust binding. crates.io published. v0.2.x 안정선.
- **Codex `codex-rs`**: AVF native binding **없음** (Lima만). quanta가 native에서 lead.

## 결정

**5 parts** — 정확히 ADR-0175 (linux-sandbox-native scaffold)의 사이드-by-사이드 mirror.

### Part 1 — `crates/darwin-vz-helper/` napi-rs crate

```
crates/darwin-vz-helper/
  Cargo.toml          — napi v2 + objc2-virtualization v0.2 (cfg(macos) gated)
  build.rs            — napi-build setup
  src/
    lib.rs            — #[napi] spawn_vm_for_mcp + availability + 3 #[napi(object)]
    vm_config.rs      — Phase 3.4 NapiMcpVmPolicy → VZVirtualMachineConfiguration
    boot_loader.rs    — Phase 3.4 Linux/macOS boot loader selection
  npm/
    darwin-arm64/package.json
    darwin-x64/package.json
  package.json        — @quanta/darwin-vz-helper
  README.md
  .gitignore
```

#### napi 표면 (3 typed objects + 2 fn)

```rust
#[napi(object)] pub struct NapiMcpVmPolicy {
    profile, workspace,
    allow_network, network_allowlist,
    host_read_allowlist, host_write_allowlist,
    memory_mb, cpu_count, max_runtime_ms,
    boot_image_path,
}
#[napi(object)] pub struct NapiVmSpawnSpec  { mcp_id, command, env }
#[napi(object)] pub struct NapiVmSpawnResult { vm_id, ipc_kind, ipc_ref, sandbox_applied, degrade_reason }

#[napi] fn spawn_vm_for_mcp(spec, policy) -> napi::Result<NapiVmSpawnResult>;
#[napi] fn availability() -> napi::Result<String>; // JSON envelope
```

**Phase 3.3 scaffold honesty**:
- `spawn_vm_for_mcp` body = `Err(napi::Error::from_reason("Phase 3.3 scaffold"))`.
- `availability()` body = `{"available":false,"backend":"apple-virtualization","reason":"vz-phase3.3-scaffold"}`.
- `vm_config::compile_configuration` + `boot_loader::select` 둘 다 typed body + 결정적 reject (workspace 절대경로 check, boot_image_path 미지원 ext) 정도까지만 — 실제 `VZVirtualMachineConfiguration` 빌드는 `unimplemented!()`.
- 비-macOS 호스트는 `cfg(not(target_os = "macos"))` arm으로 `napi::Error` ("not supported on this platform"). objc2-virtualization는 cfg-gated dep이라 dev box rust-analyzer는 happy.

### Part 2 — Workspace `crates/Cargo.toml` 확장

```toml
[workspace]
members = ["linux-sandbox-native", "darwin-vz-helper"]
resolver = "2"
```

Resolver v2 → `cfg(target_os = "macos")` 시 objc2-virtualization만 build graph 진입, Linux에선 skip. linux-sandbox-native와 mutually-exclusive cfg gate.

### Part 3 — TS adapter `src/mcp/skybridge/applevz-native.ts`

`landlock-native.ts`와 verbatim 같은 shape:
- `nativeAppleVzSandbox(cfg?)` factory — 절대 construction에서 throw 안 함
- `detectNativeAppleVz()` — cheap probe, null on absence
- `mapPolicyToNapi(policy, workspace)` — typed mapping (exactOptional preserving)
- Closed-port DI: `cfg.binding` (fake) 또는 `cfg.bindingLoader` (lazy require)
- Lazy `await import("@quanta/darwin-vz-helper")` via `dynamicLoadBinding()`
- Profile gate: `microvm`만 허용; `off`/`process-isolated`/`container` → `McpSandboxError("policy-rejected")` (registry routing bug surface)
- Fail-graceful: package missing OR `availability()`=false → `McpSandboxError("backend-unavailable")` w/ `degradeReason: "darwin-vz-not-loaded"` (warning surface)

### Part 4 — Registry chain `src/mcp/skybridge/registry.ts`

Routing rule extension (Rule 4 → 4a/4b):

```
caller-injected
  → nativeAppleVzSandbox (Phase 3.3+, when wired)        ← 신규 4a
  → microvmSandbox (Lima/AppleVZ external CLI, ADR-0160) ← 기존 4b
  → passthrough degrade                                   ← 5
```

핵심: native wired 시 microvmSandbox wired-여부 무관하게 native 우선. 동기 picker는 chain 안 함 — caller가 `backend-unavailable` reject 받으면 직접 external CLI tier로 fallback (async chain은 Lima ADR follow-up).

### Part 5 — `McpSandboxPolicy` 2-field 확장

`types.ts`에 2개 옵셔널 필드 추가 (exactOptional strict, conditional spread만):

```ts
readonly cpuCount?: number      // Phase 3 microVM CPU count
readonly bootImagePath?: string // Phase 3 boot kernel/DMG hint
```

기존 caller / Phase 1-2 backend는 둘 다 ignore — 호환 break 0.

## Default-OFF

비-darwin → TS adapter `availability()` → `backend: "passthrough"` 즉시 반환. registry는 `nativeAppleVzSandbox` slot 미주입(non-darwin assembly)이라 Rule 4a skip, Rule 4b/5로 routing. Linux/Windows 사용자 영향 0.

darwin Phase 3.3 → 사용자 host에 `@quanta/darwin-vz-helper` 미설치 ⇒ binding null ⇒ degraded backend. 설치돼도 Phase 3.3 stub은 `available: false` 반환 ⇒ Lima fallback. Phase 3.4 published 시 native path 활성.

## Hellgate

`tests/unit/mcp-skybridge-applevz-native-hellgate.test.ts` — **20 cases / 0 fail**, 4 cluster:

| Cluster | Cases | 검증 |
|---|---|---|
| A. detect availability | 3 | package not loadable / loadable + AVF available / loadable + AVF unavailable |
| B. spawn dispatch | 10 | profile gate (off/container reject) / native call shape / policy field 7개 propagation / native throw → backend-unavailable wrap |
| C. policy mapping | 3 | exactOptional 보존 / ipcKind 4-arm 매핑 / degradeReason preserve+omit |
| D. registry routing | 4 | native > Lima priority / Lima-only fallback / 둘 다 unwired degrade / off short-circuit |

모든 케이스는 fake `NativeAppleVzBinding` (closed-port DI). 실제 napi 패키지 import 0. 어떤 호스트 platform에서도 hermetic.

기존 `mcp-skybridge-hellgate.test.ts` + `mcp-skybridge-lima-hellgate.test.ts`는 surface 변경 없이 그대로 green.

## Cargo build verify

```sh
$ cd crates/darwin-vz-helper && cargo check
   ... (objc2-virtualization fetch + napi compile)
   Finished `dev` profile
```

darwin (Apple Silicon)에서 cargo check success. Phase 3.3 = scaffold only — `cargo build --release`는 cdylib 출력하지만 안에 실제 spawn 로직 없음 (Err 반환 stub).

## Phase 3.4 deferred

1. **Real `VZVirtualMachineConfiguration` compile** — vm_config.rs `unimplemented!()` body 채우기
2. **Linux boot loader selection** — `VZLinuxBootLoader` w/ kernel + initrd + commandLine
3. **Disk image management** — QCow / RAW / DMG; curated `quanta-skybridge.img` 레지스트리
4. **vsock IPC bridging** — `VZVirtioSocketDeviceConfiguration` + host-side port resolve
5. **AVF entitlements** — `com.apple.security.virtualization` + code signing
6. **GitHub Actions matrix CI** — `aarch64-apple-darwin`, `x86_64-apple-darwin` cross-build via cargo + napi-rs CLI
7. **npm publish per-platform packages** — `@quanta/darwin-vz-helper-darwin-{arm64,x64}`
8. **`stop_vm(vmId)` napi entry** — 현재 handle.stop()은 no-op
9. **Stop / signal handling** — AbortSignal 못 ferry → vmId 통해 별도 napi call로 kill
10. **`validateWithError:` real probe** — `availability()` Phase 3.3 stub → Phase 3.4 real check

## Alternatives rejected

1. **Swift binding (Swift Package + Bun FFI / cdylib)** — Swift FFI cross-compile 복잡 + linker setup + Swift runtime co-residency 비용. objc2-virtualization Rust binding이 stable + 단일 toolchain.
2. **HVF (Hypervisor.framework) 직접** — low-level (vCPU register / EPT 직접 관리). AVF가 이미 HVF wrapper + DMG/boot/IPC primitives. 1-tier 위에서 작업.
3. **qemu external CLI** — heavy boot time (~10s+), non-native (HVF accel은 가능하지만 qemu integration), Lima가 이미 wrapper. external CLI tier로는 ADR-0160에 있음.
4. **`@apple/virtualization` (가상 npm)** — 그런 패키지 존재 안 함. Apple은 Swift SDK만 ship.
5. **napi-rs v3 alpha** — crates.io에 release 없음 (sibling crate ADR-0193 동일 결정). v2.16.x 안정선; Phase 3.4 또는 v3 stable 출시 후 sibling과 동시 bump.

## SOTA++ 자리매김

| Agent | macOS native microVM (AVF) |
|---|---|
| Cursor | ❌ |
| **Claude Desktop yukonSilver** | ✅ proprietary AVF microVM (정확히 우리 target) |
| Codex `codex-rs` | ❌ (Lima only) |
| Lima | ✅ Swift FFI wrapper — 우리 Phase 2 fallback (ADR-0160) |
| Devin / OpenHands | partial (Docker container, AVF 미사용) |
| quanta (Phase 1 ADR-0155) | typed policy only |
| quanta (Phase 2 ADR-0160) | external CLI wrapper (Lima/vz) |
| **quanta (Phase 3.3 this ADR)** | ✅ **napi-rs scaffold + objc2-virtualization + TS adapter + 20-case hellgate** |
| quanta (Phase 3.4 deferred) | + real `VZVirtualMachine` + vsock + DMG registry + entitlements + CI |

"Codex가 안 한 영역이고 Claude Desktop은 proprietary 상자. 우리만의 영토: **napi-rs + objc2-virtualization Rust binding** (Swift FFI 우회) + `nativeAppleVzSandbox > Lima` registry priority + 20-case closed-port hellgate. cargo check pass on darwin, Phase 3.4 follow-up이 mechanical."

## Follow-up

- ADR-(next): Phase 3.4 real impl — VZ bring-up bodies + vsock + image registry
- 보안 review: AVF entitlement scope + DMG attestation (curated 이미지 supply chain)
- Per-MCP image registry: spec.id → bootImagePath default 자동 선택 (지금은 caller 책임)
- HVF passthrough mode for CPU-bound MCP (Phase 3.5+, AVF 우회 시나리오)
