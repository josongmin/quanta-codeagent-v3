# ADR-0529: 크로스플랫폼 셸 실행 SOTA++ — POSIX-우선 발견 ladder + dialect-aware 보안 + darwin서 검증가능한 설계 (P16 승급)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **슬라이스**: `@/runtime/shell-argv`(발견 ladder + dialect 반환) · NEW `@/runtime/shell-discovery`(순수 셸-프로브 포트) · `@/runtime/shell-snapshot`(per-dialect 캡처) · `@/permission`(dialect-aware deny-rule 매처) · `@/runtime/shell`(wire). 
- **게이트**: `QUANTA_WIN_SHELL`(P16이 정의: `error|cmd`) 확장 → `error|auto|bash|pwsh|cmd`. default `error`(loud-refuse, **byte-identical to P16**). 비-win32는 게이트 무관(POSIX 고정, env 미read).
- **관련**:
  - 승급 대상: **P16**(`src/runtime/shell-argv.ts` — ADR 없이 jun-08 랜딩; "deliberately NOT a full Windows port" 명시). 본 ADR이 그 최소버전을 풀 크로스플랫폼 레이어로 승급.
  - 재사용(신축 금지): `src/runtime/shell.ts:160`(`buildBaseShellArgv` wire site) · `src/runtime/shell-snapshot/bash-capture.ts`(ADR-0204 SnapshotSpawner — POSIX 셸 재사용) · `src/permission/classifier.ts`(LLM 보안 모니터 — 이미 shell-agnostic) · HARD_DENY 결정 규칙([[jun-06-permanent-guards]])
  - 메모리: `implementation-baseline-from-competitors`(CC/Codex 흡수→확장), `surface-model`(multi-surface), `no-heuristics-only-validated`

## Context

현재 P16(`shell-argv.ts`)은 **"silent fail 방지"만**: win32 default는 loud-refuse(typed error 127), `QUANTA_WIN_SHELL=cmd`만 cmd.exe fallback. 주석이 "deliberately NOT a full Windows port"로 자인. 결과: **Windows 유저는 셸 도구를 거의 못 씀** — cmd.exe opt-in은 bash와 의미가 달라(quoting/연산자/내장명령) 위험하고, 보안 파서·스냅샷도 bash 가정.

핵심 제약 = **개발기가 darwin이라 Windows 실제 실행을 테스트 못 함**(P16이 보류된 진짜 이유). SOTA++의 결정적 move: **결정 로직(셸 선택 / dialect 분류 / quoting / deny-rule)을 `platform`·`which()`·`spawn` 주입으로 순수화** → macOS에서 전 결정로직을 unit-test로 봉인(실제 spawn만 본질적 미검증, 정직히 문서화).

경쟁사 베이스라인:
- **Claude Code (Windows)**: Git-Bash 우선(POSIX 의미 보존) → 없으면 안내. **POSIX 셸 선호 = 기존 보안/스냅샷/quoting 그대로 재사용**.
- **Codex**: 셸 추상화 + seatbelt(플랫폼별 샌드박스).
- **흡수**: **POSIX-우선 ladder**. Git-Bash/WSL이 PATH에 있으면 win32에서도 darwin/linux와 **byte-identical 경로**(보안 classifier·HARD_DENY·snapshot·quoting 전부 unchanged, 추가 위험 0) → 없을 때만 native(pwsh/cmd) dialect 분기.

보안 레이어 현황(중요):
- `classifier.ts`의 **LLM 보안 모니터는 이미 shell-agnostic** — 명령 텍스트를 LLM이 추론하고, `pwsh -EncodedCommand`·base64 decode·composite(`&&`/`||`/`;`/`&`) 규칙을 이미 포함(line 112/119). dialect 무관 동작 → **변경 불필요**.
- 별도 **결정적 HARD_DENY 규칙**(bash-syntax: `rm -rf`, redirect 등)만 dialect 인지가 필요.

## Decision

### L1 — POSIX-우선 셸 발견 ladder (win32, gate `auto`)

주입된 `ShellDiscoveryPort`(`which(name) → path | null`, **순수**: 프로브 결과를 인자로 받음)로 ladder:

