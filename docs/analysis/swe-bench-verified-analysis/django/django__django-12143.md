---
instance_id: django__django-12143
repo: django/django
base_commit: 5573a54d409bb98b5c5acdb308310bed02d392c2
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-11-25T14:38:30Z
fail_to_pass: 1
pass_to_pass: 52
gold_files: [django/contrib/admin/options.py]
---

# django__django-12143

## 문제 요약
admin changeform 뷰에서 list_editable 편집 시 수정된 객체의 PK를 골라내기 위해 POST 키를 정규식으로 매칭한다. 이 정규식을 `prefix` 값으로 문자열 포매팅해 만드는데, formset prefix에는 정규식 특수문자(`$`, `.`, `*` 등) 제약이 없다. prefix에 특수문자가 들어가면 정규식이 의도와 다르게 동작해 일부 행이 매칭에서 누락되고, 결국 데이터 손실이 발생할 수 있다. 보고자는 `re.escape()` 한 줄 수정을 제안했다.

## 유형 분류
- 버그 카테고리: validation / 누락처리 (신뢰 불가 입력을 정규식에 raw로 주입) — 회귀(regression, b18650a2에서 도입)
- 서브시스템: django contrib admin / changelist (list_editable 일괄 편집)
- 증상 타입: silent-wrong (예외 없이 일부 객체가 업데이트 대상에서 빠짐 → 데이터 손실)
- 로컬라이제이션 신호: problem_statement가 파일·라인·코드 한 줄(`pk_pattern = re.compile(r'{}-\\d+-{}$'.format(prefix, ...))`)을 그대로 인용. 거의 핀포인트 수준 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py` : `ModelAdmin._get_edited_object_pks`
- 근본 원인: `prefix`를 `re.escape` 없이 정규식 패턴 문자열에 그대로 박아 넣음. prefix가 `form$`처럼 끝에 `$`를 가지면 `form$-\d+-uuid$` 같은 패턴이 되어 `$`가 앵커로 해석되어 매칭이 깨지고, 편집된 PK가 수집되지 않아 해당 객체가 저장 대상에서 제외됨.
- 수정 요지: 패턴 생성 시 `prefix` 부분만 `re.escape(prefix)`로 감싸 정규식 메타문자를 리터럴로 처리. `self.model._meta.pk.name`은 Python 식별자 규칙상 안전하다고 보고 그대로 둠. 단 한 줄(format 인자)을 멀티라인으로 풀어 `re.escape(prefix)` 적용하는 변경.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_get_list_editable_queryset_with_regex_chars_in_prefix` (admin_changelist.tests.ChangeListTests)
- 테스트가 어떻게 픽스를 증명하는지: prefix를 `'form$'`(정규식 특수문자 `$` 포함)로 두고, POST 데이터 키도 `form$-0-uuid` 등 동일 prefix로 구성. `_get_list_editable_queryset(request, prefix='form$')`를 호출해 반환 queryset 카운트가 1이 되는지 검증. 패치 전에는 `$`가 앵커로 잘못 해석되어 키 매칭이 실패 → 빈/잘못된 queryset, 패치 후에는 escape되어 정확히 1개(편집된 Swallow A)만 잡힘. 기존 `test_get_list_editable_queryset`(prefix='form')은 PASS_TO_PASS로 회귀 없음 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일·함수·문제 라인이 전부 명시. `_get_edited_object_pks` 또는 `re.compile(r'{}-\d+-` 패턴을 grep하면 즉시 도달. 단일 함수 수정.
- 함정/난이도 메모: 단일 파일·한 줄 수정으로 난이도 낮음. 함정은 (1) `re.escape`를 prefix가 아닌 패턴 전체나 pk.name에까지 적용하면 안 됨 — pk.name은 그대로 둬야 식별자 매칭이 유지됨. (2) 보고서가 "다른 유사 패턴이 있을 수 있다"고 했지만 골드는 이 한 곳만 고침 — 과잉수정(다른 re.compile 사이트까지 손대기) 유혹을 피해야 함.
- 우리 에이전트 관점: 막힐 지점은 거의 없으나, "데이터 손실"이라는 표현에 끌려 트랜잭션/저장 경로(`save_related`, formset save)를 뒤지면 오답 방향. 증상의 실제 발생점은 PK 수집 정규식 한 곳임을 빠르게 좁히는 것이 핵심. test_patch가 명확한 재현 입력(`form$` prefix)을 제공하므로 그대로 따라가면 정답.
