---
instance_id: sympy__sympy-22714
repo: sympy/sympy
base_commit: 3ff4717b6aef6086e78f01cdfa06f64ae23aed7e
version: "1.10"
difficulty: "<15 min fix"
created_at: 2021-12-19T18:54:36Z
fail_to_pass: 1
pass_to_pass: 11
gold_files: [sympy/geometry/point.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`with evaluate(False):` 컨텍스트에서 `sp.S('Point2D(Integer(1),Integer(2))')`가 `ValueError: Imaginary coordinates are not permitted.`로 크래시한다. 동일 코드가 `evaluate(False)` 없이는 정상 동작하고, `evaluate=False`를 인자로 직접 줘도 동작한다. 즉 실수 좌표인데도 전역 `evaluate=False` 상태에서만 허수 좌표로 오판되는 회귀다.

## 유형 (정형화)
- **L (Localization) = L1**: 스택트레이스가 `sympy/geometry/point.py`의 line 153 `raise ValueError('Imaginary coordinates are not permitted.')`를 직접 가리킨다. 파일·함수(`Point.__new__`)·정확한 raise 줄까지 명시 — 그러나 "왜 실수인데 걸리나"는 한 단계 추론이 필요해 L0는 아니다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 줄은 자명하지만 올바른 조건식을 추론으로 합성해야 한다. `im(a)`(unevaluated 시 truthy 객체)를 `im(a).is_zero is False`(assumptions 삼치 질의)로 바꾸는 것은 "허수성 판정을 truthiness가 아니라 가정시스템 질의로 해야 한다"는 의미적 추론의 산물이다. 후보 난사(S3)가 아니라 불변식을 따져 푸는 것.
- **K (Knowledge) = K-Domain**: SymPy의 `evaluate(False)` 전역 컨텍스트, `im()`가 unevaluated일 때의 동작, `is_zero`가 `True/False/None` 삼치값을 반환한다는 assumptions 시스템 지식이 핵심이다. 일반 파이썬 추론만으로는 `if im(a)`가 왜 함정인지 못 본다.
- **primary_type = T-ConstraintReason**: 위치는 트레이스로 거의 고정되나, 정답은 "참/거짓이 아니라 삼치(None 포함) 허수성 판정"이라는 올바른 조건 합성에 있다. APR 관점에서 SemFix/Angelix식 의미적 조건수리(angelic value = "실수는 reject하지 않음")에 해당.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개 / 함수 1개(`Point.__new__`) / 실효 변경 1줄 → scope는 T1~T2급.
- has-repro: 최소 재현코드 + 네이티브 스택트레이스 존재(강한 easiness 신호).
- 하지만 픽스가 S1 기계적 가드 추가가 아니라 **조건식의 의미를 바꾸는 S2 추론**이고, K-Domain(`evaluate(False)`/`im` unevaluated/`is_zero` 삼치)이 병목이다. `im(a)` → `not im(a)`처럼 단순 반전하면 오답이며, `is_zero is False`(=`None`이면 통과)라는 삼치 처리를 정확히 맞춰야 한다.
- regression-trap: P2P 11개가 좌표 검증(`test_Point2D`, `test_issue_9214`, `test_point` 등) — 진짜 허수 좌표는 여전히 reject해야 한다. 조건을 느슨하게 잘못 풀면 인접 케이스가 깨진다.
공식 라벨 `<15 min fix`는 "1줄 수정"이라는 patch-scope만 반영한 prior다. localize는 쉽지만 올바른 조건 합성에 도메인 추론이 필요해 T1이 아니라 T3로 올린다.

## 골드패치 분석
- **파일·함수**: `sympy/geometry/point.py`, `Point.__new__`.
- **근본원인**: 좌표 허수 검사가 `if any(a.is_number and im(a) for a in coords)`였다. `evaluate(False)` 전역 컨텍스트에서 `im(Integer(1))`은 `0`으로 평가되지 않고 **unevaluated `im(1)` 객체**로 남는다. 이 객체는 truthy이므로, 실수 좌표인데도 `im(a)`가 참이 되어 `ValueError`를 던졌다. 즉 "허수성"을 파이썬 truthiness로 판정한 것이 결함의 핵심 — 평가 여부에 따라 같은 입력이 다르게 분류된다.
- **수정요지**: 조건을 `a.is_number and im(a).is_zero is False`로 교체. 허수부의 0 여부를 truthiness가 아니라 **assumptions 질의 `is_zero`**로 묻는다. 실수(허수부가 확정적으로 0) → `is_zero is True` → `is False` 비교가 `False`라 통과. 진짜 허수 → `is_zero is False`라 reject. 판정 불가(`is_zero is None`)도 `is False`가 아니므로 **통과**(보수적으로 허용) — 이 삼치 처리가 정답의 미묘점이다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_issue_22684`: `with evaluate(False): Point(1, 2)` — 패치 전에는 unevaluated `im`이 truthy라 `ValueError`, 패치 후에는 `is_zero`가 정수 좌표의 실수성을 정확히 판정해 통과. 테스트는 예외가 안 나는 것으로 픽스를 증명한다(주석: "Used to give an error").
- **픽스 증명**: 테스트가 `evaluate(False)` 컨텍스트 안에서 `Point(1,2)`를 생성하므로, unevaluated `im` 경로를 정확히 타격한다. 표면적 재현(`S('Point2D(...)')` 파싱) 대신 `Point` 직접 생성으로 좁혀 결함 지점을 핀포인트.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 보이나, P2P 11개가 좌표검증 회귀를 막는다. `is_zero is False`라는 일반화는 특정 입력(1,2)에만 맞춘 special-case가 아니라 임의 실수/허수 좌표에 옳게 동작 → CEGIS식 overfit 위험 낮음.
- **regression 관점**: `test_Point2D`/`test_issue_9214`/`test_point` 등이 실제 허수 좌표 reject·정상 좌표 accept를 커버. 조건을 `not im(a)`로 단순화했다면 unevaluated 경우는 고쳐도 허수 reject가 깨질 수 있어 P2P가 적발.

## 모범답안 (오라클 기반)
1. **localize 경로**: 스택트레이스 마지막 프레임 `point.py:153 raise ValueError('Imaginary coordinates...')` → `Point.__new__`의 `if any(a.is_number and im(a) for a in coords)` 조건으로 직행. 핵심 단서는 "`evaluate(False)`일 때만 실패"이므로, `im(a)`가 평가 상태에 의존한다는 가설을 세운다.
2. **픽스와 일반화**: `evaluate(False)`에서 `im(Integer(1))`이 `0`이 아니라 unevaluated truthy 객체임을 확인 → truthiness 판정을 assumptions 질의로 교체. `im(a).is_zero is False`는 (a) 실수=`is_zero True`→reject 안 함, (b) 허수=`is_zero False`→reject, (c) 미정=`None`→reject 안 함, 세 경우 모두 의미적으로 옳다. 평가 여부와 무관하게 동작하므로 올바른 일반화.
3. **regression 안전**: 진짜 허수 좌표(`I` 포함)는 여전히 거부해야 한다 — `test_Point2D`/`test_issue_9214`가 보증. `is_zero is False`는 허수 케이스에서 정확히 reject하므로 인접 동작 보존.
4. **함정 회피**: (a) `if im(a)`를 `if not im(a)`로 반전 → 허수 검사 의미가 뒤집혀 P2P 폭발. (b) `im(a) != 0` → unevaluated 비교가 `True/False`로 안 풀려 여전히 오판. (c) `evaluate(True)`로 강제 재평가하는 우회 → 전역 컨텍스트 의도를 침해. 정답은 좌표 자체를 다시 평가하지 않고 **assumptions(`is_zero`) 삼치 질의로 허수성만 묻는 것**이며, `None`을 reject 쪽이 아니라 허용 쪽으로 분류하는 보수성이 핵심.
