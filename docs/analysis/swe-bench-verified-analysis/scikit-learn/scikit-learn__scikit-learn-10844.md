---
instance_id: scikit-learn__scikit-learn-10844
repo: scikit-learn/scikit-learn
base_commit: 97523985b39ecde369d83352d7c3baf403b60a22
version: "0.20"
difficulty: "15 min - 1 hour"
created_at: 2018-03-21T00:16:18Z
fail_to_pass: 1
pass_to_pass: 16
gold_files: [sklearn/metrics/cluster/supervised.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`fowlkes_mallows_score`가 큰 입력에서 `RuntimeWarning: overflow encountered in int_scalars`를 내고 `nan`을 반환한다. 원인은 `supervised.py:859`의 `tk / np.sqrt(pk * qk)`에서 `pk * qk`가 int32 범위(2**32)를 넘으면 정수 오버플로가 나기 때문이다. 이슈 작성자가 직접 라인 번호와 수정안(`np.sqrt(tk / pk) * np.sqrt(tk / qk)`)까지 제시했다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·라인(`supervised.py:859`)과 정확한 표현식을 직접 지목. grep 한 방, 탐색 불필요.
- **S1 Direct-Map (+S2 보조)**: 이슈 본문이 사실상 픽스를 명세한다 — 결함클래스가 "정수 오버플로(타입 폭 부족)"라는 정형 패턴이고, 템플릿 수정(타입 강제 `astype(np.int64)` / 곱셈 재배치)으로 풀린다. 다만 골드패치는 작성자 제안과 **다른** 표현식을 골랐고(나눗셈을 먼저 분배해 곱 자체를 회피), 두 표현식이 수학적으로 동일함을 확인하는 약한 대수적 추론(S2)이 보조로 들어간다.
- **K-Domain**: numpy dtype 전파 규칙(`contingency_matrix`가 int32 sparse를 내고 `**2`·`sum`이 int32를 유지) 지식이 핵심. 일반 파이썬 int는 무한정밀이라 이 버그가 안 보임 → numpy 정수 의미론을 알아야 근본원인을 짚는다.
- **primary = T-DirectMap**: 위치 명확 + 기계적 타입강제/식변경. 추론보다 "정형 결함 템플릿 매칭"이 본질.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·1함수·실질 2줄(+1줄은 식 동치 변경), L0 직접 localize, `has-repro`(이슈가 오버플로 임계와 nan 증상을 명시). 도메인 지식(numpy dtype)이 끼지만 픽스 자체는 자명해 T3까지 밀지 않는다. P2P 16개가 같은 모듈·같은 함수의 인접 동작(`test_fowlkes_mallows_score`, `_properties`)을 덮어 regression-trap이 약하게 존재 → T2 하한이 아니라 T2 정착. 공식 라벨 "15min~1h"와 정합(개발자 입장에선 동치성 검증·테스트 추가가 약간의 시간). 에이전트 난이도로는 더 쉬움(이슈가 픽스를 적어줌).

## 골드패치 분석
- **파일·함수**: `sklearn/metrics/cluster/supervised.py`의 `fowlkes_mallows_score`.
- **근본원인**: `contingency_matrix(..., sparse=True)`가 int32 dtype 행렬을 반환 → `c.sum(axis=*)**2`와 `np.dot`이 int32로 누적되어 `pk * qk`가 2**32를 넘으면 오버플로 → `np.sqrt(음수/래핑값)`이 nan.
- **수정요지** 두 갈래:
  1. `contingency_matrix(...)` 결과에 `.astype(np.int64)`를 붙여 `c.data`/`tk`/`pk`/`qk` 모든 누적을 int64로 승격 → 누적 단계의 오버플로 차단.
  2. 반환식을 `tk / np.sqrt(pk * qk)` → `np.sqrt(tk / pk) * np.sqrt(tk / qk)`로 변경. `pk*qk`라는 거대 정수 곱을 아예 만들지 않고, 나눗셈을 먼저 분배해 float로 떨어뜨려 곱 단계 오버플로까지 제거. 수학적으로 `tk/√(pk·qk) = √(tk/pk)·√(tk/qk)` (tk,pk,qk≥0)로 동일.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_int_overflow_mutual_info_fowlkes_mallows_score`(기존 `test_int_overflow_mutual_info_score`를 확장 개명). 라벨 분포가 큰 `x,y`를 만들어 `assert_all_finite(fowlkes_mallows_score(x, y))`를 추가 — 픽스 전이면 nan이 나와 `assert_all_finite`가 raise.
- 픽스 증명: int64 승격+식 재배치로 `pk*qk`가 더 이상 int32 래핑되지 않아 유한값 반환 → 단언 통과.
- overfit 관점: FAIL_TO_PASS 1개뿐이라 얇지만, 입력이 실제 오버플로 임계를 넘는 현실 분포라 special-case 통과가 어렵다. `flags`에 `overfit-risk`를 안 단 이유 — 테스트가 nan(=실패증상)을 직접 관찰.
- regression 관점: P2P 16개 중 `test_fowlkes_mallows_score`/`_properties`가 소규모 입력에서의 정확값·대칭/스케일 불변 성질을 검증. 식 동치 변경이 작은 입력 결과를 바꾸지 않음을 이들이 보증.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `supervised.py:859`와 `tk / np.sqrt(pk * qk)`, "overflow in int_scalars", "returns nan"을 직접 명시 → `fowlkes_mallows_score` 한 함수로 즉시 수렴(L0).
2. **픽스**: 근본원인은 numpy 정수 폭(int32) 한계. 올바른 일반화는 (a) `contingency_matrix(...).astype(np.int64)`로 누적 dtype을 승격하고 (b) 반환식을 `np.sqrt(tk/pk)*np.sqrt(tk/qk)`로 바꿔 거대 곱 `pk*qk` 형성 자체를 제거하는 것. 이슈 제안(`pk.astype(int64)*qk.astype(int64)`)이나 hints의 PR(#10414)식 int64 캐스팅도 증상은 막지만, 골드는 누적 dtype을 근원에서 올리고 식 분배로 곱을 없애 가장 견고 → 특정 임계가 아니라 dtype-폭 클래스 전체를 닫음(overfit 아님).
3. **regression 안전**: `test_fowlkes_mallows_score`·`_properties`가 작은 입력의 정확값·불변 성질을 보장하므로, 식이 수학적으로 동치임만 지키면 안 깨짐. int64 승격은 값을 바꾸지 않으므로 안전.
4. **함정 회피**: (a) 식을 안 바꾸고 `astype(np.int64)`만 붙이면 `tk`/`pk`/`qk` 누적은 안전해지나 `pk*qk`는 int64로 더 큰 입력에서 다시 오버플로 가능 — 골드가 곱을 분배 제거한 이유. (b) `pk`,`qk`를 float로 캐스팅하면 정밀도 손실 우려(hints에서 메인테이너가 제기) — int64 경로가 정밀·성능 모두 우위. (c) `tk != 0.` 가드를 건드리지 않아야 함(0 분기 동작 보존). 오라클 없는 에이전트는 "증상만 막는 캐스팅"에서 멈추기 쉬우나, 곱 형성 자체를 피하는 식 재배치가 정답 일반화다.
