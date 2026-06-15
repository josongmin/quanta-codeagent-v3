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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-14140

## 문제 요약
`Q` 객체에 `Exists()` 같은 부울 표현식을 자식으로 넣고 `deconstruct()`를 호출하면 `TypeError: 'Exists' object is not subscriptable`로 크래시한다. 원인은 자식이 정확히 1개인 `Q`를 특수 처리하면서 `kwargs = {child[0]: child[1]}`로 첨자 접근을 하는데, conditional expression 자식은 `(필드명, 값)` 형태의 length-2 tuple이 아니기 때문이다. 이슈 본문에 재현 스니펫(`Q(Exists(...)).deconstruct()` + 네이티브 traceback)이 그대로 들어 있고, 토론은 "특수 케이스를 가드로 유지할지(보수적) vs 통째로 제거할지(일관성)"로 갈렸으며 최종적으로 제거안이 채택됐다.

## 유형 (정형화)
- **L (Localization) = L0** — traceback이 `query_utils.py`의 `deconstruct` 안 `kwargs = {child[0]: child[1]}` 줄을 직접 지목한다. `Q.deconstruct` 한 함수로 grep 한 방에 수렴. 후보 탐색이 사실상 불필요.
- **S (Repair Strategy) = S2 (+S6)** — 고칠 지점(deconstruct의 1-child 분기)은 명백하지만, 올바른 픽스는 단순 None-가드가 아니라 "직렬화 표현(args vs kwargs)을 어떤 불변식으로 통일할지"를 추론해야 한다. 핵심 제약: deconstruct 출력은 `Q(*args, **kwargs)` reconstruct와 왕복 동치여야 하고, multi-child(`Q(x=1) & Q(x=2)`)는 kwargs로 표현 불가(인자 손실)하므로 args가 유일하게 일관된 표현이라는 추론이 픽스를 결정한다. 분기 자체를 제거하고 collect 로직을 단순화하므로 작은 구조 변경(S6)도 동반.
- **K (Knowledge) = K-Domain** — `tree.Node`/`Q`의 children 표현, `connector`/`default`/`negated` 직렬화 규약, conditional expression의 `.conditional` 속성, deconstruct↔migration writer 계약 등 django ORM 내부 지식이 픽스의 정당성을 좌우한다. 일반 파이썬 추론만으로 "왜 args로 통일이 옳은가"를 정당화하기 어렵다.
- **primary_type = T-ConstraintReason** — 위치는 명확(L0)하나 난점은 "크래시를 안 나게"가 아니라 **올바른 직렬화 불변식을 추론으로 합성**하는 데 있다. 보수적 가드 패치(`getattr(child,'conditional',False)`)는 크래시는 막지만 테스트가 요구하는 args-일관 포맷은 만족 못 하므로, 정확한 식을 의미론적으로 도출해야 하는 S2 = T-ConstraintReason이 dominant.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(≈ T2~T3 시간대)지만 다음 구조적 피처가 T4로 민다:
- **S2 constraint-reasoning + K-Domain 결합**: 픽스 자체는 4줄짜리 단일 함수지만, "왜 단순 가드가 아니라 특수 케이스 제거가 정답인가"는 ORM의 deconstruct 왕복 계약 + multi-child 표현 불가능성이라는 도메인 추론을 요구한다. 시간라벨은 이 추론 비용을 못 잡는다.
- **regression-trap (P2P 199개)**: deconstruct 출력 포맷을 바꾸므로 인접 deconstruct 케이스(`test_deconstruct_and`, `test_deconstruct_or`, `test_deconstruct_nested`, `test_deconstruct_multiple_kwargs`, reconstruct 4종)와 migration/pickle 직렬화 경로를 안 깨야 한다. 넓은 P2P가 "방어적 최소 패치" 유혹을 함정으로 만든다.
- **underspecified**: 이슈가 "크래시 수정"으로 읽히지만 채택된 해법은 "직렬화 포맷 통일"이라 본문만으론 의도가 한 갈래로 안 결정된다(보수안/제거안 양론). test_patch를 안 보면 오답으로 수렴하기 쉽다.
- L0 + has-repro라는 easiness 신호가 T3 이하로 끌지만, "크래시 회피 ≠ 정답"이라는 spec gap과 넓은 P2P가 그것을 상쇄해 T4가 적정. (T5는 아님 — 멀티파일 조율도, overfit 고위험 CEGIS도 아님; L0 단일파일 단일함수.)

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/query_utils.py` — `Q.deconstruct`
- **근본 원인**: 자식이 정확히 1개이고 그게 `Q`가 아니면 `child = self.children[0]; kwargs = {child[0]: child[1]}`로 (필드명, 값) tuple임을 가정해 첨자 접근했다. `Exists` 등 conditional expression은 subscriptable이 아니라 `TypeError`. 게다가 이 특수 케이스는 일관성도 깨짐 — `Q(x=1)`은 kwargs로, `Q(x=1,y=2)`는 args로 직렬화되고, `Q(("x",1))`은 args여야 할 것을 kwargs로 잘못 넣는다.
- **수정 요지**: 1-child 특수 분기를 통째로 삭제. children을 항상 `args = tuple(self.children)`로 직렬화하고, `kwargs`는 `self.connector != self.default`일 때만 `_connector`, `self.negated`일 때만 `_negated`를 담는다. 단일 조건이든 표현식이든 모두 args로 일관 처리되어 `child[0]`/`child[1]` 첨자 접근 자체가 코드에서 사라진다(크래시 원인 제거 + 포맷 일관화 동시 달성).

## 검증 (test_patch)
- **FAIL_TO_PASS (4개) 동작**:
  - `test_deconstruct (queries.test_q.QTests)`: `Q(price__gt=F(...))`의 기대값이 `args=(('price__gt', F(...)),), kwargs={}`로 변경(이전 kwargs 형태 폐기). 포맷 통일을 강제.
  - `test_deconstruct_negated (queries.test_q.QTests)`: `~Q(price__gt=F(...))`도 `args=(('price__gt', F(...)),), kwargs={'_negated': True}`로 args+플래그 형태.
  - `test_deconstruct_boolean_expression (queries.test_q.QTests)`: `Q(Exists(tagged)).deconstruct()`가 크래시 없이 `args=(Exists(tagged),), kwargs={}` 반환 — 원래 크래시 재현의 직접 회귀 가드.
  - `test_boolean_expression_combined_with_empty_Q (expressions.tests.BasicExpressionsTests)`: `Q(Exists(...)) & Q()`, `Q() | Q(Exists(...))` 등 빈 Q 조합 케이스가 추가되어 실제 필터 결과(`[self.max]`)까지 검증.
- **픽스 증명**: 재현 입력 `Q(Exists(qs))` → 기대 출력 `(path, (Exists(qs),), {})`. 추가로 `queryset_pickle.tests`의 `test_pickle_boolean_expression_in_Q__queryset`가 deconstruct를 거치는 pickle 왕복으로 실제 쿼리 결과 보존을 확인(P2P 항목).
- **overfit 관점**: FAIL_TO_PASS가 4개지만 deconstruct의 단일/negated/표현식/빈Q-조합 4 분기를 모두 커버하고, P2P 199개에 deconstruct·reconstruct·migration·pickle 직렬화가 광범위 포함되어 special-case로 통과 불가. overfit 위험 낮음 → CEGIS(S4) 아님.
- **regression 관점**: 출력 포맷 변경이라 인접 deconstruct/reconstruct 케이스를 깨면 안 됨. multi-child는 원래도 args였으므로 그 경로엔 회귀 없고, 단일-child만 kwargs→args로 이동하는 좁은 변경.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 네이티브 traceback이 `query_utils.py` line의 `kwargs = {child[0]: child[1]}`를 직접 가리킨다 → `grep "len(self.children) == 1"` 또는 `child[0]: child[1]`로 `Q.deconstruct`에 즉시 도달(L0). 추가 탐색 불요.
2. **픽스와 올바른 일반화인 이유**: "크래시만 막기"(보수적 가드)는 hints에도 제안됐지만 함정이다. 정답은 1-child 특수 분기를 제거하고 `args = tuple(self.children)`로 통일하는 것. 이게 올바른 일반화인 근거 = deconstruct↔reconstruct 왕복 동치 + multi-child(`Q(x=1) & Q(x=2)`)는 kwargs로 표현 시 인자 손실(토론에서 명시) → args가 모든 children 수에 대해 손실 없이 일관된 유일 표현. 즉 conditional/tuple/단일/다중을 한 규약으로 묶는 것이 special-case 누더기보다 불변식상 옳다.
3. **regression 안전**: P2P 199개 중 `test_deconstruct_and/or/nested/multiple_kwargs`와 `test_reconstruct*` 4종, `queryset_pickle`의 직렬화 왕복을 안 깨야 한다. multi-child·nested-Q 경로는 본래 args 분기라 무변경 → 회귀 없음. 단일-child만 kwargs→args로 옮기므로 영향 면이 좁고, reconstruct는 `Q(*args, **kwargs)`라 `(('price__gt',F),)` args를 그대로 받아들여 왕복 보존.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답 = (a) "버그=크래시"로 좁게 읽고 `getattr(child,'conditional',False)` 가드만 추가 → `test_deconstruct`/`test_deconstruct_negated`의 새 기대값(args 포맷)을 못 맞춰 FAIL. (b) hints의 보수적 minimal patch를 그대로 적용. 회피법 = **test_patch의 변경된 assertion(kwargs→args)을 먼저 읽어** 요구사항이 "크래시 회피"가 아니라 "직렬화 포맷 통일"임을 파악하고, 그 위에서 특수 케이스 제거가 P2P를 안 깨는지(multi-child=원래 args) 확인.
