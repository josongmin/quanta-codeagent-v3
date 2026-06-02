# RFC 07 — Windows OS-sandbox backend (실 구현)

**Status**: Draft / proposal
**Author**: architect (Jun-2 misc batch)
**Slice**: `src/runtime/os-sandbox/` (windows arm)
**Default**: OFF (opt-in; backend 부재 시 현행 passthrough byte-identical)
**ADR 제안**: ADR-0435 (최신 free — `docs/decisions/` 마지막은 `0434-permission-profile-list-select.md`)
**솔직한 ROI 경고**: 이 배치에서 **가장 낮은 ROI / 가장 플랫폼-종속적**인 슬라이스다.
quanta 사용자 중 Windows 네이티브(WSL 아님) 비중은 낮고, 진짜 격리는 native
addon / helper exe 없이는 불가능하다. macOS(seatbelt)/Linux(landlock+seccomp)와
의 **표면 패리티(surface parity)** 와 "선언만 하고 미구현인 갭 닫기"가 주 가치이지,
당장의 사용량 ROI는 작다. 따라서 본 RFC는 **pure policy-compilation core(어느
OS에서나 unit-test 가능) + native boundary 격리 + default-OFF**에 가치를 집중하고,
실제 Win32 토큰 강제는 native helper에 위임한다.

---

## 1. Problem

quanta의 OS 샌드박스는 플랫폼별 백엔드를 선택한다 (`src/runtime/os-sandbox/default.ts`).

- macOS → Seatbelt (`compileSeatbeltProfile`, `sandbox-exec -p`) — **실 구현**
- Linux → native landlock+seccomp (napi) → bubblewrap → landlock-cli → passthrough — **실 구현**
- **Windows(win32) → 분기 없음. 그냥 passthrough.**

`default.ts:106-110`:

```ts
  // Other platforms (win32, etc.): passthrough + reason.
  return passthrough(spec, spawner, {
    sandboxApplied: false,
    degradeReason: `unsupported-platform:${platform}`,
  })
```

`availabilityImpl`도 동일 (`default.ts:215-218`) — win32는 `backend: "passthrough"`,
`warnings: ["unsupported platform: win32 — degraded to passthrough"]`.

결과: **Windows에서 agent의 shell 도구는 UNSANDBOXED로 실행된다.** read-only /
workspace-write 프로파일을 지정해도 FS 쓰기·네트워크가 전혀 강제되지 않는다.
macOS/Linux 사용자는 격리되는데 Windows 사용자만 무방비다.

추가로 — task brief의 가정과 달리 — **타입 union에도 Windows arm이 없다.**
`types.ts:61`:

```ts
export type SandboxBackend = "seatbelt" | "bubblewrap" | "landlock+seccomp" | "passthrough"
```

`SandboxProfile`(`types.ts:14-19`)은 OS-중립이고 그대로 재사용 가능하지만,
`SandboxBackend`에는 `"windows-restricted-token"` 같은 arm이 **없다**. 본 RFC는
타입 union에 Windows arm을 추가하는 것까지 포함한다 (그래야 `availability()`가
정직하게 백엔드 식별을 보고할 수 있다).

> 정정 노트: brief는 "Windows가 type union에 선언돼 있다"고 했으나, 실제로는
> `OsSandboxKind`라는 타입은 존재하지 않으며 `SandboxBackend` union에도 windows가
> 없다. "선언만 되고 미구현"이 아니라 **타입에도 없고 selection 분기에도 없는,
> 완전 passthrough 상태**다. 갭은 brief가 말한 것보다 약간 더 크다.

---

## 2. Competitor research — Codex `windows_sandbox` (codex-rs 0.135)

소스: `.extracted_source/codex/_codex-rs-0.135-symbols.txt` (Rust 바이너리 string/
심볼 테이블; Win32 API 심볼 자체는 링크되어 string으로 안 남지만, crate 경로 +
human-readable error string으로 메커니즘을 역추론).

확인된 파일 경로:

