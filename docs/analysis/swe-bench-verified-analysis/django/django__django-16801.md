---
instance_id: django__django-16801
repo: django/django
base_commit: 3b62d8c83e3e48d2ed61cfa32a61c56d9e030293
version: 5.0
difficulty: <15 min fix
created_at: 2023-04-26T07:23:56Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [django/db/models/fields/files.py]
---

# django__django-16801

## 문제 요약
`ImageField`는 모델에 항상 `post_init` 시그널 핸들러(`update_dimension_fields`)를 연결한다. 하지만 `width_field`/`height_field`가 지정되지 않으면 이 핸들러는 즉시 return하는 noop이다. 그럼에도 DB에서 모델을 대량 fetch할 때 매 인스턴스 초기화마다 시그널이 평가되어 초기화 시간의 30~40%를 잡아먹는 성능 문제가 보고됐다. 사용자는 dimension field가 없으면 시그널 연결 자체를 생략하길 기대했다.

## 유형 분류
- 버그 카테고리: regression / 성능(불필요한 부작용 등록)
- 서브시스템: django ORM model fields (`ImageField` / file fields)
- 증상 타입: 성능 저하 (silent overhead, 기능적 오류는 아님)
- 로컬라이제이션 신호: "ImageField", "post_init signal handler", "width_field / height_field", "noop because we don't use the width_field/height_field" → `ImageField`가 정의된 `django/db/models/fields/files.py`의 `post_init` 연결 지점으로 직결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/files.py` — `ImageField.contribute_to_class`, `ImageField.update_dimension_fields`
- 근본 원인: `contribute_to_class`가 non-abstract 모델이면 무조건 `signals.post_init.connect(self.update_dimension_fields, ...)`를 호출했다. dimension field 유무 검사는 시그널이 *발화된 후* `update_dimension_fields` 내부의 `has_dimension_fields` 가드에서만 이루어져서, 정작 연결 자체는 막지 못했고 인스턴스마다 핸들러 호출 오버헤드가 발생했다.
- 수정 요지:
  1. `contribute_to_class`의 연결 조건을 `if not cls._meta.abstract and (self.width_field or self.height_field):`로 강화 — dimension field가 있을 때만 `post_init`을 연결.
  2. 그 결과 `update_dimension_fields` 내부에서 더는 dimension field 유무를 검사할 필요가 없어져, `has_dimension_fields` 로컬 변수와 그 가드를 제거하고 deferred 검사(`self.attname not in instance.__dict__`)만 남김.

## 검증 (test_patch)
- FAIL_TO_PASS: `ImageFieldNoDimensionsTests.test_post_init_not_connected` — width/height field가 없는 모델(`Person`)에 대해 `post_init` 시그널 수신자 목록에 해당 모델이 등록되지 않았음을 확인.
- 증명 방식: `signals.post_init.receivers`를 순회해 각 receiver의 sender_id를 모으고, `id(self.PersonModel)`이 그 목록에 **포함되지 않음**(`assertNotIn`)을 단언. 패치 전에는 무조건 connect되어 모델 id가 목록에 존재 → 실패, 패치 후에는 dimension field가 없어 연결 자체가 생략 → 성공. PASS_TO_PASS의 dimension 갱신/할당/defer 테스트들은 dimension field가 있는 경우 동작이 유지됨을 보장.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `git grep "post_init.connect"` / `update_dimension_fields`로 바로 `files.py`의 `ImageField`에 도달. 문제 진술이 클래스·시그널 이름을 그대로 줘서 로컬라이제이션은 거의 공짜.
- 함정/난이도 메모: 핵심은 "연결을 막느냐 vs 핸들러 안에서 빨리 return하느냐"의 구분. 단순히 핸들러 내부 가드만 보강하면 성능 문제가 그대로 남는다(이미 존재하던 가드임). 또 `update_dimension_fields`는 `ImageFileDescriptor.__set__`에서 `force=True`로도 직접 호출되므로, dimension field 없는데 직접 호출되는 경로가 있는지 확인해야 안전하게 내부 가드를 제거할 수 있다(테스트가 이를 커버).
- 우리 에이전트 관점: 막힐 만한 지점은 "무해한 최적화"로 판단해 over-fix하거나, 내부 가드 제거를 누락해 dead-code를 남기는 것. 단일 파일·두 함수 수정이라 멀티파일 위험은 없으나, 시그널 연결 조건과 핸들러 가드의 책임을 한쪽으로 옮기는 리팩터링적 통찰이 필요.
