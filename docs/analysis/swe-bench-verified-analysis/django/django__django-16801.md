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
primary_type: T-DesignRefactor
tier: T3
loc_axis: L0
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-16801

## 문제 요약
`ImageField`는 non-abstract 모델이면 항상 `post_init` 시그널 핸들러(`update_dimension_fields`)를 연결한다. 그러나 `width_field`/`height_field`가 지정되지 않으면 이 핸들러는 즉시 return하는 noop이다. 그럼에도 DB에서 모델을 대량 fetch할 때 매 인스턴스 초기화마다 시그널 디스패치가 평가되어, 보고자 환경에서 모델 초기화 시간의 30~40%를 잡아먹는 성능 문제가 보고됐다. 사용자는 dimension field가 없으면 시그널 연결 자체를 생략하길 기대했다. 기능적 오류는 없고 silent overhead만 있는 성능 결함이다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 본문이 `ImageField`, `post_init signal handler`, `width_field / height_field`를 그대로 지목한다. `git grep "post_init.connect"` 또는 `update_dimension_fields` 한 방으로 `django/db/models/fields/files.py`의 `contribute_to_class` 연결 지점에 직결된다. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S6 (Design-Refactor) + S2 (Constraint-Reasoning).** 한 줄짜리 가드 추가가 아니라 **가드의 위치(lifecycle)를 옮기는** 작은 구조 변경이다: dimension-field 유무 검사를 *시그널 발화 시점*(`update_dimension_fields` 내부 런타임 가드)에서 *시그널 등록 시점*(`contribute_to_class`의 `connect` 호출 조건)으로 이동시키고, 옮긴 결과 죽은 코드가 된 `has_dimension_fields` 가드를 제거한다. 책임을 한쪽으로 재배치하는 게 본질이라 S6. 동시에 "연결을 막아도 안전한가"를 따지는 S2 추론(아래 함정 회피)이 보조로 깔린다 — 기존 런타임 가드를 제거하려면 dimension field 없이 `update_dimension_fields`가 직접 호출되는 경로(특히 `ImageFileDescriptor.__set__`의 `force=True`)에서도 `attname not in instance.__dict__` 가드만으로 충분함을 불변식으로 증명해야 한다.
- **K (Knowledge) = K-Domain.** django 시그널 디스패처(`signals.post_init.receivers` 구조·weak ref), 필드 `contribute_to_class` 라이프사이클, `ImageFileDescriptor` 디스크립터 프로토콜(`__set__`/`__get__`이 dimension 갱신을 트리거)을 알아야 안전하게 옮길 수 있다. 일반 파이썬 추론만으로는 "연결을 빼도 되는지"를 확신할 수 없다.
- **primary type = T-DesignRefactor.** 위치는 자명(L0)하나 진짜 작업은 "어디서 막을지"의 책임 재배치(런타임 가드 → 등록 가드)라는 조율된 소규모 구조 변경이다. S1(기계적 가드 추가)이 아니라 두 함수에 걸친 collect-the-guard-at-the-right-lifecycle-stage 리팩터링이므로 T-DirectMap이 아니라 T-DesignRefactor가 dominant.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(T1 prior)지만 다음 구조적 피처로 T3까지 끌어올린다:
- **파일/줄수는 T1~T2 신호**: 1파일, 2함수, 순변경 ~3줄(가드 1줄 추가 + 런타임 가드 2줄 삭제). 이것만 보면 쉬움.
- **그러나 픽스의 본질이 "가드 추가"가 아니라 "가드 위치 이동 + 죽은 코드 제거"**: 단순히 `update_dimension_fields` 내부 가드만 보강하면(이미 존재하던 가드임) 성능 문제가 **그대로 남는다**. naive fix가 통하지 않는다는 점이 T1을 배제한다.
- **regression surface가 좁지 않음**: PASS_TO_PASS 17개가 dimension 갱신/할당/생성/defer/pickle 경로를 광범위하게 커버한다(`regression-trap`). 런타임 가드를 제거하면서 dimension field가 *있는* 모델의 동작이 깨지면 안 된다.
- **도메인 추론 필요**: 시그널 등록 라이프사이클 + 디스크립터 force-path 안전성 추론(K-Domain)이 필요해 순수 기계적 픽스가 아니다.
- **has-repro 존재**: 보고자가 성능 측정·원인(30~40%)을 제시해 localize/검증은 쉬움 → T4까지는 안 가고 T3에서 멈춘다.