- `core/src/windows_sandbox.rs` (symbols:921)
- `app-server/src/request_processors/windows_sandbox_processor.rs` (symbols:1947)
- `windows-sandbox-rs/src/deny_read_resolver.rs` (symbols:8869)
  — **별도 crate** `windows-sandbox-rs` (Linux의 `codex-linux-sandbox` 대응)

확인된 동작 string (`tool-results` grep):

| String | 시사점 |
| --- | --- |
| `"failed to open fs sandbox helper stdin"` / `"failed to start fs sandbox helper runtime"` / `"fs sandbox helper failed with status "` / `"failed to encode or decode fs sandbox helper message"` | **별도 helper 프로세스(broker)** — 메인이 아니라 `fs sandbox helper` 자식을 spawn하고 **stdin으로 encoded message** 전달. 즉 in-process Win32 호출이 아니라 **broker-process 아키텍처**. |
| `"file system sandbox context with dynamic permissions requires cwd"` | FS 샌드박스 컨텍스트는 **cwd(workspace) 필수**, 동적 permission 모델. |
| `"windows elevated sandbox cannot reopen writable descendants under read"` | **writable-descendants-under-read** 모델: read 권한 디렉터리 하위의 writable descendant 재오픈 제어. = workspace는 write, 그 외는 read, read 영역 안의 write 재오픈은 차단. |
| `"deny read "` + `deny_read_resolver.rs` | **read-deny resolver** — 특정 경로 read 차단 해석기(예: 비밀·자격증명 디렉터리). |
| `"failed to persist windows sandbox mode"` | sandbox mode가 상태로 persist됨(설정성). |
| `"failed to rebuild managed network proxy for sandbox change"` / `"failed to refresh managed network proxy for sandbox change"` / `"failed to start managed network proxy for sandbox change"` | **네트워크는 AppContainer firewall capability가 아니라 "managed network proxy"로 제어** — sandbox 변경 시 프록시 정책 재구성. egress proxy 경유 모델. (quanta ADR-0428 network-egress-proxy와 정확히 같은 결). |
| `app-server `windows_sandbox_processor.rs` | app-server에 **processor-per-category** 1개 (`docs/.../codex-repomap.md:42` 확인). IPC 1급 시민. |

**Codex가 쓰는 OS primitive (역추론 결론)**:

1. **별도 broker helper 프로세스** (`fs sandbox helper`) — 메인 프로세스가 직접
   토큰을 만드는 게 아니라, helper를 띄우고 stdin으로 정책 메시지를 보낸 뒤
   helper가 **restricted/low-integrity 컨텍스트에서 대상 명령을 spawn**.
   (이것이 "elevated sandbox" string과 정합 — helper가 권한 강등을 수행.)
2. **FS**: writable-descendants-under-read + `deny_read_resolver` (read-deny 목록).
   workspace=write, 시스템=read, read 영역 내 write 재오픈 차단.
3. **Network**: AppContainer 방화벽 capability가 **아니라** managed network
   proxy (egress proxy) 정책 재구성으로 처리.

> AppContainer를 안 쓰는 게 핵심 신호다. AppContainer는 admin/프로파일 등록·
> capability SID 관리·기존 핸들 상속 문제가 커서 CLI 자식 프로세스 격리엔
> 무겁다. Codex는 **restricted token + (helper에 의한) low integrity + read-deny
> resolver + egress proxy**라는 가벼운 조합을 택했다. quanta도 이 선택을 따른다.

---

## 3. quanta 현행 구조 (reference patterns)

세 가지 백엔드 패턴이 이미 존재하고, Windows는 이들을 그대로 조합한다.

### 3a. Pure compiler (Seatbelt 템플릿) — `seatbelt.ts`

`compileSeatbeltProfile(policy, workspace, opts?): string | null` — **순수 함수,
I/O 없음**. `off`/`danger-full-access`는 `null` 반환(=caller가 wrap 안 함).
profile→SBPL 텍스트. 이것이 **Windows의 pure core가 mirror할 표준**:
`policy → 토큰/ACL spec`을 OS-호출 없이 만들어 어디서나 unit-test.

### 3b. External helper binary (landlock-cli/bubblewrap 템플릿) — `landlock-cli.ts`

`compileLandlockCliArgs(policy, workspace): string[] | null` — 정책을 외부
helper 바이너리의 argv flag로 컴파일. caller가 `[helper, ...args, "--", ...cmd]`
조립. 네트워크 미지원 시 `--network-deferred` 마커 + 정직한 `degradeReason`.
**Windows helper exe 모델이 그대로 따를 패턴.**

### 3c. Native binding (napi 템플릿) — `landlock-native.ts`

`@quanta/linux-sandbox-native` optional dep. `detectNativeLandlock(cfg)`는 cheap
probe(없으면 `null`, never throw), `nativeLandlockOsSandbox(cfg)`는 binding 없으면
모든 spawn이 `degradeReason: "native-binding-unavailable"`로 degrade. **closed-port
DI**: 테스트는 `cfg.binding` / `cfg.bindingLoader` 주입. **Windows native helper의
부재/degrade 패턴이 이걸 1:1 mirror.**

### 3d. Selection — `default.ts`

`spawnImpl`이 platform별 분기:
- `off`/`danger` → passthrough (sandboxApplied=false, **degradeReason 없음**)
- darwin → seatbelt
- linux → native → bwrap → passthrough
- **그 외(win32) → passthrough + `unsupported-platform`** ← 여기에 windows 분기 삽입

`availabilityImpl`도 동일하게 windows 분기 추가.

**no-throw 계약** (`types.ts:88`의 `OsSandbox` doc): spawn 실패는 절대 throw 안 함.
`exitCode: 127` + descriptive `stderr`. Windows 백엔드도 이 계약 준수.

---

## 4. Goals / Non-goals

### Goals
- Windows에서 `read-only` / `workspace-write` / `workspace-write-net` 프로파일이
  실제로 FS 쓰기·네트워크를 강제 — macOS/Linux와 표면 패리티.
- **Pure core (`compileWindowsSandboxSpec`)** 가 정책→토큰/ACL/argv spec을
  OS-독립적으로 컴파일 (어느 OS에서나 unit-test).
- Native boundary(helper exe 또는 napi)를 **단일 파일로 격리**, 부재 시
  **현행 passthrough byte-identical degrade** (loud warning 포함).
- closed-port DI, default-OFF, slice-fenced. 기존 코드 mutate 최소(타입 union 1줄
  + selection 분기 1블록 + index export).

### Non-goals
- **admin 권한 요구 금지.** AppContainer profile 등록·서비스 설치 같은 admin
  경로는 채택 안 함.
- 순수 Node/Bun만으로 진짜 Win32 토큰 격리 달성 — **불가능.** 정직하게 native
  helper exe를 요구하고, 없으면 degrade.
- WSL 커버 — WSL은 Linux 백엔드(landlock)가 이미 커버. 본 RFC는 **win32 네이티브** 전용.
- AppContainer 채택 — Codex도 안 씀(§2). non-goal.
- 메모리/타임아웃 캡을 Bun 레벨에서 강제 — Job Object(native)로만. native 부재 시
  timeout은 기존 AbortSignal 경로로만(메모리 캡은 unenforced + warn).

---

## 5. Design

### 5.1 Windows isolation primitive (선택)

Codex(§2) + Windows 현실을 종합한 선택:

| 축 | 메커니즘 | 근거 |
| --- | --- | --- |
| **권한 강등** | **Restricted Token** (`CreateRestrictedToken` — DISABLE_MAX_PRIVILEGE + restricting SID `WinBuiltinUsersSid` 등) | admin 불필요, 자식 프로세스에 즉시 적용. AppContainer보다 가벼움. Codex의 "elevated sandbox" helper와 정합. |
| **무결성 레벨** | **Low/Medium Integrity** (`SetTokenInformation` TokenIntegrityLevel, `WinLowLabelSid`) | read-only/workspace-write에서 시스템 쓰기 차단. |
| **FS 쓰기 제한** | **deny-write via integrity + workspace ACL grant** + **deny-read resolver** | Codex writable-descendants-under-read 모델 mirror. workspace는 명시 write grant, 시스템은 read, read-deny 목록은 access 차단. |
| **자원 캡 (timeout/memory)** | **Job Object** (`CreateJobObject` + `JOBOBJECT_BASIC_LIMIT_INFORMATION` ProcessMemoryLimit + kill-on-job-close; wall-clock은 watchdog) | memoryMb/timeoutMs 강제. macOS/Linux의 memoryMb 캡과 패리티(Linux는 RLIMIT). |
| **네트워크 토글** | **managed egress proxy 연동** (1순위) / firewall WFP rule (미채택) | Codex managed network proxy mirror + quanta ADR-0428(network-egress-proxy)와 합류. allowNetwork=false면 helper가 프록시 강제 또는 connect 차단. |
| **broker** | **helper exe(`quanta-win-sandbox.exe`)** 가 restricted token + integrity + job object를 구성하고 대상 cmd를 `CreateProcessAsUser`로 spawn | Codex `fs sandbox helper` broker-process 아키텍처 mirror. Node/Bun에서 Win32 token API 직접 호출은 불가 → helper 필수. |

**왜 helper exe(또는 napi)가 필수인가**: `CreateRestrictedToken` /
`SetTokenInformation` / `CreateProcessAsUser` / Job Object API는 Win32 호출이며
Node/Bun 표준 API로 노출되지 않는다. native addon 없이는 **진짜 격리 불가.** 이건
landlock-native.ts가 napi를 요구하는 것과 동일한 정직한 제약이다.

### 5.2 SandboxProfile → Windows 메커니즘 매핑

| Profile | Restricted Token | Integrity | FS | Network |
| --- | --- | --- | --- | --- |
| `off` | — (passthrough, compile→null) | — | — | — |
| `read-only` | restricted (no write SID) | Low | workspace 포함 전부 read; **write deny** | deny (proxy block) |
| `workspace-write` | restricted | Low | 시스템=read, **workspace=write grant**, extraWritePaths=write, deny-read resolver 적용 | deny |
| `workspace-write-net` | restricted | Low | = workspace-write | **allow** (proxy 통과) |
| `danger-full-access` | — (passthrough, compile→null) | — | — | — |

`extraReadPaths`/`extraWritePaths`: 절대경로 verbatim, 상대경로는 workspace 기준
resolve (seatbelt `resolvePath` 패턴 동일). Windows 경로는 `\` 그대로 + 따옴표
escape (UNC/공백 처리는 §7).

`allowNetwork`: profile이 net-allow가 아닐 때만 의미 — seatbelt `allowNetwork`
오버라이드 규칙 동일 (`policy.profile === "workspace-write-net" || policy.allowNetwork === true`).

`timeoutMs`: Job Object wall-clock watchdog + 기존 AbortSignal. `memoryMb`: Job
Object ProcessMemoryLimit. `seccompMode`: **Windows 무시** (Linux 전용 필드 —
landlock-native가 무시하는 것과 동일).

### 5.3 Pure compilation core (OS-독립, 핵심 가치)

`compileWindowsSandboxSpec(policy, workspace): WindowsSandboxSpec | null`

```ts
export interface WindowsSandboxSpec {
  /** 토큰 강등 수준. */
  readonly restrictedToken: boolean
  readonly integrityLevel: "low" | "medium" | "untrusted"
  /** ACL grant 경로 (write 허용). workspace + extraWritePaths resolved. */
  readonly writePaths: ReadonlyArray<string>
  /** read 허용 경로 (시스템 + workspace + extraReadPaths). */
  readonly readPaths: ReadonlyArray<string>
  /** read 차단 경로 (deny_read_resolver mirror — 비밀/자격증명 등). */
  readonly denyReadPaths: ReadonlyArray<string>
  readonly allowNetwork: boolean
  /** Job Object 캡. 미지정 시 omit (exactOptional). */
  readonly memoryMb?: number
  readonly timeoutMs?: number
}
```

- `off`/`danger-full-access` → `null` (seatbelt/landlock-cli와 동일 계약 —
  caller가 wrap 안 함).
- **순수 함수, I/O 없음** → 어느 OS에서나 unit-test 가능. 이것이 본 RFC의
  testable 핵심.
- helper exe argv 직렬화는 `serializeWindowsSpecToArgv(spec): string[]`
  (landlock-cli `compileLandlockCliArgs` 패턴) 또는 JSON-over-stdin
  (Codex "encode fs sandbox helper message" 패턴). **JSON-over-stdin 권장**
  — 경로 escape/UNC 문제를 argv가 아니라 JSON으로 회피.

### 5.4 Native boundary (helper exe / napi)

landlock-native.ts를 mirror한 closed-port adapter — `windows-native.ts`:

```ts
export interface WindowsSandboxBinding {
  /** helper exe 또는 napi. spec+spawn을 받아 격리 실행 결과 반환. */
  spawn_sandboxed(
    spec: NativeWinSpec,        // {command, cwd, env?}
    sandbox: WindowsSandboxSpec,
  ): NativeWinResult | Promise<NativeWinResult>
  availability(): string       // JSON: {available, osBuild, reason?}
}

