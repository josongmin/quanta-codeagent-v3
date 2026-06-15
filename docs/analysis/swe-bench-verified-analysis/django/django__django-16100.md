---
instance_id: django__django-16100
repo: django/django
base_commit: c6350d594c359151ee17b0c4f354bb44f28ff69e
version: 4.2
difficulty: <15 min fix
created_at: 2022-09-24T13:32:02Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [django/contrib/admin/options.py]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

# django__django-16100

## 문제 요약
Django admin의 changelist 화면에서 `list_editable` 필드를 인라인 편집해 저장하면, `ModelAdmin.changelist_view`가 formset의 여러 행을 순차적으로 DB에 기록한다. 이 저장 루프가 트랜잭션으로 감싸여 있지 않아, 루프 중간에 예외가 나면 앞선 행들은 이미 커밋되어 일부 행만 저장된 불완전(half-committed) 상태가 남는다. 리포터는 "데이터를 변경하는 뷰이므로 트랜잭션으로 묶어 에러 시 전체 롤백되어야 한다"고 요청했고, hints는 과거 add/change 경로에 트랜잭션을 넣은 커밋(`7bc0878922`)을 선례로 가리키며 New Feature로 수용했다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈 본문이 `changelist_view`라는 함수명을 직접 적어줘 파일(`django/contrib/admin/options.py`)까지는 grep 한 번이면 도달한다. 다만 그 함수는 길고, `list_editable` 저장 루프(`formset.is_valid()` 직후의 `for form in formset.forms`)라는 정확한 헌크를 가려내려면 함수 내부를 읽어야 한다 — L0 핀포인트는 아니다.
- **S (Strategy) = S6 (Design-Refactor) +S5 (Spec-Inference)**: 한 줄 가드가 아니라 기존 저장 루프 전체를 `with transaction.atomic(...)` 블록 안으로 옮기는 **구조적 재배치**(lifecycle wrapping)다 — 들여쓰기 한 단계가 통째로 바뀐다. 보조로 S5인 이유는, "트랜잭션을 추가하라"는 스펙은 본문에 있으나 *어떤 경계로*(루프 전체 vs 행 단위), *어떤 DB로*(`router.db_for_write(self.model)`) 묶는 게 올바른지는 django admin의 멀티-DB·formset 관례에서 재구성해야 하기 때문. 골드는 행 단위가 아니라 루프 전체를 한 원자 단위로 묶는다(부분 커밋 방지의 핵심).
- **K (Knowledge) = K-Domain**: 프레임워크 내부 지식 의존. `transaction.atomic(using=...)` 시맨틱, admin이 멀티-DB에서 `router.db_for_write`로 쓰기 DB를 고른다는 관례, 그리고 add/change 저장 경로의 선례 패턴을 알아야 골드와 동등한 픽스가 나온다. 순수 파이썬 추론(K-Gen)으로는 `using` 인자에 도달하기 어렵다.
- **primary type = T-DesignRefactor**: dominant 축이 S6(조율된 구조 변경)다. 위치는 비교적 명확하고(L1) 픽스 식의 산술 추론(S2)도 아니며, 본질은 "저장 루프를 트랜잭션 lifecycle로 감싸는 작은 구조 변경"이다. APR 관점에서 이건 template 매칭(S1: 한 줄 가드 삽입)으로는 안 풀린다 — 픽스가 블록 범위(scope)를 재정의하므로 PAR/TBar식 단일 statement 변형이 아니라 collect/wrap 류의 구조 변환이다. 동시에 G&V(S3/S4)도 아니다: 후보가 다수라 테스트로 수렴하는 문제가 아니라, 올바른 경계를 한 번에 도출해야 하는 결정적 변환이다.

## 난이도 티어
**Tier = T3 (중간)**. 공식 라벨은 `<15 min fix`(개발자 구현시간 기준 T1~T2급)지만, 에이전트 난이도로는 한 단계 올린다 — 그 이유는 공식 시간라벨이 잡지 못하는 두 가지 구조 피처 때문이다.

