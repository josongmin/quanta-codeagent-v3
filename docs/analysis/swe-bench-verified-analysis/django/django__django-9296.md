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
primary_type: T-LocTrivial
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [overfit-risk, has-repro]
---

# django__django-9296

## 문제 요약
`Paginator` 객체의 모든 페이지를 순회하려면 지금은 `page_range`를 돌면서 `page(num)`을 직접 호출해야 한다. 사용자는 파이썬의 일반적 관용구대로 `for page in paginator:` 처럼 객체 자체를 순회하길 기대하는데, `Paginator`가 iterator protocol(`__iter__`)을 구현하지 않아 불가능하다. 즉 예외가 아니라 **기능 누락**이며, 이슈 본문이 원하는 구현 코드(`for page_num in self.page_range: yield self.page(page_num)`)까지 그대로 적어 제출한 형태다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 클래스명(`Paginator`), 추가할 메서드(`__iter__`), 의존 속성(`page_range`, `page`)을 모두 직접 지목한다. `class Paginator`는 `django/core/paginator.py`에 단일 정의되어 있어 grep 한 방이면 파일·삽입지점이 확정된다. 데이터플로우 추적·후보 탐색이 전무.
- **S (Repair Strategy) = S1 (Direct-Map / template).** 이슈가 사실상 픽스를 명세한다. 정형 결함클래스 "iterator protocol 미구현 → 제너레이터 메서드 추가" 템플릿에 기계적으로 매칭된다. 올바른 조건식을 추론 합성할 필요(S2)도, 후보를 테스트로 수렴시킬 필요(S3)도 없다. 이슈에 적힌 스니펫이 골드와 사실상 동일.
- **K (Knowledge) = K-Gen (General).** 일반 파이썬 이터레이터 프로토콜·제너레이터 지식이면 충분. django ORM/query-compiler 같은 프레임워크 내부지식 불필요. `page_range`/`page()`의 의미는 같은 파일 상단에서 즉시 읽힌다.
- **Primary type = T-LocTrivial.** L0 + S1 정의에 정확히 부합("찾으면 끝, 픽스 자명"). 위치가 이슈에 박혀 있고 픽스가 자명하므로 T-DirectMap(가드/상수/타입강제)보다 더 약한, 사실상 "스펙이 곧 패치" 케이스다. APR 관점에서 이건 retrieval-then-template의 가장 쉬운 변형 — 합성(synthesis) 부담이 0에 수렴하고, 위험은 오직 over-implementation(절제 실패)뿐.

## 난이도 티어
**T1 (존나쉬움).** 구조적 피처가 전부 최저 난이도 쪽을 가리킨다:
- 파일 1개(`django/core/paginator.py`), 순수 추가 4줄(메서드 1개), 멀티헌크·멀티파일 아님 → 구조컷상 1파일·<5줄 ≈ 48% solve 구간보다도 위.
- localize 직접성 최상(L0): 이슈가 클래스·메서드·삽입위치를 다 알려줌.
- has-repro에 준함: 이슈 본문이 원하는 동작과 구현 코드를 그대로 제공(가장 강한 easiness 신호).
- 도메인 지식 K-Gen, P2P trap 약함(아래 검증 참조).

공식 라벨 `<15 min fix`와 **일치** — prior와 구조피처가 같은 방향이라 재조정 불필요. 유일하게 시간라벨에 안 잡히는 위험은 overfit/over-engineering 쪽인데, 이는 난이도를 올리는 localize·추론 부담이 아니라 "절제"의 문제라 티어를 끌어올리지 않는다(T1 유지).

