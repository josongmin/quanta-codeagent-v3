---
instance_id: django__django-11728
repo: django/django
base_commit: 05457817647368be4b019314fcc655445a5b4c0c
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-08-29T17:31:03Z
fail_to_pass: 2
pass_to_pass: 44
gold_files: [django/contrib/admindocs/utils.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-11728

## 문제 요약
admindocs의 `simplify_regexp()`(내부적으로 `replace_named_groups()`/`replace_unnamed_groups()` 사용)이 urlpattern 끝에 trailing `/`나 `$`가 없을 때 **마지막 그룹을 치환하지 못한다**. 예: `r'entries/(?P<pk>[^/.]+)/relationships/(?P<related_field>\w+)'`에서 `related_field`가 `<related_field>`로 안 바뀌고 원본 `(?P<related_field>\w+)`이 그대로 남는다. 끝에 `/`를 붙이면 동작하는 게 워크어라운드. problem_statement에 재현 데모(`demo.py`)와 expected/got 출력이 모두 첨부됐고, Django REST Framework에서도 이 함수를 사용(DRF issue 6888)하기 때문에 다운스트림 영향이 있다.

## 유형 (정형화)

**L (Localization) = L0 — Pinpointed.** problem_statement가 `replace_named_groups()`를 함수명으로 직접 지목하고, hints_text에는 거의 골드와 동일한 diff와 "Similar change should be made in `replace_unnamed_groups()`"까지 적혀 있다. `django/contrib/admindocs/utils.py` 한 파일로 grep 한 방에 수렴 — 탐색 비용 0.

**S (Repair Strategy) = S2 (+S6) — Constraint-Reasoning + 소규모 구조 재배치.** 고칠 지점은 자명하지만, 픽스는 상수 변경이나 None-가드 추가 같은 기계적 템플릿(S1)이 아니다. "루프 본문 첫머리의 early `unmatched_open_brackets == 0` 체크가 마지막 닫는 `)`을 카운트한 *다음* iteration에 의존한다 → 패턴이 그 `)`에서 끝나면 종료 분기를 영영 못 탄다"는 **불변식·종료조건 추론**이 본질이다. 픽스는 (a) 균형 체크 분기를 루프 본문 **끝**으로 이동(S6: collect 타이밍을 한 칸 미루는 lifecycle 재배치)하고 (b) 슬라이스 끝 인덱스를 +1 보정해 마지막 `)`을 포함시키는 것. 이 둘은 "왜 +1인지"를 인덱스 산술로 따져야 맞으므로 generate-and-validate(S3)로 무작정 후보를 돌리기보다 **생각으로 푸는** 결함이다. dominant=S2, 분기 이동이 단순 한 줄 교체가 아닌 제어흐름 재배치라 S6 보조.

**K (Knowledge) = K-Gen.** django 도메인지식(ORM/query-compiler/migrations) 불필요. 순수 파이썬 문자열 순회 + 괄호 균형 카운팅 + `enumerate` 인덱스 산술로 충분하다. admindocs라는 위치만 django일 뿐 추론 자체는 일반 알고리즘.

**Primary type = T-ConstraintReason.** 위치는 L0로 명확하나(찾기 쉬움), 난점이 "올바른 종료조건·슬라이스 경계를 추론으로 합성"하는 데 있다 → 루브릭의 T-ConstraintReason(위치 명확 + S2) 정의에 정확히 부합. T-DirectMap이 아닌 이유: 픽스가 가드/기본값/상수 같은 기계적 결함클래스 템플릿이 아니라 제어흐름 재배치 + off-by-one 경계 추론이라서. T-DomainBound도 아님(K-Gen).

## 난이도 티어

**Tier = T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior).

