---
instance_id: django__django-12304
repo: django/django
base_commit: 4c1b401e8250f9f520b3c7dc369554477ce8b15a
version: 3.1
difficulty: <15 min fix
created_at: 2020-01-09T15:43:51Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [django/db/models/enums.py]
---

# django__django-12304

## 문제 요약
Django 3.0에서 도입된 enumeration 타입(`models.IntegerChoices` / `models.TextChoices`)을 템플릿에서 쓸 수 없다. `{% if x == YearInSchool.FRESHMAN %}` 같은 표현을 쓰면, Django 템플릿은 callable을 만나면 인자 없이 호출하는데 `YearInSchool`(및 그 멤버)이 클래스/Enum이라 호출 가능해서 빈 인자로 불려 `value` 인자 누락으로 실패한다. 사용자는 enum 멤버와 그 `.label`/`.value`를 템플릿에서 그냥 참조할 수 있길 기대했다.

## 유형 분류
- 버그 카테고리: API-contract (템플릿 변수 해석 규약과 Enum callable 성질의 충돌) / 누락처리
- 서브시스템: django ORM model enums (`django.db.models.enums`) ↔ template variable resolution
- 증상 타입: 예외 (템플릿 렌더 중 enum이 인자 없이 호출되어 TypeError) / silent-wrong
- 로컬라이제이션 신호: problem_statement가 "the new enumeration types", "being callable", "Django Templates always call callables", 그리고 "declare `do_not_call_in_templates = True`"를 직접 명시 → enum을 정의하는 메타클래스 위치를 거의 지목

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/enums.py` → `ChoicesMeta.__new__` (Choices Enum 메타클래스)
- 근본 원인: 템플릿 변수 해석기(`Variable._resolve_lookup`)는 lookup 대상이 callable이면 `do_not_call_in_templates` 속성이 없는 한 자동으로 무인자 호출한다. Enum 멤버/클래스는 callable이라 `Suit.DIAMOND` 같은 참조가 호출되어 버리고, 필수 인자 부족으로 깨진다.
- 수정 요지: 메타클래스 `__new__`에서 생성되는 클래스에 단 한 줄 `cls.do_not_call_in_templates = True`를 부여한다. 이 속성이 붙으면 템플릿 엔진이 enum을 호출하지 않고 객체 자체로 다뤄, `.label`/`.value` 속성 접근이 정상 동작한다. `cls.label` property 설정 직후, `enum.unique(cls)` 반환 직전에 추가됨.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_templates (model_enums.tests.ChoicesTests)` — Enum이 템플릿에서 호출되지 않고 속성 접근이 되는지 확인.
- 테스트가 픽스를 증명하는 방식: `Template('{{ Suit.DIAMOND.label }}|{{ Suit.DIAMOND.value }}')`를 `Context({'Suit': Suit})`로 렌더 → 기대 출력 `'Diamond|1'`. 패치 전엔 `Suit.DIAMOND`가 무인자 호출되어 렌더가 실패/오작동, 패치 후엔 `do_not_call_in_templates` 덕분에 멤버 객체가 그대로 보존되어 `.label`='Diamond', `.value`=1이 출력된다.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/db/models/enums.py`의 `ChoicesMeta`. problem_statement가 해결책 속성명까지 알려줘 localization은 사실상 무료 — `do_not_call_in_templates` grep → 템플릿 엔진의 callable 처리(`django/template/base.py`) 규약 확인.
- 함정/난이도: 단일 파일·한 줄. 함정은 "어느 객체에 속성을 붙일까"다. 멤버 인스턴스가 아니라 메타클래스가 만드는 클래스(`cls`)에 붙여야 클래스 참조와 멤버 참조 모두에서 호출이 억제된다. 개별 멤버에만 붙이려 하면 누락 발생.
- 우리 에이전트 관점: 실제 코드 픽스보다 "왜 callable이 호출되는가"라는 템플릿 측 메커니즘을 모르면 enum 쪽이 아니라 `student.year_in_school == ...` 비교 로직을 잘못 의심할 수 있음. 단서가 매우 강해 정답 도달은 쉽지만, 멤버 vs 클래스 부착 위치를 헷갈리면 PASS_TO_PASS 17개 중 일부 회귀 위험.
