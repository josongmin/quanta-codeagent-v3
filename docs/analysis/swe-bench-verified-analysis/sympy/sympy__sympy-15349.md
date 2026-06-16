---
instance_id: sympy__sympy-15349
repo: sympy/sympy
base_commit: 768da1c6f6ec907524b8ebbf6bf818c92b56101b
version: "1.4"
difficulty: "15 min - 1 hour"
created_at: 2018-10-06T19:45:27Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [sympy/algebras/quaternion.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, overfit-risk]
---

## 문제 요약

`Quaternion.to_rotation_matrix()`가 잘못된 회전행렬을 돌려준다. 이슈는 재현코드로 `q = Quaternion(cos(x/2), sin(x/2), 0, 0)`(x축 회전)을 만들고 `trigsimp`한 결과의 `m12`, `m21` 성분이 둘 다 `sin(x)`로 나온다고 지적한다. 올바른 x축 회전행렬이라면 둘 중 하나(`m12`)는 `-sin(x)`여야 한다. 즉 행렬 정의의 한 항에 부호 오류가 있다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 파일·함수·줄번호(quaternion.py L489, `to_rotation_matrix`)를 직접 지목하고, "둘 중 하나는 음수여야 한다"고 결함 위치 클래스까지 못박는다. grep 한 방.
- **S2 (Constraint-Reasoning)**: 픽스 지점은 자명하나 "어느 항을, 어느 부호로" 고칠지는 추론이 필요하다. quaternion→rotation 변환식(Wikipedia 표준 정의)의 불변식을 따져 `m12 = +b·a`가 아니라 `-b·a`임을 확인해야 한다. 단순 가드/기본값 교체(S1)가 아니라 올바른 수식 합성이다.
- **K-Domain**: 사원수-회전행렬 대응이라는 sympy/수학 도메인 지식이 병목. 일반 파이썬 추론만으론 어느 부호가 맞는지 결정 못 한다.
- **primary = T-ConstraintReason**: 위치는 L0로 확정이지만 본질 난점은 "올바른 항·부호를 도메인 불변식으로 추론 합성"하는 데 있다. APR 관점에서 SemFix/Angelix식 의미 기반 단일-식 수정에 해당한다 — 후보를 마구 시도(S3/G&V)하는 게 아니라 정답식을 한 번에 도출하는 문제.

## 난이도 티어

**T3 (중간).** 구조적 피처: gold 1파일·1줄(부호 1개), `has-repro`로 재현 명확(L0). 그러나 `T2`로 떨어뜨리지 못하는 이유는 픽스가 기계적 템플릿(None가드/off-by-one)이 아니라 회전행렬 표준식 대조라는 **도메인 추론**을 요구하기 때문(S2+K-Domain). P2P trap은 약하다(인접 테스트 3개뿐). 공식 라벨 "15 min - 1 hour"와 정합 — 위치 찾기는 즉시지만 올바른 부호를 검증하려면 레퍼런스(Wikipedia 정의) 대조가 필요해 trivial은 아니다.

## 골드패치 분석

- **파일·함수**: `sympy/algebras/quaternion.py`의 `Quaternion.to_rotation_matrix(self, v=None)`.
- **근본원인**: 회전행렬의 `m12` 성분 정의에서 부호가 뒤바뀌어 있었다. 표준 quaternion-derived rotation matrix에서 비대각 성분은 `2s(q_c·q_d ± q_b·q_a)` 형태로, `m12`와 `m21`이 **반대 부호**여야 직교 회전행렬이 된다. 기존 코드는 `m12`도 `m21`과 같은 `+ q.b*q.a`로 적어 두 성분이 동일해졌고, 결과적으로 비-직교(잘못된) 행렬이 나왔다.
- **수정요지**: 단 한 줄. `m12 = 2*s*(q.c*q.d + q.b*q.a)` → `m12 = 2*s*(q.c*q.d - q.b*q.a)`. `m21`(여전히 `+ q.b*q.a`)과 부호를 갈라 직교성을 회복한다.

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_quaternion_conversions`**: 기존 단언의 기대 행렬을 정정한다. `q1.to_rotation_matrix()`의 `[1][2]` 성분이 `S(14)/15` → `S(2)/3`로, augmented 버전의 같은 성분도 `S(14)/15` → `S(2)/3`, 끝열이 `-S(4)/15` → `S(0)`로 바뀐다. 픽스 전에는 `m12`가 틀려 이 값들이 달라지므로 테스트가 실패하고, 부호 수정 후 통과한다.
- **추가 회귀 테스트 `test_quaternion_rotation_iss1593`**: 이슈의 재현 그대로 x축 회전 `Quaternion(cos(x/2), sin(x/2), 0, 0)`을 `trigsimp`해 표준 x축 회전행렬 `[[1,0,0],[0,cos,-sin],[0,sin,cos]]`과 정확히 일치하는지 단언 — 부호가 갈라졌음을 직접 증명한다.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개이고, 두 단언 모두 `m12`의 부호만 건드리는 입력에 집중돼 있어 형식상 `overfit-risk`. 다만 iss1593 테스트가 일반적 x축 회전이라는 의미 있는 케이스를 추가해 special-case 통과를 막는다. P2P 3개(construction/addition/functions)는 `to_rotation_matrix`와 무관해 부호 변경이 깰 여지가 없다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 줄번호·함수까지 줬으므로 `to_rotation_matrix` 본문의 9개 성분 식으로 직행. 재현이 x축 회전(`b≠0, c=d=0`)이라 `m12`/`m21`만 살아남으므로, 두 비대각 성분 정의를 즉시 비교 대상으로 좁힌다.
2. **픽스와 일반화 근거**: Wikipedia의 quaternion-derived rotation matrix 표준 정의와 대조하면 `m12 = 2s(q_c q_d - q_b q_a)`, `m21 = 2s(q_c q_d + q_b q_a)`로 **부호가 반대**여야 한다. 기존 코드의 `m12`가 `+`로 잘못 적힌 것이 유일 결함. `-`로 바꾸는 것은 특정 입력에 끼워맞춘 게 아니라 직교 회전행렬 정의 자체를 복원하므로 올바른 일반화다.
3. **regression 안전**: P2P(construction/complex_real_addition/functions)는 `to_rotation_matrix` 경로를 타지 않으므로 안전. 같은 함수 내 다른 성분(`m10`,`m11`,`m20`,`m21` 등)은 표준식과 이미 일치하므로 건드리면 안 된다 — 변경은 `m12` 한 줄로 한정해야 한다.
4. **함정 회피**: (a) `m12`와 `m21`이 같은 `q.c*q.d`를 공유해 "둘 다 통일해야 한다"고 오판하면 틀린다 — 정답은 둘을 **갈라놓는** 것. (b) `m21`을 음수로 바꾸는 역방향 수정도 테스트를 우연히 못 통과시킬 수 있어 표준 정의로 어느 쪽이 음수인지 못박아야 한다. (c) 기존 테스트의 기대 행렬을 "정답"으로 신뢰하면 안 된다 — 그 기대값 자체가 버그를 박제한 것이므로, 외부 레퍼런스(직교성/회전 불변식)로 검증해야 한다.
