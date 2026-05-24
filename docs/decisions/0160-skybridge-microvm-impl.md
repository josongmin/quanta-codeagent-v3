# ADR-0160: Skybridge Phase 2 — Lima + Apple-VZ external-binary microVM adapters

- **상태**: Accepted (Phase 2 — external-binary wrapper adapter pair + registry auto-pick)
- **날짜**: 2026-05-24
- **관련**: ADR-0155 (Skybridge Phase 1 — typed port + passthrough + 4-arm profile; 본 ADR은 그 `microvmSandbox` 슬롯에 **실제 어댑터 한 쌍**을 끼우는 것), ADR-0136 (OS-level sandbox helper — bash subprocess 용 sibling primitive), ADR-0150 (Linux landlock Phase 2 — 동일한 "external binary wrapper" 전략의 선례)
- **SOTA 출처**: Claude Desktop 1.7196.3 yukonSilver (proprietary, native Virtualization.framework + vsock). Cursor/Codex/v0.dev/Cline — 모두 MCP 격리 부재. quanta는 **OSS 외부 바이너리 래핑**으로 동일한 STRUCTURAL 패턴 (probe → vm-name → shell exec → named-pipe IPC) 을 구현하되 native FFI는 Phase 3 로 분리.
- **참조**: `src/mcp/skybridge/{lima-microvm,applevz-microvm,registry,index}.ts`, `tests/unit/mcp-skybridge-lima-hellgate.test.ts`

## 맥락

ADR-0155 Phase 1 은 `McpSandboxRegistryConfig.microvmSandbox` 슬롯을 닫혀-있는 채로 봉인했다 — `profile="microvm"` 요청이 wired adapter 없이 떨어지면 passthrough 로 강등 + `sandboxApplied=false` + `degradeReason="phase2-not-implemented"` 로 정직하게 표시. Phase 2 = **그 슬롯에 끼울 adapter 한 쌍**을 짓는 것.

native binding (Apple Virtualization.framework Swift helper / Lima 의 vsock 직결 / firecracker subprocess + h2 socket) 는 N주짜리 native code maintenance. 본 ADR 은 **외부 바이너리 래핑 (`lima` CLI + `vz` community CLI)** 으로 그 비용을 분할 — Phase 2 는 "external binary 가 PATH 에 있으면 microvm 격리, 없으면 passthrough degrade" 의 정직한 표면을 닫고, Phase 3 는 native FFI 로 같은 surface 를 swap.

## 결정

신규 plane-clean 모듈 2개 (`src/mcp/skybridge/lima-microvm.ts` + `applevz-microvm.ts`) + 기존 `registry.ts` 의 auto-pick 한 줄 확장 + barrel re-export.

### 1. `lima-microvm.ts` — Lima 어댑터

**구조 패턴**:
1. `detectLima(cfg)` — `cfg.which("lima")` 만 신뢰 (Phase 1 plane-clean — `node:child_process` 직접 import 금지). 미설치/unwired 시 `null`.
2. `limaVmName(specId)` — FNV-1a 32bit 결정적 해시 → `quanta-skybridge-<hex8>` (filesystem-friendly, lowercase, hyphen, 길이-bounded).
3. `compileLimaConfig(policy, spec)` — pure compiler:
   - `mounts:` ← `hostReadAllowlist` (writable:false) + `hostWriteAllowlist` (writable:true). allowlist 부재 시 read-only `/` mount default.
   - `networks:` ← `networkAllowlist` (best-effort 주석 + `lima: user-v2` template — 본격적인 per-host 정책은 Phase 3 MITM proxy).
   - `memory:` ← `policy.memoryMb ?? 512` MiB.
   - `runArgs:` ← `["lima","shell",<vm>,"--", ...spec.command]`, `policy.maxRuntimeMs` 있을 때 `["timeout","<s>s", ...]` prefix (BSD/GNU `timeout` 으로 wrap — Lima 자체엔 VM-level timeout primitive 없음).
