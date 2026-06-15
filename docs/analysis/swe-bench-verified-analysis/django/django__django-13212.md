---
instance_id: django__django-13212
repo: django/django
base_commit: f4e93919e4608cfc50849a1f764fd856e0917401
version: 3.2
difficulty: 1-4 hours
created_at: 2020-07-21T02:53:58Z
fail_to_pass: 5
pass_to_pass: 2
gold_files: [django/core/validators.py, django/forms/fields.py]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-13212

## 문제 요약
Django 내장 validator들이 `ValidationError`를 raise할 때 검증에 실패한 실제 값(value)을 에러 `params`에 전달하지 않아, 사용자가 커스텀 에러 메시지에서 `%(value)s` placeholder를 쓸 수 없었다. 예를 들어 `"blah" is not a valid email.` 같은 메시지를 만들고 싶어도 value가 params에 없어 치환이 불가능했다. 문서(`ref/validators`)에는 이미 `%(value)s` 사용 예시가 있는데 내장 validator들은 이를 지원하지 않는 불일치(spec-vs-impl drift) 상태였다. 기대 동작은 `core/validators.py`의 모든 내장 validator가 raise 시점에 `params={'value': value}`를 넘겨 커스텀 메시지에서 값을 참조할 수 있게 하는 것. 골드패치는 validators.py의 거의 모든 raise 지점(클래스 + 함수형 validator)을 손대고, 추가로 `forms/fields.py`의 `DecimalField.validate` 중복 검사를 제거한다.

## 유형 (정형화)

**3축 점수**

- **L = L3 (Multi-site)** — 픽스가 한 지점이 아니라 `django/core/validators.py`의 거의 모든 `raise ValidationError` 사이트 + `django/forms/fields.py`의 `DecimalField.validate` 제거까지 ≥2 파일 ·12+ 헌크에 걸쳐 **함께** 바뀌어야 한다. problem_statement이 파일을 거의 지목(L0/L1처럼 보임)하지만, 진짜 비용은 "어느 한 곳"이 아니라 "빠짐없이 전수"이고, 함수형 validator(`validate_ipv4_address` 등)와 cross-file `DecimalField.validate`까지 포괄해야 5개 테스트가 통과한다 → 분산 수정이 본질이라 L3.
- **S = S1 (Direct-Map) +S6 (Design-Refactor)** — 각 개별 변경은 `raise ValidationError(self.message, code=self.code)` → `..., params={'value': value})`로 사실상 기계적 템플릿(이슈가 픽스를 명세). 다만 `forms/fields.py`에서 `DecimalField.validate`(별도 finite 검사)를 **삭제**해 검증 경로를 `DecimalValidator` 단일 경로로 일원화하는 부분은 단순 한 줄 추가가 아닌 작은 구조 변경이라 S6 보조.
- **K = K-Domain** — django forms/validators 내부 계약 지식 필요: ValidationError가 `params`로 메시지 포매팅을 한다는 것, `error_messages={code: ...}` 오버라이드가 먹으려면 `code`가 일치해야 한다는 것(그래서 NaN 경로에 `code='invalid'`를 명시 추가), DecimalField가 `DecimalValidator`와 자체 `validate`로 **이중 검증**한다는 도메인 지식이 없으면 cross-file 제거를 놓친다.

**primary type = T-DiffuseLoc** — 개별 픽스는 자명(S1)하지만, 난이도의 핵심이 "어디를 빠짐없이 고치는가"(L3 전수성 + cross-file `DecimalField.validate` 발견)에 있다. 위치가 명확하고 픽스가 한 곳이면 T-DirectMap이겠으나, 여기서는 분산·전수·cross-file이 지배 피처라 T-DiffuseLoc이 맞다.

**왜 이 strategy인가 (APR 관점)** — 결함클래스가 "params에 value 누락"이라는 정형 템플릿(PAR/TBar식 누락-인자 추가 패턴)에 정확히 매칭되어 각 사이트는 S1 template repair. 하지만 G&V로 한 사이트만 고치면 테스트가 일부만 통과(special-case green)하므로 generate-and-validate가 아니라 **전수 적용 + 중복 경로 제거(S6)**가 정답. SpecRover식으로 보면 의도(스펙)는 docs `%(value)s` 예시가 이미 결정해주므로 S5는 아니다 — 추론이 아니라 망라가 병목.

## 난이도 티어

**Tier = T4 (약간 어려움)**

