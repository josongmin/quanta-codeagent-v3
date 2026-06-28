# jun-28 — bench knob 소비경로 SSOT 통일 (lean, 적대어딧 정정본)

## 배경 / 진단 정정
선언 SSOT는 jun-27에 완료(KnobSchema 1선언 → inventory/registry derive). **소비**는 3경로로 보이나, 적대어딧 결과 대부분은 정당한 관심사 분리:
- `applyKnobs`(apply.ts) = AgentConfig per-knob fold의 **이미 단일 빌더** (12 non-NOOP knob). 리인벤트 금지.
- `benchPostureFromState`→BenchPosture = orchestration/liveOverrides (51 NOOP knob). AgentConfig 아님 → 중복 아님.
- `lsp`/`hooks`/`subagent` apply는 base AgentConfig 상태(registry/cwd) 의존 → posture 구조체로 못 옮김.

**유일한 진짜 빵꾸**: driver `buildConfigGuards`가 AgentConfig 필드(verifyGuard/lspPrewarm/protectTestPaths/evictLspPoolOnEnd)를 apply층 **우회·중복 set** → merge순서 취약 + `must-pass` override가 `exactCommands` 누락(jun-27 밴드에이드로 임시봉합). `verifyGuard`는 buildConfigGuards(default) + applyMustPass(override) **2곳**에서 set됨.

## 폐기된 원안 (over-reach)
BenchPosture 확장 + `postureToAgentConfig` 신설 → ❌ applyKnobs 리인벤트(중복금지 위반), ❌ state-의존 knob서 깨짐, ❌ 전이중 4경로. **안 함.**

## 타깃 (lean)
AgentConfig 빌드를 **한 흐름**으로: `applyBenchKnobs`(per-knob, 유지) → `reconcileBenchGuards`(cross-knob/instance guard 1회, 유일 권위). `verifyGuard`는 default ⊕ must-pass override를 **한 곳**에서 명시 병합 → exactCommands 누락·merge순서 취약 구조적 소멸.

## 단계
- **S1**: `buildConfigGuards` → `reconcileBenchGuards(cfg, {posture, instance, signal, mustPass})`로 개편. verifyGuard = default(swebench+full→{mustPass,maxTrips:2,exactCommands}) ⊕ mustPass override(stickyRed 포함), 한 곳 병합.
- **S2**: 호출순서 변경 — baseConfig(guard 제외) → `applyBenchKnobs` → `reconcileBenchGuards(applied,…)`. guard는 reconcile가 최종 권위(1곳).
- **S3**: `must-pass`를 bench-surface NOOP화(applyMustPass의 SURFACES에서 bench 제거; 비-bench는 apply 유지). bench verifyGuard는 reconcile가 readKnobValue로 소비. jun-27 exactCommands 밴드에이드 제거.
- **S4**: 테스트 — must-pass.test.ts 갱신, verify-guard 전 hellgate green, **byte-identical fence**(no preset/env ⇒ config 동일), parity, registry.
- **S5 라쳇**: `verifyGuard`/guard 필드를 `reconcileBenchGuards` 밖에서 set 금지(grep ratchet) + AGENTS.md.

## 리스크
- byte-identical(guard 4필드 × must-pass override): S4 fence가 안전망.
- must-pass cross-surface: bench만 NOOP화 — 비-bench 소비자 회귀 확인 필수.
- gateDisabled(process.env,…)는 buildConfigGuards에 이미 있음 → 그대로 이전(신규 raw-env 아님).

## 범위
빌더흐름 1 + buildConfigGuards 개편 + must-pass surface 1줄 + 라쳇. 중간규모, main-direct.
