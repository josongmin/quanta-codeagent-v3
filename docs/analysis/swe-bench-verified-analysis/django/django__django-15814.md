---
instance_id: django__django-15814
repo: django/django
base_commit: 5eb6a2b33d70b9889e1cafa12594ad6f80773d3a
version: "4.2"
difficulty: 15 min - 1 hour
created_at: 2022-07-03T19:10:56Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15814

## 문제 요약
proxy 모델을 가리키는 FK에 대해 `select_related("custom").only("custom__name")`을 조합하면 쿼리 실행 시 `ValueError: 'id' is not in list`로 크래시한다. 크래시는 `RelatedPopulator.__init__`의 `self.pk_idx = self.init_list.index(self.model_cls._meta.pk.attname)`에서 발생하는데, proxy 모델 기준으로 만들어진 `init_list`에 concrete 모델의 pk attname(`id`)이 없기 때문이다. 리포터는 deferred-field 최적화 쿼리가 예외 없이 정상 결과를 반환하길 기대했고, problem_statement에서 결함 라인(`sql/query.py` 745줄 `opts = cur_model._meta`)과 수정안(`concrete_model`로 정규화)까지 직접 제시했다.

## 유형 (정형화)

3축 점수:
- **L0 (Pinpointed)** — problem_statement가 `django/db/models/sql/query.py` 745줄과 `opts = cur_model._meta` 스니펫을 그대로 지목하고, traceback이 `query.py:2243`(`RelatedPopulator.__init__`)까지 노출한다. grep 한 방으로 골드 파일·함수에 도달. 유일한 미세 노력은 "크래시 지점(`RelatedPopulator`) ≠ 수정 지점(`deferred_to_data`)"의 상류 역추적인데, 이마저 리포터가 745줄을 직접 짚어줘 사실상 L0.
- **S1 (Direct-Map) +S2** — 본질은 정형 결함클래스(proxy→concrete "타입 정규화 누락")에 한 줄 삽입으로 매핑되는 기계적 픽스다. 리포터·메인테이너가 정확한 수정식(`cur_model = cur_model._meta.concrete_model`)까지 명세했으므로 합성 부담이 거의 없다(S1 dominant). 보조 S2: "왜 `opts` 자체를 바꾸지 않고 `cur_model`을 바꾸는가"(이후 `opts` 사용처와의 일관성, `source.related_model`/`source.remote_field.model` 양 분기 모두에 적용되도록)라는 약한 불변식 추론이 깔끔한 정답을 고르는 데 작용.
- **K-Domain** — django ORM 내부 지식이 병목. proxy 모델과 concrete 모델의 `_meta` 차이(proxy는 자기 필드만 추적, concrete pk attname이 init_list에 빠짐), `deferred_to_data`가 select_related 체인을 따라 로드/지연 필드를 계산하는 메커니즘, `RelatedPopulator`가 그 init_list로 pk 인덱스를 찾는 흐름 — 이 도메인 모델 없이는 `concrete_model` 정규화라는 정답을 떠올리기 어렵다.

**primary type = T-DomainBound** — 위치·픽스식이 이슈에 다 적혀 있어 localize/synthesis 난점은 사실상 0이고, 진짜 병목은 "proxy↔concrete `_meta` 구분"이라는 ORM 도메인 지식이다. K-Domain이 dominant이므로 T-DirectMap이 아니라 T-DomainBound로 분류한다(한 줄 픽스라도 그 한 줄이 도메인 개념에서만 나온다).

APR 관점 repair strategy 근거: 결함이 "특정 타입(proxy)을 정규화하지 않아 하류 인덱싱이 깨지는" 정형 패턴이고, 오라클(이슈+힌트)이 fix template을 그대로 제공하므로 SemFix류 식-합성이 아니라 PAR/TBar류 template-application(S1)에 정확히 매칭된다. 후보 패치 다수를 테스트로 거르는 G&V도 아니다 — 정답이 결정론적으로 한 줄이다.

## 난이도 티어
**T3 (중간).**

이 티어로 미는 구조적 피처:
- **L0 + 1파일·1줄** 자체는 T1~T2 신호다(has-repro까지 있어 +easiness). 골드패치는 단일 파일 단일 헌크, 순삽입 1줄.
- 그러나 **증상-원인 거리**: 크래시는 `RelatedPopulator.__init__`(2243줄)에서 나지만 결함은 상류 `deferred_to_data`(748줄)다. traceback 끝줄에만 의존하면 잘못된 함수에 방어 코드를 넣게 된다.
- **K-Domain 병목**: proxy의 `_meta` vs `_meta.concrete_model._meta` 차이는 django ORM 고유 지식이라 일반 파이썬 추론(K-Gen)으로는 막힌다. knowledge deficiency가 실패의 ~25%를 차지한다는 실증과 부합.
- **regression-trap**: PASS_TO_PASS 29개가 proxy/select_related 인접 동작을 광범위하게 커버(`test_proxy_for_model`, `test_concrete_model`, "We can still use select_related() …", `test_user_proxy_models` 등). 무심코 `RelatedPopulator`에 special-case 가드를 넣으면 정상 select_related 케이스가 깨질 위험.

