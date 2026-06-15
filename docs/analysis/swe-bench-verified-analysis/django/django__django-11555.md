---
instance_id: django__django-11555
repo: django/django
base_commit: 8dd5877f58f84f2b11126afbd0813e24545919ed
version: 3.0
difficulty: <15 min fix
created_at: 2019-07-10T18:07:07Z
fail_to_pass: 1
pass_to_pass: 26
gold_files: [django/db/models/sql/compiler.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11555

## 문제 요약
멀티테이블 상속(MTI)에서 부모 모델의 `Meta.ordering`이 문자열이 아니라 쿼리 표현식(`OrderBy`, 예: `models.F('author').asc(nulls_first=True)`, `Lower('name')`)을 포함할 때, 자식 모델을 `order_by()`로 정렬하면 크래시가 난다. 내부적으로 ordering 항목을 필드명 문자열로 가정하고 `get_order_dir()`에서 슬라이싱/구독(subscript)을 시도하다 `'OrderBy' object is not subscriptable` 같은 `TypeError`가 발생한다. 이슈는 "the field is an OrderBy object, not a string, during get_order_dir"라고 증상 함수를 직접 지목하고, 재현 레포지토리와 스택트레이스를 첨부했다. hints에는 회귀 도입 커밋(`c498f088`)과 별도 시나리오(`Lower('name')` admin 크래시)까지 명시돼 있다.

## 유형 (정형화)
- **L = L1 (Traceable).** 이슈가 `get_order_dir`라는 함수명과 `'OrderBy' object is not subscriptable` 예외 문자열을 직접 준다. grep으로 `get_order_dir` 호출처를 따라가면 단일 파일 `sql/compiler.py`의 ordering 해석 경로로 수렴한다. 다만 **증상 함수(`get_order_dir`)와 진짜 수정 함수(`find_ordering_name`)가 달라서** "grep 한 방에 정확한 라인"은 아니다 — 스택을 한 프레임 위로 올라가는 약한 탐색이 필요해 L0가 아닌 L1.
- **S = S1 dominant (+S2 보조).** 결함클래스가 정형적이다: 문자열을 기대하는 경로에 비문자열(표현식) 타입이 흘러드는 "타입 분기 누락". 픽스 템플릿이 거의 자명하다 — 재귀 전에 `isinstance(item, OrderBy)` 가드를 넣고 그대로 통과시킨다(가드 추가 = TBar/PAR식 template repair). S2가 보조로 붙는 이유는, `OrderBy`는 방향 정보를 이미 자기 안에 담고 있으므로 결과 튜플의 reverse 플래그를 `False`로 줘야 한다는 작은 의미 추론(`results.append((item, False))`)이 필요하기 때문. "어디"가 아니라 "이 한 줄이 왜 reverse=False인가"에만 사고가 든다.
- **K = K-Domain.** django ORM query-compiler 내부지식 의존. `opts.ordering`이 MTI에서 부모 메타 표현식을 그대로 재귀에 밀어넣는다는 점, `find_ordering_name`의 재귀 구조, `OrderBy`가 이미 "완성된" 정렬 노드라는 점을 알아야 정확히 고친다. 일반 파이썬 추론만으로는 reverse 플래그 의미를 알 수 없음.
- **Primary type = T-DirectMap.** 위치가 명확하고(L1) 픽스가 기계적 가드 추가(S1)이므로 T-DirectMap. T-LocTrivial이 아닌 이유는 증상/수정 함수 불일치로 localize가 완전 자명하진 않아서이고, T-DomainBound이 아닌 이유는 도메인지식이 병목(dominant)이라기보다 픽스 형태가 이미 정형 가드라 K-Domain은 "올바른 한 줄"을 다듬는 보조 역할이기 때문.

## 난이도 티어
**Tier = T3 (중간).** 공식 라벨은 `<15 min fix`로 T1~T2를 시사하지만 한 단계 올린다.
- T1/T2로 끌어내리는 피처: 단일 파일, 3줄 추가, `has-repro`(재현 레포+네이티브 스택트레이스 = 가장 강한 easiness 신호, 해결률 ~87%대), 이슈가 증상 함수를 직접 지목.
- T3로 미는 피처: (1) **localize 직접성의 미세한 함정** — 스택 바닥의 `get_order_dir`에 방어코드를 넣는 과교정으로 빠지기 쉽고, 실제 정답은 한 프레임 위 `find_ordering_name`의 `opts.ordering` 순회 루프다. (2) **재현 조건이 좁다** — MTI + 표현식 ordering 조합에서만 터지고 REPL/스크립트에선 안 터져(이슈 작성자도 "왜 test db setup에서만 터지는지 모르겠다"고 함), 헬게이트 재현 세팅 자체가 도메인지식을 요구. (3) `regression-trap` — PASS_TO_PASS 26개가 전부 `ordering` 앱의 정렬 동작(F-expression, nulls_first/last, fk_attname, reverse, extra ordering 등)이라 표현식 분기를 잘못 넣으면 인접 정렬 경로를 깨기 쉽다.
- 공식 difficulty와 다른 이유: 시간라벨은 "정답을 아는 개발자의 구현시간"이라 3줄=15분이 맞지만, **localize의 함정과 재현 세팅의 도메인성은 시간라벨에 안 잡힌다**(루브릭 명시). 에이전트 난이도 기준으로 T3.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py` : `SQLCompiler.find_ordering_name`
- 근본 원인: `find_ordering_name`은 `opts.ordering`(모델 `Meta.ordering`)을 순회하며 각 항목을 다시 `self.find_ordering_name(item, opts, alias, order, already_seen)`로 재귀한다. 이 재귀 경로는 `item`이 필드명 **문자열**이라고 가정해 하위에서 `get_order_dir(item)`로 방향 접두사(`-`)를 슬라이싱한다. 그러나 MTI 자식을 정렬할 때 부모 메타 ordering의 `OrderBy` 표현식(`F('author').asc(...)`, `Lower(...)`)이 문자열로 변환되지 않은 채 이 루프로 흘러들어, `get_order_dir`가 표현식 객체를 구독(`name[0]`)하려다 `'OrderBy' object is not subscriptable` 크래시.
- 수정 요지: 재귀 호출 직전에 타입 분기 가드 추가 —
  ```python
  for item in opts.ordering:
      if isinstance(item, OrderBy):
          results.append((item, False))
          continue
      results.extend(self.find_ordering_name(item, opts, alias, order, already_seen))
  ```
  `OrderBy`는 이미 방향(asc/desc)과 nulls 처리를 내포한 완성된 정렬 노드이므로 재귀로 재해석하지 않고 결과에 `(item, False)`(reverse=False)로 그대로 담는다. 문자열 항목만 기존 경로로 재귀해 필드명을 해석. 즉 "표현식 vs 문자열"을 타입으로 분기해 표현식이 문자열 해석 경로로 새는 것을 차단한다.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `test_order_by_ptr_field_with_default_ordering_by_expression (ordering.tests.OrderingTests)`
- 테스트 셋업: `tests/ordering/models.py`에 표현식 ordering(`ordering = (models.F('author').asc(nulls_first=True), 'id')`)을 가진 `OrderedByAuthorArticle`(부모 `Article` 계열)을 상속한 빈 자식 `class ChildArticle(Article): pass`를 추가. `tests/ordering/tests.py` import에 `ChildArticle` 추가.
- 동작/픽스 증명: `ChildArticle` 4건을 author 차이(author_1/author_2/없음)로 생성한 뒤 `ChildArticle.objects.order_by('article_ptr')`를 실행. `article_ptr`(MTI OneToOne 부모 포인터)로 정렬하면 부모의 표현식 메타 ordering이 해석 경로로 들어온다 — 픽스 전에는 여기서 `OrderBy` 구독 크래시. 픽스 후엔 표현식이 그대로 정렬에 반영되어 `assertSequenceEqual(articles, [ca4, ca2, ca1, ca3])`로 nulls_first(author 없는 ca4 먼저) + author asc 순서를 검증.
- overfit/regression 관점: FAIL_TO_PASS가 1개라 얇아 `overfit-risk`가 형식상 떠오를 수 있으나, 픽스가 special-case 하드코딩이 아니라 `OrderBy` 타입 전반에 대한 분기라 special-case 통과(S4/CEGIS 위험)가 아니다 → overfit-risk 플래그는 달지 않음. 대신 `regression-trap`이 실질 위험: PASS_TO_PASS 26개가 모두 정렬 동작(F-expression Meta.ordering, nulls_first/last, reverse meta ordering, fk_attname, extra ordering 등)이라 가드 위치·조건을 틀리면 비-MTI 표현식 정렬이나 문자열 정렬을 깬다. 골드는 `continue`로 문자열 경로를 정확히 보존해 26개를 모두 통과시킨다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `'OrderBy' object is not subscriptable`와 "during get_order_dir" 신호 → `get_order_dir` 정의를 grep(`sql/query.py` 헬퍼) → 호출처 역추적 → `sql/compiler.py`의 ordering 해석 경로. 여기서 **한 프레임 위로 올라가** 호출자 `find_ordering_name`의 `opts.ordering` 순회 루프가 표현식 항목을 문자열로 가정한 채 재귀한다는 것을 확인. 이슈가 함수명을 줘서 L1이지만 "증상 함수 ≠ 수정 함수"라 스택 한 단계 추적이 핵심.
2. **픽스와 왜 올바른 일반화인가**: 재귀 전에 `isinstance(item, OrderBy)` 가드로 표현식을 분기해 `results.append((item, False))` 후 `continue`. 이것이 올바른 일반화인 이유 — `OrderBy`는 방향/nulls를 자체 보유한 완성 노드라 문자열 필드명처럼 재해석/방향추출이 필요 없다. 특정 테스트(`article_ptr`)에 맞춘 하드코딩이 아니라 "ordering에 들어오는 모든 표현식 객체" 클래스 전반을 덮으므로(`Lower('name')` admin 시나리오도 동시 해결) overfit이 아니다.
3. **regression 안전**: `continue`가 핵심 — 가드는 표현식 항목만 가로채고 문자열 항목은 손대지 않아 기존 문자열 ordering 재귀 경로가 그대로 보존된다. 이로써 비-MTI F-expression 정렬(`test_order_by_f_expression`, `test_default_ordering_by_f_expression`), nulls_first/last, reverse meta ordering, fk_attname, extra ordering 등 26개 P2P가 안 깨진다. reverse 플래그를 `False`로 둬야 `OrderBy`가 이미 가진 desc/asc 의미를 이중 반전하지 않는다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 스택 바닥의 `get_order_dir`에 `if not isinstance(name, str)` 방어코드를 넣는 **과교정**. 그러면 표현식이 거기까지 흘러간 뒤라 방향/구조 처리가 어색해지고 P2P 깨질 위험. 정답은 표현식이 문자열 경로로 새기 전에 상위 루프에서 막는 것. (b) reverse 플래그를 `True`나 `order` 변수로 잘못 줘서 정렬 방향을 뒤집는 것 — `OrderBy`는 자기 방향을 이미 알므로 `False`가 맞다. (c) 재현 세팅 실패 — MTI(`ChildArticle(Article)`) + 표현식 `Meta.ordering` + `order_by('article_ptr')` 조합을 못 만들면 RED 헬게이트를 못 세워 픽스 검증이 안 된다(이슈가 "test db setup에서만 터진다"고 한 단서를 반영해야 함).