```
win32 + QUANTA_WIN_SHELL=auto:
  1. POSIX  : which(bash) [Git-Bash/WSL/MSYS2]  → ["bash","-lc",cmd]   dialect=posix  ★darwin/linux와 byte-identical
  2. pwsh   : which(pwsh|powershell)             → ["pwsh","-NoProfile","-NonInteractive","-Command",cmd]  dialect=powershell
  3. cmd    : (최후)                              → ["cmd.exe","/d","/s","/c",cmd]  dialect=cmd
  전부 null → 기존 typed error(127, P16 메시지)
반환: { kind:"argv", argv, dialect } | { kind:"error", reason }
```

- **POSIX 우선이 ROI의 핵심**: Git-Bash 유저는 즉시 full parity(전 보안·스냅샷·quoting 재사용, 0 추가 표면). native dialect는 그게 없을 때만.
- `buildBaseShellArgv`를 `(command, platform, probe, winShell) → ShellArgvDecision`로 **순수 확장** — `process.platform`·`which`·`spawn` 미접촉. darwin서 fake probe로 전 ladder 분기 테스트.

### L2 — dialect-aware 보안 → **구조적 결론: dialect는 보안 입력이 아니다 (NEW CODE 불필요)**

> **jun-09 재검토 (구조적 해결):** 초안은 결정적 HARD_DENY 매처에 dialect별 위험표(pwsh `Remove-Item -Recurse -Force` 등)를 넣으려 했으나 — **보안 게이트가 이미 shell-agnostic이라 구조적으로 불필요**:
> - quanta 보안경계는 ① **user-ask**(비-auto 모드: 모든 mutating 셸 명령을 사용자가 승인 — pwsh/cmd 포함) ② **LLM ClassifierPort**(auto 모드: `CLASSIFIER_SYSTEM_PROMPT`이 명령텍스트를 dialect 무관 추론, `pwsh -EncodedCommand`·base64까지 이미 규칙화). **둘 다 dialect를 안 본다.**
> - 결정적 bash-syntax HARD_DENY(`rm -rf`)는 pwsh 명령에 안 매칭되지만, 그건 **fast-path 백스톱이 안 탈 뿐 silent-allow가 아님** — pwsh 위험명령은 여전히 user-ask 또는 LLM-classifier로 간다(보안구멍 0).
> - pwsh/cmd 결정적 위험표를 **새로 발명하는 것은 Windows 실행을 검증할 수 없는 휴리스틱**([[no-heuristics-only-validated]] 위반) + 이미 상위 게이트가 커버하는 중복. → **명시적 non-goal.** dialect의 정당한 소비처는 보안이 아니라 snapshot/observability(L3·future).
> - 불변식: 어떤 dialect서도 mutating 셸이 게이트를 우회 못 함 — 기존 user-ask/classifier 경로가 dialect-무관하게 보장(별도 hellgate 불요, 기존 권한 hellgate가 cover).

### L3 — per-dialect snapshot → **구조적 결론: non-posix = no-snapshot degrade (이미 안전)**

> **jun-09 재검토:** `dialect`별 스냅샷 어댑터 매핑이 구조적 정답이고, 이미 안전하게 성립:
> - `posix`(darwin/linux/Git-Bash/WSL): `bash-capture.ts`(ADR-0204) 재사용 — 변경 없음.
> - `powershell`/`cmd`: 스냅샷 시스템은 bash/zsh 전용이라 **non-posix는 자동으로 no-snapshot(env 상속만)** — SnapshotSpawner no-throw degrade 계약 그대로. 명령은 실행되고, 사용자 `$PROFILE` 함수만 미주입(저ROI).
> - 신규 `powershell-capture`(`$PROFILE` dump)는 **Windows 실행 검증 불가 + 저ROI** → **명시적 non-goal**(억지로 검증불가 spawn-args를 짜지 않는다). dialect 반환값은 이 future 어댑터 선택의 seam으로 남는다(dead 아님 — 구조적 분기점).

### L4 — darwin 검증가능 설계 (SOTA++ 핵심)