이 티어로 미는 구조적 피처:
- **단일 파일·소규모**(`utils.py` 1파일, 실질 변경 ~10줄)인데도 **순수 기계적이 아닌 실질 추론**(종료조건 off-by-one + 슬라이스 +1 보정)이 필요 → 루브릭 T3 정의("L1+S2/S5 단일파일이나 실질 추론")에 정합. localize는 L0로 더 쉽지만, 추론 난도가 T2(가벼운 엣지추론)를 넘어선다.
- **regression-trap(약~중)**: PASS_TO_PASS 44개 중 다수가 `simplify_regex`와 같은 admin_docs 뷰 계열이고, 슬라이스 인덱스 보정을 틀리면 **trailing `/`·`$`가 있던 기존 케이스(`^(?P<a>\w+)/b/(?P<c>\w+)$` 등)가 회귀**한다. 한 파일 안에서 named/unnamed 두 함수를 **함께** 같은 방식으로 고쳐야 하는 멀티-헌크라 조율이 필요(L3까지는 아님 — 같은 파일·같은 함수쌍).
- **has-repro**: problem_statement에 expected/got + AssertionError 스택까지 첨부 → 가장 강한 easiness 신호(해결률 ~87%)라 위로 끌어내림.

T2가 아닌 이유: 픽스가 "가벼운 엣지추론" 이상의 종료조건+인덱스 산술 추론이고, named/unnamed 두 곳 동시 수정이라는 조율과 off-by-one 회귀 함정이 있음. T4가 아닌 이유: cross-file 없음, 도메인지식 없음, 1파일 소규모, repro 첨부로 localize·검증이 쉬움. 공식 라벨(상한 1h)과 충돌 없이 T3로 수렴.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/admindocs/utils.py` — `replace_named_groups()`, `replace_unnamed_groups()`.
- **근본 원인**: 두 함수 모두 named/unnamed 그룹 본문을 한 글자씩(`for idx, val in enumerate(pattern[end:])` / `enumerate(pattern[start+1:])`) 순회하며 `unmatched_open_brackets`로 괄호 균형을 센다. 그런데 **균형 확인 분기(`if unmatched_open_brackets == 0: ... break`)를 루프 본문 맨 앞**에 두었다. 마지막 닫는 `)`은 그 iteration의 *아래쪽* `elif val == ')'`에서 카운트되어 균형이 0이 되므로, 종료 판정은 **그 다음 iteration의 첫머리**에서야 일어난다. 패턴 문자열이 바로 그 `)`에서 끝나면 다음 iteration이 없어 종료 분기를 **한 번도 못 타고**, `group_pattern_and_name`/`group_indices`에 그룹이 등록되지 않아 → 마지막 그룹이 미치환으로 남는다.
- **수정 요지**:
  1. 균형 체크 분기를 루프 본문의 **맨 끝**(괄호 카운팅 `if/elif`와 `prev_char = val` 이후)으로 이동 → 닫는 `)`을 카운트한 **같은 iteration**에서 종료를 판정.
  2. 슬라이스 끝 인덱스 +1 보정: `replace_named_groups`는 `pattern[start:end+idx]` → `pattern[start:end+idx+1]`, `replace_unnamed_groups`는 `(start, start+1+idx)` → `(start, start+2+idx)`. 종료 시점이 한 칸 뒤로 밀렸으므로 마지막 `)`을 슬라이스에 포함시키기 위함(named는 `end+idx`가 닫는괄호 직전 → +1, unnamed는 base offset이 `start+1`이라 `+2+idx`).
  3. 두 함수 docstring에 trailing `/` 없는 예시(예 3, 4) 추가.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_simplify_regex (admin_docs.test_views.AdminDocViewFunctionsTests)`, `test_app_not_found (admin_docs.test_views.TestModelDetailView)`.
