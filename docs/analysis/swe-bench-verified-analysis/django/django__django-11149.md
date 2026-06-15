---
instance_id: django__django-11149
repo: django/django
base_commit: e245046bb6e8b32360aa48b8a41fb7050f0fc730
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-03-30T18:14:35Z
fail_to_pass: 2
pass_to_pass: 46
gold_files: [django/contrib/admin/options.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-11149

## 문제 요약
auto-created ManyToManyField을 `TabularInline`(model = `X.through`)으로 admin에 노출하면, **view 권한만** 가진 사용자가 화면에서 M2M 항목을 추가/삭제할 수 있는 권한-상승 버그. Django 2.1에서 view 권한 기능이 도입되면서 회귀했다(릴리스 블로커로 격상됨). 같은 M2M을 inline이 아닌 일반 필드로 두면 동작은 정상이라는 점이 단서. 사용자는 view-only면 inline이 읽기 전용이길 기대했다. 재현 프로젝트(zip + fixture, readonly 계정)가 첨부되어 있다.

## 유형 (정형화)

**L (Localization) = L1 (Traceable).** problem_statement의 "auto-created ManyToManyField" + "TabularInline" + "view permission" 키워드가 `django/contrib/admin/options.py`의 `InlineModelAdmin.has_*_permission` 메서드군, 특히 `self.opts.auto_created` 분기로 좁은 단일파일 후보를 직접 가리킨다. 심볼을 콕 집어주진 않으므로 L0는 아니지만, grep 한두 번이면 수렴한다. 멀티사이트(L3)가 아닌 이유: 수정은 한 파일·한 클래스 안에서 끝나고, 네 메서드가 같은 헬퍼를 공유하는 형태일 뿐 cross-file 조율은 없다.

**S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor 보조).** 고칠 위치(`auto_created` 분기)는 명확하나, **올바른 권한 집합을 추론으로 합성**해야 한다: 핵심은 "`has_view_permission`이 view OR change를 허용하므로 add/change/delete가 그걸 위임하면 view-only가 편집 경로를 통과한다"는 불변식 위반을 짚고, edit 계열엔 `['change']`, view엔 `['view','change']`라는 서로 다른 권한 집합을 도출하는 것이다. 테스트를 마구 돌려 수렴하는 G&V(S3/S4)가 아니라 권한 의미를 따져 한 번에 풀어야 한다. S6 보조: 기존 `has_view_permission`에 박혀 있던 through→target model 탐색 루프를 `_has_any_perms_for_target_model(request, perms)` 헬퍼로 추출(collect-then-process)해야 4개 메서드가 공유 가능 — 단순 한 줄 변경이 아닌 소규모 구조 변경.

**K (Knowledge) = K-Domain.** django admin 권한 모델 내부 지식이 병목: auto_created intermediate(through) model은 자체 권한이 없어 target model 권한으로 매핑해야 한다는 것, `get_permission_codename`/`request.user.has_perm('%s.%s')` 규약, "change가 view를 함의한다"는 권한 위계를 알아야 픽스가 올바르다. 일반 파이썬 추론(K-Gen)만으론 `['change']` vs `['view','change']` 구분을 정당화할 수 없다.

**Primary type = T-ConstraintReason.** 위치는 비교적 명확(L1)하지만 진짜 난점이 "어디"가 아니라 **올바른 권한 식·조건을 의미 추론으로 합성**하는 데 있으므로 T-DiffuseLoc도 T-DomainBound도 아닌 T-ConstraintReason이 dominant. 도메인 지식은 그 추론의 입력으로 작동한다.

## 난이도 티어

**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 `15 min - 1 hour`(≈T3 prior). 이를 T4로 상향하는 구조적 피처:
- **S2 constraint-reasoning + S6 소규모 refactor 동반**: 단순 가드/상수(S1)가 아니라 두 종류의 권한 집합을 추론 분리하고 공유 헬퍼를 도입해야 함 — 루브릭상 "constraint추론·소규모 refactor 중 하나"가 T4 신호.
- **K-Domain**: 권한 위계/through-model 매핑 지식이 병목.
- **regression-trap (넓은 P2P)**: PASS_TO_PASS 46개 중 다수가 `TestInlinePermissions`의 add/change × fk/m2m × perm 조합(`test_inline_change_m2m_change_perm`, `test_inline_add_m2m_add_perm`, `test_inline_change_m2m_noperm` 등). add/change/delete를 잘못 죄면 정당한 change/add 권한 사용자의 정상 동작을 깨기 쉬움.

T5로 올리지 않는 이유: 단일 파일·단일 클래스이고 멀티파일 조율(L3)이나 overfit 고위험(S4)이 없으며, **has-repro**(zip+fixture+stacktrace급 재현 절차)가 강한 easiness 신호로 작용해 의도 모호성을 상쇄한다. 공식 라벨보다 높은 건 시간라벨이 "구현시간"만 재고 권한 의미 추론·P2P trap을 안 잡기 때문.

## 골드패치 분석