- ladder·dialect-classify·quote·deny-rule을 **전부 순수 함수**로: 입력 = `(command, platform, probeResult, winShell, dialect)`. process.platform/which/spawn 주입.
- darwin서 `platform:"win32"` + fake probe(`{bash:null, pwsh:"C:\\...ps.exe", cmd:"..."}`)로 **전 ladder 분기 + dialect deny-rule + quoting을 unit-test**.
- 실제 win32 spawn만 미검증 — **플랫폼 본질적 한계**라 정직히 문서화(`@platform-untested` 마커). 단 **전 결정로직은 순수-테스트로 검증**: win32 분기의 모든 decision(ladder 4분기·dialect 태그·discoverShells fallback·explicit bash/pwsh argv·error 경로)이 `shell-discovery-ladder-hellgate`로 커버됨(mutation으로 teeth 확인). (자동 coverage-fence ratchet은 후속 — 현재는 hellgate가 봉인.)

## 아키텍처 불변식 (ratchet)

1. **비-win32 byte-identity**: `platform !== "win32"` ⇒ `["bash","-lc",cmd]` 그대로, env 미read, allocation 불변(P16 보장 유지). 
2. **default `error` 유지**: gate 미설정/오타 ⇒ loud-refuse(P16). `auto`/`pwsh`/`cmd`는 명시 opt-in.
3. **보안 단조성**: dialect 추가가 HARD_DENY를 절대 loose화 못 함 — cross-dialect hellgate로 증명. POSIX 외 불명확 ⇒ LLM 승급(fail-closed).
4. **win32 결정로직 순수-테스트 봉인**: spawn 외 모든 분기가 darwin서 `shell-discovery-ladder-hellgate`로 mutation-검증됨(자동 coverage-fence ratchet은 후속 강화 항목 — 현재는 hellgate가 그 역할).

## 단계

- **P0 (L1 ladder + L4 순수설계, gate `QUANTA_WIN_SHELL=auto`)**: 발견 ladder + dialect 반환 + `ShellDiscoveryPort` + darwin fake-probe 전-분기 테스트. POSIX-우선이라 Git-Bash 유저 즉시 full parity. TDD red-first.
- **P1 (L2 보안) → 구조적으로 CLOSED, NEW CODE 불필요**: 게이트(user-ask/LLM-classifier)가 이미 shell-agnostic이라 dialect는 보안입력 아님. pwsh/cmd 결정적 위험표 발명은 검증불가 휴리스틱 + 중복 → non-goal(위 L2 재검토).
- **P2 (L3 snapshot) → 구조적으로 CLOSED**: posix=bash-capture 재사용, non-posix=no-snapshot degrade(이미 안전). powershell-capture는 검증불가·저ROI non-goal. dialect 반환값=future 어댑터 선택 seam.

각 단계 독립 PR. P0이 단독으로 Git-Bash 유저에게 full 셸 parity 제공.

## Default posture / 안전성

- default `error`(P16 그대로). 비-win32 byte-identical.
- POSIX-우선이라 보안표면 확장 최소(Git-Bash = 기존 검증된 경로). native dialect는 fail-closed.
- 실제 Windows spawn 미검증은 darwin 한계로 정직히 문서화 — 단 전 결정로직 순수-테스트 봉인이라 "검증 불가라 보류"의 진짜 블로커를 해소(로직은 검증됨, 실행만 미검증).

## 대안 (기각)

- **cmd.exe만 확장**(P16 연장): bash 의미와 달라 유저 함정 + 보안 파서 미적용. POSIX-우선 ladder가 우월.
- **Windows 전용 보안 파서 풀 재작성**: LLM classifier가 이미 shell-agnostic이라 불필요 — 결정적 규칙만 dialect 테이블로 보강.
- **WSL 강제**: 환경 의존 과대. ladder의 POSIX 후보 중 하나로만.
- **실제 Windows CI 셸 게이트**(darwin서 검증 불가 해소책): GitHub Actions windows-runner로 실 spawn smoke를 추가할 수 있으나 본 ADR 범위 밖(인프라). 순수-테스트로 로직 봉인이 선행 — CI 실행검증은 후속 옵션.
