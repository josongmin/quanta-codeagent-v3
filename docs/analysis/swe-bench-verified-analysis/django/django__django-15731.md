---
instance_id: django__django-15731
repo: django/django
base_commit: 93cedc82f29076c824d476354527af1150888e4f
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-05-24T12:30:05Z
fail_to_pass: 1
pass_to_pass: 58
gold_files: [django/db/models/manager.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15731

## 문제 요약
`inspect.signature(Person.objects.bulk_create)` 같은 매니저 메서드에 대해 실제 시그니처(`(objs, batch_size=None, ignore_conflicts=False, ...)`) 대신 `(*args, **kwargs)`가 반환된다. `BaseManager`가 `QuerySet` 메서드를 동적으로 프록시 생성하면서, 래퍼 함수에 `__name__`과 `__doc__`만 수동 복사하고 `__wrapped__`를 포함한 나머지 메타데이터를 빠뜨렸기 때문이다. 그 결과 ipython/jupyter의 `<obj>?` 도움말이나 IDE 자동완성이 잘못된 시그니처를 보여준다. problem_statement는 파일 경로(`django/db/models/manager.py`), 정확한 라인(L84/87/88), 그리고 해결책(`functools.wraps` 사용)까지 직접 명시한다.

## 유형 (정형화)

3축 점수:
- **L0 (Pinpointed)** — 이슈 본문이 `django/db/models/manager.py`를 파일 경로·라인번호(L84, L87, L88)까지 직접 지목하고, 문제 함수(`create_method`가 만드는 `manager_method` 래퍼)와 원인("`__name__`/`__doc__`만 수동 복사")을 명시한다. grep도 필요 없는 직접 포인터.
- **S1 (Direct-Map)** — 이슈가 사실상 픽스를 명세한다("The fix is to use functools.wraps instead of manually assigning name and docstring"). 정형 결함클래스(불완전 메타데이터 복사 → 표준 decorator-helper로 대체)에 기계적으로 템플릿 매칭된다. 올바른 조건식을 추론으로 합성할 필요가 없다(S2 아님), 후보 다수 중 테스트로 고를 필요도 없다(S3/S4 아님).
- **K-Domain** — 일반 파이썬 추론으로는 "왜 `__name__`/`__doc__`만으론 부족한가"를 곧장 답하기 어렵다. `functools.wraps`가 `__wrapped__`를 세팅하고 `inspect.signature(..., follow_wrapped=True)`가 그 체인을 따라간다는 CPython 내부 계약 + django의 manager-proxy 동적 생성 패턴을 알아야 한다. 다만 이슈가 정답을 적어주므로 지식 의존이 병목까지는 아니다(K-API는 공개 시그니처 계약을 *맞춰야* 할 때인데, 여기선 오히려 원본 시그니처를 *드러내는* 것이라 K-Domain이 더 정확).

primary type = **T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적(S1, 표준 데코레이터로 교체)인 전형이다. T-LocTrivial은 K-Gen 자명 픽스를 가정하는데, 여기엔 `@wraps`→`__wrapped__`→`inspect.signature` 연결고리라는 도메인 지식이 한 단계 끼므로 T-LocTrivial보다 T-DirectMap이 정확하다. T-DomainBound도 후보지만, 지식이 *병목*이 아니라 이슈가 정답 API까지 적어줘서 dominant 신호는 "위치 명확 + 기계적 픽스"다.

repair strategy가 S1인 이유(APR 관점): 결함이 정형 클래스(불완전 metadata-propagation)에 속하고, 수리가 "수동 복사 2줄 삭제 + 표준 라이브러리 데코레이터(`@wraps`) 적용"이라는 단일 변환으로 환원된다. PAR/TBar류 template repair의 전형 — fix template("manual attr copy → functools.wraps")이 이슈에 명시되어 탐색·검증 반복(G&V)이나 조건 합성(SemFix류)이 불필요하다. CEGIS(S4)가 아닌 이유는 FAIL_TO_PASS가 픽스를 과소명세하지 않기 때문이다: 시그니처 정확일치 + attribute 동등성을 함께 요구해 special-case로 빠져나갈 여지가 좁다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일수 1, 변경 줄수 극소(라인 추가 1 = `from functools import wraps`, helper 내부 1줄 데코레이터 추가, 수동복사 2줄 삭제) → "1파일·<5줄" 컷(≈48% solve 구간)에 정확히 든다.
- localize 직접성 = L0(이슈가 파일·라인·해결책 명시) → 탐색 비용 0.
- `has-repro` = 이슈에 실행 가능한 재현 스니펫(`inspect.signature(Person.objects.bulk_create)` actual vs expected) 존재 → 가장 강한 easiness 신호(repro 있으면 해결률 ~87%).
- 픽스가 자명한 한 줄이 아니라 도메인 메커니즘(`__wrapped__`) 이해를 한 단계 요구 → T1(존나쉬움, K-Gen)보다 한 칸 위.

공식 difficulty 라벨은 "15 min - 1 hour"(T3 prior에 해당). 본 분석은 한 칸 낮은 **T2**로 둔다 — 공식 라벨은 *개발자 구현시간*(테스트 작성·검증·PR 포함)을 재는데, 에이전트 난이도 관점에선 localize가 거의 공짜(L0+repro)이고 픽스가 이슈에 적혀 있어 실제 수리 비용은 T2다. 시간라벨에 잡히는 "구현 절차 오버헤드"는 에이전트 난이도와 무관하다.

다만 T1로 더 내리지 않은 이유는 **regression-trap**: P2P가 58개로 넓고, `_get_queryset_methods`는 매니저가 노출하는 모든 QuerySet-프록시 메서드를 생성하는 핫패스다. `@wraps`가 `__name__`/`__doc__`뿐 아니라 `__dict__`까지 갱신하므로, 기존에 `test_manager_methods`가 검증하는 메서드 집합·이름이 그대로 유지되는지를 안 깨야 한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/manager.py` → `BaseManager._get_queryset_methods` 내부의 클로저 `create_method`(그 안의 `manager_method` 래퍼).
- 근본 원인: `create_method`가 만든 `manager_method`는 `(self, *args, **kwargs)` 시그니처의 일반 위임 래퍼다. 여기에 `manager_method.__name__ = method.__name__`과 `manager_method.__doc__ = method.__doc__`만 수동 할당했다. 핵심 누락은 `__wrapped__` 속성 — `inspect.signature`는 `follow_wrapped=True`(기본값) 하에서 `__wrapped__` 체인을 따라 원본 함수의 시그니처를 복원하는데, 수동 복사는 이 속성을 만들지 않아 래퍼 자신의 `(*args, **kwargs)`만 보이게 된다. `__module__`/`__qualname__`/`__dict__`도 함께 비어 introspection이 전반적으로 부정확.
- 수정 요지: (1) 파일 상단에 `from functools import wraps` 추가, (2) `manager_method`에 `@wraps(method)` 데코레이터 적용, (3) 수동 할당 2줄(`manager_method.__name__ = ...`, `manager_method.__doc__ = ...`) 삭제. `functools.wraps`는 `WRAPPER_ASSIGNMENTS`(`__module__`,`__name__`,`__qualname__`,`__doc__`,`__dict__`,`__annotations__`)를 복사하고 추가로 `__wrapped__ = method`를 세팅한다. 따라서 `inspect.signature(Article.objects.bulk_create)`가 `__wrapped__`를 따라 원본 `QuerySet.bulk_create`의 시그니처를 그대로 반환하게 된다.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `test_manager_method_signature (basic.tests.ManagerTest)` — `str(inspect.signature(Article.objects.bulk_create))`가 `"(objs, batch_size=None, ignore_conflicts=False, update_conflicts=False, update_fields=None, unique_fields=None)"`와 정확히 일치하는지 확인. 픽스 전: 래퍼에 `__wrapped__`가 없어 `(*args, **kwargs)` 반환 → FAIL. 픽스 후: `@wraps(method)`가 `__wrapped__`를 세팅 → `inspect.signature`가 원본 `bulk_create` 시그니처를 복원 → PASS.
- 함께 추가된 P2P: `test_manager_method_attributes (basic.tests.ManagerTest)`는 `Article.objects.get.__doc__ == models.QuerySet.get.__doc__`와 `count.__name__` 일치를 검증한다. 이는 기존 동작(이름·docstring 전파)이 `@wraps` 전환 후에도 깨지지 않음을 보장하는 회귀 가드. `test_manager_methods`(P2P)는 매니저가 노출하는 메서드 집합이 그대로인지 확인.
- overfit 관점: 위험 낮음. FAIL_TO_PASS가 전체 6-파라미터 시그니처를 문자열로 정확일치 요구하고, attribute 동등성 테스트가 페어로 붙어 있어 "이 한 메서드만 특수처리"하는 special-case 패치로는 통과할 수 없다. 일반 메커니즘(`@wraps`)으로 풀어야 모든 프록시 메서드가 동시에 고쳐진다.
- regression 관점: P2P 58개가 `basic.tests` 전반(모델 생성/조회/refresh/manager)을 커버. `_get_queryset_methods`는 모든 프록시 메서드의 생성 지점이라, `@wraps`가 `__dict__` 갱신 등으로 기존 메서드 이름/집합을 바꾸면 `test_manager_methods`나 인접 ORM 테스트가 깨질 수 있어 넓은 P2P가 그 안전망 역할.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `django/db/models/manager.py`의 라인(L84/87/88)과 함수 맥락("decorated method", "manually assigning name and docstring")을 직접 준다. → `_get_queryset_methods` 안의 `create_method`/`manager_method` 클로저로 직행. 재현 스니펫(`inspect.signature(Person.objects.bulk_create)` → `(*args,**kwargs)`)이 증상을 정확히 고정해 주므로 탐색 불필요.

2. **픽스와 왜 올바른 일반화인가**: 수동 `__name__`/`__doc__` 복사를 `@wraps(method)`로 대체한다. 이게 올바른 일반화인 이유 — 증상의 근인은 특정 속성 하나가 아니라 **`__wrapped__` 부재로 인한 `inspect.signature`의 follow-chain 실패**다. `@wraps`는 `WRAPPER_ASSIGNMENTS` 전체 + `__wrapped__`를 한 번에 챙기므로, `bulk_create` 하나가 아니라 매니저가 프록시하는 *모든* QuerySet 메서드의 introspection이 동시에 정상화된다. 속성을 손으로 더 추가하는 우회(예: `__module__`,`__qualname__` 수동 복사)는 `__wrapped__`를 놓치기 쉬워 fragile하다.

3. **regression 안전**: 안 깨야 할 P2P 핵심은 `test_manager_method_attributes`(name/doc 전파 유지)와 `test_manager_methods`(노출 메서드 집합 불변), 그리고 인접 ORM 동작 56개. `@wraps`는 기존 수동 복사가 하던 `__name__`/`__doc__` 전파를 superset으로 포함하므로 attribute 테스트는 유지되고, 위임 본체(`getattr(self.get_queryset(), name)(*args, **kwargs)`)는 손대지 않아 런타임 호출 의미는 불변.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `__name__`/`__doc__`에 `__module__`/`__qualname__`만 더 손으로 복사하고 끝내면 `inspect.signature`는 여전히 `(*args,**kwargs)`를 반환한다(핵심은 속성 개수가 아니라 `__wrapped__`다). FAIL_TO_PASS가 이 함정을 정확히 잡는다. (b) `manager_method`의 시그니처를 `(self, objs, ...)`로 직접 흉내내려는 시도는 메서드마다 달라 불가능·fragile. 정답은 **표준 라이브러리 한 줄(`@wraps`)이 `__wrapped__`까지 세팅한다는 메커니즘을 이해**하는 것. 이슈가 이미 `functools.wraps`를 지목하므로, 이슈 본문의 처방을 무시하고 자체 우회를 만들지 않는 것이 회피법이다.
