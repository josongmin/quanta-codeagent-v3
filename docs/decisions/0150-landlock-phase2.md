# ADR-0150: Linux sandbox Phase 2 — `bwrap` (bubblewrap) shell-out adapter

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0136 (OS-sandbox helper Phase 1 — Seatbelt + Linux stub), ADR-0093 (effect-channel — 미래 통합 지점), ADR-0006 (runtime 샌드박스 추상화)
- **SOTA 출처**: Cursor `cursorsandbox` (Linux backend = bubblewrap + landlock+seccomp 조합), Codex `codex-linux-sandbox` (Landlock + seccomp; 본 ADR은 user-space 등가물). bubblewrap 자체는 flatpak/sandboxd 산업 표준.
- **참조**: `src/runtime/os-sandbox/{bubblewrap,landlock,default,index,types}.ts`, `tests/unit/os-sandbox-bubblewrap-hellgate.test.ts`

## 맥락

ADR-0136 은 Phase 1 에서 명시적 "not implemented" stub 으로 Linux 백엔드를 남겼다 — `spawnViaLandlock()` 가 항상 degraded passthrough + `degradeReason: "landlock-not-implemented"`. 정직한 강등이지만 **Linux 사용자에게 실제 sandbox 가 0**이라는 의미였다.

Phase 2 옵션 매트릭스 (실제 평가):

| 옵션 | 효과 | 구현 비용 | 유지보수 | 사용자 부담 |
|---|---|---|---|---|
| **napi-rs Native Landlock FFI** | kernel-LSM-level enforcement | N주 + per-arch builds | kernel ABI drift | npm install 시 native compile |
| **`bwrap` (bubblewrap) 셸-아웃** | namespace-level (uts/pid/net/mount) | 1슬라이스 | system 바이너리, 안정 | `apt install bubblewrap` 한 번 |
| **`firejail`** | 비슷; default profile heavy | 1슬라이스 | upstream policy churn | X11 forwarding 등 surprise |
| **Docker/podman 매 호출** | container-level | 0 코드 | docker daemon | per-call 100ms+ 오버헤드 |

bubblewrap 채택. 이유:
1. 동일한 denylist 의미론(`--unshare-net`, `--ro-bind /` + `--bind workspace`) 을 Seatbelt 와 1:1 맵으로 표현 가능.
2. native binding 유지보수 0 — `bwrap`은 11년된 안정 바이너리, 모든 주요 distro 의 official package.
3. Phase 3 에서 native Landlock FFI 가 stable Rust binding 으로 등장하면 `bubblewrap.ts` 만 교체하면 됨 — 정책 → 백엔드 경계가 좁다.

## 결정

`src/runtime/os-sandbox/` 안에서 (다른 슬라이스 미수정):

### 1. `bubblewrap.ts` (신규) — Pure argv compiler

```ts
compileBubblewrapArgs(policy, workspace): string[] | null
```

`compileSeatbeltProfile` 와 동일한 contract — `null` = "이 profile 은 sandbox 안 함, verbatim spawn 하라" (`off` / `danger-full-access`).

Profile → bwrap argv mapping:
- `read-only`           → `--die-with-parent --ro-bind / / --ro-bind <ws> <ws> --unshare-net`
- `workspace-write`     → `--die-with-parent --ro-bind / / --bind <ws> <ws> --proc /proc --dev /dev --unshare-net`
- `workspace-write-net` → 위와 같음 MINUS `--unshare-net`
- `extraReadPaths`      → `--ro-bind <p> <p>` 각 (절대경로만, `/proc`/`/sys` 제외)
- `extraWritePaths`     → `--bind <p> <p>` 각 (절대경로만, `/proc`/`/sys` 제외)