4. `limaMicroVmSandbox(cfg).spawn`:
   - `detectLima` + `cfg.spawner` 둘 다 wired 인지 검사 → 미충족 시 `McpSandboxError("backend-unavailable")` throw (caller 가 명시적으로 이 어댑터를 직접 wire 했다면 강등 결정은 registry 의 일이 아님).
   - `cfg.runner` 가 wired 면 `lima list --json` 으로 VM running 상태 prove → 미실행 시 `lima start <vm>` (idempotent — running 인 VM 에 start 부르는 비용은 ~ms; cold-start 5–15s 회피가 핵심).
   - `cfg.spawner(runArgs, opts)` 로 MCP 서버 띄움; throw 시 `McpSandboxError("spawn-failed", cause=원본)` 으로 wrap.
   - return: `sandboxApplied: true`, `ipcChannel: { kind:"named-pipe", ref:"lima-socket:<vm>" }`, `backendId: <vmName>`, idempotent `stop()`.

### 2. `applevz-microvm.ts` — Apple-VZ 어댑터 (darwin only)

Lima 와 STRUCTURAL 동일, 차이 4개:
- `detectAppleVz` 는 platform 게이트 — `cfg.platform ?? process.platform !== "darwin"` 이면 `null`.
- VM 이름 prefix 는 `quanta-vz-<hex8>` (Lima 와 구분).
- `lima start` 같은 vm-bootstrap 단계 없음 — `vz` CLI 들 (cirruslabs/vz, evansm7/vftool, Veertu/anka 류) 은 lifecycle 을 자체 관리한다고 가정. 단순화.
- `ipcChannel.ref = "vz-socket:<vm>"`.

darwin 외 platform 에서 spawn 호출 → `McpSandboxError("backend-unavailable")` with `darwin-only` message. `availability()` → `passthrough` (silent fallback 아님, 명시적 warning).

### 3. `registry.ts` 확장 — auto-pick

기존 `resolveMcpSandbox` (sync) 는 그대로. 신규 `resolveMcpSandboxAsync(policy, cfg)`:

```
1. profile="off" / "process-isolated" → passthrough (rule 1+2, Phase 1 동일)
2. profile="container" + wired         → wired (rule 3, Phase 1 동일)
3. profile="microvm" + cfg.microvmSandbox wired → wired (rule 4a — caller injection 우선)
4. profile="microvm" + autoDetectMicrovm + which wired → probe Apple-VZ → Lima
   첫 번째로 availability().backend === "microvm" 인 어댑터 반환 (rule 4b)
5. else → passthrough degrade (rule 5)
```

핵심 결정 3가지:

#### `resolveMcpSandbox` sync 와 `resolveMcpSandboxAsync` 의 **분리**
sync 표면을 byte-identical 로 보존 — 기존 caller (assembly layer, tests) 가 sync 의존하면 1줄도 안 바뀐다. Phase 2 의 auto-pick 은 async 표면에서만 — auto-pick 은 IO probe (`which`) 이므로 sync 가 거짓말이 됨. 두 surface 공존이 정직한 답.

#### `caller-injected microvmSandbox > auto-pick` 우선순위
caller 가 `microvmSandbox` 슬롯을 명시적으로 채웠다면 (예: Phase 3 native FFI adapter), auto-pick 을 거치지 않는다. caller 의 의도가 detection 보다 강함.

#### `autoDetectMicrovm` 의 default-OFF
Phase 1 default-OFF posture 와 일치 — caller 가 명시적으로 켜야 동작. assembly layer 에서 user config / `.mcp.json` 의 `sandbox.autoDetect: true` 같은 explicit opt-in 으로만 활성화 (별도 ADR 에서 표면 정의).

## 계약 (Phase 2, 5)

1. **NO-THROW on registry resolve** — `resolveMcpSandboxAsync` 는 어떤 detection 실패도 passthrough degrade 로 collapse. throw 는 오직 어댑터의 `spawn()` — caller 가 직접 어댑터를 wire 한 경우.
2. **honesty 봉인 확장** — Lima/Apple-VZ 어댑터는 `sandboxApplied: true` 만 보고. detection 실패 시 backend-unavailable throw (registry 가 catch + degrade) 또는 sync path 에서 passthrough degrade. `sandboxApplied: true` 가 거짓이 될 수 없음.
3. **plane-clean 유지** — `src/mcp/skybridge/*` 는 여전히 `node:child_process` / `Bun.spawn` / `node:fs` 직접 import 안 함. `which`/`spawner`/`runner` 전부 caller DI. production 와이어링은 @/agent assembly 책임.
4. **idempotent stop** — Lima `stop()` 은 spawned shell 프로세스만 멈춤 (VM 은 workspace-scoped, sibling MCP 가 공유). 두 번째 `stop()` 은 inner spawner stop 재호출 안 함.
5. **vmName 결정성** — `limaVmName(id)` / `appleVzVmName(id)` 는 같은 id 에 같은 이름; FNV-1a 32bit 면 workspace-scope collision 자유 (cryptographic 의미는 없음).