이 티어로 미는 피처:
- **단일 파일·소규모지만 S6 구조 변경**: 1파일·~17줄 헌크로 scope는 작다(T1 방향). 그러나 한 줄 삽입이 아니라 루프 전체를 들여쓰기째 재배치하는 구조 변환이라 diff 노이즈가 크고, 단순 가드 삽입 휴리스틱으로는 골드와 어긋난다.
- **도메인 지식 병목(K-Domain)**: `transaction.atomic()`까지는 일반 지식으로 가도, `using=router.db_for_write(self.model)`는 admin 멀티-DB 관례를 모르면 빠뜨린다. 이게 골드 동등성을 가르는 결정적 디테일이다.
- **넓은 P2P trap(regression-trap)**: PASS_TO_PASS 59개가 거의 전부 `ChangeListTests`/changelist 동작이다. 저장 루프를 재배치하면서 `changecount` 집계, save 순서, formset 처리 흐름을 하나라도 깨면 광범위한 인접 테스트가 무너진다.
- **underspecified**: 본문이 "wrap in a transaction"까지만 말하고 경계·DB 선택은 명시하지 않는다 — 트랜잭션 경계를 행 단위로 잘못 잡거나 `using` 없이 넣어도 "스펙을 만족한 것처럼" 보인다.

