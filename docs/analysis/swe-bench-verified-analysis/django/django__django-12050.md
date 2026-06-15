---
instance_id: django__django-12050
repo: django/django
base_commit: b93a0e34d9b9b99d41103782b7e7aeabf47517e3
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-11-10T08:53:45Z
fail_to_pass: 1
pass_to_pass: 10
gold_files: [django/db/models/sql/query.py]
---

# django__django-12050

## 문제 요약
`Query.resolve_lookup_value`가 lookup 값으로 들어온 `list`를 항상 `tuple`로 강제 변환한다. #30687 변경에서 생긴 회귀로, 입력 iterable 타입이 보존되지 않는다. PickledField처럼 입력 타입이 정확히 일치해야 동작하는 ORM 필드의 exact value 쿼리가 깨진다. 기대 동작은 반환 iterable 타입이 입력 iterable 타입과 동일하게 유지되는 것.

## 유형 분류
- 버그 카테고리: regression (logic / 타입보존 누락)
- 서브시스템: django ORM query (db/models/sql lookup 값 해석)
- 증상 타입: silent-wrong (예외 없이 list가 tuple로 바뀌어 exact 매칭 실패)
- 로컬라이제이션 신호: problem_statement가 `Query.resolve_lookup_value`와 PR #30687을 명시적으로 지목 — 함수명/메서드명이 그대로 골드 파일·함수로 연결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` : `Query.resolve_lookup_value`
- 근본 원인: list/tuple 분기에서 sub_value들을 풀어 `resolved_values` 리스트에 모은 뒤 `value = tuple(resolved_values)`로 무조건 tuple로 재조립했다. 입력이 list여도 출력이 tuple이 되어 타입이 손실됨. 또한 F/일반 expression을 수동으로 갈라 처리하는 중복 코드가 있었다.
- 수정 요지: 명령형 루프 + `tuple(...)` 재조립을 제거하고 `return type(value)(self.resolve_lookup_value(sub_value, ...) for sub_value in value)`로 교체. (1) `type(value)`로 원본 컨테이너 타입을 보존하고, (2) 각 sub_value를 `resolve_lookup_value`로 재귀 호출해 F/expression 분기 로직을 재사용(스칼라 분기가 이미 처리)하여 수동 F isinstance 분기를 삭제.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_iterable_lookup_value` — `Query(Item)`에서 `build_where(Q(name=['a', 'b']))`를 만들고 첫 자식이 `Exact`인지, 그 `rhs`가 문자열 `"['a', 'b']"`인지 확인.
- 증명 방식: rhs가 list의 repr인 `"['a', 'b']"`와 같다는 것은 내부에서 list가 tuple로 변환되지 않았음을 의미한다(tuple이었다면 `"('a', 'b')"`가 됨). 즉 입력 list 타입 보존을 직접 검증한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 함수명과 PR 번호를 직접 주므로 `resolve_lookup_value` 정의로 바로 진입. `git log`/blame으로 #30687 변경 hunk를 찾으면 정확한 회귀 지점 확인 가능.
- 함정/난이도 메모: 단일 파일·단일 메서드라 로컬라이제이션은 쉽다. 함정은 단순 `value = list(resolved_values)`로 고치면 tuple 입력이 깨진다는 점 — 반드시 `type(value)`로 원본 타입을 보존해야 한다. 재귀 호출로 단순화하면 F 분기 중복도 자연 제거되지만, 스칼라 분기가 expression/F를 이미 다룬다는 사실을 이해해야 안전하다.
- 우리 에이전트 관점: 막힐 만한 지점은 "타입 보존"을 놓치고 list로 하드코딩하거나, 재귀 단순화 없이 루프 안에서만 `type(value)(...)`로 감싸 PASS_TO_PASS의 F/transform 케이스를 의도치 않게 건드리는 것. 테스트가 rhs repr 문자열을 정확히 비교하므로 타입 보존만 정확히 맞추면 통과.