이 티어로 미는 구조적 피처:
- **파일수/줄수**: gold patch가 2파일·12+ 헌크. ICLR 2024 컷 기준 "1파일·<5줄(≈48% solve)"을 한참 벗어나 ≥2파일/멀티헌크 구간 → solve-rate 떨어지는 구간.
- **localize 직접성**: problem_statement이 placeholder·validators를 지목해 *초기* 진입은 쉬우나(L0처럼 보이는 함정), **전수성**이 진짜 난점. 함수형 validator(`validate_ipv4_address/ipv6/ipv46`), `ProhibitNullCharactersValidator`, `FileExtensionValidator`까지 빠뜨리면 5개 중 일부만 green.
- **cross-file P2P trap**: `forms/fields.py`의 `DecimalField.validate` 삭제를 놓치면 NaN 케이스에서 value 없는 옛 경로가 먼저 터져 decimal 테스트가 깨진다. validators.py만 고치면 불완전 — cross-file 인과를 연결해야 함.
- **도메인 지식**: ValidationError params 포매팅 계약 + DecimalField 이중검증 구조 = K-Domain.
- **repro 없음**: 네이티브 스택트레이스/재현코드 없음(가장 강한 easiness 신호 부재).

**공식 라벨 = "1-4 hours"(T4-ish)와 일치.** 다만 공식 라벨은 "개발자 구현시간"이라 기계적 일괄치환을 시간으로만 본다. 에이전트 관점에서 진짜 위험(전수 누락 + cross-file `DecimalField.validate` 삭제 누락)은 시간라벨에 안 잡히지만, 우리 구조축에서도 L3·cross-file-dep로 T4를 지지하므로 결론적으로 동일 티어. T5로 올리지 않은 이유: overfit/추론 합성 위험이 낮고(픽스가 자명·S1), 도메인 깊이가 query-compiler/migrations급은 아님.

## 골드패치 분석

**건드린 파일·함수**
- `django/core/validators.py`:
  - `RegexValidator.__call__`, `URLValidator.__call__`(scheme/IPv6/punycode/length 등 5개 raise 지점), `EmailValidator.__call__`(empty·user_regex·domain 3지점)
  - 함수형 validator: `validate_ipv4_address`, `validate_ipv6_address`, `validate_ipv46_address`
  - `DecimalValidator.__call__`(invalid/NaN, max_digits, max_decimal_places, max_whole_digits)
  - `FileExtensionValidator.__call__`
  - `ProhibitNullCharactersValidator.__call__`
- `django/forms/fields.py`: `DecimalField.validate` (메서드 **제거**)

**근본 원인** — 각 validator가 `raise ValidationError(self.message, code=self.code)`만 호출하고 `params`에 실패한 value를 싣지 않아, 메시지 포매팅 시 `%(value)s`를 채울 데이터가 존재하지 않았다(docs는 지원한다고 적혀 있는데 impl이 안 따라간 spec drift).

**수정 요지**
- 모든 raise 지점에 `params={'value': value}` 추가. 이미 params dict가 있던 `DecimalValidator`(`max_digits`/`max_decimal_places`/`max_whole_digits`)와 `FileExtensionValidator`(`extension`/`allowed_extensions`)는 덮어쓰지 않고 기존 dict에 `'value': value`를 **병합**.
- `DecimalValidator`의 NaN/Inf(`invalid`) raise에는 원래 `code`가 없어 `code='invalid'`를 명시 추가 — 그래야 `error_messages={'invalid': '%(value)s'}` 오버라이드가 매칭됨.
- `forms/fields.py`의 `DecimalField.validate`에서 `is_finite()` 검사를 **제거** — 이 검사가 value 없이 별도로 `invalid`를 던지고 있었고, `DecimalValidator`가 이미 동일 검사를(이제 value 포함하여) 수행하므로 약한 중복 경로를 삭제해 단일 경로로 일원화(S6).

## 검증 (test_patch)

**FAIL_TO_PASS (5)** — `forms_tests.tests.test_validators.ValidatorCustomMessageTests`의 char_field / decimal_field / file_field / integer_field / null_character 5개.