T4까지 올리지 않는 이유: cross-file 조율(L3)이 없고 단일 헌크이며, 제약 추론(S2)의 산술적 어려움도 없다. localize도 함수명이 본문에 있어 어렵지 않다. 따라서 "단일파일 + 실질 구조변경 + 약한 도메인지식 + 넓은 P2P"의 T3가 정확하다.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/options.py` → `ModelAdmin.changelist_view` (라인 ~2011, `formset.is_valid()` 분기 내부).
- **근본 원인**: `formset.is_valid()` 통과 후 `for form in formset.forms` 루프가 행마다 `self.save_form` → `self.save_model` → `self.save_related` → `self.log_change`를 즉시 수행하며, 각 행이 자기 트랜잭션(autocommit)으로 곧장 DB에 반영된다. 루프 도중 어느 행에서든 예외가 터지면 그 이전에 성공한 행들은 이미 커밋되어 롤백되지 않아 데이터 정합성이 깨진다(부분 저장).
- **수정 요지**: 저장 루프 전체를 `with transaction.atomic(using=router.db_for_write(self.model)):` 블록으로 감싸 한 단위로 원자화했다. 이로써 루프 중 어떤 행에서 예외가 나든 같은 트랜잭션 안의 모든 변경(이미 성공한 행 포함)이 함께 롤백된다. 멀티-DB 환경을 위해 `router.db_for_write(self.model)`로 쓰기 대상 DB를 명시적으로 선택한다. 루프 본문 로직(저장 순서, `changecount += 1` 집계)은 그대로 유지하고 원자성만 덧입혔으며, `transaction`/`router`는 이미 `options.py`에 import되어 있어 추가 import는 불필요하다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_list_editable_atomicity (admin_changelist.tests.ChangeListTests)`. `Swallow` 두 개(a: load=4/speed=1, b: load=2/speed=2)를 만들고 changelist URL에 두 행을 동시 편집하는 POST를 보낸다.
- **픽스 증명 방식**: `django.contrib.admin.ModelAdmin.log_change`를 `mock.patch`로 가로채 두 시나리오를 만든다 — (1) `side_effect=DatabaseError`(첫 행부터 실패), (2) `side_effect=[None, DatabaseError]`(첫 행 성공, 둘째 행에서 실패). 두 경우 모두 POST가 `DatabaseError`를 전파하는지 `assertRaises`로 확인한 뒤, `a.refresh_from_db()`/`b.refresh_from_db()`로 두 행의 값이 **원래대로 보존**(load=4/1, load=2/2)됐는지 단언한다. 트랜잭션이 없으면 특히 (2) 케이스에서 첫 행 변경이 커밋되어 단언이 깨진다 — 즉 둘째 시나리오가 "루프 전체 원자성"을 정조준한다. `@skipUnlessDBFeature("supports_transactions")`로 트랜잭션 미지원 백엔드는 건너뛴다.
- **overfit 관점**: FAIL_TO_PASS는 1개로 얇아 보이지만, 두 번째 `[None, DatabaseError]` 케이스가 "행 단위 트랜잭션"이라는 흔한 오답을 직접 배제한다(첫 행이 커밋되면 fail). 따라서 special-case 통과 여지가 작아 overfit 위험은 낮다. `flags`에 `overfit-risk`를 넣지 않은 이유다. 단, `using` 인자 누락은 이 단일-DB 테스트로는 잡히지 않으므로 골드 동등성 측면에선 미검증 영역이 남는다.
- **regression 관점**: PASS_TO_PASS 59개가 changelist 전반(`list_editable`, 페이지네이션, 동시편집, 검색, ordering 등)을 덮어 저장 루프 재배치가 인접 동작을 깨지 않음을 보장한다. 특히 "Simultaneous edits of list_editable", "list_editable with pagination", "list_editable edits use a filtered queryset"가 변경 경로를 직접 회귀 검사한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 본문의 "changelist_view ... missing a transaction" → `django/contrib/admin/options.py`의 `ModelAdmin.changelist_view`로 직행. 그 함수 안에서 데이터를 변경하는 지점은 `formset.is_valid()` 직후 `for form in formset.forms:` 저장 루프뿐이므로 헌크가 좁혀진다. hints가 가리키는 선례 커밋(`7bc0878922`, add/change 경로의 트랜잭션화)을 보면 동일 패턴을 어디에 적용할지 확정된다.
2. **픽스와 올바른 일반화 근거**: 저장 루프 **전체**를 `with transaction.atomic(using=router.db_for_write(self.model)):`로 감싼다. 핵심은 트랜잭션 경계를 *행 단위가 아니라 루프 전체*로 잡는 것 — 그래야 "여러 행 중 하나라도 실패하면 전부 롤백"이라는 의도가 충족된다. `using=router.db_for_write(self.model)`는 멀티-DB 라우팅에서 쓰기 DB와 트랜잭션 DB를 일치시키는 admin 관례를 따른 것으로, 단일 admin이 비기본 DB의 모델을 다룰 때 트랜잭션이 엉뚱한 연결에 걸리는 것을 막는다. 이는 special-case가 아니라 "변경 뷰는 멀티-DB에서도 쓰기 DB 기준으로 원자적"이라는 일반 규칙의 적용이다.
3. **regression 안전**: 루프 본문(save_form/save_model/save_related/log_change 순서, `changecount` 집계)을 한 글자도 바꾸지 말고 들여쓰기만 한 단계 추가해야 한다. PASS_TO_PASS의 "Simultaneous edits of list_editable", "list_editable with pagination", "list_editable edits use a filtered queryset", 그리고 `changecount` 기반 성공 메시지(ngettext)를 검증하는 경로들이 깨지지 않아야 한다 — 즉 정상 경로의 커밋 동작과 변경 카운트는 보존되어야 한다.
4. **함정 회피(오라클 없는 에이전트가 틀릴 지점)**:
   - **트랜잭션 경계 오선택**: 루프 *안*에서 행마다 `transaction.atomic()`을 쓰면 부분 커밋이 그대로 남아 FAIL_TO_PASS의 두 번째 케이스에서 실패한다. 반드시 루프를 통째로 감싸야 한다.
   - **`using` 인자 누락**: 단순 `transaction.atomic()`만 넣으면 단일-DB 테스트는 통과하지만 골드와 어긋나고 멀티-DB 정합성을 놓친다. `router.db_for_write(self.model)`를 붙여야 정답.
   - **잘못된 경로 수정**: changelist 인라인 편집 루프가 아니라 add/change form 저장 경로(이미 트랜잭션 처리됨)를 건드리면 안 된다 — 대상은 `changelist_view`의 formset 루프뿐.
   - **불필요한 import 추가/구조 망가뜨림**: `transaction`·`router`는 이미 import되어 있다. diff가 들여쓰기 변경으로 크게 보여도 로직 변경을 끼워 넣지 말 것.
