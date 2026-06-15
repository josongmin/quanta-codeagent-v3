---
instance_id: django__django-14155
repo: django/django
base_commit: 2f13c476abe4ba787b6cb71131818341911f43cc
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-03-19T15:44:25Z
fail_to_pass: 3
pass_to_pass: 89
gold_files: [django/urls/resolvers.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-14155

## 문제 요약
URL 뷰로 `functools.partial`을 넘기면 `ResolverMatch.__repr__()`가 func 인자를 그냥 `functools.partial`로만 출력해서, 감싸진 실제 함수나 미리 바인딩된 인자가 전혀 드러나지 않는다. partial은 앞단에 인자를 미리 갖고 있으므로 repr이 그 내부를 풀어서 보여주길 기대한다. 이슈 본문은 "`ResolverMatch.__init__()`에서 partial을 unwrap하면 된다"고 제안하지만, 골드는 `__repr__` 국소 분기로 최소 변경한다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** 이슈 제목이 `ResolverMatch.__repr__()`를 심볼 단위로 직접 호명한다. `django/urls/resolvers.py`의 `ResolverMatch` 클래스 한 곳으로 grep 한 방에 수렴 — 탐색 비용 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1 보조).** 고칠 위치는 자명하지만, "어떤 출력이 올바른 repr인가"를 추론으로 합성해야 한다. partial 분기를 추가하는 것 자체는 S1성(특수 케이스 가드)이나, 골드의 핵심 결정 — partial일 때 `_func_path` 대신 `repr(self.func)`를 쓰고 **동시에 모든 필드 포맷을 `%s`→`%r`로 전환** — 은 단순 None-가드 템플릿이 아니라 "repr이 만족해야 할 불변식(파이썬 repr 관례: 문자열은 따옴표, eval-친화)"을 따져야 도출된다. 그래서 dominant는 S2, partial-가드 추가가 S1 보조.
- **K (Knowledge) = K-Domain.** `_func_path`/`self.func`가 무엇인지, partial 뷰가 어디서 생기는지(`functools.partial` 래핑 뷰), URL resolver의 ResolverMatch 계약을 알아야 한다. django URL routing 내부 지식이 병목이라 K-Gen이 아님. 다만 공개 시그니처/리턴형 계약을 깨는 건 아니라서 K-API는 아님.
- **Primary = T-ConstraintReason.** 위치는 명확(L0)한데 진짜 난점이 "올바른 repr 식을 추론으로 합성"하는 데 있어 T-DirectMap(기계적 가드)보다 T-ConstraintReason이 정확하다. partial 분기 한 줄만 넣고 `%r` 전환을 빠뜨리면 틀린다는 점이 단순 template-map이 아님을 증명한다.

APR 관점: 결함 위치가 주어진 상태에서 **출력 명세를 의미적으로 재구성**하는 SemFix/Angelix 계열(S2)이다. partial 케이스는 가드 추가지만, 그 가드의 정답 형태(`repr(self.func)` + 전 필드 `%r`)는 테스트를 마구 돌려 수렴(S3/S4)하는 게 아니라 repr 관례에서 연역해야 옳게 나온다.

## 난이도 티어

**Tier = T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 경계)인데, 구조 피처로 보면 T3가 맞다.

이 티어로 미는 피처:
- **localize 직접성 = 최상(L0)** → 하향 압력. 단일 파일·단일 메서드(`ResolverMatch.__repr__`), gold patch ~8줄. 파일수·줄수 컷(1파일·<10줄 ≈ 48% solve)으로는 T2급.
- **그러나 S2 추론 + P2P trap이 T3로 끌어올림.** 픽스가 partial 분기 1줄로 끝나지 않고, partial과 **무관한** 기존 `test_repr` 기대값까지 `%r` 전환 때문에 함께 바뀐다. 즉 "신규 케이스만 고치면 끝"이 아니라 기존 출력 포맷 회귀를 동반 처리해야 하는 결합(coupling)이 있다.
- **regression-trap (P2P 89개).** `urlpatterns_reverse` 스위트가 넓다. `test_urlpattern_resolve`, namespace/include/reverse 다수가 P2P에 있어 repr 포맷 변경이 인접 동작을 깨면 안 된다.
- repro는 명시 코드가 아니라 서술뿐(has-repro 아님) → 약한 상향. underspecified는 아님(증상·기대가 명확).

T4로 안 가는 이유: cross-file 조율 없음(L0 단일 site), 도메인 지식이 깊은 call-chain 추적을 요구하지 않음(repr 한 메서드 국소). T2로 안 내려가는 이유: `%s`→`%r` 전 필드 전환이라는 비자명 추론 + 넓은 P2P가 단순 가드-추가를 넘어선다.

## 골드패치 분석