## Hellgate (18 cases / 142 expects)

`tests/unit/mcp-skybridge-lima-hellgate.test.ts`:

- **A. detectLima (3)**: which-found / which-empty / which-null. Phase-1 plane-clean 회귀 봉인.
- **B. compileLimaConfig (6)**: hostRead/hostWrite mount / network allowlist 주석 + 부재 시 networks: 섹션 omit / memoryMb default 512 + override / maxRuntimeMs → `timeout <s>` prefix + sub-second clamp / runArgs 정확 shape / limaVmName 결정성 + filesystem-friendly regex.
- **C. limaMicroVmSandbox.spawn (5)**: lima 부재 → backend-unavailable throw / VM 미실행 → `lima start` 후 spawn / VM running → start 스킵 (runner 한 번만 호출) / spawner throw → spawn-failed wrap + cause 보존 / handle.stop() idempotent.
- **D. appleVzMicroVmSandbox (2)**: vz 있고 darwin → availability=microvm + spawn 성공 + `vz-socket:` ref / vz 없거나 비-darwin → backend-unavailable throw + availability=passthrough.
- **E. registry routing (2)**: profile=microvm + autoDetect + Lima only (vz=null) → Lima 가 픽됨, spawn 시 `lima-socket:` ref 로 검증 / 둘 다 없음 → degrade to passthrough (no throw) + sandboxApplied=false + `phase2-not-implemented`.

기존 Phase-1 hellgate 18 cases 와 함께 36 pass / 142 expects.

## Phase 3 deferral 합리화

**deferred to Phase 3**:
- **Native Apple Virtualization.framework FFI** (Swift via Bun FFI 또는 napi-rs) — sub-second boot + native vsock IPC. `vz` CLI wrapper 의 process spawn overhead 제거.
- **Lima 직접 vsock 결선** — 현재는 `lima shell` 로 stdio 라우팅. vsock 직결 시 socket 경로가 named-pipe ref 가 됨.
- **per-MCP fresh VM** — Lima cold-start 5–15s 를 amortize 할 image snapshot 메커니즘 등장 시 (Phase 1 호스트 공유 패턴은 weaker, but cheaper).
- **firecracker / cloud-hypervisor** Linux 옵션 — Lima 가 macOS-친화이지 Linux 에서 더 가벼운 hypervisor 가 있을 수 있음. 매트릭스 평가 필요.
- **WSL2 / Hyper-V** Windows 게스트 — 현재 모든 어댑터 미지원. Windows 진출 시점에 별도 ADR.

이건 single-ADR 분량이 아니다. Phase 2 의 가치는: native binding 도착 시 `microvmSandbox` 슬롯에 한 줄 swap — Lima/Apple-VZ adapter 와 동일한 `McpSandbox` shape 으로 caller 코드 변경 없음.

## Alternatives rejected

1. **"Docker / Podman 를 microvm 백엔드로 직접"** — 격리 강도가 process-isolated 보다 약하면 보낼 수 없다 (chroot+namespace). Lima 는 VM 격리 (커널 분리) 라서 강도 단계 위. Docker 가 들어갈 슬롯은 `container` 어댑터 — 별도 ADR.
2. **"native Virtualization.framework FFI 를 Phase 2 에 바로"** — Swift helper binary 빌드 + per-arch prebuilt (x64/arm64) + vsock host↔guest bootstrap + restart 시 reconnect 시맨틱 — single-ADR 가 아니다. Phase 2 의 가치는 external binary wrapper 로도 격리 효과를 봉인하는 것 + Phase 3 swap 표면을 검증하는 것.
3. **"per-MCP fresh VM"** — Lima cold-start 5–15s. workspace 당 MCP 서버 N개 가정 시 N*5s = startup latency 폭발. shared-kernel weakness 는 Phase 3 image snapshot 으로 분리해 amortize. 본 ADR 의 "one VM per workspace" 는 trade-off 명시.
4. **"containerd / nerdctl 를 직접 host-side daemon 없이"** — rootless container 옵션이지만 격리 강도가 VM 보다 약하고, daemon-less 한 surface 의 maintenance 부담 큼. Lima 가 그 모든 것을 wraps 하므로 한 단 안쪽으로 미루면 됨.
5. **"detection 시 binary version 도 같이 strict-check"** — `lima --version` 으로 v0.21+ 강제 — false positive 가능 (개발 build), Phase 2 에서는 path detection 만 + Phase 3 에서 schema-bound (vsock API 차이날 때) 검증 추가.
6. **"single-VM-per-MCP daemon"** — 별도 VM-pool 매니저 프로세스 + 풀 prewarming + LRU eviction — 별도 슬라이스. Phase 2 는 stateless adapter.

