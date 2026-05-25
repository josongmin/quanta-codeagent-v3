# ADR-0295 — bash `mode` parameter + per-call OS sandbox wrap

Status: Accepted
Date: 2026-05-25
출처: Cursor 3.2.16 (`.extracted_source/` audit), `cursor-3.2-absorption` 메모.
참조 ADR: 0136 (OS sandbox helper), 0150 (bwrap fallback), 0175 (native Landlock), 0191 (strict seccomp), 0204 (shell snapshot).
관련 메모: [[no-heuristics-only-validated]], [[codex-seatbelt-sandbox-profile]], [[cursor-3.2-absorption]].

## 컨텍스트

기존 OS sandbox 와이어(`installShellSandbox` / `ShellSandboxSlot`)는 **세션 전역**이다.
`QUANTA_SANDBOX=read-only` 같은 부트 환경 변수가 그 세션의 모든 `runShell` 호출에 동일 정책을 적용한다.
이 모델은 다음을 표현할 수 없다.

> "이 한 번의 bash 호출만은 OS-강제 read-only로 돌고 싶다 — 다른 호출은 그대로 두고."

Cursor 3.2의 `Bash` 도구가 채택한 패턴이 이것이다. 도구 입력에 `mode: "read" | "write"` 가 있고,
`mode="read"` 일 때 OS sandbox로 **호출당** 래핑한다. 감사/사고-방지 용도. 동시성은 별개 차원이다 (SOTA 합의대로 직렬 유지; parallel-safety는 다른 ADR로 분리).

## 결정

`src/tool/bash/index.ts` 의 input schema 에 closed-enum 파라미터 `mode: "read" | "write"` 를 OPTIONAL로 추가한다 (기본 `"write"`, byte-identical legacy). `mode="read"` 일 때:

1. closed-port `PerCallSandboxPort` (`src/runtime/os-sandbox/per-call.ts`) 를 factory로 획득한다 (read-only profile).
2. `port.availability()` 동기 probe로 **호스트가 강제 가능한지** 먼저 확인한다.
   - 강제 불가 (`darwin`인데 `sandbox-exec` 없음 / `linux` 미구현-per-call / 기타 플랫폼) → typed `ToolFailure { mode: "sandbox_unavailable", reason }` 반환 + **spawn 안 함** (fail-closed; 절대 unsandboxed legacy 경로로 fallback하지 않음).
3. 강제 가능 → `runShell` 의 신규 옵션 `perCallWrap` 를 통해 wrap 어댑터를 주입한다. `runShell` 은 이 wrap을 **세션 slot보다 먼저** 적용한다 (per-call → slot → snapshot 순; defense-in-depth).
4. 자식 프로세스의 write/exec/network 시도는 OS (Seatbelt) 가 EACCES / "Operation not permitted" 로 거부한다. tool은 stderr 의 OS 진단 패턴을 closed-enum `SandboxViolationReason` (`write_denied | exec_denied | network_denied | unknown`) 으로 매핑하여 `ToolFailure { mode: "sandbox_violation", reason }` 을 반환한다. **command 문자열은 절대 검사하지 않는다** — OS가 enforcer ([[no-heuristics-only-validated]]).

### closed-port shape (`PerCallSandboxPort`)

```ts
interface PerCallSandboxPort {
  wrap(argv: ReadonlyArray<string>, cwd: string): WrappedShellArgv | Promise<WrappedShellArgv>
  availability(): { supported: true } | { supported: false; reason: string }
}
```

production: `defaultPerCallSandbox("read-only")` — `wrapShellArgv` + 생성-시점 1회 `sandbox-exec` 존재 probe.
test: 페이크 port 주입을 위한 `__setBashPerCallSandboxFactory(factory | undefined)` 모듈-슬롯 DI seam (`src/tool/bash/per-call-factory.ts`).

### `ToolFailure` 확장 (closed-union)

```ts
| { mode: "sandbox_violation"; reason: SandboxViolationReason }  // OS denied a wrapped call
| { mode: "sandbox_unavailable"; reason: string }                // host cannot enforce; fail-closed
```

기존 `tests/unit/agent/tool-failure-mode.test.ts` 의 `never`-default exhaustive switch에 두 case를 추가했다 (drift 발생 시 tsc 컴파일 에러).

### 동시성

`isConcurrencySafe()` 는 **`false` 유지**. SOTA 합의: per-call sandbox는 감사/사고-방지 목적이지 parallel-safety guarantee가 아니다. parallel 진출은 별도 ADR + 측정 후 결정 ([[no-heuristics-only-validated]]).

## 대안

- **A) 세션 전역 slot 재사용** (`installShellSandbox` 만으로 충분).
  거부: 한 호출만 sandboxing 하는 use-case를 표현 불가. 사용자가 모든 호출에 mode를 강제하는 부작용.
- **B) Command-pattern 분류기 (writes vs reads regex 매칭)**.
  거부: 휴리스틱 금지 ([[no-heuristics-only-validated]]). bypass 자명 (`echo > /tmp/x via aliased function`).
- **C) `mode="read"` 시 OS 미지원이면 직렬-only로 폴백**.
  거부: 사용자가 "사고 방지" 의도로 read를 선택한 것을 silently degrade하는 것 = audit posture를 잃음. fail-closed 가 정답.

## 결과

- bash tool은 후방 호환: `mode` 미지정 / `mode="write"` → byte-identical legacy.
- `mode="read"` 는 macOS에서 즉시 작동, Linux는 honest `sandbox_unavailable` (per-call 경로 미구현; 세션 slot 사용 권장 — 추후 ADR로 per-call linux 확장 가능).
- 모델은 closed-enum `failure.mode` 로 분기 가능: 같은 명령을 `mode="write"` 로 재시도하거나 audit failure 로 학습.
- 새 슬라이스 추가물:
  - `src/runtime/os-sandbox/per-call.ts` — closed-port + default impl
  - `src/tool/bash/per-call-factory.ts` — DI seam
  - 30 hellgate (8 schema + violation 분류 + fail-closed + 100-fuzz)
- byte-identical legacy 보존: `ShellOptions.perCallWrap` 가 absent 일 때 `runShell` 동작 변화 0.

## 검증

- 30 hellgate / 0 fail / 60 expect (tests/unit/bash-mode-hellgate.test.ts).
- 기존 bash 회귀 (16 test) / 기존 sandbox 회귀 / `tool-failure-mode` exhaustive switch 모두 그대로 통과 — 95 pass / 0 fail.
- `tsc` slice clean. `biome` slice 0 errors 0 warnings.
- fuzz 100 mutating ops (rm/mv/cp/touch/mkdir/chmod/chown/ln/`>` / `>>` × 6 targets) → 100% `sandbox_violation` (휴리스틱 없이 OS-enforced).

## 미해결

- Linux per-call wrap은 미구현 (`linux-not-implemented-per-call`). 세션 slot 경로로 충분하지만, 사용 빈도가 올라가면 별도 ADR로 async bwrap probe 도입.
- 동시 실행은 의도적으로 미오픈. 데이터를 보고 결정 ([[no-heuristics-only-validated]]).
