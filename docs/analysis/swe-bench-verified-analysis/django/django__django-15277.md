---
instance_id: django__django-15277
repo: django/django
base_commit: 30613d6a748fce18919ff8b0da166d9fda2ed9bc
version: 4.1
difficulty: <15 min fix
created_at: 2022-01-03T12:14:06Z
fail_to_pass: 2
pass_to_pass: 158
gold_files: [django/db/models/fields/__init__.py]
---

# django__django-15277

## 문제 요약
`Value('test')._resolve_output_field()`는 `CharField()`를 `max_length` 없이 인스턴스화한다. 그런데 `CharField.__init__`이 무조건 `MaxLengthValidator(self.max_length)`를 validators에 추가하기 때문에 `max_length=None`인 validator가 만들어진다. 이 validator로 `clean()`을 호출하면 `'>' not supported between instances of 'int' and 'NoneType'` TypeError가 난다. 추가로 `@deconstructible` 데코레이터된 validator를 매번 생성하는 비용까지 더해져, 불필요하고(output_field는 validate되지 않음) 깨진 객체를 만드는 게 문제. 사용자는 `max_length`가 없으면 validator를 아예 안 만들기를 기대.

## 유형 분류
- 버그 카테고리: 누락처리 (None 가드 누락) + edge-case
- 서브시스템: django ORM model fields (CharField / expressions Value)
- 증상 타입: 잠재적 크래시 (clean 호출 시 TypeError) + 불필요한 객체 생성(성능)
- 로컬라이제이션 신호: problem_statement가 직접 `CharField.__init__`을 지목하고, 수정 코드(`if self.max_length is not None:`)와 `BinaryField.__init__`의 선례까지 명시 — 거의 골드 그대로의 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` : `CharField.__init__`
- 근본 원인: `CharField.__init__`이 `self.max_length`의 None 여부와 무관하게 항상 `validators.MaxLengthValidator(self.max_length)`를 append. `max_length`가 None이면 비교 연산에서 깨지는 validator가 생기고, `Value`의 output_field처럼 max_length 없이 만들어지는 경로에서 노출됨.
- 수정 요지: validator append를 `if self.max_length is not None:` 가드로 감쌈. None일 때는 validator를 추가하지 않아 깨진 MaxLengthValidator 생성을 방지하고, 동시에 불필요한 `@deconstructible` 인스턴스화 비용도 제거. 정상적으로 max_length를 가진 CharField 동작은 그대로.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `ValueTests.test_output_field_does_not_create_broken_validators` — 여러 파이썬 타입(str/bool/int/float/date/datetime/time/timedelta/Decimal/bytes/uuid)에 대해 `Value(value)._resolve_output_field()`로 얻은 field가 `field.clean(value, model_instance=None)`을 예외 없이 통과하는지 확인.
- 테스트가 픽스를 증명하는 방식: 픽스 전에는 str 케이스에서 `CharField`의 max_length=None validator가 `clean` 중 TypeError를 던져 테스트가 RED. 픽스 후에는 validator 자체가 추가되지 않아 clean이 통과. (`test_raise_empty_expressionlist`도 함께 FAIL_TO_PASS에 포함되어 있으나 핵심 회귀 검증은 broken validator 테스트.)

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 파일/메서드/수정안을 거의 그대로 알려주므로, `CharField.__init__`의 `validators.append(MaxLengthValidator(...))` 한 줄을 찾는 게 전부. `_resolve_output_field`와 `MaxLengthValidator`를 grep하면 바로 수렴.
- 함정/난이도: 단일 파일 단일 라인 수정. 함정은 (1) `Field.__init__`에 가드를 넣어 다른 필드까지 영향 주는 과도한 수정, (2) `MaxLengthValidator.compare`나 `_resolve_output_field` 쪽을 고치려는 잘못된 진입점. 정답은 CharField에만 국한된 None 가드이며 `BinaryField.__init__`의 기존 패턴과 동일하다는 점이 정합성 단서.
- 우리 에이전트 관점: 난이도가 매우 낮아(<15분) 막힐 여지는 적음. 다만 "성능 최적화" 프레이밍에 휘말려 deconstructible 제거 같은 광범위 변경으로 새지 않고, 가장 작은 None 가드로 수렴하는지가 관건.