export interface NativeWindowsConfig extends OsSandboxConfig {
  readonly binding?: WindowsSandboxBinding         // 테스트 직접 fake
  readonly bindingLoader?: () => WindowsSandboxBinding | null
}

export const detectNativeWindows = async (cfg?): Promise<{...} | null> => {...}  // cheap probe, never throw
export const nativeWindowsOsSandbox = (cfg?): OsSandbox => {...}                  // binding null → degrade passthrough
```

두 가지 구현 옵션 (둘 다 native 경계, 택1 — 권장: **A**):

- **A. helper exe(`quanta-win-sandbox.exe`)** — `detectNativeWindows`가
  `which("quanta-win-sandbox")` 또는 번들 경로 확인. spawn은 helper를 띄우고
  spec을 **JSON over stdin**으로 전달(Codex 패턴). 빌드는 별도 Rust crate
  (`windows-sandbox-rs` 대응)로 cross-compile, optional artifact. node-gyp 불요,
  Bun.spawn으로 호출 → 빌드/배포가 napi보다 단순.
- **B. napi addon(`@quanta/windows-sandbox-native`)** — landlock-native와 완전
  동형. node-gyp/prebuild 필요. helper exe보다 호출 오버헤드 적지만 빌드 복잡.

**권장 A**: helper exe. 이유 — (1) Codex가 broker-process를 택한 것과 정합,
(2) Bun.spawn 한 줄로 호출, (3) napi prebuild 매트릭스(arch×node-abi) 회피,
(4) helper가 죽어도 메인 프로세스 안전. landlock은 in-process 강제가 의미 있어
napi였지만, Windows 토큰 강등은 어차피 자식 프로세스 spawn이므로 broker가 자연스럽다.

### 5.5 Selection wire (`default.ts`)

`spawnImpl`에 darwin/linux 분기 뒤, win32 분기 추가:

```ts
  if (platform === "win32") {
    const native = await detectNativeWindows(nativeCfg)
    if (native !== null) {
      return nativeWindowsOsSandbox(nativeCfg).spawn(spec, policy)
    }
    // helper 부재 → 정직한 degrade (loud). 기존 passthrough byte-identical.
    return passthrough(spec, spawner, {
      sandboxApplied: false,
      degradeReason:
        "win32-sandbox-helper-missing — install quanta-win-sandbox.exe for isolation (degraded to passthrough)",
    })
  }
