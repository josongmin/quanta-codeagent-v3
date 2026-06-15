---
instance_id: django__django-16899
repo: django/django
base_commit: d3d173425fc0a1107836da5b4567f1c88253191b
version: 5.0
difficulty: <15 min fix
created_at: 2023-05-26T13:41:37Z
fail_to_pass: 2
pass_to_pass: 54
gold_files: [django/contrib/admin/checks.py]
---

# django__django-16899

## 문제 요약
ModelAdmin을 서브클래싱할 때 `readonly_fields`의 시스템 체크(admin.E035) 에러 메시지는 잘못된 값의 인덱스(`readonly_fields[0]`)만 알려주고 정작 어떤 필드 이름이 문제인지는 알려주지 않는다. `list_editable`, `raw_id_fields`, `list_display` 등 다른 옵션의 체크는 `refers to '<field_name>'` 형태로 실제 값을 메시지에 포함시킨다. 사용자는 `readonly_fields` 체크도 동일하게 필드 이름을 포함해 메시지를 통일하고 디버깅을 쉽게 해주길 기대한다.

## 유형 분류
- 버그 카테고리: API-contract (에러 메시지 일관성/UX) — 동작 자체는 정상, 진단 메시지의 정보 누락
- 서브시스템: django.contrib.admin 시스템 체크 (admin checks framework)
- 증상 타입: silent-wrong에 가까운 불충분 출력 — 체크는 정상적으로 에러를 내지만 메시지가 필드명을 누락
- 로컬라이제이션 신호: problem_statement가 정확한 에러 문구("The value of 'readonly_fields[0]' is not a callable...")와 비교 대상(`list_editable[0] ... refers to ...`)을 그대로 인용 → `django/contrib/admin/checks.py`의 `readonly_fields` 체크 함수로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/checks.py` : `BaseModelAdminChecks._check_readonly_fields_item` (FieldDoesNotExist 예외 처리 분기)
- 근본 원인: `FieldDoesNotExist`가 발생했을 때 생성하는 `checks.Error` 메시지 템플릿이 `label`(예: `readonly_fields[1]`)과 클래스명/모델명만 포맷에 넣고, 정작 해석 실패한 `field_name`(실제 잘못된 값)은 포맷 인자에서 빠져 있었다.
- 수정 요지: 메시지 템플릿을 `"The value of '%s' refers to '%s', which is not a callable, an attribute of '%s', or an attribute of '%s'."`로 바꾸고 포맷 튜플에 `field_name`을 `label` 뒤에 추가. 즉 `%s` 슬롯이 3개 → 4개로 늘고, 새 슬롯에 잘못된 필드 이름을 채워 다른 admin 옵션 체크들과 메시지 형식을 통일.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_nonexistent_field`, `test_nonexistent_field_on_inline` — 존재하지 않는 필드를 `readonly_fields`에 넣은 `SongAdmin`/`CityInline`을 체크했을 때 E035 에러 메시지를 검증
- 증명 방식: 테스트가 기대 `checks.Error` 문자열을 새 형식(`"...'readonly_fields[1]' refers to 'nonexistent', which is not a callable..."`, 인라인은 `'i_dont_exist'`)으로 갱신. 재현 입력은 `readonly_fields=[..., "nonexistent"]`인 ModelAdmin → `.check()` 호출, 기대 출력은 필드명을 포함한 정확한 메시지(id=`admin.E035`). 패치 전 코드는 옛 문구를 반환하므로 문자열 비교에서 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement의 에러 문구를 `grep`하면 `_check_readonly_fields_item`의 `FieldDoesNotExist` 분기 하나로 바로 좁혀진다. 단일 파일·단일 함수·단일 메시지 수정.
- 함정/난이도: 포맷 문자열의 `%s` 개수와 포맷 튜플 인자 개수를 정확히 맞춰야 함(슬롯 3→4). `field_name`을 `label` 다음 위치에 넣어야 메시지 어순이 맞고, 기존 admin 체크들의 `refers to '%s'` 관용구와 일치시켜야 한다. 멀티파일 아님.
- 우리 에이전트 관점: 난이도 매우 낮음(<15분). 막힐 위험은 거의 없으나, 테스트가 메시지 전문(全文) 일치를 요구하므로 새 문구의 띄어쓰기/문장부호/단어 순서를 골드와 한 글자도 다르지 않게 맞추는 것이 유일한 리스크. 메시지 통일 의도를 무시하고 자체 문구를 창작하면 FAIL_TO_PASS 문자열 비교에서 탈락한다.