- **건드린 파일/함수:** `django/urls/resolvers.py` → `ResolverMatch.__repr__`
- **근본 원인:** `__repr__`이 func 표현으로 항상 `self._func_path`를 사용한다. 뷰가 `functools.partial`이면 `_func_path`가 감싼 함수·바인딩 인자를 담지 못해 `functools.partial`류로만 찍히고 디버깅 정보가 소실된다. 추가로 기존 포맷이 `%s`라 `url_name`/`route` 등 문자열 필드가 따옴표 없이 출력돼 repr 관례(eval-친화/구분 가능)를 어긴다.
- **수정 요지:**
  - func이 `functools.partial` 인스턴스면 `func = repr(self.func)`(partial 전체 = 감싼 함수 + `template_name=` 등 바인딩 인자)를 쓰고, 아니면 기존 `func = self._func_path` 유지.
  - 포맷 문자열을 `%s` → `%r`로 전환: `args`, `kwargs`, `url_name`, `app_names`, `namespaces`, `route` 모두 repr 표현으로 출력(문자열 필드에 따옴표 부여).
  - 본문은 `__init__` unwrap을 제안했으나 골드는 `__repr__` 분기만으로 최소 변경. `functools`는 모듈 상단에 이미 import됨(추가 import 불필요).

## 검증 (test_patch)

- **FAIL_TO_PASS (3개, `urlpatterns_reverse.tests.ResolverMatchTests`):**
  - `test_repr` — 기존 repr 기대값을 `%r` 포맷에 맞춰 갱신. `url_name=no-kwargs` → `url_name='no-kwargs'`, `route=^...$` → `route='^...$'`로 따옴표가 붙는지 확인. **partial과 무관한데도 포맷 전환 때문에 깨졌다 통과로 바뀜** → `%r` 전환을 안 하면 이 테스트가 RED로 남는 강한 가드.
  - `test_repr_functools_partial` — `partial`, `partial_nested`, `partial_wrapped` URL을 resolve 후 func 부분이 `functools.partial(<empty_view repr>, template_name='...')`로 풀려 나오는지 subTest 3건으로 검증.
  - `test_resolver_match_on_request` — repr/포맷 변경이 ResolverMatch 경로의 기존 동작을 깨지 않는지 회귀 확인.
- **overfit 관점:** FAIL_TO_PASS가 partial 3변종 + 일반 repr + on_request로 partial/non-partial 양쪽 분기를 모두 관찰한다. partial만 special-case로 처리하고 `%r` 전환을 빠뜨리면 `test_repr`가 잡아내므로 "테스트 너머 일반화 실패"(S4 overfit)가 차단된다 → overfit-risk 플래그 미부여.
- **regression 관점:** P2P 89개 중 다수가 같은 `urlpatterns_reverse` 모듈(namespace/include/reverse/resolver). repr 포맷이 다른 코드의 문자열 파싱·로깅에 영향을 주지 않는지가 P2P로 보증된다 → regression-trap 플래그 부여.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈 제목 `ResolverMatch.__repr__() doesn't handle functools.partial()`이 클래스·메서드를 직접 지목. `grep -n "class ResolverMatch" django/urls/resolvers.py` → `__repr__`로 직행. 탐색 불필요(L0).

2. **픽스와 올바른 일반화 이유:** func이 `functools.partial`이면 `repr(self.func)`로 분기, 아니면 `_func_path` 유지. 그리고 **모든 동적 필드를 `%r`로** 출력. 이게 올바른 일반화인 이유 — (a) partial 가드는 "감싼 함수+바인딩 인자를 드러낸다"는 이슈 의도를 정확히 충족하면서 비-partial 경로는 그대로 둠. (b) `%r` 전환은 partial 케이스 하나가 아니라 repr 전체가 만족해야 할 관례(문자열은 따옴표로 구분, 출력 모호성 제거)를 일관 적용 → special-case 땜질이 아니라 메서드 계약 정정. 골드는 본문 힌트(`__init__` unwrap)를 따르지 않고 repr 국소 수정을 택했는데, init unwrap은 `self.func`/`self.args` 의미를 바꿔 다른 소비자에 부수효과를 낼 수 있으므로 repr-only가 더 안전한 최소 변경.

3. **regression 안전:** P2P 89개 — 특히 `test_urlpattern_resolve`, `test_resolver_match_on_request_before_resolution`, namespace/include/reverse 다수. repr은 사람이 읽는 디버그 문자열이라 어떤 P2P도 그 정확한 바이트열에 의존하지 않아야 하며(의존하면 그건 갱신 대상), partial 분기는 비-partial 경로를 건드리지 않으므로 기존 resolve/reverse 로직은 불변. `%r` 전환이 `__repr__` 밖으로 새지 않음을 확인.

4. **함정 회피 (오라클 없는 에이전트가 틀릴 지점):**
   - **함정 A — partial만 고치고 `%r` 전환 누락.** partial 분기 한 줄만 추가하면 `test_repr_functools_partial`은 통과해도 `test_repr`가 따옴표 기대값 불일치로 RED. 픽스가 "partial 케이스 추가"가 아니라 "repr 포맷 일관 정정"임을 봐야 함 → 가드 추가 후 기존 repr 테스트도 같이 돌려 따옴표 회귀를 확인.
   - **함정 B — 본문 힌트 맹종.** "`__init__`에서 unwrap"을 그대로 구현하면 `self.func`/`self.args`의 의미가 바뀌어 partial 인자가 args에 섞이는 등 기대값(`args=()`)과 어긋나고 P2P 부수효과 위험. 골드처럼 repr 국소 분기가 정답.
   - **함정 C — `functools` import.** 분기에 `functools.partial`을 쓰는데 모듈에 이미 import돼 있음을 확인하지 않고 중복 import를 추가하거나, 없다고 가정해 `partial` 직접 참조 오류.