## 골드패치 분석
- **건드린 파일/함수:** `django/core/paginator.py` → `Paginator.__iter__` (신규, `__init__` 직후 삽입).
- **근본 원인:** `Paginator`가 iterator protocol을 구현하지 않아 `iter(paginator)`/`for page in paginator:`가 불가. 페이지 순회 의도를 표현할 표준 진입점 부재.
- **수정 요지:** 제너레이터 메서드
  ```python
  def __iter__(self):
      for page_number in self.page_range:
          yield self.page(page_number)
  ```
  를 추가. 기존 `self.page_range`(1-based 페이지 번호 시퀀스)를 돌며 각 번호마다 `self.page(page_number)`를 `yield`. `page()`/`validate_number()` 로직을 재사용하므로 페이지 경계·orphans·`allow_empty_first_page` 처리는 전부 기존 메서드에 위임된다. 동작 추가만 있고 기존 시그니처/동작 변경 0 → 회귀 표면이 극소.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_paginator_iteration` — `Paginator([1, 2, 3], 2)`를 만들고 `iter(paginator)`로 이터레이터를 얻은 뒤 `next()`를 반복. `enumerate(([1, 2], [3]), start=1)`로 1페이지=`[1,2]`, 2페이지=`[3]` 기대값을 만들고, 각 `next(page_iterator)`가 돌려준 `Page`를 `list()`로 펼쳐 비교. `subTest(page=...)`로 페이지별 단언 분리.
- **픽스 증명:** 패치 전엔 `__iter__`가 없어 `iter()`/`next()`가 페이지를 내놓지 못해 실패. 패치 후 `page_range`(=`[1,2]`) 순서대로 정확히 2개 페이지를 yield 해 통과. per_page=2, 원소 3개 → orphans 없이 2페이지로 분할되는 표준 경로를 탄다.
- **overfit 관점 (`overfit-risk` 플래그):** FAIL_TO_PASS가 **단 1개**이고 입력이 `[1,2,3]`/per_page=2 한 케이스뿐 — orphans>0, 빈 리스트, `allow_empty_first_page=False` 같은 경계는 직접 검증하지 않는다. 따라서 테스트만 보면 "그냥 `[1,2]`,`[3]` 두 Page 하드코딩"으로도 통과하는 과소명세(weak suite)다. 골드가 이 함정을 피하는 이유는 `page_range`/`page()` 위임 덕에 모든 경계가 기존 검증로직으로 자동 일반화되기 때문(테스트가 약해도 구현이 옳음).
- **regression 관점:** PASS_TO_PASS 20개는 전부 `pagination.tests`의 기존 동작(`test_paginator`, `test_page_range_iterator`, `get_page` 계열, 모델 페이지네이션 등). `__iter__`는 순수 추가라 이들 경로를 건드리지 않으므로 회귀 표면이 거의 0. `regression-trap` 플래그는 비표기(P2P가 광범위한 인접 동작 변경을 강제하지 않음).

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `Paginator.__iter__`를 명시 → `grep -n "class Paginator" django/core/paginator.py` 한 번. 같은 파일에서 `page_range` 프로퍼티(1-based 번호 시퀀스 반환)와 `page(number)` 메서드(`validate_number`로 1-based 검증)를 확인해 위임 대상 2개를 고정. 탐색 종료.
2. **픽스 & 올바른 일반화:** `__init__` 직후에 제너레이터 메서드 `__iter__`를 추가하고 본문은 `for page_number in self.page_range: yield self.page(page_number)`. 이게 overfit이 아니라 올바른 일반화인 이유 — 페이지 분할·orphans·empty 처리를 직접 재구현하지 않고 **이미 검증된 `page_range`/`page()`에 위임**하므로, 테스트가 한 케이스만 봐도 모든 경계(orphans, empty, allow_empty_first_page=False)에서 정확히 동작한다. 수동으로 `range(self.num_pages)`를 돌리면 0-based/1-based 불일치(off-by-one)를 새로 만들 위험이 있어 위임이 정답.
3. **regression 안전:** 순수 추가 메서드라 기존 PASS_TO_PASS 20개(특히 `test_page_range_iterator`, `test_paginator`, `get_page` 계열)는 호출경로가 바뀌지 않아 안전. 기존 시그니처·프로퍼티를 일절 수정하지 않는 것이 회귀 0의 핵심.
4. **함정 회피:** 오라클 없는 에이전트의 실패 지점은 두 가지뿐. (a) **off-by-one** — `self.page_range`(1-based) 대신 `range(self.num_pages)`나 `range(1, self.num_pages)`를 쓰면 첫/끝 페이지가 빠짐; 반드시 `page_range`에 위임. (b) **over-engineering / overfit** — 약한 단일 테스트에 끌려 `[1,2]`,`[3]`을 흉내내는 특수화를 하거나, 요구되지 않은 `__len__`/`__getitem__`/`__contains__`까지 추가하는 것. 골드처럼 `__iter__` 단일 메서드 + `page_range` 위임 최소 구현에서 멈추는 절제가 정답이며, `__iter__`를 제너레이터로 둬야 매 호출마다 새 이터레이터를 반환(재진입 가능)한다는 점도 지킬 것.
