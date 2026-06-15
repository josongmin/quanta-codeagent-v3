---
instance_id: django__django-11149
repo: django/django
base_commit: e245046bb6e8b32360aa48b8a41fb7050f0fc730
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-03-30T18:14:35Z
fail_to_pass: 2
pass_to_pass: 46
gold_files: [django/contrib/admin/options.py]
---

# django__django-11149

## 문제 요약
auto-created ManyToManyField을 `TabularInline`(model = `X.through`)으로 노출하면, view 권한만 가진 사용자가 admin 화면에서 M2M 항목을 추가/삭제할 수 있는 버그. Django 2.1의 새 view 권한 기능에서 회귀했으며, 같은 M2M을 일반 필드로 두면 정상 동작한다. 사용자는 view-only 권한이면 inline이 읽기 전용이길 기대했다.

## 유형 분류
- 버그 카테고리: regression (2.1 view-permission 도입 시 회귀) / API-contract (권한 의미 위반)
- 서브시스템: django admin / inline permissions (`InlineModelAdmin`)
- 증상 타입: silent-wrong (권한 상승 — view-only인데 편집 가능)
- 로컬라이제이션 신호: problem_statement의 "auto-created ManyToManyField", "TabularInline", "view permission" 키워드 → admin options의 inline `has_*_permission` 메서드, 특히 `self.opts.auto_created` 분기.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py` — `InlineModelAdmin.has_add_permission` / `has_change_permission` / `has_delete_permission` / `has_view_permission`, 그리고 신규 헬퍼 `_has_any_perms_for_target_model`
- 근본 원인: auto_created intermediate model 분기에서 `has_add/change/delete_permission`이 전부 `has_view_permission(request, obj)`를 그대로 반환했다. `has_view_permission`은 view 또는 change 권한 중 하나만 있으면 True를 주므로, view-only 사용자에게 add/change/delete가 모두 허용되어 편집이 가능했다.
- 수정 요지: target model 권한 조회 로직을 `_has_any_perms_for_target_model(request, perms)` 헬퍼로 추출(기존 has_view_permission의 through→target 탐색 루프 재사용). add/change/delete는 `['change']` 권한을 요구하도록 변경하고, view는 `['view', 'change']`를 그대로 유지(change가 view를 함의). 즉 편집 동작은 더 이상 view 권한으로 통과하지 못한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_inline_add_m2m_view_only_perm`, `test_inline_change_m2m_view_only_perm` (`admin_inlines.tests.TestInlinePermissions`)
- 증명 방식: `view_book` 권한만 부여한 사용자로 author add/change 페이지를 GET → context의 `inline_admin_formset`에서 `has_view_permission=True`이고 `has_add/change/delete_permission=False`임을 단언. add 페이지는 TOTAL_FORMS=0, change 페이지는 TOTAL_FORMS=1(읽기 전용 표시 `<p>{book}</p>`)이며 "Add another ..." 버튼과 DELETE 체크박스가 없음을 검증. 기존 `test_inline_change_m2m_change_perm`에도 4개 권한이 모두 True라는 단언을 추가해 change 권한 경로의 정상성을 회귀 보호. `models.py`에는 `<p>%s</p> % self.book` 비교를 위해 `Book.__str__` 추가.

## 공략 포인트 (뭘 조져야)
- localization 전략: `admin/options.py`에서 `auto_created` 분기를 grep → `has_add_permission/has_change_permission/has_delete_permission`가 모두 `has_view_permission`을 위임하는 것이 즉시 보이는 스멜. has_view_permission이 view+change OR이라는 점을 알면 권한 상승 경로가 드러난다.
- 함정/난이도: 단일 파일·단일 클래스라 멀티파일은 아니지만, 네 메서드를 동일하게 손봐야 하고 view와 edit 계열의 권한 집합이 다르다(`['view','change']` vs `['change']`)는 점이 핵심. through→target model 탐색 루프를 헬퍼로 빼지 않고 인라인 복붙하면 회귀 위험.
- 우리 에이전트 관점: 막힐 만한 지점은 "view 권한이 통과하면 안 되는데 has_view_permission이 change도 허용한다"는 의미 차이를 놓치는 것. 단순히 has_add를 super()로 돌리면 auto_created intermediate에 자체 권한이 없어 깨지므로, target model 기준 change 권한으로 매핑해야 한다는 도메인 이해가 필요하다.
