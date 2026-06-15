---
instance_id: django__django-11095
repo: django/django
base_commit: 7d49ad76562e8c0597a0eb66046ab423b12888d8
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-03-19T15:17:28Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [django/contrib/admin/options.py]
primary_type: T-DesignRefactor
tier: T2
loc_axis: L0
repair_strategy: S6 (+S1)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-11095

## 문제 요약
`ModelAdmin`에서 request나 모델 인스턴스에 따라 인라인을 동적으로 바꾸려면 현재는 `get_inline_instances()` 전체를 오버라이드하고 그 안의 for 루프까지 복붙해야 한다. 사용자는 인라인 "인스턴스"가 아니라 인라인 "클래스 목록"만 동적으로 결정하고 싶어 한다. 그래서 다른 `get_fields`/`get_fieldsets`/`get_ordering` 훅처럼 `get_inlines(request, obj=None)` 훅을 새로 추가해 보일러플레이트 없이 인라인 클래스 목록만 오버라이드할 수 있게 해 달라는 기능 요청이다. PR(#7920)까지 첨부되어 의도가 거의 픽스 수준으로 명세돼 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 `get_inline_instances`(현 우회 지점)와 신규 훅 이름 `get_inlines(request, obj=None)`를 둘 다 문자 그대로 지목한다. `django/contrib/admin/options.py`의 `ModelAdmin`로 grep 한 방에 수렴. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S6 Design-Refactor (+S1 Direct-Map)**: 한 줄 값/가드 변경이 아니라 **확장 seam(훅 메서드) 도입 + 호출부 재배선**이라는 소규모 구조 변경이 본질이라 dominant가 S6다. 다만 도입할 구조가 기존 `get_*` 훅 패턴의 복제라 합성 추론은 거의 없고, 기본 구현(`return self.inlines`)·호출부 교체가 기계적이라 S1을 보조로 단다. APR 관점에서 이건 "parameter/hook introduction" 형태의 transformation으로, SemFix식 조건 합성(S2)이나 G&V 탐색(S3/S4)이 아니라 **정해진 리팩터 템플릿의 적용**이다 — 그래서 overfit 위험이 구조적으로 낮다(테스트로 후보를 고를 일이 없음).
- **K (Knowledge) = K-Domain**: django admin의 `get_*` 훅 컨벤션(시그니처가 `(self, request, obj)`이고 인접 위치에 배치, `get_inline_instances`가 `obj`를 받아 권한검사에 쓰는 mechanics)을 알아야 "올바른" 형태가 나온다. 일반 파이썬 추론만으로는 시그니처/배치/`obj` 전파를 정확히 못 맞춘다. 다만 깊은 ORM/쿼리컴파일러 지식은 아니라 도메인 의존은 가벼운 편.
- **primary type = T-DesignRefactor**: 위치는 자명(L0)하고 지식도 가벼우므로 병목은 "어디"나 "지식"이 아니라 **작은 구조 변경을 절제 있게 수행하는 것**(seam을 만들고 호출부 한 줄만 재배선). 따라서 T-DiffuseLoc/T-DomainBound가 아니라 T-DesignRefactor가 dominant.

## 난이도 티어
**T2 (쉬움)**. 이 티어로 미는 구조적 피처:
- 파일 1개(`options.py`), 헌크 2개, 순증 ~7줄(신규 3줄 메서드 + 호출부 1줄 교체). 1파일·소규모는 ICLR 2024 구조컷에서 가장 쉬운 구간.
- localize 직접성 L0(이름 직접 지목) + PR 첨부로 의도 거의 명세 → 추론 부담 최소.
- regression 위험은 존재하나 약함: 기본 구현이 `self.inlines`를 그대로 돌려주므로 기존 호출 경로는 byte-compatible. 19개 PASS_TO_PASS는 인접 admin 인라인 동작이라 `regression-trap` 플래그는 달되, 정확히 기본값만 보존하면 자동으로 안 깨진다.

T1이 아닌 이유: 이슈가 "값 한 개"를 적어주는 게 아니라 **새 메서드 seam 도입 + 호출부 재배선**(S6)이라 순수 S1보다 한 칸 위다. 공식 difficulty 라벨 `15 min - 1 hour`(T3급 시간)와는 한 단계 낮게 본다 — 그 시간의 대부분은 코드가 아니라 PatchReviewChecklist(릴리즈노트/문서/테스트) 때문이지, 에이전트가 통과시켜야 할 코드 변경 자체(localize 자명 + 리팩터 자명)는 T2 수준이기 때문이다(시간라벨=개발자 구현시간, 에이전트 난이도와 다름).

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/options.py`
  - `ModelAdmin.get_inlines(self, request, obj)` — **신규** 훅. `get_fieldsets` 바로 아래에 배치. 본문은 `"""Hook for specifying custom inlines."""` + `return self.inlines`.
  - `ModelAdmin.get_inline_instances(self, request, obj=None)` — 루프 소스 한 줄 교체.
- **근본 원인**: `get_inline_instances`가 `for inline_class in self.inlines:`로 인라인 클래스 목록을 **직접 하드코딩 순회**해, 클래스 목록을 동적으로 가로챌 확장 지점이 없었다. `get_fields`/`get_fieldsets`/`get_ordering`은 훅이 있는데 inlines만 빠져 있던 비대칭.
- **수정 요지**:
  1. `get_inlines(request, obj)` 훅 신설, 기본 구현 `return self.inlines` — 다른 `get_*` 훅과 시그니처·위치 컨벤션 일치.
  2. `get_inline_instances`의 루프를 `for inline_class in self.inlines:` → `for inline_class in self.get_inlines(request, obj):`로 변경. `obj`를 그대로 새 훅에 전달.
  3. 서브클래스는 for 루프 복붙 없이 `get_inlines`만 오버라이드하면 request/obj 기반 동적 인라인 가능. 기본 경로 동작은 완전 동일.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_get_inline_instances_override_get_inlines (generic_inline_admin.tests.GenericInlineModelAdminTest)`.
- **동작**: 테스트가 `EpisodeAdmin`에서 `inlines = (AlternateInline, MediaInline)`을 두고 `get_inlines(request, obj)`를 오버라이드 — `request.name`이 없으면 `[]`, `'alternate'`면 `self.inlines[:1]`, `'media'`면 `self.inlines[1:2]`.
  - `name` 미설정: `ma.get_inlines(request, None) == []` 그리고 `ma.get_inline_instances(request) == []` → 새 훅이 실제로 루프 소스로 **배선**됐음을 증명(훅만 추가하고 호출부를 안 바꾼 가짜 픽스는 여기서 `get_inline_instances`가 여전히 두 인스턴스를 만들어 RED).
  - `name='alternate'`/`'media'`: `get_inlines`가 `(AlternateInline,)`/`(MediaInline,)`을 주고, `type(get_inline_instances(request)[0])`가 각각 그 클래스 → 동적 선택이 인스턴스 생성까지 전파됨을 확인.
- **overfit 관점**: 픽스가 테스트 입력공간에 의존하지 않는 순수 리팩터(seam 도입)라 special-case 통과가 불가능 — overfit 위험 낮음. 테스트는 얇지만(F2P 1개) 호출부 배선까지 직접 관찰해 가짜 픽스를 잡으므로 신호가치는 충분.
- **regression 관점**: 기본 `get_inlines`가 `self.inlines`를 그대로 반환하므로 19개 PASS_TO_PASS(폼셋/권한/extra·min/max num/add·edit GET·POST 등 인접 인라인 admin 동작)는 기본 경로가 byte-compatible해 안 깨진다. `regression-trap`은 "기본값을 정확히 self.inlines로 두기"라는 단일 조건으로 방어된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `get_inline_instances`(현 우회처)와 신규 이름 `get_inlines(request, obj=None)`를 직접 적어준다 → `django/contrib/admin/options.py`에서 `def get_inline_instances`를 grep, 그 안의 `for inline_class in self.inlines:` 줄과, 바로 위 `get_fieldsets`/`get_ordering` 훅 패턴을 동시에 본다. 탐색 끝.
2. **픽스(올바른 일반화인 이유)**: `get_inlines(self, request, obj)`를 `get_fieldsets` 아래에 신설하고 기본 `return self.inlines`, 그다음 `get_inline_instances`의 루프 소스를 `self.get_inlines(request, obj)`로 교체. 이것이 overfit이 아닌 **올바른 일반화**인 이유 — 특정 request 값을 분기하는 게 아니라 클래스 목록 산출 지점을 메서드로 추출(Extract-Method/Introduce-Hook 리팩터)하는 것이라, 모든 서브클래스 오버라이드에 대해 정의대로 동작한다. `obj`를 훅에 전달해야 "model instance 기반"이라는 요구를 충족.
3. **regression 안전**: 기본 구현을 반드시 `self.inlines`(가공 없이 그대로)로 둬야 한다. 그래야 오버라이드하지 않은 기존 모든 `ModelAdmin`이 정확히 같은 인라인을 같은 순서로 생성 → 19개 P2P(특히 `test_get_formsets_with_inlines_returns_tuples`, add/edit GET·POST 뷰)가 보존된다. 기본값을 `list(self.inlines)`로 바꾸거나 필터링을 넣으면 안 됨(불필요한 동작 변경).
4. **함정 회피**: 오라클 없는 에이전트의 가장 흔한 실패는 (a) **과잉수정** — `get_inline_instances` 본문 전체를 재작성하려다 권한검사 로직을 건드려 회귀 유발(골드는 루프 소스 한 줄만 교체). (b) **호출부 미배선** — `get_inlines` 메서드만 추가하고 `get_inline_instances`가 여전히 `self.inlines`를 직접 도는 경우, F2P의 `name` 미설정 단언(`get_inline_instances == []`)에서 RED. 훅 추가와 호출부 교체는 반드시 페어. (c) **시그니처 불일치** — 테스트가 `get_inlines(request, None)` 형태로 호출하므로 `obj`를 위치인자로 받아야 하고, `get_*` 컨벤션상 `(self, request, obj)`로 맞춘다(키워드 강제나 `obj=None` 디폴트 유무로 테스트가 깨지진 않지만 컨벤션 일치가 정답). 절제(최소 침습) + 호출부 배선 두 가지만 지키면 통과.
