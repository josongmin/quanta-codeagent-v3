---
instance_id: django__django-16560
repo: django/django
base_commit: 51c9bb7cd16081133af4f0ab6d06572660309730
version: "5.0"
difficulty: 1-4 hours
created_at: 2023-02-16T10:45:56Z
fail_to_pass: 8
pass_to_pass: 66
gold_files: [django/contrib/postgres/constraints.py, django/db/models/constraints.py]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-16560

## 문제 요약
`BaseConstraint.validate`가 제약 위반 시 `ValidationError`를 던질 때, 메시지(`violation_error_message`)는 커스터마이즈할 수 있지만 `code` 속성은 지정할 수 없었다. 사용자는 폼 검증 가이드(Provide a descriptive error code to the constructor)대로 위반 에러에 식별용 `code`를 붙이고 싶었으나, 현재는 제약을 서브클래싱해 `validate`를 오버라이드하고 에러를 catch & reraise 해야만 했다. validators가 이미 갖춘 메커니즘처럼, 생성자에 `violation_error_code` 파라미터를 추가해 `BaseConstraint`/`CheckConstraint`/`UniqueConstraint`/`ExclusionConstraint` 전반에서 위반 에러 코드를 지정할 수 있게 해 달라는 기능 요청이다.

## 유형 (정형화)

**L = L3 (Multi-site).** 이슈가 `BaseConstraint.validate`와 `violation_error_message`를 직접 지목하므로 진입점 탐색 자체는 쉽다. 그러나 픽스는 단일 지점이 아니라 `BaseConstraint`(SSOT)와 그 3개 서브클래스(`CheckConstraint`/`UniqueConstraint`/`ExclusionConstraint`)의 `__init__`/`deconstruct`/`__repr__`/`__eq__`/`validate`가 2개 파일에 걸쳐 **조율되어 함께** 바뀌어야 한다. 한 메서드라도 빠지면 부분 실패 → 진입점은 L0급이나 수정범위가 L3.

**S = S1 dominant (+S6).** 결함클래스가 "기존 `violation_error_message` 통로를 그대로 미러링하는 새 속성 추가"라 픽스가 사실상 명세돼 있다 — 기존 패턴을 1:1 복제하는 기계적 작업이라 S1(template). 단 단순 가드/상수 한 줄이 아니라 클래스 계층에 새 상태 필드(`violation_error_code`)를 도입해 `__init__`→`super().__init__`→deconstruct/eq/repr/validate 라이프사이클 전반에 배선하는 소규모 구조 변경이므로 S6(파라미터 도입) 보조. 추론으로 새 식을 합성(S2)하거나 테스트 반복으로 후보를 고르는(S3/S4) 성격은 전혀 아니다.

**K = K-Domain.** django ORM constraints 내부 구조(BaseConstraint↔서브클래스 상속, `deconstruct` 마이그레이션 직렬화 계약, `ValidationError(code=...)` 의미, postgres `ExclusionConstraint`가 별도 contrib 파일에서 같은 계층을 미러한다는 사실)를 알아야 완전하게 고친다. 특히 `UniqueConstraint`의 fields-기반 `unique_error_message` 경로가 backward-compat 때문에 code를 받으면 안 된다는 점은 순수 일반 추론으로는 안 나오는 프레임워크 도메인 지식이다.

**Primary type = T-DirectMap.** 위치가 (이슈 + 기존 `violation_error_message` 흐름으로) 명확하고, 픽스가 정형화된 "기존 속성 미러링" 템플릿 매칭이므로 T-DirectMap. 진짜 난점은 추론(T-ConstraintReason)이나 localize 발산(T-DiffuseLoc)이 아니라 **enumeration 완전성**(4클래스×5메서드×2파일 빠짐없이) + fields-경로 예외 처리에 있다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 라벨은 `1-4 hours`(T3~T4 prior)인데 T4로 둔다.

이 티어로 미는 구조적 피처:
- **수정 범위 L3 멀티파일/멀티헌크**: gold patch가 2개 파일(`django/db/models/constraints.py` + `django/contrib/postgres/constraints.py`), 4개 클래스, 각 5개 메서드를 건드린다(헌크 다수). 단일 파일·<5줄 결함이 아니므로 T1~T3은 배제.
- **넓은 P2P trap (regression-trap)**: PASS_TO_PASS 66개로 매우 두껍다. 기존 `__repr__`/`__eq__`/`deconstruct`/`validate` 동작을 하나라도 깨면 다수가 빨개진다. 특히 `test_validate`(UniqueConstraint)는 fields-경로에 code를 잘못 붙이면 깨지는 함정 테스트.
- **도메인 지식 (K-Domain)**: deconstruct 마이그레이션 round-trip 계약, fields-vs-expressions 분기의 backward-compat 의미를 알아야 함.