설계 노트 (deliberate):
- `--ro-bind / /` (전체 RO 바인드) + `--bind <ws> <ws>` shadow 패턴 채택 — distro 별로 다른 `/usr/lib`/`/etc`/`/lib64` 위치를 enumerate 하지 않음. Codex `seatbelt-sandbox-profile` 의 "frame works RO subpath" 정신과 동일 (특정 path만 deny 가 아니라 ambient RO).
- `--die-with-parent` 항상 켜짐 — 하네스 crash 후 sandboxed child orphan escape 방지.
- `--proc /proc` + `--dev /dev` 는 `workspace-write*` 만 — `read-only` 에 host process table 누출 방지 (작지만 의도된 hardening).
- `extraReadPaths` 의 상대경로 / `/proc`/`/sys` prefix는 silent skip — bwrap 이 EBUSY 로 죽으면 user-debuggable 하지 않음.

### 2. `landlock.ts` (replace) — Phase 2 entry + back-compat

```ts
isBubblewrapAvailable(which): Promise<boolean>      // 신규
spawnViaBubblewrap(spec, policy, spawner): Promise<Result>  // 신규
isLandlockAvailable(): Promise<boolean>             // legacy alias → false
spawnViaLandlock(spec, policy, spawner): ...        // legacy alias → spawnViaBubblewrap
```

파일명 `landlock.ts` 유지 — 외부에서 보면 Linux 엔트리. 내부 메커니즘(bubblewrap)은 implementation detail. Phase 3 에서 native FFI 가 올라오면 본 파일만 다시 교체.

`spawnViaBubblewrap` 가 핵심: `compileBubblewrapArgs` → `null` 이면 passthrough (`sandboxApplied: false`, **no degradeReason** — opt-out 의도). 그 외 `[bwrap, ...policyArgs, "--", ...userCommand]` 로 spawner 호출, `sandboxApplied: true`.

### 3. `default.ts` (extend) — Linux 분기

```ts
if (platform === "linux") {
  if (await isBubblewrapAvailable(which)) {
    return spawnViaBubblewrap(spec, policy, spawner)
  }
  return passthrough(spec, spawner, {
    sandboxApplied: false,
    degradeReason: "linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)",
  })
}
```

`availability()` Linux 분기:
- `bwrap` present → `backend: "bubblewrap"`, no warnings
- `bwrap` missing → `backend: "passthrough"`, warning `"install bubblewrap for sandbox (apt/dnf/pacman)"` (actionable, distro-agnostic)

### 4. `types.ts` (extend) — `SandboxBackend` 추가

```ts
type SandboxBackend = "seatbelt" | "bubblewrap" | "landlock+seccomp" | "passthrough"
```

`"landlock+seccomp"` arm 은 Phase 3 native FFI 를 위한 placeholder 로 남김 (당장 사용 안 됨 — Phase 2 에서 정직하게 `"bubblewrap"` 로 표시).

## 계약 (4 — Phase 1 6개 + 본 ADR 추가)

1. **NO-THROW** — 변동 없음. spawn 실패 collapse 정책 동일.
2. **off / danger-full-access 의 `degradeReason` 미발생** — `spawnViaBubblewrap` 도 동일 contract.
3. **bwrap 부재 = 정직한 강등** — `"linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)"` 메시지에 install 명령 포함. silent fallback 금지.
4. **Backend 정직** — `availability()` 가 `"bubblewrap"` 으로 보고. `"landlock+seccomp"` 라고 거짓 보고하지 않음 — Phase 3 까지 그 arm 은 unused.

## Hellgate (Phase 2 신규 11 cases)

`tests/unit/os-sandbox-bubblewrap-hellgate.test.ts`:

- **A. compileBubblewrapArgs pure (5)**:
  1. read-only → `--ro-bind workspace` + `--unshare-net`, NO `--bind workspace`
  2. workspace-write → `--bind workspace` + `--unshare-net` + `--proc` + `--dev`
  3. workspace-write-net → 위 minus `--unshare-net`
  4. off / danger → null
  5. extraReadPaths → `--ro-bind p p` 각, extraWritePaths → `--bind p p` 각
- **B. spawnViaBubblewrap runtime (3)**:
  6. happy → argv = `[bwrap, ...policyArgs, "--", ...userCommand]`, `sandboxApplied: true`
  7. off → bypass, 원본 argv 그대로, `sandboxApplied: false`, no `degradeReason`
  8. spawner throw → exit 127 + `stderr` "spawn-failed" + "boom" + `degradeReason: "spawn-failed"`
