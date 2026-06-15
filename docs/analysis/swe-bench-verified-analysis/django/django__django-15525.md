---
instance_id: django__django-15525
repo: django/django
base_commit: fbacaa58ffc5a62456ee68b90efa13957f761ce4
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-03-18T10:39:26Z
fail_to_pass: 1
pass_to_pass: 53
gold_files: [django/core/serializers/base.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-15525

## 문제 요약
natural_key가 외래키(FK)를 참조하도록 정의된 모델을 `loaddata`로 비-기본(non-default) 데이터베이스에 로드하면 예외가 발생한다. 기본 DB에서는 잘 동작하지만, `--database other`로 로드하면 `natural_key()` 안에서 `self.author.natural_key()`를 호출하는 순간 `Author matching query does not exist`(DoesNotExist)가 터진다. 사용자는 기본 DB와 다른 DB가 동일하게 동작하길 기대했고, 재현 가능한 버그 프로젝트와 전체 트레이스백을 첨부했다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement의 트레이스백이 `django/core/serializers/base.py` line 332 `natural_key = Model(**data).natural_key()`를 함수·라인까지 직접 지목한다. grep 한 방으로 `build_instance` 한 함수에 도달한다. cross-module 데이터플로우 추적이 전혀 필요 없으므로 L1조차 아니다.

- **S (Repair Strategy) = S2 (Constraint-Reasoning)** — 고칠 지점(build_instance의 임시 인스턴스 생성)은 자명하나, "올바른 식"이 자명하지 않다. 단순 None-가드/상수변경 템플릿(S1)이 아니라, "임시 인스턴스의 `_state.db`가 None이라 라우터가 default로 폴백해 FK lazy-조회가 잘못된 DB로 라우팅된다 → natural_key() **호출 전에** db를 주입해야 한다"는 불변식·순서 의존성을 추론으로 합성해야 한다. 테스트를 여러 번 돌려 후보를 고르는 generate-&-validate(S3/S4)가 아니라, ORM 라우팅 의미론을 따져 "생각으로" 한 번에 푸는 SemFix/Angelix 계열이다. 그래서 primary는 **T-ConstraintReason** — 위치는 명확하나 S2로 올바른 조건(db 주입 + 호출 순서)을 추론 합성하는 게 본질.

- **K (Knowledge) = K-Domain** — django ORM 내부 동작 지식이 병목이다. `Model(**data)`로 만든 미저장 인스턴스의 `_state.db`는 `None`이라는 점(`ModelState.db = None`이 기본값이며 `DEFAULT_DB_ALIAS`가 아님), FK 디스크립터(`ForwardManyToOneDescriptor.__get__`)의 lazy 조회가 라우터를 거치는데 라우터가 `instance._state.db`가 falsy(None)이면 `DEFAULT_DB_ALIAS`로 폴백 라우팅한다는 점, 그래서 db를 안 맞추면 default에서 author를 못 찾는다는 점 — 이 멀티-DB 라우팅 도메인지식 없이는 픽스가 보이지 않는다. K-API는 아니다(공개 시그니처/리턴형 계약 변경 없음).

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(개발자 구현시간)이고, 프로덕션 픽스가 단일 파일 3줄·has-repro라 표면적으로는 T2~T3로 보인다. 그러나 다음 구조적 피처들이 T4로 민다:

- **추론 난도 (S2 + K-Domain)**: 픽스 줄 수는 작아도 "어디"가 아니라 "왜·어떤 순서로"가 어렵다. 증상(`Author DoesNotExist`)이 데이터/픽스처 결함처럼 보이는 **오도성 증상**이라, ORM `_state.db` 라우팅 가설에 도달하지 못하면 픽스처/매니저 쪽을 헤맨다. 이건 시간라벨에 잡히지 않는 난이도다.
- **regression-trap (넓은 P2P)**: PASS_TO_PASS 53개가 대부분 `fixtures_regress`/serializer/natural-key dependency-sorting 테스트라, build_instance를 건드리면 기존 default-DB 자연키 로드·dependency 정렬·M2M 자연키 직렬화를 깨기 쉽다. 픽스가 default 경로 동작을 보존해야 하는 제약이 강하다(루브릭 T4 "넓은 P2P trap" 컷).
- **cross-file 검증 비용**: 본체는 1파일이지만 회귀 테스트가 models.py(새 모델/매니저)+새 픽스처 json+tests.py(새 TestCase) 3파일에 걸친다.

repro가 있어 T5까지 가지는 않는다(localize·재현이 거의 공짜). 따라서 공식 시간라벨과 대체로 정합하되, 에이전트 관점에서는 추론·regression 위험이 라벨보다 한 단계 무겁다.

## 골드패치 분석
- **건드린 파일·함수**: `django/core/serializers/base.py` → `build_instance(Model, data, db)`
- **근본 원인**: `Model(**data)`로 생성한 미저장 임시 인스턴스의 `_state.db`가 `None`으로 남는다(`ModelState.db = None`이 기본값). 이 인스턴스의 `natural_key()`가 FK(`self.author`)에 접근하면, FK 디스크립터의 lazy 조회가 라우터를 거치는데, 라우터는 `instance._state.db`가 falsy(None)이므로 `DEFAULT_DB_ALIAS`로 폴백해 default DB에서 관련 객체를 찾는다. 데이터가 `other` DB에만 적재되는 상황(default에는 아직 없음)에서는 default에 author가 없어 `DoesNotExist`가 발생한다. 즉 임시 인스턴스에 **대상 DB 컨텍스트가 누락**(None)되어 라우터 폴백을 타고 natural_key 계산 중 FK 역참조가 default DB로 라우팅되는 게 원인. 픽스는 `obj._state.db = db`로 라우터에 읽힐 non-None 값을 심어 이 폴백을 막는다.
- **수정 요지**: 임시 인스턴스를 변수 `obj`로 분리하고, `natural_key()`를 호출하기 **전에** `obj._state.db = db`를 명시적으로 주입한다. 호출 순서가 핵심 — db 주입이 natural_key() 평가보다 앞서야 그 내부의 FK lazy 조회가 올바른 `db`로 라우팅된다.

```python
obj = Model(**data)
obj._state.db = db
natural_key = obj.natural_key()
```

(참고: PR에서는 `Model.from_db`를 쓰면 private `_state.db` 직접 접근을 피해 더 깔끔하다는 논의가 있었으나, 머지된 골드패치는 `_state.db` 직접 대입을 채택했다.)

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `fixtures_regress.tests.NaturalKeyFixtureOnOtherDatabaseTests.test_natural_key_dependencies` — "Natural keys with foreing keys in dependencies works in a multiple database setup."
- **테스트 구성**: `tests/fixtures_regress/models.py`에 `NaturalKeyWithFKDependency`(FK `author → Person`, `natural_key`가 `(self.name,) + self.author.natural_key()`, `natural_key.dependencies = ["fixtures_regress.Person"]`, `unique_together = ["name", "author"]`)와 매니저 `NaturalKeyWithFKDependencyManager.get_by_natural_key(name, author)`를 추가. 새 픽스처 `tests/fixtures_regress/fixtures/nk_with_foreign_key.json`은 Person("J.R.R. Tolkien")과 그를 자연키로 참조하는 책("The Lord of the Rings")을 담는다.
- **픽스 증명**: `databases = {"other"}`인 TestCase에서 `management.call_command("loaddata", "nk_with_foreign_key.json", database="other")` 실행. 패치 전이면 build_instance가 임시 인스턴스의 default `_state.db`로 author를 조회해 `DoesNotExist`로 실패. 패치 후에는 `obj._state.db = "other"`로 라우팅되어 자연키 계산이 성공하고 로드가 완료된다. 이후 `NaturalKeyWithFKDependency.objects.using("other").get()`으로 `name == "The Lord of the Rings"`, `author.name == "J.R.R. Tolkien"`을 단언해 데이터가 실제로 other DB에 올바르게 적재됐음을 확인한다.
- **overfit 관점**: FAIL_TO_PASS는 1개지만, 픽스가 "this specific fixture만 통과"하는 special-case가 아니라 build_instance의 구조적 db 주입이므로 overfit-risk 플래그는 약하다. 다만 테스트가 단일 시나리오(1-hop FK 의존)만 커버하고 다중 FK·체이닝된 자연키 의존은 직접 검증하지 않으므로, 일반화 자체는 코드 추론으로 보장된다(테스트가 아니라 픽스의 보편성으로).
- **regression 관점**: `_state.db = db`는 default DB 경로에서 db가 이미 `default`이므로 동작 불변 — 그래서 53개 P2P(default-DB 자연키 로드, dependency-sorting 1~6, M2M 자연키 직렬화, ticket 회귀 다수)가 그대로 통과해야 한다. test_patch에 포함된 `backends/sqlite/test_features.py`의 mock 대상 변경(`mock.patch.object(connection, "cursor", ...)`)은 멀티-DB 테스트 추가로 인한 mock 격리 보정이며 핵심 픽스와 무관하다(그래서 해당 테스트가 P2P에 들어있다).

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 트레이스백이 `serializers/base.py` line 332 `natural_key = Model(**data).natural_key()`를 콕 집어준다. "non-default database"라는 키워드 + 트레이스백이 `self.author.natural_key()` → `DoesNotExist`로 이어지는 흐름을 보면, FK 역참조가 잘못된 DB를 본다는 가설이 즉시 선다. build_instance 한 함수만 읽으면 끝(L0).

2. **픽스와 올바른 일반화인 이유**: `Model(**data)`로 만든 인스턴스의 `_state.db`가 None이라 라우터가 default로 폴백해 그 안의 FK lazy 조회가 default DB로 가는 게 근본 원인. 따라서 `obj._state.db = db`를 natural_key() **호출 전에** 주입한다. 이게 overfit이 아닌 올바른 일반화인 이유: 픽스가 특정 모델/픽스처가 아니라 build_instance가 만드는 **모든** 임시 인스턴스에 대상 db 컨텍스트를 부여하므로, FK를 쓰는 임의의 자연키 모델·임의의 비-default DB에 일반적으로 적용된다. 증상(데이터 없음)이 아니라 메커니즘(라우팅 컨텍스트 누락)을 고친 것.

3. **regression 안전**: default DB 경로에서는 db가 이미 `default`라 `_state.db` 대입이 no-op이므로 기존 동작이 byte-수준으로 보존된다. 반드시 안 깨야 하는 P2P: `test_dependency_sorting_*`(자연키 dependency 위상정렬), default-DB 자연키 로드/직렬화, M2M 자연키, `test_supports_json_field_operational_error`(mock 보정으로 인해 P2P에 들어옴). db 주입이 natural_key 계산 경로 안에서만 라우팅을 바꾸고 정렬·직렬화 로직은 건드리지 않으므로 안전.

4. **함정 회피**: 오라클 없는 에이전트가 틀리는 지점 — (a) 증상 `Author DoesNotExist`에 끌려 픽스처 데이터 누락/매니저 `get_by_natural_key`/dependency 순서 문제로 오진단해 엉뚱한 파일을 헤맨다. 정답은 트레이스백 line 332를 신뢰하고 `_state.db` 라우팅 가설로 직행하는 것. (b) db 주입을 natural_key() **호출 후**에 넣으면(순서 실수) 여전히 default로 조회돼 실패 — 순서 의존성을 놓치면 픽스가 무효. (c) `using(db)`를 매니저 조회 쪽에만 추가하는 식의 우회는 임시 인스턴스의 FK 디스크립터 경로를 못 잡아 부분 실패하고 P2P를 깰 수 있다. 인스턴스 `_state.db`를 고치는 게 근본 처방.
