---
instance_id: django__django-13023
repo: django/django
base_commit: f83b44075dafa429d59e8755aa47e15577cc49f9
version: 3.2
difficulty: <15 min fix
created_at: 2020-06-04T20:40:44Z
fail_to_pass: 2
pass_to_pass: 9
gold_files: [django/db/models/fields/__init__.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-13023

## 문제 요약
`DecimalField.to_python()`에 dict 같은 값을 넘기면 `ValidationError`가 아니라 `TypeError`가 발생한다. 실수로 decimal 필드에 딕셔너리를 세팅한 모델 객체를 저장하려 하면, 사용자는 "어떤 필드가 잘못됐는지" 알려주는 깔끔한 ValidationError를 기대하지만 대신 raw TypeError가 튀어나와, 필드가 많은 객체에서는 원인 추적이 어렵다. 기대 동작은 잘못된 타입(dict/list/set/object/complex/비숫자 바이트문자열 등)도 다른 invalid 값(`'abc'`)과 동일하게 ValidationError로 정규화되는 것이다. 이슈 본문에 PR 링크(#13023)까지 포함되어 있다.

## 유형 (정형화)

**L0 (Pinpointed)** — problem_statement가 `DecimalField.to_python()`를 메서드명 그대로 지명하고, 게다가 수정 PR 링크까지 첨부한다. `grep DecimalField django/db/models/fields/__init__.py` 한 방이면 해당 try/except 블록에 도달한다. 탐색 비용 사실상 0.

**S1 Direct-Map (+S2 보조)** — 결함 클래스가 정형적이다: "변환 실패 시 모든 invalid 입력을 ValidationError로 정규화"라는 의도가 코드에 이미 존재하는데(`except decimal.InvalidOperation: raise ValidationError`), 잡는 예외 집합이 불완전했을 뿐이다. 픽스는 except 절에 누락 예외를 추가하는 기계적 패턴(예외-범위 확장 = None가드/타입강제와 같은 결함클래스의 TBar/PAR 템플릿). 다만 "정확히 어떤 예외를 더 잡아야 하나"(`TypeError`만? `ValueError`도?)는 `decimal.Decimal()` 생성자의 실제 동작을 따져봐야 하는 가벼운 constraint-reasoning이라 S2를 보조로 표기한다 — `Decimal(dict)`→TypeError, 일부 입력→ValueError, 비숫자 문자열→InvalidOperation을 구별해야 누락 없이 좁힐 수 있다.

**K-Gen** — django ORM 내부 지식이 필요 없다. 표준 라이브러리 `decimal.Decimal` 생성자의 예외 동작이라는 일반 파이썬 지식이면 충분하다. forms/query-compiler/migrations 같은 프레임워크 도메인 의존 없음.

**primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 예외-가드 확장(S1)이라는 조합이 dominant. T-LocTrivial보다 한 단계 위인 이유는, 픽스가 "이슈가 적어준 대로 한 줄"이긴 하나 추가할 예외 집합을 실제 동작 검증으로 좁히는 미세 추론(S2)이 끼어 자명(self-evident)까지는 아니기 때문이다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- **파일 1개 / 헌크 1개 / 실질 1줄** 변경(`except decimal.InvalidOperation` → `except (decimal.InvalidOperation, TypeError, ValueError)`). ICLR 2024 컷 기준 1파일·<5줄은 solve-rate 상위 구간.
- **L0 + has-repro** — 이슈가 함수를 지명하고 재현 시나리오(dict 세팅 후 save)와 PR 링크까지 제공. has-repro는 가장 강한 easiness 신호.
- T1이 아닌 이유: 추가 예외 집합을 정확히 좁히려면 `Decimal()`의 입력별 예외를 따지는 가벼운 추론(S2)이 필요해 "이슈가 픽스를 거의 적어줌"(T1 프로파일)보다 살짝 위. `TypeError`만 넣고 `ValueError`를 빠뜨리는 함정이 존재.
- **regression-trap 약함이지만 존재**: PASS_TO_PASS 9개가 인접 동작(`test_to_python`, `test_save_without_float_conversion`, `test_get_prep_value`, max_digits/decimal_places 검증 등)을 커버한다. except 절을 과하게 넓혀(`except Exception`) 정상 변환 경로나 `create_decimal_from_float` 분기를 삼키면 이들이 깨질 수 있어, T1로 내려가지 않게 잡아준다.

공식 라벨 `<15 min fix`와 일치한다(T2). 다만 공식 라벨은 "개발자 구현시간"이라, 추가 예외 누락(`ValueError` 빠뜨림) 위험은 시간라벨에 안 잡히는 에이전트-특화 함정임을 명시한다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/__init__.py` : `DecimalField.to_python`
- **근본 원인**: `to_python`은 `decimal.Decimal(value)` 변환 실패를 `except decimal.InvalidOperation`으로만 잡아 `ValidationError`로 변환했다. 그러나 `Decimal()` 생성자는 dict/list/set/object 등 변환 불가 타입에는 `InvalidOperation`이 아니라 `TypeError`를, 일부 입력에는 `ValueError`를 던진다. 이 두 예외가 except 절을 통과해 호출자에게 raw로 전파됐다.
- **수정 요지**: except 절을 `except (decimal.InvalidOperation, TypeError, ValueError)`로 확장. 한 줄 변경으로 모든 비-decimal 변환 실패가 동일한 `raise exceptions.ValidationError(self.error_messages['invalid'], code='invalid', ...)`로 정규화된다. `value is None` 처리와 float 분기(`create_decimal_from_float`)는 try 바깥/위쪽이라 그대로 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_invalid_value` (신규)와 `test_lookup_really_big_value`.
  - `test_invalid_value`: 기존 `test_to_python` 안의 `'abc'` 단일 케이스를 떼어 별도 메서드로 만들고, `()`, `[]`, `{}`, `set()`, `object()`, `complex()`, `'non-numeric string'`, `b'non-numeric byte-string'` 8종을 `subTest`로 순회한다. 각 값에 `field.clean(value, None)`을 호출해 `assertRaisesMessage(ValidationError, '“%s” value must be a decimal number.' % value)`로 검증 — dict/object 등 이전엔 TypeError를 내던 입력이 이제 정확한 메시지의 ValidationError를 내는지 확인.
  - `test_lookup_really_big_value`는 인접 회귀 보장용으로 함께 잠긴다.
- **overfit 관점**: 테스트가 8개의 서로 다른 타입 부류(빈 컬렉션/object/complex/문자열/바이트)를 한꺼번에 커버하므로 "특정 타입만 특수 처리"하는 overfit 패치는 통과할 수 없다. `TypeError`만 추가하고 `ValueError`를 빠뜨리면 일부 입력이 여전히 새어 FAIL — 테스트가 일반화를 강제한다(weak suite 아님). 그래서 overfit-risk 플래그는 달지 않았다.
- **regression 관점**: PASS_TO_PASS 9개가 정상 decimal 변환·trailing-zero·max_digits/decimal_places 검증·float-conversion 회피를 커버. except 절을 너무 넓히지(`except Exception`) 않는 한 모두 보존된다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `DecimalField.to_python()`를 직접 지명 → `django/db/models/fields/__init__.py`에서 `class DecimalField`의 `to_python` 메서드로 직행. 메서드 내 `try: return decimal.Decimal(value)` / `except decimal.InvalidOperation:` 블록을 즉시 식별. (이슈에 PR 링크까지 있어 L0 — 탐색 거의 불필요.)

2. **픽스와 올바른 일반화 이유**: except 튜플을 `(decimal.InvalidOperation, TypeError, ValueError)`로 확장. 이게 overfit이 아닌 이유는, 코드의 *원래 의도*가 "변환 불가 입력 → ValidationError 정규화"인데 잡는 예외만 불완전했던 것이고, dict 하나만 특수 처리하는 게 아니라 `Decimal()` 생성자가 던질 수 있는 변환-실패 예외 부류 전체를 일반적으로 포착하기 때문이다. dict→TypeError, complex/일부→ValueError를 한 번에 덮어 동일 코드패스(`ValidationError(...invalid...)`)로 수렴시킨다.

3. **regression 안전**: PASS_TO_PASS의 정상 변환(`test_to_python`의 유효 입력, `test_save_without_float_conversion`, `test_get_prep_value`)과 max_digits/decimal_places 검증을 깨지 않아야 한다. 안전 조건은 (a) except를 `Exception`처럼 광범위하게 넓히지 말 것 — 무관한 버그를 삼켜 검증을 무력화함, (b) try 범위를 늘려 `create_decimal_from_float` float 분기나 None 처리를 감싸지 말 것. except 절 한 줄만 좁게 확장하면 모두 보존된다.

4. **함정 회피**: 오라클 없는 에이전트의 전형적 오류는 (1) **`TypeError`만 추가하고 `ValueError`를 누락** — 이슈가 dict(=TypeError)만 언급해서 거기 꽂히기 쉬운데, 그러면 complex 등 ValueError 케이스가 새어 `test_invalid_value`가 일부 subTest에서 FAIL. 회피법: 실제로 `Decimal({})`, `Decimal(complex())`, `Decimal(b'x')`를 REPL에서 굴려 던지는 예외 부류를 실측해 집합을 좁힐 것. (2) **과확장**(`except Exception` 또는 try 범위 확대)으로 정상 경로/float 분기를 삼켜 regression. 회피법: 의도된 결함클래스(변환-실패 예외만)에 매칭되는 최소 예외 집합만 추가.