```

`availabilityImpl`도 동일 분기 — helper 있으면
`{ backend: "windows-restricted-token", warnings: [] }`, 없으면
`{ backend: "passthrough", warnings: ["win32: quanta-win-sandbox.exe not found — degraded to passthrough"] }`.

**default-OFF / byte-identical 보장**: helper 미설치 Windows 사용자는 이전과
**완전히 동일한 passthrough**. 단지 `degradeReason` string만 더 구체화될 뿐
(이전 `unsupported-platform:win32` → 새 actionable hint). sandboxApplied=false,
exit/stdout/stderr 동일. profile=`off`는 모든 플랫폼에서 degradeReason 없는 순수
passthrough 유지.

### 5.6 Type union 변경

`types.ts:61`:

```ts
export type SandboxBackend =
  | "seatbelt"
  | "bubblewrap"
  | "landlock+seccomp"
  | "windows-restricted-token"   // NEW
  | "passthrough"
```

`SandboxProfile`/`SandboxPolicy`는 **변경 없음** (OS-중립). `seccompMode`는
Windows에서 무시(문서 1줄 추가).

---

## 6. Path / network mapping (상세)

### FS
- `workspace-write`: helper가 workspace 디렉터리에 대상 토큰 SID로 **명시 write
  ACL grant**(`SetNamedSecurityInfo` 또는 토큰 SID가 이미 owner면 integrity만
  Low로). 시스템 경로는 Low integrity로 자동 write-deny(Windows mandatory
  integrity control — Low 프로세스는 Medium/High 객체 write 불가).
- `extraWritePaths`: 동일하게 write grant. `extraReadPaths`: read 허용(Low는
  대부분 read 가능, 단 deny-read resolver가 우선).
- **deny-read resolver** (Codex `deny_read_resolver.rs` mirror):
  `denyReadPaths`에 든 경로(예: `%USERPROFILE%\.aws`, `.ssh`, 자격증명 store)는
  **명시 deny ACE** 또는 helper 레벨 차단. quanta는 기본 deny-read 목록을 pure
  core에서 합성(비밀 디렉터리 휴리스틱은 쓰지 않고, **명시 정책 입력**만 — memory
  `no-heuristics-only-validated` 준수). v1은 빈 목록 + policy 확장점만 제공.

### Network
- **1순위 — managed egress proxy 연동** (quanta ADR-0428): allowNetwork=false면
  helper가 대상 프로세스 env에 프록시 강제(또는 loopback-only) + 외부 connect를
  proxy deny로. Codex "managed network proxy for sandbox change" mirror.
- **2순위 — WFP/firewall rule**: helper가 프로세스별 outbound block rule. 단
  per-process WFP는 SID 매칭이 까다롭고 admin 가능성 → **v1 비채택**.
- **degrade**: 네트워크 강제가 불가능한데 정책이 deny를 요구하면 →
  `degradeReason: "win32-network-policy-not-enforced"` + spawn은 진행(landlock-cli
  `--network-deferred` 패턴과 동일한 honest degradation). **fail-closed 아님,
  warn** (기본). fail-closed는 별도 knob으로 opt-in 가능(§7).

### 자원 캡 (Job Object)
- `memoryMb` → `JOBOBJECT_EXTENDED_LIMIT_INFORMATION.ProcessMemoryLimit`.
- `timeoutMs` → helper watchdog + Job kill-on-close(메인이 죽으면 자식도 종료).
- native 부재 시 timeout은 기존 AbortSignal 경로만, memoryMb는 unenforced+warn.

---

## 7. Edge cases

| Case | 처리 |
| --- | --- |
| **helper exe 부재** | passthrough + loud `degradeReason`(actionable install hint). byte-identical. (§5.5) |
| **경로에 공백** | JSON-over-stdin이므로 argv quoting 불요. helper가 Win32 API에 wide-string 그대로 전달. (argv 직렬화 택할 경우만 quoting 필요 — JSON 권장 이유.) |
| **UNC 경로 (`\\server\share`)** | pure core는 verbatim 보존(escape 없이 JSON string). helper가 UNC ACL grant 시도; 실패하면 해당 경로만 degrade-warn. workspace가 UNC면 write grant 불가 가능성 → `degradeReason: "win32-unc-workspace-unsupported"` + read-only로 강등 또는 passthrough(정직 보고). |
| **네트워크 토글 미지원** | 기본 warn(`win32-network-policy-not-enforced`) + spawn 진행. opt-in `failClosedOnNetwork` knob(native config)이 true면 spawn 거부(exitCode 127, degradeReason). 기본은 사용자 차단 안 함. |
| **timeout/memory 캡 (native 부재)** | timeout=AbortSignal만, memory=unenforced+warn. native 있으면 Job Object. |
| **danger-full-access** | compile→null, passthrough, degradeReason 없음(사용자가 명시 opt-out). |
| **drive 루트/심볼릭/junction** | helper가 reparse point 처리; v1은 junction을 따라가지 않고 named target ACL만. 한계 문서화. |
| **helper 비정상 종료** | `degradeReason: "win32-sandbox-helper-failed:<status>"`, exitCode 127, never throw (Codex "fs sandbox helper failed with status" mirror). |

---

## 8. Test plan (hellgate)

핵심 원칙: **pure core는 어느 OS에서나 테스트, native 경로는 mock/gate.**

### 8a. Pure — `windows.ts` compileWindowsSandboxSpec (모든 OS에서 실행)
- profile별 spec 컴파일 정확성 (read-only=write deny, workspace-write=workspace
  write grant, -net=allowNetwork true).
- `off`/`danger-full-access` → `null` (caller wrap 안 함 계약).
- extraRead/Write 경로 resolve (절대 verbatim / 상대 workspace-join).
- allowNetwork 오버라이드 규칙 (profile vs override).
- memoryMb/timeoutMs exactOptional spread (omit when undefined).
- seccompMode 무시 확인.
- denyReadPaths 합성(명시 입력만).
- **adversarial**: 공백/UNC/`"`/`\` 경로 → JSON-safe 직렬화, 깨지지 않음.

