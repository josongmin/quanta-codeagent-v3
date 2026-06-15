---
instance_id: django__django-14140
repo: django/django
base_commit: 45814af6197cfd8f4dc72ee43b90ecde305a1d5a
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2021-03-17T11:37:55Z
fail_to_pass: 4
pass_to_pass: 199
gold_files: [django/db/models/query_utils.py]
---

# django__django-14140

## 문제 요약
`Q` 객체에 `Exists()` 같은 부울 표현식을 자식으로 넣고 `deconstruct()`를 호출하면 `TypeError: 'Exists' object is not subscriptable`로 크래시한다. 원인은 자식이 1개인 `Q`를 특수 처리해서 `child[0]`, `child[1]`로 첨자 접근하는데, 표현식 자식은 (필드명, 값) 형태의 2-tuple이 아니기 때문이다. 사용자는 `Q(Exists(qs)).deconstruct()`가 다른 입력처럼 정상적으로 직렬화되기를 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (1-child 특수 케이스가 비-tuple 자식을 가정)
- 서브시스템: django ORM query (`Q` 객체 직렬화/deconstruct)
- 증상 타입: 예외 (TypeError, not subscriptable)
- 로컬라이제이션 신호: traceback이 `deconstruct`의 `kwargs = {child[0]: child[1]}` 줄을 직접 가리킴 → `query_utils.py`의 `Q.deconstruct`로 바로 연결

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query_utils.py` : `Q.deconstruct`
- 근본 원인: 자식이 정확히 1개이고 그게 `Q`가 아니면 `(child[0], child[1])` tuple로 가정해 `kwargs`에 풀어 넣었다. 이 첨자 접근이 `Exists` 같은 conditional expression(non-subscriptable)에서 터짐. 또한 이 특수 케이스는 일관성도 없음 — `Q(x=1)`은 kwargs로, `Q(x=1, y=2)`는 args로 직렬화됨.
- 수정 요지: 1-child 특수 분기를 통째로 제거. 이제 `children`을 항상 `args = tuple(self.children)`로 직렬화하고, `kwargs`는 `connector`가 기본값과 다를 때만 `_connector`, negated일 때만 `_negated`를 담는다. 단일 조건이든 표현식이든 모두 args로 일관 처리되어 첨자 접근 자체가 사라짐.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `test_deconstruct`: `Q(price__gt=F(...))`가 이제 `args=(('price__gt', F(...)),), kwargs={}`로 나옴 (이전 kwargs 형태 폐기).
  - `test_deconstruct_negated`: negated 단일 조건도 args로 직렬화 + `kwargs={'_negated': True}`.
  - `test_deconstruct_boolean_expression`: `Q(Exists(tagged)).deconstruct()`가 크래시 없이 `args=(Exists(tagged),), kwargs={}` 반환.
  - `test_boolean_expression_combined_with_empty_Q`: `Q(Exists(...)) & Q()` 등 빈 Q와의 조합 케이스 추가.
- 픽스 증명 방식: 재현 입력 `Q(Exists(qs))` → 기대 출력 `(path, (Exists(qs),), {})`. 또한 `queryset_pickle` 테스트(`test_pickle_boolean_expression_in_Q__queryset`)가 deconstruct를 거치는 pickle 왕복을 통해 실제 쿼리 결과가 보존됨을 확인.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback이 친절하게 `query_utils.py`의 `deconstruct` 안 특정 줄을 가리킨다. `grep`으로 `child[0]: child[1]` 또는 `len(self.children) == 1`을 찾으면 바로 도달.
- 함정/난이도 메모:
  - hints에는 보수적 패치(`getattr(child, 'conditional', False)` 체크로 특수 케이스 유지)도 제안됐지만, 골드는 더 과감하게 특수 케이스 자체를 제거했다. 에이전트가 hints의 최소 패치만 적용하면 `test_deconstruct`/`test_deconstruct_negated`의 새 기대값(args 형태)을 만족 못 해 FAIL.
  - 즉 "크래시만 안 나게" 고치면 부족 — deconstruct 출력 포맷을 args 일관 방식으로 바꿔야 4개 FAIL_TO_PASS 전부 통과.
  - 단일 파일 수정이지만, deconstruct 출력은 reconstruct(`Q(*args, **kwargs)`)와 왕복 호환되어야 하므로 args/kwargs 분배 변경이 `__init__` 의미와 맞는지 확인 필요. multi-child 케이스는 원래도 args였으므로 회귀 없음.
- 우리 에이전트 관점: 막힐 만한 지점은 "버그=크래시"로 좁게 보고 방어적 가드만 추가하는 것. 테스트가 출력 포맷 변경까지 요구한다는 걸 test_patch를 안 읽으면 놓침. PASS_TO_PASS가 175개로 넓으니 포맷 변경이 다른 deconstruct 케이스를 깨지 않는지도 점검해야 한다.
