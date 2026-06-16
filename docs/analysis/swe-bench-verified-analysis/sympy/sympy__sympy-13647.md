---
instance_id: sympy__sympy-13647
repo: sympy/sympy
base_commit: 67e3c956083d0128a621f65ee86a7dacd4f9f19f
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-11-28T21:22:51Z
fail_to_pass: 1
pass_to_pass: 76
gold_files: [sympy/matrices/common.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [regression-trap, has-repro]
---

## 문제 요약
`Matrix.col_insert(pos, other)`가 삽입 블록 오른쪽의 기존 컬럼들을 잘못된 위치에서 가져온다. `eye(6).col_insert(3, V)` 실행 시 삽입된 2컬럼 블록 우측에 와야 할 3x3 단위행렬 부분이 아래 3행이 아니라 위 3행으로 밀려 올라간다. 이슈에 `sm.__version__ '1.1.1'` 재현 코드와 시각적 출력이 그대로 들어 있고, 힌트도 "common.py L89의 `pos`가 거기 있으면 안 된다"고 거의 픽스 위치를 지목한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈가 `col_insert`를 직접 지명하고, 힌트 텍스트가 `sympy/matrices/common.py#L89`을 정확히 가리킨다. grep 한 방으로 `_eval_col_insert`의 마지막 `return`에 도달한다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning).** 고칠 한 줄은 자명하나, 올바른 인덱스 식은 "오프셋을 빼서 추론 합성"해야 한다. 단순 None가드/상수치환(S1)이 아니라, 인덱스 산술의 불변식(삽입 블록 우측 컬럼 `j`는 원본 컬럼 `j - other.cols`여야 함)을 따져야 정답이 나온다.
- **K (Knowledge) = K-Gen.** sympy 도메인 지식 불필요. lazy `entry(i, j)` 콜백의 컬럼 인덱스 매핑이라는 일반 산술 추론으로 충분하다.
- **Primary = T-ConstraintReason.** 위치는 확정(L0)이지만 픽스의 본질이 "어떤 식이 맞는가"의 추론이라 DirectMap이 아니다. 세 분기 중 마지막 분기의 오프셋만 정정하면 되므로 S2가 dominant.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 단일 파일(`common.py`) 단일 함수, gold diff는 1줄 변경(`-1`/`+1` 토큰 한 개), has-repro(시각 출력 포함), K-Gen. localize 직접성이 최상(힌트가 라인까지 지목). 공식 라벨 "15 min - 1 hour"보다 낮게 잡는 이유: 그 시간은 인간이 원인을 처음부터 디버깅하는 비용이고, 오라클/이슈 힌트가 있으면 픽스는 1토큰 추론이다. T1으로 더 내리지 않는 이유는 S1 템플릿(가드 추가/기본값)이 아니라 인덱스 식을 정확히 재유도해야 하고(off-by-`pos` 실수 여지), `test_col_insert` 외 `test_row_insert`·`test_hstack`·`test_diag` 등 76개 P2P가 인접 shaping 동작을 깨지 않도록 묶여 있어 regression-trap이 약하게 존재하기 때문이다.

## 골드패치 분석
- **파일·함수:** `sympy/matrices/common.py` → `MatrixShaping._eval_col_insert` 내부 lazy 콜백 `entry(i, j)`.
- **근본원인:** `entry`는 결과 컬럼 `j`를 세 영역으로 나눈다 — (a) `j < pos` 원본 좌측, (b) `pos <= j < pos + other.cols` 삽입 블록, (c) 그 외 우측 원본. (c)의 매핑이 `self[i, j - pos - other.cols]`로 되어 있어 우측 원본 컬럼을 `pos`만큼 추가로 더 빼버린다. 결과 컬럼 `j`(블록 뒤)는 원본 컬럼 `j - other.cols`에 대응해야 한다 — 삽입으로 우측이 `other.cols`만큼 밀렸을 뿐이고 `pos`는 이미 (a)/(b) 분기 경계에만 쓰여야 한다. 잘못된 `- pos`가 우측 원본을 위로 끌어올려 단위행렬 하단 블록이 상단으로 보이는 증상을 만든다.
- **수정요지:** `return self[i, j - pos - other.cols]` → `return self[i, j - other.cols]`. 잉여 오프셋 `pos` 한 개 제거.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_col_insert`.** 추가된 단언은 이슈 13643/13647 그대로의 케이스: `eye_Shaping(6).col_insert(3, Matrix([[2,2]]*6))`가 기대 8x6(8컬럼) 행렬과 정확히 같은지 검사한다. 기대값은 좌측 3컬럼 단위 + 중앙 2컬럼 2-블록 + 우측 3컬럼 단위가 **대각선 위치를 유지**한 형태라, (c) 분기의 컬럼 매핑이 옳을 때만 통과한다.
- **픽스 증명:** 버그 식은 우측 컬럼을 `pos`만큼 위/좌로 끌어와 단위행렬을 위쪽으로 깨뜨리므로 단언이 fail; 정정 식은 우측 원본을 `other.cols`만큼만 시프트해 대각 위치를 보존하므로 pass.
- **overfit/regression 관점:** 테스트가 단일 케이스로 얇지만(overfit 이론상 우려) 픽스가 인덱스 식의 구조적 정정이라 special-case 통과 여지가 없다 — `pos=3`이 아닌 임의 `pos`/`other.cols`에서도 일반적으로 옳다. 76개 P2P가 `row_insert`·`hstack`·`vstack`·`diag` 등 형상 연산 전반을 커버해 잘못된 과교정(예: 분기 경계까지 건드림)을 잡아낸다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈 제목 `col_insert`로 직행 → `grep _eval_col_insert sympy/matrices/common.py`. 힌트가 L89(`return self[i, j - pos - other.cols]`)를 명시하므로 탐색은 사실상 0. 세 분기 콜백 구조를 읽고 (c) 분기가 우측 원본 매핑임을 확인한다.
2. **픽스와 일반화 근거:** 결과 컬럼 `j >= pos + other.cols`는 원본 컬럼 `j - other.cols`에서 와야 한다 — 삽입은 우측을 정확히 `other.cols`만큼만 밀기 때문. `pos`는 좌측/블록 경계 판정용이지 우측 역매핑에 들어가면 안 된다. 따라서 `- pos` 제거가 off-by-`pos`의 올바른 일반 정정이며, 특정 입력에 맞춘 hack이 아니다.
3. **regression 안전:** (a) `j < pos`와 (b) 블록 분기는 손대지 않아 좌측·삽입부 동작 불변. `test_row_insert`(대칭 연산), `test_hstack`/`test_col_join`(컬럼 결합), `test_diag`/`test_eye`(이번 입력의 구성 요소)가 안 깨져야 함 — 변경이 (c) 한 분기에 국한되므로 안전.
4. **함정 회피:** 오라클 없는 에이전트가 빠질 함정 — (i) 증상("단위행렬이 위로 밀림")을 보고 (a) 분기나 분기 경계 `pos <= j`를 바꾸려는 과교정, (ii) `- pos`만 빼면 될 것을 `+ pos`/`+ other.cols` 등으로 부호를 잘못 잡는 산술 실수. 회피법: 결과 컬럼→원본 컬럼의 역매핑을 작은 예제(`pos=3, other.cols=2, j=5→원본3`)로 손으로 검증하면 `j - other.cols`가 유일 해임이 즉시 확정된다.