### 8b. Native adapter — `windows-native.ts` (모든 OS, fake binding 주입)
- binding null → 모든 spawn `degradeReason: "native-binding-unavailable"`,
  sandboxApplied=false (landlock-native mirror).
- fake binding이 성공 result → mapResult 정확.
- binding throw → exitCode 127 + `degradeReason: "native-binding-threw"`, never throw.
- `availability()` JSON parse (available/osBuild/reason).
- `detectNativeWindows` never throw, null on absence.

### 8c. Selection — `default.ts` (platform override로 OS-독립)
- `cfg.platform="win32"` + binding 없음 → passthrough + actionable degradeReason.
  **byte-identical**: sandboxApplied=false, exit/out/err가 fake spawner 결과와 동일.
- `cfg.platform="win32"` + fake binding → native 경로 사용, sandboxApplied=true.
- `availabilityImpl` win32: helper 있음→`windows-restricted-token`, 없음→`passthrough`.
- **non-win32 회귀 0**: darwin/linux 분기 그대로(기존 테스트 green 유지).
- profile=`off` on win32 → degradeReason 없는 순수 passthrough.

### 8d. Integration (win32 게이트 — `process.platform === "win32"` 시만)
- 실 helper exe로 read-only에서 workspace 밖 write 시도 → 차단(EACCES류).
- workspace-write에서 workspace 내 write 성공 / 밖 실패.
- workspace-write-net에서 outbound 허용 / workspace-write에서 차단(proxy).
- memoryMb 초과 → Job Object kill.
- **CI 비용 솔직히**: Windows runner 필요. macOS/Linux CI에서는 skip + 8a~8c가
  주 커버리지. (landlock integration이 Linux-only로 gate되는 것과 동일.)

