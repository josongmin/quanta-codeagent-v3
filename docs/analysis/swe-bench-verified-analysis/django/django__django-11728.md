---
instance_id: django__django-11728
repo: django/django
base_commit: 05457817647368be4b019314fcc655445a5b4c0c
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-08-29T17:31:03Z
fail_to_pass: 2
pass_to_pass: 44
gold_files: [django/contrib/admindocs/utils.py]
---

# django__django-11728

## 문제 요약
admindocs의 `simplify_regexp()`(내부적으로 `replace_named_groups()`/`replace_unnamed_groups()` 사용)이 urlpattern 끝에 trailing `/`나 `$`가 없을 때 **마지막 그룹을 치환하지 못한다**. 예: `r'entries/(?P<pk>[^/.]+)/relationships/(?P<related_field>\w+)'`에서 `related_field`가 `<related_field>`로 안 바뀌고 원본 `(?P<related_field>\w+)`이 그대로 남는다. 끝에 `/`를 붙이면 동작하는 게 워크어라운드. Django REST Framework에서도 이 함수를 사용하기 때문에 다운스트림 영향이 있다.

## 유형 분류
- 버그 카테고리: edge-case (off-by-one 성격의 루프 종료 처리)
- 서브시스템: django contrib admindocs (URL 패턴 → 사람이 읽는 형태 변환)
- 증상 타입: silent-wrong (예외 없이 마지막 그룹만 미치환)
- 로컬라이제이션 신호: problem_statement에 함수명 `replace_named_groups()`가 직접 등장하고, hints_text에 거의 골드와 동일한 diff까지 제시됨 → `django/contrib/admindocs/utils.py` 정확히 지목

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admindocs/utils.py` : `replace_named_groups()`, `replace_unnamed_groups()`
- 근본 원인: 두 함수 모두 `pattern`의 그룹 본문을 한 글자씩 순회하며 괄호 균형을 세는 루프인데, **균형 확인(`unmatched_open_brackets == 0`) 체크를 루프 본문 맨 앞**에 두었다. 그래서 마지막 닫는 `)`을 처리해 균형이 0이 된 순간 루프가 즉시 끝나버려(`enumerate`가 다음 iteration을 못 돎), 패턴 문자열이 그 닫는 괄호에서 끝나면 종료 분기를 **한 번도 못 타고** 그룹이 등록되지 않는다.
- 수정 요지:
  1. 균형 체크 분기를 루프 본문의 **맨 끝(괄호 카운팅 이후)** 으로 이동시켜, 닫는 `)`을 카운트한 같은 iteration에서 종료를 판정하게 함.
  2. 슬라이스 인덱스를 보정: `replace_named_groups`는 `pattern[start:end+idx]` → `pattern[start:end+idx+1]`, `replace_unnamed_groups`는 `start+1+idx` → `start+2+idx`로 +1 해서 마지막 `)`까지 포함.
  3. docstring에 trailing `/` 없는 케이스(예 3, 4)를 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_simplify_regex` (그리고 `test_app_not_found`).
- `tests/admin_docs/test_views.py`의 `test_simplify_regex` 케이스 테이블에 trailing `/`나 `$`가 없는 입력들을 추가: `r'^(?P<a>\w+)/b/(?P<c>\w+)'` → `/<a>/b/<c>`, `r'^(?P<a>\w+)/b/(\w+)'` → `/<a>/b/<var>`, `r'^(?P<a>\w+)/b/((x|y)\w+)'` → `/<a>/b/<var>`, `r'^(?P<a>(x|y))/b/(?P<c>\w+)'` → `/<a>/b/<c>`. 픽스 전에는 마지막 그룹이 원본 그대로 남아 기대 출력과 불일치 → 픽스 후 정확히 치환되어 통과.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 함수명을 직접 줬으니 `admindocs/utils.py`의 `replace_named_groups` 루프를 바로 보면 됨. 핵심은 "early-check가 마지막 닫는 괄호 이후 iteration에 의존"한다는 구조 인식.
- 함정/난이도: (1) 두 함수가 **거의 동일한 패턴**이라 한쪽만 고치면 unnamed 케이스가 깨진다(멀티 함수, 단일 파일). (2) 슬라이스 인덱스 +1 보정을 빼먹으면 마지막 `)`가 잘려 치환 결과가 틀어짐 — off-by-one 함정. (3) trailing `/`가 있던 기존 케이스가 회귀하지 않도록 인덱스 보정이 정확해야 함.
- 우리 에이전트 관점: hints_text에 거의 완성된 diff가 있어 난이도 자체는 낮음. 막힐 만한 지점은 `replace_unnamed_groups`에도 동일 수정을 적용해야 한다는 점을 놓치는 것과, 두 함수의 인덱스 베이스(`end+idx+1` vs `start+2+idx`)가 미묘하게 달라서 기계적 복붙 시 off-by-one을 내는 것.
