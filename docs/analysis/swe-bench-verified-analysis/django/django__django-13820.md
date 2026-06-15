---
instance_id: django__django-13820
repo: django/django
base_commit: 98ad327864aed8df245fd19ea9d2743279e11643
version: "3.2"
difficulty: 15 min - 1 hour
created_at: 2020-12-28T22:07:57Z
fail_to_pass: 1
pass_to_pass: 24
gold_files: [django/db/migrations/loader.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13820

## 문제 요약
`MigrationLoader.load_disk`는 PEP-420 네임스페이스 패키지를 마이그레이션 대상에서 제외하려고 "`getattr(module, '__file__', None)`이 없으면 unmigrated 처리하고 건너뛴다"는 검사를 쓴다. 문제는 `__file__`이 없는 모듈이 네임스페이스 패키지만이 아니라는 것. Python import 규약상 `__file__`은 *선택* 속성이라(예: DB에서 로드된 모듈), frozen Python 환경(임베디드/동결 배포)은 일반 정규 패키지에도 `__file__`을 설정하지 않을 수 있다. 그 결과 frozen 환경에서는 멀쩡한 정규 마이그레이션 패키지가 통째로 무시되어 `unmigrated_apps`로 잘못 분류된다(예외 없이 조용히 틀림). 요청자는 네임스페이스 패키지 허용이 아니라, 네임스페이스 판별을 Python 문서 기준에 맞게 더 *좁고 정확하게* 만들자고 명시적으로 선을 긋는다.

## 유형 (정형화)

**L (Localization) = L0 — Pinpointed.** problem_statement가 `django.db.migrations.loader.MigrationLoader.load_disk`라는 모듈·클래스·메서드를 풀네임으로 지목하고, 문제의 표현식 `getattr(m, '__file__', None)`까지 그대로 인용한다. grep 한 방이면 정확한 수정 지점에 도달한다 — 탐색 노력 사실상 0.

**S (Repair Strategy) = S2 (+S5) — Constraint-Reasoning + Spec-Inference.** 고칠 *지점*은 자명하지만(L0), 올바른 *대체 판별식*은 기계적 템플릿(S1)으로 나오지 않는다. "네임스페이스 패키지 ≠ `__file__` 없는 모든 모듈"이라는 집합 관계를 따져, 진짜 네임스페이스 패키지만 골라내는 충분조건을 *추론으로 합성*해야 한다(S2). 그 충분조건 — "네임스페이스 패키지는 `__path__`가 일반 `list`가 아니라 커스텀 iterable"" — 은 코드만 봐서는 도출 불가능하고 Python import 시스템 *명세*(reference/import.html#namespace-packages)에서 재구성해야 하므로 S5가 보조로 붙는다. G&V(S3/S4)가 아닌 이유: 테스트 반복으로 후보를 굴려 맞추는 문제가 아니라, 정답 식이 좁고 유일에 가까워 "생각으로" 합성하는 SemFix/Angelix 계열에 정확히 들어맞는다.

**K (Knowledge) = K-Domain.** django migrations 로더 내부 동작 + CPython import 프로토콜(네임스페이스 패키지 `__path__` 타입, `_NamespacePath`, `__spec__.origin`)을 알아야 한다. 일반 파이썬 추론(K-Gen)으로는 `__file__` 대체 시그니처를 잡을 수 없다.

**primary type = T-ConstraintReason.** 위치는 명확(L0)하나 난점이 "어디"가 아니라 "올바른 조건식 합성"에 있다 — T-DiffuseLoc도 T-DirectMap도 아니다. S2가 dominant이므로 T-ConstraintReason. (K-Domain이 강하지만 병목은 지식 *조회*가 아니라 그 지식으로 *조건을 합성*하는 추론이라 T-DomainBound보다 T-ConstraintReason이 정확하다.)

## 난이도 티어

**T4 — 약간 어려움.** 공식 라벨은 "15분-1시간"(prior로 T3 근처)이지만 T4로 올린다.

- **파일/줄수**: 단일 파일 1개(`loader.py`), 골드 헌크는 ~8줄 net 변경. 구조컷(1파일·소규모)만 보면 T2~T3.
- **localize 직접성**: L0 — 이 축은 난이도를 *낮춘다*.
- **이를 T4로 올리는 결정 피처 = S2 constraint추론 + K-Domain의 결합**. 루브릭 T4 정의가 정확히 "constraint추론·소규모 refactor·도메인지식 중 하나"인데 이 문제는 그 둘(S2+K-Domain)이 겹친다. 픽스 자체는 짧지만, *올바른 짧은 픽스*에 도달하려면 CPython 네임스페이스 패키지 규약이라는 비자명한 도메인 사실이 필요하다.
- **regression-trap(P2P 24개)**: naive 픽스("`__file__` 검사를 그냥 삭제")는 진짜 네임스페이스 패키지를 로드해버려 `test_loading_namespace_package`류 P2P를 깬다. 인접 동작을 안 깨면서 좁히는 제약이 난이도를 더한다.
- **has-repro 완화**: 이슈가 매우 명료하고(underspecified 아님) 요청자가 직접 대체식(`and isinstance(m.__path__, list)`)까지 제안 → 이 신호가 없었다면 T5에 가까웠을 것. has-repro/명세성이 T5로 가지 않게 잡아준다.

공식 라벨과 다른 이유: 시간라벨은 "이미 답을 아는 개발자의 *구현* 시간"이라 짧지만, 오라클 없는 에이전트에게는 "왜 `__file__`만으론 안 되는가 → `__path__` 타입이 진짜 시그니처"라는 도메인 추론이 진짜 병목이고 이게 시간라벨에 잡히지 않는다.

## 골드패치 분석

- **건드린 파일·함수**: `django/db/migrations/loader.py` → `MigrationLoader.load_disk`
- **근본 원인**: 네임스페이스 패키지 판별을 `getattr(module, '__file__', None) is None` *단독*으로 했다. 그러나 `__file__`은 Python import 규약상 선택 속성이라 정규 패키지(특히 frozen 환경)에서도 없을 수 있다. 즉 판별 조건이 *과도하게 넓어(over-broad)* 정상 정규 패키지까지 네임스페이스로 오탐(false positive)해 `unmigrated_apps`로 분류, 마이그레이션을 못 찾는다.
- **수정 요지**:
  1. **블록 재배치**: "module이 package가 아님(`not hasattr(module, '__path__')`, 예: `migrations.py`)" 검사를 `__file__` 검사보다 *앞으로* 옮겼다. 새 조건이 `module.__path__`를 참조하므로, `__path__` 부재 케이스를 먼저 걸러내 `AttributeError`를 방지하는 순서 의존이 생겼다.
  2. **조건 강화**: 네임스페이스 판별을 `getattr(module, '__file__', None) is None` → `getattr(module, '__file__', None) is None and not isinstance(module.__path__, list)`로 AND 결합.
  3. **근거(주석으로 명시)**: 진짜 네임스페이스 패키지는 `__path__`로 일반 `list`가 아니라 커스텀 iterable(`_NamespacePath`)을 쓴다. 따라서 `__file__`이 없어도 `__path__`가 `list`면 정규 패키지로 판정해 로드한다. `_NamespacePath` 같은 CPython 구현 디테일에 직접 의존하지 않고 "list 여부"라는 안정적 관측 가능 속성으로 판별 — 정확히 요청자가 제안한 식.

## 검증 (test_patch)

- **FAIL_TO_PASS (1)**: `test_loading_package_without__file__` (`migrations.test_loader.LoaderTests`). `__file__`은 없지만 정규 패키지인 마이그레이션 모듈에서 마이그레이션이 정상 로드되는지 확인.
- **픽스 증명**: `MIGRATION_MODULES={'migrations': 'migrations.test_migrations'}`로 오버라이드하고 그 모듈을 import한 뒤, frozen 환경을 흉내내어 `del test_module.__file__` + `__spec__.origin = None` + `__spec__.has_location = False`로 만든다. 이 상태에서 `loader.load_disk()`를 호출하고 `migrations` 앱에서 로드된 마이그레이션이 `assertCountEqual(..., ['0001_initial', '0002_second'])`인지 검증한다. `finally`에서 `__file__`/`__spec__.origin`/`has_location`을 원복해 전역 모듈 상태 오염(다른 테스트 영향)을 막는다. 픽스 전이라면 `__file__` 부재만으로 네임스페이스로 오인 → 빈 목록 → 실패.
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이지만, 테스트가 실제 `test_migrations` 패키지(`__path__`가 진짜 `list`)를 쓰고 마이그레이션 *내용*(0001/0002)까지 정확히 단언하므로 special-case 트릭으로는 통과 못 한다. 다만 `overfit-risk` 자체는 낮음 — 정답식이 좁고 유일에 가까워 우회 패치 공간이 작다.
- **regression 관점**: `regression-trap` 표기. 24개 P2P 중 `test_loading_namespace_package`(진짜 네임스페이스 패키지는 여전히 제외되어야 함)와 `test_load_module_file`/`test_explicit_missing_module`/`test_load_empty_dir`(비-패키지·빈 디렉토리 경로)가 핵심 가드다. 픽스가 이들을 깨지 않아야만 "정규 패키지만 추가 허용, 네임스페이스는 여전히 차단"이라는 좁은 의도가 보존된다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `MigrationLoader.load_disk`와 `getattr(m, '__file__', None)`을 풀네임으로 인용 → `django/db/migrations/loader.py`의 `load_disk` 내 "Empty directories are namespaces" 주석 블록으로 직행. L0이므로 탐색 분기 없음.

2. **픽스와 왜 올바른 일반화인가**: `__file__ is None` 단독 검사를 `__file__ is None and not isinstance(module.__path__, list)`로 좁힌다. 이게 overfit이 아닌 *올바른 일반화*인 이유 — "네임스페이스 패키지를 식별하는 안정적 시그니처"라는 근본 관측에 기반하기 때문이다. Python 명세상 네임스페이스 패키지는 `__path__`가 list가 아닌 iterable(`_NamespacePath`)이라는 *불변식*을 쓰므로, 특정 테스트 입력이 아니라 "frozen 정규 패키지 전체 클래스"를 올바르게 받아들이고 "네임스페이스 패키지 전체 클래스"를 올바르게 거부한다. `__spec__.origin` 같은 다른 관측으로도 frozen 케이스는 통과시킬 수 있지만, 네임스페이스를 정확히 배제하는 가장 좁은 술어는 `__path__` 타입이다.

3. **regression 안전**: `test_loading_namespace_package`(네임스페이스는 계속 unmigrated여야 함)를 절대 깨면 안 된다 — AND의 둘째 항 `not isinstance(__path__, list)`가 바로 이걸 지킨다. 또 `not hasattr(module, '__path__')` 검사를 `__file__`/`__path__` 검사보다 앞으로 옮긴 순서 의존을 반드시 보존해야 `migrations.py`(비-패키지) 케이스에서 `module.__path__` 접근 시 `AttributeError`가 안 난다(P2P `test_load_module_file` 보호).

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 두 지점 — (a) "`__file__`이 frozen에서 없으니 검사를 그냥 삭제"하면 진짜 네임스페이스 패키지까지 로드해 `test_loading_namespace_package` 회귀. (b) `__spec__.origin`/`has_location` 기반으로 우회해 FAIL_TO_PASS는 통과시키지만 네임스페이스 배제 의미를 약화. 회피법은 *왜 네임스페이스를 막는가*(의도)와 *네임스페이스의 진짜 시그니처가 무엇인가*(`__path__` non-list)를 분리해 사고하고, "정규 패키지 허용을 늘리되 네임스페이스 차단은 그대로"라는 좁은 명세를 P2P가 강제한다는 점을 인지하는 것. 이슈 본문이 이미 정답식을 제안하므로, 본문을 무시하고 `__spec__`로 새지만 않으면 골드와 수렴한다.