---

## 9. File-by-file change list

| File | 변경 | 비고 |
| --- | --- | --- |
| `src/runtime/os-sandbox/windows.ts` | **NEW** | pure core: `compileWindowsSandboxSpec` + `WindowsSandboxSpec` 타입 + `serializeWindowsSpec`(JSON). seatbelt.ts mirror. I/O 없음. |
| `src/runtime/os-sandbox/windows-native.ts` | **NEW** | native boundary: `WindowsSandboxBinding`/`NativeWindowsConfig`/`detectNativeWindows`/`nativeWindowsOsSandbox`. landlock-native.ts mirror. helper exe(권장) 또는 napi. |
| `src/runtime/os-sandbox/types.ts` | EDIT (~1줄) | `SandboxBackend`에 `"windows-restricted-token"` arm 추가. `seccompMode` doc에 "Windows 무시" 1줄. |
| `src/runtime/os-sandbox/default.ts` | EDIT (~1블록) | `spawnImpl`/`availabilityImpl`에 win32 분기. `NativeLandlockConfig` → `NativeWindowsConfig` 합성 또는 별도 cfg 필드. |
| `src/runtime/os-sandbox/index.ts` | EDIT | windows.ts/windows-native.ts public export. |
| `docs/decisions/0435-windows-sandbox-backend.md` | **NEW** | ADR. |
| `docs/10.feature-catalog.md` | EDIT | fc row 1개 추가. |
| `tests/.../os-sandbox-windows-*.hellgate.test.ts` | **NEW** | 8a~8c (OS-독립). 8d는 win32 gate. |
| (배포) `windows-sandbox-rs/` 또는 `@quanta/windows-sandbox-native` | **별도 artifact** | optional. 이 RFC 범위는 TS 슬라이스 + 경계 인터페이스까지. helper 빌드는 follow-up. |