- **건드린 파일·함수**: `django/contrib/admin/options.py` — `InlineModelAdmin.has_add_permission` / `has_change_permission` / `has_delete_permission` / `has_view_permission` 4개 메서드 + 신규 헬퍼 `_has_any_perms_for_target_model(self, request, perms)`.
- **근본 원인**: auto_created intermediate model 분기에서 `has_add_permission` / `has_change_permission` / `has_delete_permission`가 전부 `return self.has_view_permission(request, obj)`로 위임했다. 그런데 `has_view_permission`은 target model의 `view` **또는** `change` 권한 중 하나만 있어도 True를 반환한다. 따라서 view-only 사용자도 add/change/delete가 모두 True가 되어 inline에서 편집/삭제가 가능 — 권한 상승.
- **수정 요지**: through→target model을 찾던 `has_view_permission`의 탐색 루프(`for field in opts.fields: if field.remote_field and field.remote_field.model != self.parent_model:`)와 `has_perm` 조회를 `_has_any_perms_for_target_model(request, perms)`로 추출. 그 위에서:
  - `has_add/change/delete_permission` → `self._has_any_perms_for_target_model(request, ['change'])` (편집은 change 권한 필요)
  - `has_view_permission` → `self._has_any_perms_for_target_model(request, ['view', 'change'])` (view 또는 change로 열람 가능; change가 view를 함의)
  이로써 view-only 사용자는 편집 경로 4개 중 view만 통과하고 add/change/delete는 False가 된다.

## 검증 (test_patch)

- **FAIL_TO_PASS (2개)**: `test_inline_add_m2m_view_only_perm`, `test_inline_change_m2m_view_only_perm` (`admin_inlines.tests.TestInlinePermissions`).
- **픽스 증명**: `view_book` 권한만 부여한 사용자로 author **add** / **change** 페이지를 GET → context의 `inline_admin_formset`에서 `has_view_permission is True`이고 `has_add/change/delete_permission is False`임을 `assertIs`로 단언. add 페이지는 `Author_books-TOTAL_FORMS value="0"`, change 페이지는 `value="1"` + 읽기전용 표시 `<p>{book}</p>`이며, "Add another Author-Book Relationship" 버튼과 `Author_books-0-DELETE` 체크박스가 없음을 `assertNotContains`로 확인. 패치 전엔 has_view가 add/change/delete로 새어 모든 단언이 True가 되어 실패한다. test_patch는 `models.py`에 `Book.__str__`을 추가(읽기전용 `<p>%s</p> % self.book` 비교용)하고 setUp의 `book`을 `cls.book`으로 승격한다.
- **overfit 관점**: special-case 통과 위험 낮음. `assertIs(..., False)` 3종 + TOTAL_FORMS + DELETE 부재 + Add 버튼 부재를 add/change 두 페이지에서 교차 검증하므로, "그냥 항상 False 반환" 같은 꼼수는 동시에 추가된 `test_inline_change_m2m_change_perm`의 `has_add/change/delete is True` 단언에서 즉시 깨진다. CEGIS(S4) 상황 아님.
- **regression 관점**: 46개 P2P 중 `test_inline_change_m2m_change_perm` / `test_inline_add_m2m_add_perm` / `test_inline_change_m2m_noperm` / fk 계열 다수가 권한 경로를 직접 본다. `['change']`/`['view','change']` 매핑이 정확해야 정당한 권한 사용자의 동작과 무권한 차단을 동시에 보존한다 — regression-trap이 실재한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "auto-created ManyToManyField" + "TabularInline(model=...through)" + "view permission으로 편집 가능"을 신호로 admin 권한 메서드를 의심 → `django/contrib/admin/options.py`에서 `auto_created`를 grep → `InlineModelAdmin`의 `has_add/change/delete/view_permission` 네 메서드의 `if self.opts.auto_created:` 분기를 본다. 여기서 add/change/delete가 모두 `has_view_permission`을 위임하는 스멜이 즉시 드러나고, `has_view_permission`이 `view OR change`로 True를 주는 것을 읽으면 권한-상승 경로가 확정된다.

2. **픽스(왜 올바른 일반화인가)**: edit 계열(add/change/delete)은 target model의 `change` 권한을, view는 `view OR change`를 요구하도록 분리. 이게 overfit이 아닌 이유 — django의 권한 위계상 "intermediate model엔 자체 권한이 없으니 target model 권한으로 판정"이라는 기존 설계 의도를 유지하면서, 편집/열람의 의미 차이만 정확히 반영했기 때문. `['change']`를 모든 편집 동작의 단일 기준으로 둔 것은 add/change/delete가 모두 M2M 관계의 *쓰기*라는 일반 규칙. 탐색 루프를 `_has_any_perms_for_target_model` 헬퍼로 추출한 것은 네 메서드의 중복 제거 + 단일 진실 — 인라인 복붙은 회귀 위험.

3. **regression 안전**: `['change']`/`['view','change']` 경계를 정확히 맞춰 `test_inline_change_m2m_change_perm`(change 권한자는 4개 다 True), `test_inline_add_m2m_add_perm`, `test_inline_change_m2m_noperm`(무권한 차단), 그리고 fk 계열 P2P를 안 깨야 한다. 특히 add를 `super().has_add_permission()`로 돌려선 안 됨 — intermediate model엔 자체 add 권한이 없어 항상 False가 되어 정당한 사용자까지 막힌다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) add/change/delete를 단순히 `super()`로 위임 → intermediate model 권한 부재로 정당 사용자 차단(P2P 깨짐). (b) edit 계열에 `['view','change']`를 그대로 둠 → 버그 미수정(view-only가 여전히 편집). (c) target model 탐색 루프를 메서드마다 복붙 → 중복·회귀 위험. 피하는 법: "has_view가 change도 허용한다"는 의미 차이를 먼저 명시하고, edit=`['change']` / view=`['view','change']`로 권한 집합을 명시적으로 분리한 뒤 탐색 로직을 단일 헬퍼로 공유한다.