T5로 올리지 않는 이유: localize 진입점이 명확(L0급)하고 픽스가 추론 합성이 아니라 미러링(S1)이라 overfit/CEGIS 고위험이 없다. FAIL_TO_PASS가 8개로 동작을 충분히 핀다. 따라서 깊은 추론이 아니라 완전성·범위가 난이도의 본질 → T4가 정확.

## 골드패치 분석
**건드린 파일·함수:**
- `django/db/models/constraints.py`
  - `BaseConstraint`: 클래스 속성 `violation_error_code = None` 추가; `__init__(*args, name=None, violation_error_code=None, violation_error_message=None)`로 시그니처 확장(주어졌을 때만 인스턴스 속성 설정); `deconstruct()`가 code를 kwargs에 포함.
  - `CheckConstraint.__init__/validate/__repr__/__eq__`
  - `UniqueConstraint.__init__/validate/__repr__/__eq__`
- `django/contrib/postgres/constraints.py`
  - `ExclusionConstraint.__init__/validate/__repr__/__eq__`

**근본 원인:** `ValidationError`를 생성하는 모든 `validate` 경로가 메시지만 넘기고(`raise ValidationError(self.get_violation_error_message())`) `code`를 받는 통로가 클래스 계층 어디에도 없었다. 기존엔 `violation_error_message`만 인스턴스 상태로 보존·비교·직렬화되고 있었다.

**수정 요지:**
- `BaseConstraint`에 클래스 기본값 `violation_error_code = None` 추가 + `__init__`에 `violation_error_code` 키워드 인자(`if violation_error_code is not None: self.violation_error_code = ...`).
- `deconstruct()`: `if self.violation_error_code is not None: kwargs["violation_error_code"] = ...` → 마이그레이션 round-trip 지원.
- `CheckConstraint`/`UniqueConstraint`/`ExclusionConstraint` 생성자가 새 인자를 받아 `super().__init__(..., violation_error_code=violation_error_code, ...)`로 전달.
- 각 `validate`의 `raise ValidationError(...)`에 `code=self.violation_error_code` 추가. **단** `UniqueConstraint`의 fields-기반 경로(`instance.unique_error_message(model, self.fields)`)는 backward-compat 위해 의도적으로 code 미적용(→ 코드가 `unique_together`로 남음).
- `__repr__`: 포맷 문자열에 `%s` placeholder 1개 추가 + `violation_error_code is None`이면 빈 문자열, 아니면 ` violation_error_code=%r` 분기.
- `__eq__`: 비교 튜플에 `self.violation_error_code == other.violation_error_code` 추가.

## 검증 (test_patch)
**FAIL_TO_PASS(8개)가 핀 동작:**
- `test_custom_violation_code_message` (BaseConstraint): `BaseConstraint(name=..., violation_error_code="custom_code")`가 `.violation_error_code` 속성에 저장.
- `test_deconstruction` (BaseConstraint): deconstruct kwargs에 `violation_error_code` 포함.
- `test_eq` (Check/Unique): code가 다르면 `assertNotEqual`, 같으면 `assertEqual`.
- `test_repr_with_violation_error_code` (Check/Unique): repr 문자열에 `violation_error_code='...'` 출력.
- `test_validate_custom_error` (Check): 위반 시 `cm.exception.code == "fake_discount"`(메시지는 그대로).
- `test_validate_conditon_custom_error` (Unique, condition 경로): `cm.exception.code == "custom_code"`.

**픽스 증명:** 예) `CheckConstraint(check=Q(price__gt=F("discounted_price")), violation_error_message="discount is fake", violation_error_code="fake_discount")`로 invalid 인스턴스를 validate → 메시지는 `"discount is fake"` 그대로지만 `code`가 `"fake_discount"`로 전파됨. eq/repr/deconstruct 테스트가 새 필드가 동치·표현·직렬화 전 라이프사이클에 배선됐음을 독립적으로 확인.