## Security 봉인

- **PATH 비신뢰**: `cfg.which("lima")` 가 임의 경로를 반환할 수 있음 (e.g. `PATH=/tmp/evil-lima`). 본 어댑터는 path 를 그대로 spawner 에 넘기지 않고 `["lima", ...]` 로 spawn — spawner 자체가 PATH resolution 책임. 별도 hardening 은 assembly layer 의 `which` 구현체 책임 (e.g. realpath check, signature verify).
- **spec.id injection**: `limaVmName` 의 hash 가 id 의 모든 비-ASCII / 특수문자를 8-hex 로 봉합 — VM name 에 직접 id 들어가지 않음.
- **mount escape**: `hostReadAllowlist`/`hostWriteAllowlist` 의 path 가 yaml-injection 으로 escape 할 수 있음 (`location: "/etc"` 안에 `"` 문자 등). Phase 2 는 caller 가 trusted policy 만 넘긴다 가정 — `.mcp.json` 의 user-supplied path 가 들어올 때는 별도 sanitizer (Phase 3 ADR).
- **VM 공유 blast radius**: workspace 당 단일 VM → 동일 workspace 의 모든 MCP 가 같은 커널 공유. 강도는 "host process isolation < Lima VM < per-MCP VM". 본 ADR 의 격리 강도는 명시적으로 두 번째 — `availability().warnings` 에 도큐먼트.

## SOTA++ 자리매김

| Agent | MCP microVM 격리 | external binary wrapper | native FFI | adapter swap cost |
|---|---|---|---|---|
| Cline | ❌ | n/a | n/a | n/a |
| Cursor 3.2 | ❌ | n/a | n/a | rewrite |
| Codex 0.131 | ❌ | n/a | n/a | rewrite |
| Claude Desktop 1.7196 | ✅ yukonSilver | n/a | ✅ Virtualization.framework | internal |
| v0.dev | ❌ | n/a | n/a | n/a |
| **quanta (Phase 2)** | ✅ Lima + Apple-VZ pair | ✅ external CLI | deferred → Phase 3 | **1-line swap to native** |

= "Claude Desktop 의 native binding 비용은 N주. 우리는 OSS external binary 로 같은 격리 강도 + 같은 ipcChannel 표면을 봉인 — Phase 3 native FFI 가 도착하면 어댑터 한 줄 swap, caller 코드 0 변경."

## Follow-up (이 ADR 이 닫지 않는 것)

- **Phase 3 ADR — native Apple Virtualization.framework FFI** — Swift helper (`Virtualization.framework`) 를 Bun FFI / napi-rs 로 결선. vsock 직결 IPC. cold-start <1s.
- **Phase 3 ADR — Lima vsock 직결** — `lima shell` stdio 대신 `lima virtiofs` 또는 `--guest-vsock` 으로 host↔guest socket 직결.
- **Phase 3 ADR — MITM network proxy** — Lima `networks:` 의 best-effort 주석을 진짜 enforce 하는 outbound proxy. Claude Desktop Skybridge 의 4번째 축.
- **per-MCP fresh VM (Phase 3)** — image snapshot 으로 cold-start amortize. blast radius "host process < workspace VM < per-MCP VM" 의 최강 단계 도달.
- **observability metric** — `mcp_sandbox_backend_picked_total{backend="lima"|"apple-vz"|"passthrough"}` counter (ADR-0144 MetricSink). auto-pick 의 silent 동작을 측정으로 봉인.
- **policy DSL 표면 확장** — `.mcp.json` 의 `sandbox: { profile, autoDetect, hostReadAllowlist, ... }` 필드 — user-facing config. 현재는 코드에서 policy 객체 주입.
- **per-platform binary version pinning** — `lima` v0.21+ / `vz` CLI 의 어떤 변종 (cirruslabs vs vftool vs anka) 인지 detection 단계에서 brand-discriminate.