공식 `<15 min fix`와의 차이: 개발자(컨텍스트를 이미 아는 코어 메인테이너)에게는 15분이지만, 오라클 없는 에이전트 입장에서는 "런타임 가드 보강"이라는 가짜 해법에 빠지기 쉽고 force-path 안전성을 스스로 검증해야 하므로 구조적 난이도는 T3가 정직하다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/files.py` — `ImageField.contribute_to_class`, `ImageField.update_dimension_fields`.
- **근본 원인**: `contribute_to_class`가 non-abstract 모델이면 `cls._meta.abstract` 여부만 보고 무조건 `signals.post_init.connect(self.update_dimension_fields, sender=cls)`를 호출했다. dimension-field 유무 검사는 시그널이 *발화된 후* `update_dimension_fields` 내부의 `has_dimension_fields = self.width_field or self.height_field` 가드에서만 일어났다. 즉 핸들러는 noop이어도 **연결 자체는 막히지 않아**, 인스턴스마다 시그널 디스패치 + 핸들러 호출 + 즉시 return의 오버헤드가 발생했다.
- **수정 요지**:
  1. `contribute_to_class`의 연결 조건을 `if not cls._meta.abstract and (self.width_field or self.height_field):`로 강화 — dimension field가 실제로 있을 때만 `post_init`을 연결(등록 시점 가드).
  2. 가드를 등록 시점으로 옮겼으므로 `update_dimension_fields` 내부의 `has_dimension_fields` 로컬 변수와 그 가드를 제거하고, deferred 검사(`if self.attname not in instance.__dict__: return`)만 남김. 이로써 핸들러가 연결된 경우는 항상 dimension field가 보장되어 내부 dimension 검사가 불필요해진다.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작**: `model_fields.test_imagefield.ImageFieldNoDimensionsTests.test_post_init_not_connected`. width/height field가 없는 모델(`Person`)에 대해 `signals.post_init.receivers`를 순회하며 각 receiver의 sender_id를 모으고, `id(self.PersonModel)`이 그 목록에 **포함되지 않음**을 `assertNotIn`으로 단언한다.
- **픽스 증명**: 패치 전에는 dimension field 유무와 무관하게 무조건 `connect`되어 모델 id가 수신자 목록에 존재 → `assertNotIn` 실패. 패치 후에는 `(self.width_field or self.height_field)`가 거짓이라 연결 자체가 생략되어 목록에 없음 → 통과. 테스트가 "핸들러가 빨리 return하는가"가 아니라 "**연결되지 않았는가**"를 검사하는 점이 핵심 — naive한 내부-가드-보강 픽스는 여전히 connect를 하므로 이 테스트를 통과시키지 못한다(픽스의 정확한 형태를 강제).
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, 검사하는 불변식(연결 자체의 부재)이 정확히 성능 결함의 근본을 짚어 special-case 우회가 어렵다. dimension field가 *있는* 케이스의 연결/동작은 PASS_TO_PASS가 막아준다 — 따라서 `overfit-risk`보다 `regression-trap`이 지배적.
- **regression 관점**: PASS_TO_PASS 17개(dimension 갱신, 생성자/Manager.create 할당, defer, pickle, None 할당 시 dimension clear 등)가 dimension field가 **있는** 모델의 정상 동작을 광범위하게 고정한다. 특히 런타임 `has_dimension_fields` 가드 제거 후에도 `ImageFileDescriptor.__set__`의 `force=True` 직접 호출 경로가 안전한지를 `test_assignment`/`test_create`/dimension-update 테스트가 커버한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "ImageField", "post_init signal handler", "noop because we don't use the width_field / height_field" 신호를 그대로 따라 `git grep "post_init.connect"` 또는 `update_dimension_fields` → `django/db/models/fields/files.py`의 `ImageField.contribute_to_class`(연결 지점)와 `update_dimension_fields`(noop 핸들러) 두 함수에 즉시 도달. L0라 탐색 거의 불필요.
2. **픽스와 올바른 일반화**: noop을 빠르게 return시키는 게 아니라 **애초에 연결을 막는다**. `contribute_to_class`의 connect 조건에 `(self.width_field or self.height_field)`를 추가. 이것이 올바른 일반화인 이유 — 성능 비용은 "핸들러 본문"이 아니라 "시그널 디스패치 자체"에서 발생하므로, dimension field가 없는 *모든* `ImageField`에서 비용을 제거하는 유일하게 근본적인 지점이 등록 시점이다. 동시에 옮긴 결과 dead가 된 `has_dimension_fields` 런타임 가드를 제거해 단일 책임(가드는 등록 시점에만)을 유지한다.
3. **regression 안전**: dimension field가 *있는* 모델은 여전히 연결돼야 하므로 조건이 `and (width_field or height_field)`여야 하고(둘 다 없을 때만 스킵), `abstract` 검사는 보존한다. 런타임 가드 제거 시 `update_dimension_fields`가 디스크립터 `__set__(force=True)`에서 직접 호출되어도 연결된 핸들러는 항상 dimension field를 가지므로 `attname not in instance.__dict__` 가드만으로 충분 — PASS_TO_PASS의 dimension-update/assignment/create/defer/None-clear 테스트가 이를 보증한다.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 곳 — (a) "무해한 최적화"로 보고 핸들러 내부에서 더 빨리 return하도록만 손대면 성능 결함이 남고 FAIL_TO_PASS도 못 통과한다(테스트가 연결 자체의 부재를 검사). (b) connect 조건만 추가하고 이제 도달 불가능해진 `has_dimension_fields` 가드를 제거하지 않아 dead code를 남기는 것. (c) 조건을 `or`/`not` 잘못 써서 dimension field가 *있는* 모델까지 연결을 끊어 회귀를 일으키는 것. (d) 런타임 가드 제거가 force-path를 깨지 않는지 검증하지 않는 것 — 디스크립터 `__set__` 호출 경로를 추적해 안전성을 확인해야 한다.