**slice-fence**: 변경은 `src/runtime/os-sandbox/` 내부 + types/default/index 3파일.
다른 plane mutate 없음. default-OFF.

---

## 10. Effort / 순서

- **L1 (pure core)**: `windows.ts` + 8a 테스트. ~0.5d. OS-독립, 즉시 머지 가능,
  default-OFF (selection이 아직 안 부르므로 dead-but-safe).
- **L2 (native boundary + selection)**: `windows-native.ts` + default.ts 분기 +
  8b/8c. ~0.5d. binding 부재 시 passthrough byte-identical.
- **L3 (helper exe / napi 빌드)**: Rust crate cross-compile + 8d integration.
  ~수 일, **별도 트랙** (landlock-native가 napi 빌드를 별 ADR로 분리한 것과 동일).
  본 RFC는 L1+L2까지를 SHIP 범위로 제안하고 L3는 follow-up backlog.

**합집계 (L1+L2)**: ~1d, +~40 unit/hellgate, tsc 0 / biome 0, 회귀 0.

---

## 11. SOTA++ 체크

- ✅ **pure policy-compilation core** (`compileWindowsSandboxSpec`) — OS-독립,
  unit-testable (seatbelt.ts mirror).
- ✅ **native boundary 격리** (`windows-native.ts` 단일 파일, landlock-native mirror,
  cheap probe + never-throw degrade).
