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
---

# django__django-15814

## 문제 요약
proxy 모델을 가리키는 FK에 대해 `select_related("custom").only("custom__name")`을 조합하면 쿼리 실행 시 `ValueError: 'id' is not in list`로 크래시한다. `RelatedPopulator.__init__`에서 `self.init_list.index(self.model_cls._meta.pk.attname)`을 수행하는데, proxy 모델 기준으로 만들어진 `init_list`에 concrete 모델의 pk(`id`)가 없어서 발생한다. 사용자는 deferred-field 최적화 쿼리가 정상적으로 결과를 반환하길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (proxy → concrete 모델 정규화 누락)
- 서브시스템: django ORM query 컴파일 (`sql/query.py`의 deferred field 처리)
- 증상 타입: 예외 (ValueError 크래시)
- 로컬라이제이션 신호: traceback이 `query.py:2243`의 `RelatedPopulator.__init__`를 직접 가리키고, 리포터가 problem_statement에서 `query.py` 745줄의 `opts = cur_model._meta` 스니펫과 수정안(`concrete_model`)까지 명시 — 골드 파일/라인이 그대로 노출됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` : `Query.deferred_to_data`
- 근본 원인: `deferred_to_data`가 select_related 체인을 따라가며 각 모델의 `_meta.opts`로부터 어떤 필드를 로드/지연할지 계산하는데, FK 타깃이 proxy 모델일 때 `cur_model`이 proxy 클래스 그대로 남는다. proxy의 `_meta`는 자기 필드만 추적하므로 거기서 만든 `init_list`에는 concrete 모델의 pk attname(`id`)이 누락되고, 이후 `RelatedPopulator`가 pk 인덱스를 찾다 실패한다.
- 수정 요지: `opts = cur_model._meta` 직전에 `cur_model = cur_model._meta.concrete_model` 한 줄을 삽입. proxy를 concrete 모델로 정규화한 뒤 `opts`를 뽑아, pk를 포함한 올바른 필드 집합으로 deferred 데이터를 구성하게 한다. hints에서 메인테이너가 제안한 "opts 자체가 아니라 cur_model을 고치라"는 방향을 그대로 채택.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_select_related_only (proxy_models.tests.ProxyModelTests)`
- 테스트가 어떻게 픽스를 증명하는지: `ProxyTrackerUser`(proxy)를 assignee로 갖는 `Issue`를 생성한 뒤 `Issue.objects.select_related("assignee").only("assignee__status")`를 실행하고 `qs.get()`이 원본 issue와 같은지 단언한다. 패치 전에는 이 `.get()`이 `ValueError: 'id' is not in list`로 터지므로, 예외 없이 객체를 반환한다는 것 자체가 픽스 증명이 된다 (재현 입력 = proxy FK + select_related + only, 기대 출력 = 정상 객체).

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback의 최종 프레임(`RelatedPopulator.__init__`의 pk_idx 계산)에서 시작하되, 실제 결함은 `init_list`를 채우는 상류인 `deferred_to_data`에 있다. "어디서 터지나"가 아니라 "잘못된 init_list가 어디서 만들어지나"를 역추적해야 함.
- 함정/난이도 메모: 크래시 지점(`RelatedPopulator`)과 수정 지점(`deferred_to_data`)이 다른 함수라 증상-원인 거리가 있다. proxy의 `_meta`와 `_meta.concrete_model._meta`의 차이를 알아야 하며, 무심코 `RelatedPopulator` 쪽에 방어 코드를 넣으면 근본 원인 미해결 + PASS_TO_PASS의 다른 select_related 케이스가 깨질 수 있다. 단일 파일/한 줄 수정이지만 정확한 위치 선정이 핵심.
- 우리 에이전트 관점: traceback 끝줄에만 집중하면 잘못된 함수를 패치하기 쉽다. proxy↔concrete 모델 구분이라는 도메인 지식이 없으면 `concrete_model` 정규화라는 정답을 떠올리기 어려움. problem_statement가 친절히 라인·수정안을 줬으므로, 힌트를 신뢰하되 "opts 교체" 대신 "cur_model 교체"가 더 깔끔한 이유(이후 `opts` 사용처와의 일관성)를 판단할 수 있어야 한다.
