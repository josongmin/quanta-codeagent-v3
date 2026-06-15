---
instance_id: django__django-11815
repo: django/django
base_commit: e02f67ef2d03d48128e7a118bf75f0418e24e8ac
version: "3.1"
difficulty: 15 min - 1 hour
created_at: 2019-09-24T21:45:36Z
fail_to_pass: 2
pass_to_pass: 44
gold_files: [django/db/migrations/serializer.py]
---

# django__django-11815

## 문제 요약
Enum 객체를 CharField의 default 값으로 쓰면, 생성된 마이그레이션 파일이 Enum의 이름(name)이 아니라 값(value)을 사용해 직렬화한다(`Status('Good')`). Enum 값이 `gettext_lazy`로 번역 가능한 문자열이면, 언어를 바꿔 번역이 적용된 순간 그 값은 더 이상 Enum 멤버가 아니게 되어 기존 마이그레이션이 `ValueError: 'Good' is not a valid Status`로 깨진다. 사용자는 번역에 불변인 멤버 이름을 써서 `Status['GOOD']` 형태로 직렬화되길 기대한다.

## 유형 분류
- 버그 카테고리: API-contract / edge-case (직렬화 표현이 번역에 취약한 값에 의존)
- 서브시스템: django migrations serializer (makemigrations 직렬화)
- 증상 타입: 런타임 예외 (마이그레이션 로드 시 ValueError), 잠재적 silent-wrong 직렬화
- 로컬라이제이션 신호: problem_statement가 "generated migration file", "Enum", "default value" + 기대 출력 `Status['GOOD']`를 직접 명시 → `django/db/migrations/serializer.py`의 Enum 직렬화 코드로 거의 바로 연결됨

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/serializer.py` : `EnumSerializer.serialize`
- 근본 원인: 기존 코드는 `serializer_factory(self.value.value).serialize()`로 Enum의 **값**을 직렬화하고 `"%s.%s(%s)" % (module, class, v_string)` 즉 `EnumClass(value)` 호출 형태를 만들었다. 값이 번역 가능 문자열이면 다른 언어에서 같은 값으로 멤버를 못 찾아 깨진다.
- 수정 요지: 값 대신 멤버 **이름**으로 인덱싱하도록 변경. `'%s.%s[%r]' % (module, enum_class.__name__, self.value.name)` 을 반환하고, imports는 `{'import %s' % module}`만 남긴다. 값 자체를 직렬화하지 않으므로 `serializer_factory` 호출과 `v_imports`가 제거된다. `%r`을 써서 이름 문자열을 따옴표로 안전하게 감싼다(`['GOOD']`).

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_serialize_enums`: `TextEnum`/`BinaryEnum`/`IntEnum` 및 신규 `TextTranslatedEnum`(값이 `_()` lazy)을 직렬화해 결과가 `migrations.test_writer.TextEnum['A']` 형태인지 확인. CharField/IntegerField의 choices+default 직렬화 문자열도 `TextEnum['A']`, `IntEnum['B']` 형태로 기대.
  - `test_serialize_class_based_validators`: `re.S` 플래그가 `re.RegexFlag(16)`이 아니라 `re.RegexFlag['DOTALL']`로 직렬화되는지 확인 — `re.RegexFlag`도 enum이라 같은 경로를 탄다.
- 증명 방식: 번역 가능한 `TextTranslatedEnum.A`를 넣어 `['A']`(이름)로 나오는지 검증. 이름 기반이면 값이 어떻게 번역되든 멤버 조회가 항상 성공하므로 픽스를 직접 증명한다. 재현 입력 `Status.GOOD` → 기대 출력 `migrations.test_writer.Status['GOOD']`.

## 공략 포인트 (뭘 조져야)
- localization 전략: `grep`로 `EnumSerializer` 또는 `enum_class.__name__` / `serializer_factory(self.value.value)`를 찾으면 단일 함수에 도달. 단일 파일, 단일 함수 수정이라 범위가 좁다.
- 함정/난이도 메모:
  - hints에 나온 초기 다이프(`self.value`를 그대로 `'%s'`로 포맷)는 `EnumClass.GOOD` 문자열을 만들어 틀림 → 반드시 `self.value.name`을 써야 함. 따옴표 처리도 `%r`로 해야 `['GOOD']`가 됨.
  - `IntEnum`은 값이 정수라 `value`로 직렬화돼도 동작하지만 골드는 일관되게 이름으로 통일 → 테스트가 `IntEnum['B']`를 요구하므로 정수 enum도 동일 처리 필요.
  - 부수효과: 더 이상 값을 직렬화하지 않으므로 `v_imports`/`serializer_factory` 의존을 제거해야 imports 비교 테스트(`{'import ...'}`만)가 통과.
- 우리 에이전트 관점: 막힐 만한 지점은 (1) `self.value` vs `self.value.name` 혼동, (2) `%s` vs `%r` 따옴표 누락으로 테스트의 정확한 문자열(`['A']`) 불일치, (3) `re.RegexFlag` 케이스가 같은 직렬화기를 공유한다는 점을 놓쳐 PASS_TO_PASS가 아닌 두 번째 FAIL_TO_PASS를 못 잡는 것.