**overfit·regression 관점:**
- overfit 낮음. FAIL_TO_PASS가 속성 저장·deconstruct·eq·repr·validate(check/condition 경로) 4개 면을 모두 검사하므로 단일 메서드만 고치는 special-case 패치로는 통과 불가 → S1 미러링을 전 면에 적용하도록 강제(올바른 일반화로 수렴).
- regression 핵심: `test_validate` (UniqueConstraint, PASS_TO_PASS)가 fields-경로에서 커스텀 code를 세팅해도 `cm.exception.code == "unique_together"`임을 확인 → 무지성으로 모든 raise에 code를 붙이면 이 테스트가 빨개진다. test_patch가 이 의도적 예외를 명시적으로 잠가둠. 또 postgres `ExclusionConstraint`의 repr/eq 테스트가 contrib 파일까지 동일 수정을 빠뜨리지 않았는지 검증.

## 모범답안 (오라클 기반)

**(1) localize 경로.** 이슈가 `BaseConstraint.validate` + `violation_error_message`를 직접 지목한다. `grep "violation_error_message"`로 `django/db/models/constraints.py`에서 이 속성이 흐르는 전 지점(`BaseConstraint.__init__`/`deconstruct`, `CheckConstraint`/`UniqueConstraint`의 `__init__`/`__repr__`/`__eq__`/`validate`)을 회수하고, 같은 grep을 레포 전역으로 돌려 `django/contrib/postgres/constraints.py`의 `ExclusionConstraint`가 동일 계층을 미러한다는 cross-file 의존을 반드시 발견해야 한다. localize는 쉽지만 "두 번째 파일"을 놓치는 게 1순위 실수.

**(2) 픽스와 왜 올바른 일반화인가.** 새 패턴을 발명하지 말고 `violation_error_message`가 가진 모든 통로를 `violation_error_code`로 1:1 미러링한다: 클래스 기본값 `None`, `__init__` 키워드 인자(주어질 때만 세팅), `deconstruct` kwargs(non-None일 때만), 서브클래스 `super().__init__` 전달, `validate`의 `ValidationError(..., code=self.violation_error_code)`, `__repr__` placeholder, `__eq__` 비교항. 이게 overfit이 아닌 이유: 기존 메시지 메커니즘이 이미 검증된 정답 형태이고, 새 필드를 동일한 라이프사이클 전체에 배선해야만 deconstruct round-trip·동치·표현이 모두 성립하기 때문 — 부분 패치는 8개 FAIL_TO_PASS의 서로 다른 면에서 깨진다.

**(3) regression 안전.** 두 가지를 깨면 안 된다. 첫째, `UniqueConstraint.validate`의 fields-기반 분기는 `unique_error_message`를 쓰며 backward-compat상 code가 `unique_together`로 남아야 한다 — 이 raise에는 `code=`를 붙이지 않는다(PASS_TO_PASS `test_validate`가 잠금). 둘째, code 미지정(`None`)일 때 deconstruct/repr이 기존과 byte-identical해야 한다 → `is not None` 가드로 기본 경로를 무변경 유지(66개 PASS_TO_PASS의 기존 repr/eq/deconstruct 테스트가 그대로 통과).

**(4) 함정 회피.** 오라클 없는 에이전트가 틀릴 지점:
- **ExclusionConstraint 누락**: db/models만 고치고 contrib/postgres를 빼먹음 → postgres repr/eq 테스트 부분 실패. cross-file grep으로 사전 회수.
- **fields-경로에 code 무차별 적용**: 모든 `raise ValidationError`에 일괄 `code=`를 붙여 `unique_together` 경로까지 오염 → `test_validate` 회귀. 분기별로 의도를 구분.
- **`__repr__` placeholder 카운트**: 포맷 문자열에 ` violation_error_code=%r` 분기를 추가하면서 `%s` 개수를 같이 늘리지 않으면 `TypeError`. repr 테스트가 정확히 이 위치/순서(message 앞)를 기대.
- **deconstruct 무조건 포함**: `None`일 때도 kwargs에 넣으면 기존 deconstruct 테스트가 깨짐 → `is not None` 가드 필수.
- **enumeration 불완전**: 4클래스×{init,deconstruct/super,repr,eq,validate} 매트릭스를 체크리스트로 전수 확인. 하나라도 빠지면 그 면의 FAIL_TO_PASS만 빨갛게 남는다.