**동작 / 픽스 증명** — 각 테스트는 `error_messages={code: '%(value)s'}`로 메시지를 value만 출력하도록 오버라이드한 폼 필드를 만들고 invalid 값을 넣어 `form.errors == {'field': [value]}`를 단언한다. 픽스 전에는 params에 value가 없어 포매팅 시 placeholder가 채워지지 않음 → 픽스 후 입력값이 그대로 에러 메시지로 출력.
- `char_field`: `validate_email('a')` → `['a']`, `validate_ipv4_address('256.1.1.1')`, `validate_slug('你 好')`, `URLValidator()('no_scheme')` 등 subTest로 16+ validator 망라 — 전수성을 직접 강제.
- `null_character`: `'a\0b'` → `['a\x00b']` (ProhibitNullCharactersValidator).
- `integer_field`: Max/MinValueValidator + URLValidator on IntegerField.
- `decimal_field`: NaN(`invalid`)/`max_digits`/`max_decimal_places`/`max_whole_digits` 4코드 — `DecimalField.validate` 제거 + `code='invalid'` 추가가 둘 다 안 되면 실패.
- `file_field`: `validate_image_file_extension`로 `myfile.txt` 업로드 → `['myfile.txt']`.

**PASS_TO_PASS (2)** — `test_all_errors_get_reported`, `test_field_validators_can_be_any_iterable` (둘 다 `TestFieldWithValidators`). 기존 다중 에러 수집·iterable validator 동작이 깨지면 안 됨.

**overfit / regression 관점**
- overfit 위험 낮음: subTest가 함수형/클래스형/Regex/URL/Min·MaxLength까지 폭넓게 검증해 "한두 사이트만 고치면 통과"하는 special-case green을 차단(S4 아님). 다만 테스트에 안 잡힌 validator를 빠뜨리면 그 validator는 여전히 value 미전달 — 테스트 커버리지 너머는 미검증.
- regression-trap: `DecimalField.validate` 삭제가 NaN 처리를 `DecimalValidator`로 위임하는데, 위임 경로가 동치임을 decimal 테스트가 증명. params 병합(덮어쓰기 금지)을 잘못하면 max_digits 등 기존 placeholder가 깨질 수 있어 PASS_TO_PASS/decimal 테스트가 가드.

## 모범답안 (오라클 기반)

**1) localize 경로** — problem_statement의 "built-in validators provide value to ValidationError" + `%(value)s` placeholder + docs 링크 신호 → `django/core/validators.py`. 여기서 멈추지 말고 `rg "raise ValidationError" django/core/validators.py`로 **모든 raise 사이트를 전수 열거**(클래스 `__call__` + 함수형 `validate_ipv4_address`/`ipv6`/`ipv46`). 추가로 "decimal NaN" 동작의 출처를 추적하면 `forms/fields.py`의 `DecimalField.validate`가 별도 `is_finite()` 검사를 들고 있음을 발견 → cross-file 타깃 확정.

**2) 픽스와 왜 올바른 일반화인가** — 모든 raise에 `params={'value': value}`를 (이미 params 있으면 병합) 추가. 이것이 overfit이 아닌 이유: 테스트가 특정 validator 한둘이 아니라 16+ validator를 subTest로 검증하므로, 정답은 "테스트에 나온 것만"이 아니라 validators.py 전체에 일관 적용하는 것. `DecimalValidator` NaN 경로에 `code='invalid'` 추가는 오버라이드 매칭을 위해 필수(코드 일치가 ValidationError 메시지 선택 계약). `DecimalField.validate` 삭제는 value 없는 약한 중복 검사를 제거해 단일 권위 경로(`DecimalValidator`)로 수렴 — 일반화이자 정합성 개선.

**3) regression 안전** — PASS_TO_PASS(`test_all_errors_get_reported`, `test_field_validators_can_be_any_iterable`)를 깨지 않으려면 (a) params는 **병합**(덮어쓰기 금지)해 max_digits/extension 등 기존 placeholder 보존, (b) `DecimalField.validate` 삭제 후에도 NaN이 여전히 `invalid`로 거부되는지(이제 `DecimalValidator` 경로) 확인 — decimal 테스트가 이 동치를 보증.

**4) 함정 회피 (오라클 없는 에이전트가 틀릴 지점)**
- "한 줄 추가"로 착각해 일부 raise만 고치고 종료 → char_field/integer_field subTest의 미수정 validator에서 실패. **전수 grep 후 사이트 카운트 확인**으로 회피.
- 함수형 validator(`validate_ipv4_address` 등)를 클래스만 보고 빠뜨림 → IPv4/6/46 케이스 실패.
- `DecimalValidator` NaN에 `code='invalid'` 누락 → `error_messages={'invalid': ...}` 오버라이드 미매칭으로 decimal NaN 실패.
- cross-file `DecimalField.validate` 삭제 미발견(validators.py만 수정) → NaN에서 value 없는 옛 경로가 먼저 터져 decimal 테스트 실패. forms/fields.py까지 연결짓는 cross-file 추론이 필수.
- 이미 params 있는 dict를 통째 교체 → 기존 placeholder 회귀.