- ✅ **closed-port DI** (`cfg.binding`/`cfg.bindingLoader`/`cfg.platform` 주입).
- ✅ **default-OFF / byte-identical**: helper 미설치 = 현행 passthrough 동일,
  degradeReason string만 actionable화. profile=`off`는 순수 passthrough 유지.
- ✅ **slice-fenced**: os-sandbox 내부 + 3 파일 edit.
- ✅ **honest degradation**: 네트워크/메모리 미강제 시 fail-closed 아닌 warn(기본)
  + opt-in fail-closed knob. landlock-cli `--network-deferred` 패턴 일관.
- ✅ **no-heuristics**: deny-read 목록은 명시 정책 입력만, 비밀-디렉터리 추정 안 함.

## 12. 솔직한 결론

이 배치에서 **가장 낮은 ROI**. 진짜 격리(L3)는 native helper 빌드를 요구하고,
그게 없으면 L1+L2는 "정직한 타입+경계+degrade"에 그친다. 그럼에도 머지 가치는:
(1) Windows가 macOS/Linux와 **표면 패리티**를 갖고 `availability()`가 정직하게
백엔드를 보고, (2) helper가 준비되면 selection이 자동으로 native를 집어 쓰므로
**L3가 와이어 변경 없이 활성화**, (3) "선언만 하고 미구현" 갭(실은 타입에도 없던
갭)을 닫는다. L3 native helper 빌드는 ROI가 확실해질 때(Windows 네이티브 사용자
신호)까지 backlog에 두는 것을 권장한다.
