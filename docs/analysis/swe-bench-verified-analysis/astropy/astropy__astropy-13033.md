---
instance_id: astropy__astropy-13033
repo: astropy/astropy
base_commit: 298ccb478e6bf092953bca67a3d29dc6c35f6752
version: "4.3"
difficulty: "15 min - 1 hour"
created_at: 2022-03-31T23:28:27Z
fail_to_pass: 1
pass_to_pass: 20
gold_files: [astropy/timeseries/core.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약

`TimeSeries`에 `time` 외에 추가 필수컬럼(`_required_columns`)이 설정된 상태에서 그중 하나를 `remove_column`으로 지우면, 검증 실패 예외 메시지가 오해를 부른다. 실제로는 `expected 'time' as the first columns but found 'time'`처럼 항상 첫 원소(`required_columns[0]`)만 출력해서, 무엇이 빠졌는지 알 수 없는 자기모순 메시지가 나온다. 메시지가 단일 필수컬럼(`time` 하나)만 있다는 암묵 가정 위에 만들어졌기 때문. 기대는 빠진 필수컬럼 전체를 알려주는 메시지.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 코드 줄(`core.py#L77-L82`)을 직접 링크하고 함수명(`_check_required_columns`)·메시지 문자열까지 명시. grep 한 방. 점수 = L0.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, "스칼라일 때는 `'x'`, 1개 리스트는 `'x'`, 다중일 때는 `['x','y']` 전체" 라는 *올바른 표현 규칙*을 추론해 합성해야 한다. 단순 상수/기본값 치환(S1)이 아니라 입력 형태(스칼라/길이1/길이N)에 따른 분기 불변식을 따져야 함. 점수 = S2.
- **K-Gen**: timeseries 도메인 지식 불필요. 순수 파이썬 문자열 포매팅·`__len__`/슬라이싱 추론으로 충분. 점수 = K-Gen.
- **Primary = T-ConstraintReason**: 위치는 L0로 명확하나 난점이 "메시지 표현 규칙을 케이스별로 올바르게 합성"하는 S2 추론에 있음. APR 관점에서 단순 템플릿 매칭(None가드/경계)으로 안 풀리고, 출력 형태에 대한 작은 불변식 설계가 본질이라 Constraint-Reasoning.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일수 1 / 함수 1 / 순증 ~10줄(헬퍼 7줄 + 메시지 포맷 교체). scope는 T1~T2급.
- localize 직접성: L0 (이슈가 줄번호 링크) → 위로 미는 요인 없음.
- has-repro: 재현코드 + 실제 잘못된 메시지 텍스트 둘 다 제공 → easiness 강신호.
- 그럼에도 T2가 아닌 이유: 픽스가 상수 치환이 아니라 **스칼라/길이1/길이N 3분기 표현 규칙을 새로 설계**해야 하고(S2), FAIL_TO_PASS가 정확한 메시지 문자열(`['time', 'a']` ... `['time', 'b']`)을 byte-exact로 요구해서 포맷을 정밀히 맞춰야 한다. 단순 "리스트 통째로 print"하면 따옴표·길이1 케이스에서 기존 테스트(단일 `'time'` 메시지)를 깨뜨림.
- P2P trap: 같은 `test_required_columns`가 기존 단일컬럼 메시지(`'time'` 따옴표 형식)도 검증하므로 새 헬퍼가 길이1·스칼라에서 *기존 따옴표 포맷을 보존*해야 한다(regression-trap).

공식 라벨 "15분-1시간"과 일치. T3로 본 건 S2 추론 + 메시지 byte-exact 제약 때문.

## 골드패치 분석

- **파일/함수**: `astropy/timeseries/core.py`의 `BaseTimeSeries._check_required_columns`.
- **근본원인**: `else` 분기의 `raise ValueError`가 `required_columns[0]`와 `self.colnames[0]`만 포맷에 넣어, 필수컬럼이 여러 개일 때 첫 원소만 비교/표시 → "expected 'time' ... but found 'time'"라는 무의미·오해 메시지. 메시지가 단일 필수컬럼 가정에 묶임.
- **수정요지**:
  1. 내부 헬퍼 `as_scalar_or_list_str(obj)` 도입 — `__len__` 없으면 `'obj'`(스칼라), 길이 1이면 `'obj[0]'`(따옴표 단일, 기존 포맷 보존), 그 외엔 `str(obj)`(리스트 전체 `['time', 'a']`).
  2. 메시지를 `required_columns[0]`/`colnames[0]` → `as_scalar_or_list_str(required_columns)` 및 `as_scalar_or_list_str(self.colnames[:len(required_columns)])`로 교체. 비교 슬라이스 길이를 `len(required_columns)`로 맞춰 expected/found가 동일 차원으로 출력됨.

## 검증 (test_patch)

- **FAIL_TO_PASS**: `astropy/timeseries/tests/test_sampled.py::test_required_columns`. 추가 케이스가 `_required_columns = ['time', 'a']`로 두고 `remove_column('a')` 시, 예외 메시지가 정확히 `expected ['time', 'a'] as the first columns but found ['time', 'b']`인지 단언. 즉 다중 필수컬럼 경로에서 새 포맷을 직접 관찰.
- **픽스 증명**: 길이 2 입력 → `as_scalar_or_list_str`가 `str(['time','a'])` 분기로 가 리스트 전체 출력. 동시에 같은 테스트의 기존 단일컬럼 단언(`'time' as the first column ... but found 'banana'`)은 길이1 분기가 따옴표 단일 포맷을 보존해 그대로 통과 → 두 케이스가 한 함수 안에서 함께 green.
- **overfit/regression**: overfit-risk 낮음. 헬퍼가 3분기로 일반화돼 special-case 하드코딩이 아님(다만 추가 테스트가 길이2 한 케이스뿐이라 길이≥3은 미검증 — 그래도 같은 `str()` 분기라 일반화 안전). regression-trap은 기존 단일컬럼 메시지 단언 + 20개 PASS_TO_PASS(초기화/fold/read/periodogram) — 메시지 외 동작은 안 건드려 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `core.py#L77-L82`와 잘못된 메시지 텍스트를 직접 제공 → `_check_required_columns`의 `raise ValueError` 한 곳으로 즉시 수렴(L0). 다른 후보 탐색 불필요.
2. **픽스와 일반화 정당성**: 근본원인은 "첫 원소만 포맷"이므로 expected/found 양쪽을 *필수컬럼 개수만큼*의 표현으로 바꿔야 함. 스칼라/길이1/길이N 3케이스를 분기하는 헬퍼가 올바른 일반화 — 길이1에서 따옴표 단일을 유지해 하위호환을 지키고, 길이N에서 리스트 전체를 보여 정보손실을 없앰. `colnames`도 `[:len(required_columns)]` 슬라이스로 맞춰 expected와 found가 같은 차원으로 대조되게 함.
3. **regression 안전**: 같은 `test_required_columns` 안의 기존 단일컬럼 메시지 단언과, 20개 PASS_TO_PASS(`test_initialize_*`, `test_fold`, `test_read*`, `test_periodogram[*]`)를 깨면 안 됨. 길이1 분기가 옛 따옴표 포맷을 보존하므로 단일컬럼 경로 byte-identical. 검증 로직 자체(컬럼 비교)는 손대지 않아 초기화·읽기 경로 무영향.
4. **함정 회피**: 오라클 없는 에이전트가 흔히 (a) `required_columns`를 통째로 `str()`만 해 길이1에서 `['time']`로 출력 → 기존 `'time'` 따옴표 단언 회귀, (b) `found` 쪽을 슬라이스 안 하고 `colnames` 전체를 찍어 메시지 차원 불일치, (c) 메시지 문구를 "the first column"→"the first columns" 복수형 처리를 빼먹음(테스트가 복수형까지 byte-exact 요구). 핵심은 *길이1 따옴표 포맷 보존 + expected/found 슬라이스 차원 일치 + 복수형*을 동시에 만족하는 것. 골드의 `as_scalar_or_list_str` 3분기가 이 셋을 정확히 커버한다.