- **C. defaultOsSandbox Linux integration (3)**:
  9. linux + bwrap present → `backend: "bubblewrap"`, `sandboxApplied: true`, argv prefixed `bwrap`
  10. linux + bwrap missing → `backend: "passthrough"` + "install bubblewrap" warning + degraded spawn with `"linux-bwrap-missing"` reason
  11. linux + danger profile → passthrough regardless of bwrap availability (off-arm 우선)

기존 `os-sandbox-hellgate.test.ts` 의 HELL-B11 / HELL-C16 두 케이스는 Phase 2 의미론에 맞춰 갱신 ("landlock-not-implemented" → "linux-bwrap-missing", "Phase 2" warning → "install bubblewrap" warning). 총 22 (수정 2) + 11 신규 = 33 cases / 0 fail.

## Alternatives rejected

1. **Native Landlock FFI (napi-rs landlock)** — N주 effort + per-arch (x64/arm64/musl) prebuilt 빌드 + kernel ABI drift 유지보수. first-cut Linux 지원에 정당화 안 됨. **Phase 3 ADR** 로 분리 — stable Rust binding (e.g. landlock-rs 1.0) 가 등장하면 재평가.
2. **Firejail** — heavier (1.4MB binary, 200+ default profiles). X11 forwarding 을 기본으로 차단해 GUI 도구 user 가 놀람. bubblewrap 이 더 minimal + predictable.
3. **Docker/podman per-call wrap** — per-spawn container start ~100ms. interactive loop (수십 spawn/turn)에 unacceptable. `DockerSandbox` (ADR-0006) 는 contract-tier 전용 유지.
4. **chroot + setrlimit user-space wrapper** — fork escape 에 무력 (capability/namespace 가 없음). 의미 있는 sandbox 가 못 됨.
5. **system call filter only (libseccomp via FFI)** — Cursor/Codex 가 Landlock 과 **함께** 쓰는 layer. 단독으로는 FS 격리 안 되므로 의미 없음. Phase 3 의 native Landlock FFI 묶음에 같이 들어갈 후보.
6. **profile-uncompilable error 추가** — 현재 `null` return = "verbatim spawn" 이라는 단일 의미. 새 enum 안 추가하고 caller 분기 단순 유지.

## SOTA++ 자리매김

| Agent | macOS | Linux | 의미론 등가 | binding 유지보수 |
|---|---|---|---|---|
| Cursor 3.2 | Seatbelt | bubblewrap + landlock+seccomp | ✅ | Rust binding |
| Codex 0.131 | Seatbelt | Landlock + seccomp (native Rust) | ✅ | Rust binding |
| Claude Code 2.1 | ❌ | ❌ | — | — |
| v0.dev | ❌ | ❌ | — | — |
| **quanta (本 Phase 2)** | Seatbelt | **bubblewrap (shell-out)** | ✅ (denylist parity) | 0 (system bin) |

Phase 2 에서 quanta 는 **Linux sandbox parity 진입**. native FFI 가 아닌 shell-out 이 trade-off — Phase 3 에서 native 로 격상 가능, 단 의미론 동등(denylist) 은 이미 달성.

## 후속

- **Phase 3 ADR — Native Landlock FFI** — stable Rust binding 도입 시점. `bubblewrap.ts` 대체, `landlock.ts` 의 dispatch 만 갱신. `SandboxBackend` 의 `"landlock+seccomp"` arm 활성화.
- **`runShell` 통합** — `ShellOptions.osSandbox?` 슬롯 sibling ADR. Phase 2 가 wire-ready 한 첫 시점.
- **EffectChannel (ADR-0093)** — 모든 effect-tagged spawn 의 sandbox 라우팅. Phase 2 의 Linux 정직성이 prereq.
- **Bubblewrap version probe** — 매우 오래된 `bwrap` 은 `--die-with-parent` 미지원. `bwrap --version` parse + 최소 0.4.0 요구 경고는 hardening 후속.
- **macOS sandbox-exec deprecation 추적** — Apple 이 deprecate flag 를 단 sandbox-exec; future arm64 macOS 에서 대안 필요. 동일 패턴(shell-out 또는 FFI)으로 대응 가능.
