---
instance_id: django__django-12308
repo: django/django
base_commit: 2e0f04507b17362239ba49830d26fec504d46978
version: 3.1
difficulty: <15 min fix
created_at: 2020-01-12T04:21:15Z
fail_to_pass: 2
pass_to_pass: 20
gold_files: [django/contrib/admin/utils.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap, cross-file-dep]
---

# django__django-12308

## 문제 요약
admin에서 `JSONField`가 readonly로 표시될 때 값이 파이썬 dict의 `repr`로 그대로 출력된다. 예를 들어 `{"foo": "bar"}`가 `{'foo': 'bar'}`로 보이는데, 작은따옴표 때문에 유효한 JSON이 아니다. 사용자는 readonly admin에서도 정상적인 JSON 문자열(`{"foo": "bar"}`)이 표시되기를 기대한다. 이슈 본문은 `django.contrib.admin.utils.display_for_field`에 special case를 추가하되, `json.dumps`를 직접 부르지 말고 `prepare_value`를 호출해 `InvalidJSONInput` 케이스를 처리하라고 픽스 방향까지 제시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement가 파일·함수(`django.contrib.admin.utils.display_for_field`)는 물론 호출할 메서드(`prepare_value`), 피해야 할 함정(`json.dumps`), 처리해야 할 엣지(`InvalidJSONInput`)까지 직접 지목. grep 한 방으로 정확한 수정 지점에 도달. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1)** — 수정 위치는 자명하나(S1식 분기 추가) 픽스의 핵심은 *올바른 직렬화 식과 폴백 조건을 추론으로 합성*하는 데 있다. `get_prep_value(value)`가 JSON 문자열을 만들고, JSON으로 직렬화 불가능한 입력(튜플 키 등)에서 던지는 `TypeError`를 catch해 `display_for_value` 폴백으로 떨어뜨리며, None은 `and value` 가드로 분기 진입을 막는다 — 세 가지 불변식(정상 직렬화 / invalid-JSON 폴백 / null 폴백)을 동시에 만족시키는 조건식을 "생각으로" 맞춰야 한다. 기계적 분기 추가(S1)로 보이지만 폴백 설계가 semantic reasoning이라 dominant는 S2.
- **K (Knowledge) = K-Domain** — django admin 내부 디스플레이 헬퍼와 ORM 필드 API 지식이 병목. `get_prep_value`가 `InvalidJSONInput`을 안전하게 흡수한다는 점, `models.JSONField`가 이 버전(3.1, #12990 이후)에서 `django.db.models`에 존재한다는 점, `display_for_field`/`display_for_value`의 역할 분담 — 모두 framework-internal 지식. 일반 파이썬 추론(K-Gen)만으론 `json.dumps`로 가다 invalid 입력에서 깨진다.
- **Primary type = T-DomainBound** — 위치는 L0로 완전 명확하고 strategy도 단일 헌크라 T-ConstraintReason과 경합하지만, 진짜 병목은 "어떤 필드 메서드가 올바른 JSON을 만들고 invalid 입력을 안전하게 처리하는가"라는 **프레임워크 내부 지식**이다. hints_text가 명시적으로 경고한 두 오답(타입명 문자열 비교의 brittleness, contrib.postgres 결합)도 도메인 지식 부재 시 빠지는 함정이라 K-Domain dominant. APR 관점에서 이건 template 매칭(PAR/TBar)으로는 안 풀리고, 올바른 API 계약을 알아야 조건식을 합성할 수 있는 도메인-속박 수리.

## 난이도 티어
**Tier = T3 (중간)**. 공식 라벨은 `<15 min fix`로 T1~T2를 가리키지만, 구조적 피처는 T3로 민다:
- **T1/T2를 막는 요인**: 픽스가 단순 가드/상수 변경(S1)이 아니라, `get_prep_value` + `TypeError` 폴백 + `and value` null 가드라는 3중 불변식을 만족하는 조건식 합성(S2)이며, 올바른 API 선택이 K-Domain에 속박된다. `json.dumps`로 직진하는 자연스러운 오답이 존재(invalid-JSON 입력에서 깨짐)해 단순 mechanical fix가 아니다.
- **L0 + has-repro**: 위치가 완전히 지목되고 재현 예시가 명확해 T4 이상으로는 못 올라간다(localize 어려움 없음, 1파일 5줄, 단일 헌크).
- **regression-trap**: PASS_TO_PASS 20개로 `display_for_field`/`display_for_value`/`label_for_field`의 인접 동작(number format, FloatField null, list_display 등)을 안 깨야 한다. 분기 위치를 FileField 뒤·최종 else 앞에 정확히 끼워야 다른 타입 경로를 건드리지 않는다.
- **종합**: localize 직접성(L0)은 난이도를 낮추지만, 도메인-속박 폴백 추론 + 인접 동작 regression trap이 mechanical T1/T2를 넘어 T3로 끌어올린다. 공식 라벨과 차이는 "개발자 구현시간(짧음)"과 "에이전트가 올바른 API·폴백을 추론하는 난이도(중간)"의 괴리에서 온다.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/admin/utils.py` — `display_for_field(value, field, empty_value_display)`.
- **근본 원인**: `display_for_field`의 isinstance 분기 사다리(`DateTimeField`/`BooleanField`/`DecimalField`/`FileField` 등)에 `JSONField` 케이스가 없어, JSONField 값이 모든 비특수 타입과 함께 최종 `else` 가지의 `display_for_value`로 떨어지고 결국 dict가 `str()`/`repr` 형태(작은따옴표)로 직렬화 → 유효 JSON이 아님.
- **수정 요지**: `FileField` 분기 다음에 다음 5줄 추가 —
  ```python
  elif isinstance(field, models.JSONField) and value:
      try:
          return field.get_prep_value(value)
      except TypeError:
          return display_for_value(value, empty_value_display)
  ```
  정상 케이스는 `field.get_prep_value(value)`로 올바른 JSON 문자열을 반환하고, JSON으로 못 만드는 입력(튜플 키 등)이 던지는 `TypeError`를 catch해 기존 `display_for_value` 폴백으로 처리. `json.dumps` 직접 호출 대신 필드 메서드를 써서 `InvalidJSONInput` 케이스를 자연스럽게 흡수. `and value` 가드로 None/falsy는 분기에 진입하지 않고 최종 else 폴백으로 빠진다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_json_display_for_field` (신규) + `test_label_for_field`.
- `test_json_display_for_field`는 `display_for_field(value, models.JSONField(), empty_value)`에 대해 4쌍을 검증: `{'a': {'b': 'c'}}` → `'{"a": {"b": "c"}}'`, `['a','b']` → `'["a", "b"]'`, `'a'` → `'"a"'`(큰따옴표 JSON), invalid JSON인 `{('a','b'): 'c'}` → 파이썬 repr `"{('a', 'b'): 'c'}"`(폴백 경로). 처음 3쌍이 정상 직렬화 경로, 마지막 1쌍이 `TypeError` 폴백 경로를 증명.
- `test_null_display_for_field`에 `display_for_field(None, models.JSONField(), empty_value)` → `empty_value` 케이스 추가 → `and value` 가드로 None이 분기에 안 들어가고 폴백되는 동작을 증명(PASS_TO_PASS로도 보호됨).
- **overfit 관점**: FAIL_TO_PASS가 정상/invalid/null 세 경로를 모두 커버해 special-case 통과 여지가 작다. 다만 `get_prep_value`가 아닌 ad-hoc `json.dumps(value)`로도 정상 3쌍은 통과 가능 — invalid-JSON 쌍(`{('a','b'): 'c'}`)이 `TypeError` 폴백을 강제하는 distinguishing input 역할을 해 overfit을 어느 정도 막는다(완전하진 않음, `overfit-risk`는 미부여하나 폴백 누락 시 1쌍에서 fail).
- **regression 관점**: PASS_TO_PASS 20개(number formats, FloatField null, list_display, label_for_field 류)가 인접 분기·헬퍼 경로를 보호. 분기를 잘못된 위치(예: 최종 else 위가 아닌 곳, 또는 `and value` 누락)에 넣으면 null/타입 경로가 깨진다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 본문이 `django.contrib.admin.utils.display_for_field`를 직접 지목 → 그 함수의 isinstance 분기 사다리로 직행. JSONField 케이스가 사다리에 없고 값이 최종 `else`의 `display_for_value`로 떨어져 dict repr이 되는 것을 확인. 추가 탐색 불필요(L0).
2. **픽스와 왜 올바른 일반화인가**: `FileField` 분기 뒤에 `elif isinstance(field, models.JSONField) and value:`를 추가하고 `field.get_prep_value(value)` 반환. 이게 `json.dumps(value)` 직접 호출보다 올바른 일반화인 이유 — (a) `get_prep_value`는 필드가 정의한 직렬화 계약을 따라 `InvalidJSONInput` 같은 케이스를 일관되게 처리, (b) 직렬화 불가 입력의 `TypeError`를 catch해 `display_for_value` 폴백으로 떨어뜨려 모든 입력공간에서 예외 없이 안전, (c) isinstance 체크라 서브클래스(상속)도 커버 — hints_text가 경고한 "타입명 문자열 비교의 brittleness"를 회피.
3. **regression 안전**: `and value` 가드로 None/falsy는 분기에 진입하지 않아 `test_null_display_for_field`의 JSONField-None 케이스가 보존. 분기를 최종 `else` *앞*, `FileField` *뒤*에 정확히 끼워 number format/list_display/label_for_field 등 PASS_TO_PASS 20개 경로를 건드리지 않음. `display_for_value`를 폴백으로 재사용해 기존 폴백 동작과 동일하게 맞춤.
4. **함정 회피**: 오라클 없는 에이전트가 틀리기 쉬운 지점 — (a) `json.dumps`로 직진 → invalid-JSON 입력(`{('a','b'): 'c'}`)에서 `TypeError`로 깨지거나 폴백 누락; 반드시 `get_prep_value` + `try/except TypeError`. (b) 타입명 문자열 비교(`field.__class__.__name__ == 'JSONField'`)나 contrib.postgres import로 결합 → brittle하고 상속 미처리(hints_text 명시 경고); `models.JSONField` isinstance여야 함(3.1은 #12990로 `django.db.models.JSONField` 존재). (c) `and value` 가드 누락 → null 케이스 회귀. (d) 폴백 대상을 `format_html`이나 raw str로 잘못 잡으면 기존 display 계약과 불일치.