공식 라벨("15 min - 1 hour")과의 정합: 개발자 구현시간으로는 한 줄 + 회귀테스트라 이 구간이 타당하고, 에이전트 관점에서도 has-repro + L0 + 명시된 fix가 난이도를 끌어내려 T4까지는 가지 않는다. 다만 도메인 지식 의존 + 증상-원인 분리 + 넓은 P2P trap이 T1/T2 "존나쉬움/쉬움"보다는 위라, **T3로 한 단계 올려** 재조정한다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/query.py` : `Query.deferred_to_data`
- **근본 원인**: `deferred_to_data`는 select_related 체인을 순회하며 각 단계의 `cur_model`을 `source.related_model`(forward) 또는 `source.remote_field.model`(기타)로 잡고, `opts = cur_model._meta`에서 어떤 필드를 로드/지연할지 계산한다. FK 타깃이 proxy 모델이면 `cur_model`이 proxy 클래스 그대로 남고, proxy의 `_meta`는 자기 필드만 추적하므로 거기서 만든 init_list에 concrete 모델의 pk attname(`id`)이 누락된다. 하류 `RelatedPopulator.__init__`이 `init_list.index(pk.attname)`로 pk 인덱스를 찾다 `ValueError: 'id' is not in list`로 실패한다.
- **수정 요지**: `opts = cur_model._meta` 직전에 `cur_model = cur_model._meta.concrete_model` 한 줄 삽입. proxy를 concrete 모델로 먼저 정규화한 뒤 `opts`를 뽑아, pk를 포함한 올바른 필드 집합으로 deferred 데이터를 구성한다. 메인테이너가 hints에서 제시한 "`opts`를 `cur_model._meta.concrete_model._meta`로 바꾸지 말고 `cur_model` 자체를 고치라"는 방향을 채택 — 이후 `opts`를 쓰는 모든 사용처가 concrete 모델 기준으로 일관되게 동작하기 때문.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_select_related_only (proxy_models.tests.ProxyModelTests)`
- **동작/픽스 증명**: 테스트는 `ProxyTrackerUser`(proxy)를 assignee로 갖는 `Issue`를 만든 뒤 `Issue.objects.select_related("assignee").only("assignee__status")`를 실행하고 `qs.get()`이 원본 `issue`와 같은지 단언한다. 패치 전에는 `.get()`이 `ValueError: 'id' is not in list`로 크래시하므로, **예외 없이 동등 객체를 반환한다는 것 자체가** 픽스 증명이다(재현 입력 = proxy FK + select_related + only, 기대 출력 = 정상 객체).
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇지만, 픽스가 special-case 분기가 아니라 "proxy를 항상 concrete로 정규화"라는 일반 변환이라 overfit 위험은 낮다 — 이 한 줄은 모든 proxy-타깃 FK select_related 경로를 동일하게 교정하지, 테스트 입력에만 맞춘 패치가 아니다. (`overfit-risk` 플래그를 달지 않은 이유.)
- **regression 관점**: PASS_TO_PASS 29개가 proxy 및 select_related 정상 동작을 광범위하게 검증하므로 `regression-trap`. concrete 모델은 `_meta.concrete_model`이 자기 자신이라 정규화가 no-op → 기존 비-proxy select_related 케이스는 동작 불변. 만약 픽스를 `RelatedPopulator` 쪽 방어 코드로 넣었다면 이 P2P 군이 깨졌을 것.

## 모범답안 (오라클 기반)
1. **localize 경로**: traceback 최종 프레임(`query.py:2243` `RelatedPopulator.__init__` → `pk_idx = init_list.index(pk.attname)`)에서 "왜 pk가 init_list에 없나"를 질문한다. init_list를 채우는 상류를 역추적하면 `deferred_to_data`의 `opts = cur_model._meta`에 닿는다. problem_statement가 745줄과 이 스니펫을 직접 짚어줘 역추적이 강하게 가이드된다 → 골드 파일·함수 확정.
2. **픽스와 일반화 정당성**: 결함은 "`cur_model`이 proxy일 때 `_meta`가 concrete pk를 누락"이므로, `opts`를 뽑기 직전 `cur_model = cur_model._meta.concrete_model`로 정규화한다. 이것이 올바른 일반화인 이유 — (a) proxy는 본질적으로 concrete의 동일 테이블/동일 pk를 공유하는 뷰이므로 deferred 필드 계산은 항상 concrete 기준이어야 한다(개념적 불변식), (b) concrete 모델에선 `concrete_model`이 자기 자신이라 no-op → 안전, (c) `opts`가 아니라 `cur_model`을 고치면 forward/remote 양 분기와 이후 모든 `opts` 사용처가 일관. 테스트 입력에 맞춘 패치가 아니라 proxy 클래스 전체에 대한 변환이라 overfit 아님.
3. **regression 안전**: 비-proxy select_related/only 경로(P2P의 "We can still use select_related() …", `test_proxy_for_model`, `test_concrete_model`, `test_user_proxy_models` 등)는 정규화가 no-op라 동작 불변이어야 하고 실제로 그렇다. 이 P2P 군을 깨지 않는 것이 픽스의 정당성 검증이다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) traceback 끝줄에만 집중해 `RelatedPopulator.__init__`에 `try/except`나 pk-fallback 같은 방어 코드를 넣어 근본 원인 미해결 + P2P 회귀를 유발하기 쉽고, (b) proxy↔concrete `_meta` 차이라는 도메인 지식이 없으면 `concrete_model` 정규화를 떠올리지 못한다. 회피법: "어디서 터지나"가 아니라 "잘못된 init_list가 어디서 만들어지나"로 질문을 바꿔 상류 `deferred_to_data`로 올라가고, problem_statement/hints의 메인테이너 제안("opts 교체 대신 cur_model 교체")을 신뢰하되 그 이유(이후 `opts` 사용처 일관성)를 스스로 검증한다.
