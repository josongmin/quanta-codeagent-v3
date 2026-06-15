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
---

# django__django-15525

## 문제 요약
natural_key가 외래키(FK)를 참조하도록 정의된 모델을 `loaddata`로 비-기본(non-default) 데이터베이스에 로드하면 예외가 발생한다. 기본 DB에서는 잘 동작하지만, `--database other`로 로드하면 `natural_key()` 안에서 `self.author.natural_key()`를 호출하는 순간 `Author matching query does not exist`(DoesNotExist)가 터진다. 사용자는 기본 DB와 다른 DB가 동일하게 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (멀티-DB 라우팅 컨텍스트 누락) / edge-case
- 서브시스템: django core serializers (fixtures/loaddata 역직렬화 경로)
- 증상 타입: 예외 (DoesNotExist → loaddata 실패)
- 로컬라이제이션 신호: problem_statement의 트레이스백이 정확히 `django/core/serializers/base.py`의 `build_instance`, line 332 `natural_key = Model(**data).natural_key()`를 지목한다. 또한 "non-default database"라는 키워드가 DB 라우팅/`_state.db` 문제임을 암시한다.

## 골드패치 분석
- 건드린 파일/함수: `django/core/serializers/base.py:build_instance`
- 근본 원인: `Model(**data)`로 만든 임시 인스턴스의 `_state.db`가 기본값(`default`)이므로, `natural_key()` 내부에서 FK(`self.author`)에 접근할 때 관련 객체를 잘못된 DB(default)에서 조회한다. 데이터가 `other` DB에만 있으면 default에는 없으므로 `DoesNotExist`가 발생한다. FK 디스크립터의 lazy 조회가 인스턴스의 `_state.db`를 따라가기 때문이다.
- 수정 요지: 임시 인스턴스를 변수 `obj`로 분리한 뒤, `natural_key()`를 호출하기 **전에** `obj._state.db = db`를 명시적으로 설정한다. 이로써 natural_key 계산 중 발생하는 FK 조회가 올바른 대상 DB(`db`)로 라우팅되어 관련 객체를 찾을 수 있게 된다.

```python
obj = Model(**data)
obj._state.db = db
natural_key = obj.natural_key()
```

## 검증 (test_patch)
- FAIL_TO_PASS: `NaturalKeyFixtureOnOtherDatabaseTests.test_natural_key_dependencies` — "Natural keys with foreing keys in dependencies works in a multiple database setup."
- 테스트 구성: `tests/fixtures_regress/models.py`에 `NaturalKeyWithFKDependency`(FK author→Person, `natural_key`가 `(self.name,) + self.author.natural_key()`, `dependencies=["fixtures_regress.Person"]`)와 매니저 `get_by_natural_key(name, author)`를 추가. 새 픽스처 `nk_with_foreign_key.json`은 Person("J.R.R. Tolkien")과 그것을 자연키로 참조하는 책("The Lord of the Rings")을 담는다.
- 증명 방식: `databases = {"other"}`인 TestCase에서 `loaddata nk_with_foreign_key.json --database other` 실행 → 패치 전이라면 build_instance가 default DB에서 author를 조회해 실패. 패치 후에는 `obj._state.db = "other"`로 라우팅되어 성공. 이후 `NaturalKeyWithFKDependency.objects.using("other").get()`으로 name/author.name이 기대값과 일치하는지 단언한다.
- 참고: test_patch에는 무관한 `backends/sqlite/test_features.py`의 mock 대상 변경(`mock.patch.object(connection, "cursor", ...)`)도 함께 들어있으나, 이는 멀티-DB 테스트 추가로 인한 mock 격리 보정이며 핵심 픽스와는 별개다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement의 트레이스백이 파일·함수·라인까지 거의 콕 집어준다. `serializers/base.py`의 `build_instance` 한 함수만 보면 된다. 로컬라이제이션 난이도는 매우 낮다.
- 함정/난이도: 진짜 어려움은 "왜"다. 표면 증상은 `Author DoesNotExist`라 데이터/픽스처 문제처럼 보이지만, 실제 원인은 임시 인스턴스의 `_state.db` 라우팅 누락이다. FK 디스크립터가 인스턴스의 `_state.db`를 따라간다는 ORM 내부 동작을 이해해야 픽스가 보인다. 또한 픽스가 private 필드(`_state.db`)를 건드린다는 점(hints에서는 `Model.from_db`를 대안으로 언급)도 헷갈릴 수 있다.
- 멀티파일 여부: 프로덕션 픽스는 단일 파일·3줄로 매우 작다. 다만 검증을 위해 새 모델/매니저/픽스처/테스트를 여러 파일에 걸쳐 추가해야 하므로 테스트 작성 비용이 본체보다 크다.
- 우리 에이전트 관점: 한 줄짜리 픽스 자체는 쉽지만, (1) `Model(**data)`가 default DB 컨텍스트를 갖는다는 사실을 추론하고, (2) natural_key 호출 전에 db를 주입해야 한다는 순서 의존성을 잡아내는 것이 관건. 에이전트가 증상(DoesNotExist)에 끌려 픽스처/매니저 쪽을 헤매면 시간을 낭비할 수 있다. 트레이스백의 line 332를 신뢰하고 `_state.db` 가설로 바로 가는 게 정답 경로다.
