---
instance_id: django__django-13512
repo: django/django
base_commit: b79088306513d5ed76d31ac40ab3c15f858946ea
version: 3.2
difficulty: <15 min fix
created_at: 2020-10-08T13:52:57Z
fail_to_pass: 3
pass_to_pass: 32
gold_files: [django/contrib/admin/utils.py, django/forms/fields.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L3
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-13512

## 문제 요약
JSONField에 한국어/중국어/이모지 같은 non-ASCII 문자를 저장한 뒤 Django admin에서 보거나 편집하면 `中国`이 `中国`처럼 ASCII 이스케이프된 형태로 표시된다. 원인은 `json.dumps`가 기본값 `ensure_ascii=True`로 직렬화하기 때문. 이슈는 `>>> json.dumps('中国')` 재현 스니펫과 "admin 표시 전용이라 MySQL utf8mb4 제약과 무관"이라는 핵심 단서를 본문에 직접 적어준다. 사용자는 admin 화면에서 원문 유니코드 문자가 그대로 보이길 기대한다.

## 유형 (정형화)
- **L (Localization) = L3 (Multi-site).** 이슈/hints가 `prepare_value`(forms)를 직접 지목하나, FAIL_TO_PASS의 `test_json_display_for_field`는 별도 경로인 `django/contrib/admin/utils.py`의 `display_for_field`까지 함께 고쳐야 통과한다. 두 파일이 **함께** 바뀌어야 완결되므로 단순 L0가 아니라 L3. (포인터 자체는 명확하지만 cross-file 조율이 강제됨.)
- **S (Repair Strategy) = S1 Direct-Map (+S2).** dominant는 S1: 정형 결함클래스 "직렬화 옵션 누락"에 대해 `ensure_ascii=False` 인자를 추가하는 기계적 픽스. forms 쪽은 거의 순수 S1(한 인자 추가). 보조 S2가 필요한 곳은 admin.utils 분기 — 단순 인자 추가가 아니라 `field.get_prep_value(value)`(DB 직렬화)를 `json.dumps(value, ensure_ascii=False, cls=field.encoder)`(표시 직렬화)로 **올바른 식을 추론·합성**해야 한다. "표시 경로에선 DB prep이 아니라 form encoder를 써야 한다"는 의미적 판단이 S2 성분.
- **K (Knowledge) = K-Domain.** Django forms/admin 내부 지식이 병목: `JSONField`에 `encoder` 속성이 있다는 점, `get_prep_value`는 DB write용이라 표시에 부적합하다는 점, `TypeError` 폴백이 invalid-JSON(dict 키가 tuple) 케이스를 위한 것이라는 점 — 모두 프레임워크 내부 계약 지식이다. 일반 파이썬 추론(K-Gen)으로는 admin.utils 분기의 `get_prep_value` 교체를 못 짚는다.
- **primary_type = T-DirectMap.** 위치가 명확하고(이슈가 라인까지 지목) dominant 픽스가 S1 기계적 인자 추가이므로 T-DirectMap. T-DiffuseLoc은 아님 — 어려움이 "어디인지 찾기"에 있지 않고(포인터 명확), 오히려 "두 번째 site도 같이 고쳐야 함"에 있다. T-DomainBound도 후보였으나 K-Domain이 단독 병목이라기보단 S1 픽스를 보조하는 수준이라 T-DirectMap이 더 정확.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(=T1~T2 prior)지만 다음 구조적 피처가 한 단계 위로 민다:
- **cross-file-dep / L3 멀티사이트:** gold patch가 2파일에 걸침. hints_text가 forms 라인만 가리켜서, 그것만 고치면 `test_json_display_for_field`(admin_utils)가 FAIL → 절반 픽스 함정. 단일파일 `<5줄`의 48% solve 구간이 아니다.
- **admin.utils 분기는 순수 S1이 아님:** `ensure_ascii=False`만 추가하는 게 아니라 호출 메서드 자체(`get_prep_value`→`json.dumps(..., cls=field.encoder)`)를 바꿔야 하는 S2 성분. 단순 인자 추가만 시도하면 그 분기가 여전히 틀린 메서드를 호출.
- **import 누락 함정:** admin/utils.py 상단에 `import json`을 추가하지 않으면 NameError(런타임 회귀).
- **regression-trap:** PASS_TO_PASS 32개(admin_utils의 NestedObjects/display 계열, forms_tests의 encoder/has_changed/invalid 계열)를 안 깨야 함. 특히 `TypeError` 폴백을 보존하지 않으면 invalid-JSON 케이스 P2P가 깨진다.

공식 시간라벨보다 높게 잡는 이유: 시간라벨은 "개발자가 정답 알 때 구현시간"이라 멀티사이트 localize 누락·잘못된 메서드 교체 함정을 반영하지 못한다(루브릭 주: localize 어려움/함정은 시간라벨에 안 잡힘).

## 골드패치 분석
- 건드린 파일/함수:
  - `django/forms/fields.py` — `JSONField.prepare_value`
  - `django/contrib/admin/utils.py` — `display_for_field`의 `isinstance(field, models.JSONField)` 분기 (+ 모듈 상단 `import json` 추가)
- 근본 원인: 두 표시 경로 모두 `json.dumps`로 JSONField 값을 직렬화하면서 `ensure_ascii=False`를 빠뜨려, 기본 `ensure_ascii=True`가 non-ASCII를 전부 `\uXXXX`로 이스케이프함. 추가로 admin.utils 분기는 `field.get_prep_value(value)`(DB 저장용 prep)를 표시에 잘못 사용하고 있었음 — 이건 form encoder를 존중하지 않고 유니코드도 보존 못 함.
- 수정 요지:
  - `prepare_value`: `json.dumps(value, cls=self.encoder)` → `json.dumps(value, ensure_ascii=False, cls=self.encoder)`. (1줄, 순수 인자 추가)
  - `display_for_field`: `return field.get_prep_value(value)` → `return json.dumps(value, ensure_ascii=False, cls=field.encoder)`. form 경로와 동일하게 유니코드 보존 + 필드의 커스텀 `encoder` 존중. 기존 `except TypeError: return display_for_value(...)` 폴백은 그대로 유지(tuple-key dict 등 비직렬화 입력 처리).

## 검증 (test_patch)
- FAIL_TO_PASS (3개):
  - `test_prepare_value (forms_tests...JSONFieldTest)`: `'你好，世界'`→`'"你好，世界"'`, `{'a': '😀🐱'}`→`'{"a": "😀🐱"}'`, `["你好，世界", "jaźń"]`→원문 보존을 단언. 픽스 전엔 `ensure_ascii=True`로 `\uXXXX`가 나와 실패, 인자 추가 후 통과.
  - `test_json_display_for_field (admin_utils...UtilsTests)`: 표 기반 파라미터에 `({'a': '你好 世界'}, '{"a": "你好 世界"}')`를 추가. **이 케이스가 admin.utils 분기를 강제** — forms만 고치면 여기서 FAIL. 직후의 `({('a','b'):'c'}, "{('a', 'b'): 'c'}")  # Invalid JSON.` 케이스가 `TypeError` 폴백 경로를 함께 커버.
  - `test_label_for_field (admin_utils...UtilsTests)`: 동일 모듈 회귀 보호(직접 관련 단언은 아니나 모듈 import/실행 경로 보장).
- 픽스 증명: 재현 입력(유니코드 문자열) → 기대 출력(원문 그대로)이 1:1 대응. `ensure_ascii=False` 추가가 정확히 이 매핑을 성립시킨다.
- overfit 관점: FAIL_TO_PASS가 얇지 않고(중국어/이모지/폴란드어 + dict/list/scalar로 입력공간을 넓게 표집), special-case로 통과시킬 여지가 거의 없음 → overfit-risk 플래그 미부여. `ensure_ascii=False`는 모든 non-ASCII에 일반적으로 작동하는 올바른 일반화.
- regression 관점: regression-trap 플래그 부여 — P2P 32개. 특히 `test_custom_encoder_decoder`(field.encoder 존중), `test_invalid`/`test_has_changed`(InvalidJSONInput 단락), admin_utils의 invalid-JSON 폴백을 안 깨야 함. `get_prep_value`를 지우되 `TypeError` 폴백을 보존하는 게 안전 핵심.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 "json.dumps use ASCII encoding by default" + "edit a JsonField ... in Django admin"이 두 표시 표면을 가리킨다. (a) 편집 입력 위젯 → `JSONField.prepare_value`(forms/fields.py, hints가 L1261 직접 지목). (b) admin read-only 표시 → `display_for_field`(contrib/admin/utils.py). hints가 forms만 짚더라도, "admin에서 본다"는 문구와 FAIL_TO_PASS 모듈명(`admin_utils`)이 두 번째 site를 강제하므로 admin.utils의 JSONField 분기도 grep해야 한다.
2. **픽스 (왜 올바른 일반화인가):** 양쪽 `json.dumps`에 `ensure_ascii=False`를 추가. 이건 특정 입력에만 맞춘 special-case가 아니라 직렬화 정책 자체를 "유니코드 보존"으로 바꾸는 것이라 모든 non-ASCII에 일반적으로 옳다. admin.utils에선 한 발 더 나아가 `get_prep_value`(DB prep)를 `json.dumps(..., cls=field.encoder)`로 교체 — 표시 경로는 DB 직렬화가 아니라 form encoder를 써야 한다는 게 의미적으로 올바른 선택(forms 경로와 일관). 모듈 상단 `import json` 추가는 필수.
3. **regression 안전:** P2P 32개를 보존해야 한다. `field.encoder`(`cls=`)를 유지해 `test_custom_encoder_decoder`가 깨지지 않게, `except TypeError → display_for_value` 폴백을 유지해 tuple-key dict 같은 invalid-JSON 케이스가 깨지지 않게(`test_json_display_for_field`의 마지막 행), forms 쪽 `InvalidJSONInput` 단락도 손대지 않음. MySQL utf8mb4 제약(#18392)은 admin 표시 전용 경로라 무관 — DB write 경로는 건드리지 않으므로 안전.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (1) hints만 보고 `prepare_value` 한 줄만 고치고 종료 → `test_json_display_for_field` FAIL. 두 번째 site를 반드시 찾아야 함. (2) admin.utils 분기에 `ensure_ascii=False`만 추가하고 `get_prep_value` 호출은 유지 → 여전히 DB prep 값을 쓰고 encoder 미존중, 유니코드도 보존 안 됨. 메서드 자체를 `json.dumps`로 교체해야 함. (3) `import json` 누락 시 NameError. (4) `TypeError` 폴백 제거 시 invalid-JSON P2P 회귀. 안전책: FAIL_TO_PASS 모듈명을 localize 단서로 삼아 admin.utils까지 커버하고, 기존 폴백·encoder 계약을 보존한 채 인자만/메서드만 최소 변경.
