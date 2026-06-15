---
instance_id: django__django-16527
repo: django/django
base_commit: bd366ca2aeffa869b7dbc0b0aa01caea75e6dc31
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-02-05T22:05:00Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [django/contrib/admin/templatetags/admin_modify.py]
---

# django__django-16527

## 문제 요약
Django admin의 변경 화면에서 "Save as new"(저장 시 새 객체 생성) 버튼은 사실상 새 레코드를 추가(add)하는 동작인데, 이 버튼의 노출 조건(`show_save_as_new`)이 add 권한을 검사하지 않았다. 그 결과 change 권한만 가진 사용자에게도 버튼이 노출되어, add 권한 없이도 새 객체를 만들 수 있는 권한 누락이 발생한다. 사용자는 "Save as new"가 add 작업이므로 `has_add_permission` 체크가 추가되기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (권한 검증 누락) / validation
- 서브시스템: django.contrib.admin (template tags / 권한 게이팅)
- 증상 타입: silent-wrong (권한 없는 사용자에게 버튼 노출 → 권한 우회)
- 로컬라이제이션 신호: problem_statement가 파일 경로(`django/contrib/admin/templatetags/admin_modify.py`)와 라인 번호(102), 정확한 키(`show_save_as_new`), 수정안까지 그대로 제시 — 거의 핀포인트 수준의 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/templatetags/admin_modify.py` : `submit_row(context)`
- 근본 원인: `show_save_as_new` 컨텍스트 값이 `not is_popup and has_change_permission and change and save_as`로 계산되어, "새 객체 생성" 의미의 동작임에도 add 권한(`has_add_permission`)을 전혀 보지 않았다. change 권한만으로 통과.
- 수정 요지: 단 한 줄 교체 — `and has_change_permission`을 `and has_add_permission`으로 변경. 즉 "Save as new"의 게이팅 권한을 change에서 add로 바꿨다. (hints에서 "둘 다 검사할 필요 없이 add만으로 충분"하다고 합의된 결론. Save as new는 현재 객체의 저장이기도 하지만 권한 기준은 add로 통일.)

## 검증 (test_patch)
- FAIL_TO_PASS: `test_submit_row_save_as_new_add_permission_required` — `submit_row()`가 반환하는 `show_save_as_new` 플래그가 add 권한 유무에 따라 올바르게 토글되는지 검증.
- 테스트가 픽스를 증명하는 방식:
  - change 권한만 가진 `change_user`로 `UserAdmin.change_view`를 실행(`save_as=True`) → `submit_row(response.context_data)["show_save_as_new"]`가 `False`여야 함. (버그 코드에선 change 권한만으로 True가 되어 실패.)
  - add+change 권한을 모두 가진 `add_user`로 동일 실행 → `show_save_as_new`가 `True`. 헬퍼 `get_perm`과 `get_permission_codename("add"/"change", User._meta)`로 권한을 정밀하게 부여해 두 경우를 대비시킨다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일·라인·키를 직접 명시하므로 `admin_modify.py`의 `submit_row` 내부 컨텍스트 dict에서 `show_save_as_new` 항목만 찾으면 됨. localization 난이도는 매우 낮음.
- 함정/난이도 메모: 진짜 함정은 "add를 *추가*로 끼워넣을지" vs "change를 add로 *교체*할지"의 판단. 사용자 초안은 `has_add_permission and has_change_permission` 둘 다였지만, 골드/hints 합의는 add 한 줄로 교체. 두 줄로 만들면 PASS_TO_PASS는 통과해도 의도(중복 검사 제거)와 어긋날 수 있음 — 단, FAIL_TO_PASS 테스트는 add+change를 동시에 주므로 "둘 다 검사" 구현도 테스트는 통과한다(테스트가 교체 vs 추가를 구분하지 못함). 멀티파일 아님(단일 파일, 단일 라인).
- 우리 에이전트 관점: 핀포인트 단서 덕에 막힐 일은 거의 없으나, "change를 유지한 채 add를 추가"하는 안전빵 구현으로 흐를 가능성. 골드와 정확히 일치시키려면 hints의 "add만으로 충분" 결론을 읽고 change를 add로 *교체*해야 함. 인접한 `show_save_and_add_another` / `can_save_and_add_another` 로직과 헷갈리지 말 것(과거 #3817에서 그쪽만 고쳐졌던 이력).
