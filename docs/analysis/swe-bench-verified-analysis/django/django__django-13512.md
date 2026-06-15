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
---

# django__django-13512

## 문제 요약
JSONField에 한국어/중국어/이모지 같은 non-ASCII 문자를 저장한 뒤 Django admin에서 보거나 편집하면 `中国` 처럼 ASCII 이스케이프된 형태로 표시된다. 원인은 `json.dumps`가 기본값 `ensure_ascii=True`로 직렬화하기 때문. 사용자는 admin 화면에서 원문 유니코드 문자가 그대로 보이길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (직렬화 옵션 미지정) / API-contract
- 서브시스템: django forms (JSONField) + django.contrib.admin display utils
- 증상 타입: 잘못된 출력 (silent-wrong, ASCII 이스케이프 표시)
- 로컬라이제이션 신호: problem_statement이 "json.dumps use ASCII encoding by default"와 "edit a JsonField ... in Django admin"을 직접 명시. hints_text가 `django/forms/fields.py#L1261`(prepare_value)을 정확히 지목하고, admin 표시 전용임도 못박음 → forms.fields와 admin.utils 두 곳이 후보.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/forms/fields.py`: `JSONField.prepare_value`
  - `django/contrib/admin/utils.py`: `display_for_field` (+ 상단 `import json` 추가)
- 근본 원인: 두 표시 경로 모두 `json.dumps`를 호출하면서 `ensure_ascii=False`를 빼먹음. 기본 `ensure_ascii=True` 때문에 non-ASCII가 전부 `\uXXXX`로 변환됨. admin.utils 쪽은 더 나아가 `field.get_prep_value(value)`를 써서 (form encoder가 아닌) DB prep 값을 표시에 쓰고 있었음.
- 수정 요지:
  - `prepare_value`: `json.dumps(value, cls=self.encoder)` → `json.dumps(value, ensure_ascii=False, cls=self.encoder)`.
  - `display_for_field`: JSONField 분기에서 `field.get_prep_value(value)` → `json.dumps(value, ensure_ascii=False, cls=field.encoder)`로 교체해 form 경로와 동일하게 유니코드 보존 + 필드의 커스텀 encoder 존중. `TypeError`는 기존대로 catch해 `display_for_value`로 폴백.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_prepare_value`: `'你好，世界'`, `{'a': '😀🐱'}`, `["你好，世界", "jaźń"]` 입력에 대해 이스케이프 없이 원문 그대로 직렬화되는지 단언.
  - `test_json_display_for_field`: `({'a': '你好 世界'}, '{"a": "你好 世界"}')` 케이스를 표 기반 파라미터에 추가, admin 표시값이 유니코드를 보존하는지 확인. 직후의 invalid-JSON 케이스(`{('a','b'):'c'}`)는 `TypeError` 폴백 경로를 함께 커버.
  - `test_label_for_field`: 동일 모듈 회귀 보호.
- 증명 방식: 픽스 전에는 `ensure_ascii=True` 기본값으로 `你好...`가 나와 단언 실패. `ensure_ascii=False` 추가 후 입력 문자열이 그대로 출력되어 통과 — 재현 입력 → 기대 출력이 1:1로 대응.

## 공략 포인트 (뭘 조져야)
- localization 전략: "Django admin"과 "JSONField" 두 단서로 시작. `prepare_value`(form 입력 위젯 표시)와 `display_for_field`(admin 읽기 표시) 두 경로 모두 손봐야 완전. hints_text가 forms 라인만 가리키지만 그것만 고치면 admin read-only 표시(`display_for_field`)가 누락되어 절반만 픽스됨.
- 함정/난이도: (1) 멀티파일 — forms 한 곳만 고치면 admin_utils 테스트 FAIL. (2) admin.utils 분기는 단순 `ensure_ascii=False` 추가가 아니라 `get_prep_value` → `json.dumps(..., cls=field.encoder)`로 함수 자체를 바꿔야 함(get_prep_value는 DB 직렬화라 표시에 부적합). (3) 파일 상단 `import json` 누락 시 NameError.
- 우리 에이전트 관점: forms 쪽 한 줄 픽스로 만족하고 끝낼 위험이 큼(`<15 min fix` 난이도지만 멀티파일). admin.utils의 `get_prep_value` 교체가 핵심 통찰인데, 단순 인자 추가만 시도하면 그 분기가 여전히 잘못된 메서드를 호출. `field.encoder`가 JSONField에 존재한다는 점과 `TypeError` 폴백을 깨지 않는 것도 확인 필요.
