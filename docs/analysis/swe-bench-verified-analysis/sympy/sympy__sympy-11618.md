---
instance_id: sympy__sympy-11618
repo: sympy/sympy
base_commit: 360290c4c401e386db60723ddb0109ed499c9f6e
version: "1.0"
difficulty: "15 min - 1 hour"
created_at: 2016-09-15T20:01:58Z
fail_to_pass: 1
pass_to_pass: 4
gold_files: [sympy/geometry/point.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [overfit-risk, has-repro]
---

## 문제 요약
`Point(2,0).distance(Point(1,0,2))` 가 `sqrt(5)`가 아니라 `1`을 반환한다. 차원이 다른 두 Point의 거리 계산에서 더 긴 쪽의 3번째 좌표가 무시되기 때문이다. 이슈 본문이 원인을 직접 진단해준다: 좌표를 `zip`으로 묶을 때 짧은 쪽에 맞춰 잘려서 `sqrt((2-1)**2 + (0-0)**2)` 만 계산된다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 `distance` 메서드와 `zip` 동작까지 콕 집어줌. grep `def distance` 한 방으로 단일 함수에 수렴. 탐색 비용 0.
- **S2 (Constraint-Reasoning)**: 고칠 줄은 자명하나 픽스가 단순 가드 추가가 아니다. "차원이 다를 때 짧은 점을 0-패딩한 뒤 유클리드 거리"라는 **올바른 수식·조건을 의미적으로 합성**해야 한다. `zip` truncation이라는 불변식 위반을 이해하고 길이 정렬 로직을 새로 써야 함 — 기계적 템플릿 매칭(S1)이 아님.
- **K-Gen**: 순수 파이썬 `zip`/`len` 의미론과 유클리드 거리 정의만으로 충분. sympy 내부 도메인지식 불필요(`Point.args` 접근 정도).
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 핵심 난점이 "올바른 패딩 조건식을 추론으로 짜는 것"에 있어 S2 dominant.

APR 관점: 실패의 근본은 `zip`이 짧은 시퀀스에서 멈추는 silent-truncation 시맨틱. SemFix/Angelix류처럼 입출력 제약(`distance(P3D,P2D)==sqrt(5)`)을 만족하는 식을 합성해야 하므로 generate-&-validate 반복(S3)보다 constraint reasoning이 dominant.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개(`point.py`), 함수 1개(`distance`), 헌크 1개, +14줄 — scope 매우 작음.
- localize 직접성 최상(L0), `has-repro`로 재현 즉시 가능 → easiness 강신호.
- 그러나 단순 None-가드/상수변경이 아니라 **차원 정렬 로직 합성**이라는 실질 추론이 들어가 T2(쉬움)보다 한 단계 위.
- P2P가 4개(`test_point3D`, `test_Point2D`, `test_issue_9214`, `test_transform`)로 좁아 regression-trap 약함.
- 공식 라벨 "15 min - 1 hour"와 일치. localize는 쉽지만 동일차원 경로를 안 깨면서 mismatch 경로를 추가하는 분기 설계에 약간의 시간이 듦.

## 골드패치 분석
- **파일/함수**: `sympy/geometry/point.py` 의 `Point.distance(self, p)`.
- **근본원인**: 기존 한 줄 `sqrt(sum([(a-b)**2 for a,b in zip(self.args, p.args ...)]))` 가 `zip`을 쓴다. `zip`은 가장 짧은 시퀀스에서 멈추므로 `len(p) != len(self)` 일 때 긴 점의 꼬리 좌표가 통째로 누락 → 잘못된(작은) 거리.
- **수정요지**: `distance` 진입부에 `if type(p) is not type(self):` 분기를 추가.
  - 길이가 같으면(`len(p) == len(self)`) 기존 zip 식 그대로 사용.
  - 길이가 다르면 `p1 = [0]*max(len(p),len(self))` 로 0-패딩 버퍼를 만들고, 짧은 쪽 좌표를 채운 뒤(`p1[i] = ...`), 긴 점(`p2`)과 zip하여 누락 차원을 0으로 보정해 `sqrt`. 동일타입이면 마지막의 원래 zip 식으로 fall-through.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_issue_11617`: `Point3D(1,0,2).distance(Point2D(2,0)) == sqrt(5)`. 패치 전엔 `zip`이 2좌표만 묶어 `sqrt((1-2)**2+(0-0)**2)=1` (대칭적으로 이슈의 `Point(2,0).distance(Point(1,0,2))` 케이스), 패치 후엔 `(1-2)**2+0+2**2 = 5` → `sqrt(5)`. 정확히 mismatch 분기를 탄다.
- **픽스 증명**: 새 분기가 누락되던 3번째 좌표 `2`를 0-패딩 상대와 차분하여 `(2-0)**2` 항을 복원함을 보인다.
- **overfit 관점(`overfit-risk`)**: FAIL_TO_PASS가 단 1개이고 `(3D,2D)` 한 방향·정수좌표만 검증. 역방향(`Point2D.distance(Point3D)`), 4D 이상, 심볼릭 좌표, 0이 아닌 패딩값 케이스는 미검증. 골드패치 자체도 `p1[i]` 인덱싱이 길이비교에 의존해 다소 brittle — special-case로 통과 가능한 약한 테스트.
- **regression 관점**: 동일타입 경로는 `if type(p) is not type(self)` 밖이라 기존 zip 식 그대로 → `test_point3D`/`test_Point2D`/`test_transform`이 깨지지 않음. regression-trap 낮음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 "distance", "zipped together", 누락된 3번째 차원을 명시 → `grep "def distance"` → `point.py`의 단일 메서드. 추가 탐색 불필요(L0).
2. **픽스와 일반화**: 근본원인은 `zip`의 shortest-stop 시맨틱. 올바른 일반화는 "두 점을 공통 최대 차원으로 0-패딩한 뒤 성분별 차분 제곱합". 이는 R^n ⊂ R^(n+1)에 누락축을 0으로 임베드하는 표준 정의와 일치 — special-case가 아니라 차원불일치 전반에 맞는 일반해다.
3. **regression 안전**: 같은 차원/같은 타입 경로(`test_point3D` 등)는 반드시 기존 식 그대로 유지해야 한다. 골드패치처럼 길이/타입 동일 분기를 fall-through로 보존하면 인접 동작이 안 깨진다.
4. **함정 회피**: (a) 오라클 없는 에이전트는 FAIL_TO_PASS 1개에 과적합해 `(3D,2D)`만 통과하는 비대칭 코드를 쓰기 쉽다 — `len(p)<len(self)` 분기로 양방향을 모두 처리하는지 자가검증해야 한다. (b) `zip`을 `itertools.zip_longest(fillvalue=0)`로 바꾸는 더 깔끔한 일반화도 정답이지만, `p`가 Point가 아닌 raw 시퀀스/`p.args` 접근 분기를 함께 보존해야 회귀가 안 난다. (c) 단순히 짧은 쪽을 자르지 말고 **긴 쪽을 0-패딩**해야 함 — 방향을 뒤집으면 또다시 좌표 누락.
