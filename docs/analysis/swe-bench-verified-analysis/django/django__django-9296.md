---
instance_id: django__django-9296
repo: django/django
base_commit: 84322a29ce9b0940335f8ab3d60e55192bef1e50
version: 3.1
difficulty: <15 min fix
created_at: 2017-10-27T11:10:04Z
fail_to_pass: 1
pass_to_pass: 20
gold_files: [django/core/paginator.py]
---

# django__django-9296

## 문제 요약
`Paginator` 객체의 모든 페이지를 순회하려면 지금은 `page_range`를 돌면서 `page(num)`을 직접 호출해야 한다. 사용자는 파이썬의 일반적인 관용구대로 `for page in paginator:` 처럼 객체 자체를 iterate 하기를 기대한다. 즉 기능 누락(`__iter__` 미구현)으로, `iter(paginator)`가 의미 있게 동작하지 않는 것이 증상이다.

## 유형 분류
- 버그 카테고리: 누락처리 (missing feature / API-contract — iterator protocol 미구현)
- 서브시스템: django core pagination (`django/core/paginator.py`)
- 증상 타입: silent-wrong / 기능 부재 (예외는 아니고 기대한 순회 인터페이스가 없음)
- 로컬라이제이션 신호: problem_statement가 클래스명(`Paginator`), 메서드(`__iter__`), 기존 속성(`page_range`, `page`)을 직접 지목하고, 심지어 원하는 구현 코드까지 그대로 제시한다. `Paginator`는 `django/core/paginator.py`에 단일 정의되어 있어 파일 특정이 사실상 자명하다.

## 골드패치 분석
- 건드린 파일/함수: `django/core/paginator.py` : `Paginator.__iter__` (신규 추가)
- 근본 원인: `Paginator`가 iterator protocol(`__iter__`)을 구현하지 않아 `iter()`/`for` 순회가 불가. 페이지 순회 의도를 표현할 표준 진입점이 없었다.
- 수정 요지: `__init__` 바로 뒤에 제너레이터 메서드 `__iter__`를 추가. 기존 `self.page_range`(1-based 페이지 번호 시퀀스)를 돌면서 각 번호마다 `self.page(page_number)`를 `yield` 한다. 기존 `page()`/`validate_number()` 로직을 재사용하므로 페이지 경계·orphans 처리는 그대로 위임된다. 동작 추가만 있고 기존 메서드 시그니처/동작 변경은 없다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_paginator_iteration` — `Paginator([1, 2, 3], 2)`를 만들고 `iter(paginator)`로 얻은 이터레이터에서 `next()`를 반복.
- 증명 방식: 재현 입력은 3개 원소·per_page=2 → 기대 페이지는 `[1, 2]`(1페이지), `[3]`(2페이지). `enumerate(([1,2],[3]), start=1)`로 각 `next(page_iterator)`가 반환한 `Page`를 `list()`로 펼쳐 기대값과 비교한다. `__iter__`가 없으면 `iter()`/`next()`가 페이지를 내놓지 못해 실패하고, 패치 후에는 `page_range`(=[1,2]) 순서대로 정확히 2개 페이지를 yield 해 통과한다. `subTest(page=...)`로 페이지별 단언을 분리.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 클래스·메서드·구현 스니펫이 다 적혀 있으므로 `django/core/paginator.py`의 `class Paginator`를 열어 `__init__` 직후에 메서드를 추가하면 끝. grep `class Paginator` 한 번이면 파일 특정.
- 함정/난이도 메모: 난이도 <15분. 함정은 거의 없으나 (1) `page_range`는 1-based이고 `page()`도 1-based 번호를 기대 — off-by-one으로 `range(self.num_pages)`를 직접 쓰면 안 되고 `self.page_range`를 써야 한다. (2) `__iter__`는 매 호출마다 새 제너레이터를 만들어야 하므로 메서드 자체를 제너레이터로 두는 것이 정석(재진입 가능). 단일 파일·단일 메서드, 멀티파일 아님.
- 우리 에이전트 관점: 막힐 지점이 거의 없는 전형적 "스펙이 곧 패치" 케이스. 리스크는 오버엔지니어링(불필요한 `__len__`/`__getitem__`까지 추가하거나 `page_range` 대신 수동 range 계산)뿐. 골드와 동일하게 `self.page_range` 위임 최소 구현으로 멈추는 절제가 정답.