- **동작**: `tests/admin_docs/test_views.py`의 `test_simplify_regex` 케이스 테이블에 trailing `/`·`$`가 **없는** 입력 4종을 추가 — `r'^(?P<a>\w+)/b/(?P<c>\w+)'` → `/<a>/b/<c>`, `r'^(?P<a>\w+)/b/(\w+)'` → `/<a>/b/<var>`, `r'^(?P<a>\w+)/b/((x|y)\w+)'` → `/<a>/b/<var>`, `r'^(?P<a>(x|y))/b/(?P<c>\w+)'` → `/<a>/b/<c>`. 픽스 전에는 마지막 그룹이 원본(`(?P<c>\w+)` / `(\w+)`)으로 남아 기대 출력과 불일치 → 픽스 후 정확히 치환되어 통과.
- **overfit 관점**: 테스트가 named/unnamed × 단순/중첩(`((x|y)\w+)`) × trailing 없음을 교차로 덮어 special-case 해결을 차단한다. 다만 FAIL_TO_PASS가 사실상 1개 함수형 테스트(`test_app_not_found`는 admindocs 앱 로딩 부수효과로 동반 통과)라 케이스 테이블 외 입력공간(예: 깊게 중첩된 비대칭 그룹)에 대한 보장은 약함 → 미세한 overfit 잔존. 단, 골드는 구조적 종료조건 수정이라 테이블 너머로도 올바르게 일반화됨(테스트 overfit 위험 ≠ 골드 overfit).
- **regression 관점**: PASS_TO_PASS 44개 중 기존 trailing `/`·`$` 케이스(`^(?P<a>\w+)/b/(?P<c>\w+)$` 등)가 인덱스 +1 보정 오류 시 깨질 수 있음. 골드의 +1 보정이 정확하므로 기존 케이스는 보존되고, 나머지 admin_docs 뷰/필드 테스트는 이 함수와 무관해 영향 없음.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement가 함수명 `replace_named_groups()`를 직접 주고 has-repro로 입력/expected/got까지 첨부 → `git grep replace_named_groups` 한 방에 `django/contrib/admindocs/utils.py`로 직행. 증상("trailing `/` 없으면 마지막 그룹 미치환")이 "마지막 문자가 `)`일 때만 실패"임을 가리키므로, 루프 종료조건을 의심하는 게 정답 경로. hints_text가 거의 완성 diff를 주지만, 그게 없어도 L0라 자력 localize 가능.

2. **픽스와 왜 올바른 일반화인가**: early-check(`if unmatched_open_brackets == 0` 맨 앞)를 **루프 끝으로 이동** + 슬라이스 끝 **+1 보정**. 이것이 overfit 아닌 일반화인 이유: 결함의 근본은 "종료 판정이 닫는 괄호 *다음* iteration에 의존"하는 구조이고, 분기를 끝으로 옮기면 **패턴 마지막 문자가 닫는 괄호든 아니든** 동일 iteration에서 균형 0을 잡는다. 즉 trailing-`/`-없음이라는 특정 입력이 아니라 "그룹이 패턴 끝에서 닫히는" 모든 경우를 한 번에 커버 → CEGIS식 special-case 패치가 아니라 종료조건 자체를 교정한 구조 픽스.

3. **regression 안전**: 기존에 통과하던 trailing `/`·`$` 케이스를 깨면 안 된다. 분기를 끝으로 옮기면 종료 idx가 1 증가하므로 슬라이스 끝을 `+1`(named) / `+2`(unnamed, base offset 차이) 보정해야 기존 케이스의 슬라이스 길이가 **불변**으로 유지된다. named는 `end+idx`→`end+idx+1`, unnamed는 `start+1+idx`→`start+2+idx`로 base가 달라 보정량이 다름 — 이 비대칭을 정확히 맞춰야 trailing-있음 P2P가 보존된다.

4. **함정 회피 (오라클 없는 에이전트가 틀릴 지점)**:
   - **단일 함수만 수정**: `replace_named_groups`만 고치고 `replace_unnamed_groups`를 빠뜨리면 unnamed 케이스(`(\w+)`, `((x|y)\w+)`)가 여전히 실패 → 테스트 테이블이 둘 다 덮으므로 FAIL. hints의 "Similar change should be made in `replace_unnamed_groups()`"를 반드시 반영.
   - **off-by-one 복붙 오류**: 두 함수의 인덱스 base가 `end+idx+1` vs `start+2+idx`로 미묘하게 달라(named는 `pattern[end:]`, unnamed는 `pattern[start+1:]` 기준), 한쪽을 그대로 복붙하면 마지막 `)`이 잘리거나 한 글자 더 먹어 치환이 틀어진다. 각 함수의 enumerate base를 따져 +1을 독립 계산해야 함.
   - **분기 이동 없이 인덱스만 +1**: 종료조건을 끝으로 옮기지 않고 슬라이스만 +1 하면, 패턴 끝에서 닫히는 그룹은 여전히 종료 분기를 못 타 미등록 → 무효. 구조 이동이 핵심이고 인덱스 보정은 그에 종속.
