---
instance_id: django__django-16899
repo: django/django
base_commit: d3d173425fc0a1107836da5b4567f1c88253191b
version: 5.0
difficulty: <15 min fix
created_at: 2023-05-26T13:41:37Z
fail_to_pass: 2
pass_to_pass: 54
gold_files: [django/contrib/admin/checks.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-16899

## 문제 요약
ModelAdmin을 서브클래싱할 때 `readonly_fields`의 시스템 체크(admin.E035)가 내는 에러 메시지는 잘못된 값의 인덱스(`readonly_fields[0]`)만 알려주고, 정작 어떤 필드 이름이 문제인지는 메시지에 포함하지 않는다. `list_editable`, `raw_id_fields`, `list_display` 등 다른 admin 옵션 체크는 `... refers to '<field_name>', which is not ...` 형태로 실제 위반 값을 메시지에 넣어준다. 이슈는 `readonly_fields` 체크도 동일하게 필드 이름을 포함하도록 통일해 디버깅 가독성을 높여달라는 순수 진단-메시지 개선 요청이다. 동작 자체에는 결함이 없고, 에러 텍스트의 정보 누락만 고치면 된다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement가 깨진 에러 문구("The value of 'readonly_fields[0]' is not a callable, an attribute of ...")를 그대로 인용하고, 통일 대상인 `list_editable[0] ... refers to ...` 문구까지 제시한다. 이 리터럴을 grep하면 `django/contrib/admin/checks.py`의 단일 분기로 한 방에 수렴한다. 탐색 노력 사실상 0.
- **S1 (Direct-Map)** — 이슈가 픽스를 사실상 명세한다("include the field name", 다른 옵션과 "unify"). 결함 클래스는 "포맷 문자열에 인자 1개 추가"라는 정형 템플릿이고, 올바른 식을 추론으로 합성할 필요(S2)가 없다. 메시지 템플릿에 `%s` 슬롯 하나를 늘리고 포맷 튜플에 `field_name`을 끼우는 기계적 변경이라 S1이 dominant. CEGIS/G&V처럼 후보를 여럿 만들어 테스트로 수렴시킬 여지도 없다(목표 문구가 사실상 고정).
- **K-Domain** — 일반 파이썬 추론(K-Gen)만으로도 "field_name을 메시지에 넣는다"는 도달 가능하지만, 정확히 어느 함수(`_check_readonly_fields_item`)에서 `FieldDoesNotExist`를 잡고 `admin.E035`를 만드는지, 그리고 django admin checks의 관용 문구(`refers to '%s', which is not ...`)를 그대로 맞춰야 한다는 점은 django.contrib.admin checks 프레임워크 내부 지식에 의존한다. 단 그 의존도는 얕다.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 포맷-문자열 보강(S1)이다. T-LocTrivial(T1)이 아닌 이유는 K-Domain이 약하게 끼고, 테스트가 전문(全文) 일치를 요구해 자명함보다 한 단계 위이기 때문.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- 파일 1개·함수 1개·변경 라인 ~5줄(메시지 템플릿 2줄 + 포맷 튜플에 `field_name` 1줄 추가). 구조적 컷(1파일·<5줄 ≈ 높은 solve)에 정확히 들어맞는다.
- localize 직접성 최상(L0): 이슈가 에러 리터럴을 인용 → grep 한 방.
- repro는 네이티브 스택트레이스 형태는 아니지만, 이슈가 기대 입력/출력 문구를 명시해 사실상 재현 명세를 제공한다(`has-repro` 플래그까지는 주지 않음 — 실행 가능한 재현 코드/스택은 아님).

공식 라벨 `<15 min fix`(prior상 T1 후보)와 한 단계 다르게 **T2로 올린 이유**: (1) FAIL_TO_PASS가 에러 메시지 전문 문자열 일치를 요구해, 새 문구의 띄어쓰기·문장부호·단어 순서를 골드와 한 글자도 다르지 않게 맞춰야 한다(자체 문구 창작 시 즉시 탈락). (2) PASS_TO_PASS 54개가 동일 `admin_checks` 스위트에 걸쳐 있어 메시지 포맷 변경이 인접 체크의 기대 문구를 깨지 않도록 슬롯/인자 정합을 정확히 맞춰야 한다(`regression-trap`). 이 두 제약이 T1의 "이슈가 픽스를 거의 적어줌, 막힐 위험 0"보다 미세하게 까다롭다. 그래도 추론·refactor·깊은 도메인 요소가 없어 T3 이상은 아니다.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/checks.py` → `BaseModelAdminChecks._check_readonly_fields_item`, 구체적으로 `except FieldDoesNotExist:` 분기에서 반환하는 `checks.Error`(id=`admin.E035`) 생성부.
- **근본 원인**: `FieldDoesNotExist`가 발생했을 때의 메시지 템플릿이 `"The value of '%s' is not a callable, an attribute of '%s', or an attribute of '%s'."`로 `%s` 슬롯이 3개였고, 포맷 튜플에 `label`(예: `readonly_fields[1]`) / `obj.__class__.__name__` / `obj.model._meta.label`만 들어갔다. 해석에 실패한 실제 값 `field_name`이 포맷 인자에서 완전히 빠져 있어, 메시지가 위반 필드 이름을 표시하지 못했다.
- **수정 요지**: 템플릿을 `"The value of '%s' refers to '%s', which is not a callable, an attribute of '%s', or an attribute of '%s'."`로 교체(`%s` 슬롯 3→4)하고, 포맷 튜플에서 `label` 바로 뒤에 `field_name`을 삽입. 결과적으로 `readonly_fields` 체크의 에러 메시지가 `list_editable` 등 다른 admin 옵션과 동일한 `refers to '<value>', which is not ...` 관용구로 통일된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_nonexistent_field`, `test_nonexistent_field_on_inline`. 각각 존재하지 않는 필드를 `readonly_fields`에 넣은 `SongAdmin`(`"nonexistent"`)과 `CityInline`(`"i_dont_exist"`)을 `.check()`로 돌려 E035 에러 객체를 검증한다.
- **픽스 증명**: 테스트가 기대 `checks.Error` 문자열을 새 형식으로 갱신한다 — `"The value of 'readonly_fields[1]' refers to 'nonexistent', which is not a callable, an attribute of 'SongAdmin', or an attribute of 'admin_checks.Song'."`(인라인은 `'i_dont_exist'`/`CityInline`/`admin_checks.City`). 패치 전 코드는 `field_name` 없는 옛 문구를 반환하므로 정확 문자열 비교에서 실패하고, 패치 후에는 슬롯에 위반 필드명이 채워져 통과한다. 입력→출력의 인과(존재하지 않는 필드 → 그 이름을 포함한 E035)가 테스트로 직접 고정된다.
- **overfit 관점**: 변경이 메시지 텍스트 한 곳뿐이고 `field_name`이라는 일반 변수를 모든 입력에 동일하게 끼우므로, 특정 테스트 입력에만 통하는 special-case 여지가 없다(`overfit-risk` 아님). 다만 두 FAIL_TO_PASS가 모두 "전문 일치"라 테스트 자체는 얇다 — 의미(올바른 일반화)는 명백하나 검증은 문자열 동등성에 의존.
- **regression 관점**: `regression-trap` 표기. PASS_TO_PASS 54개 다수가 같은 `admin_checks` 스위트의 다른 체크(`test_readonly*`, `test_editable`, `test_list_editable_*` 등)라, 포맷 슬롯/인자 개수를 어긋나게 바꾸면 `TypeError`(`not enough/too many arguments for format string`)로 인접 정상 경로까지 무너질 수 있다. 골드처럼 슬롯=인자=4로 정확히 맞춰야 안전.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 인용한 리터럴 `"is not a callable, an attribute of"`를 코드베이스에 grep → `django/contrib/admin/checks.py`의 `_check_readonly_fields_item` 내 `except FieldDoesNotExist:` 분기로 단번에 수렴. 이슈가 짝으로 보여준 `list_editable[0] ... refers to ...` 문구를 같은 파일에서 확인해 목표 포맷의 정답 형태를 베낀다.
2. **픽스와 올바른 일반화**: 메시지 템플릿에 `refers to '%s'` 슬롯을 추가하고 포맷 튜플의 `label` 뒤에 `field_name`을 넣는다. 이것이 overfit이 아니라 올바른 일반화인 이유 — `field_name`은 분기에 이미 바인딩된 "해석 실패한 실제 값"이라 모든 입력에 보편적으로 맞고, django admin checks 전반의 기존 관용구(`refers to '%s', which is not ...`)를 그대로 따르므로 두 FAIL_TO_PASS 입력뿐 아니라 임의의 잘못된 readonly_fields 값 전체에 일관되게 동작한다.
3. **regression 안전**: 같은 `admin_checks` 스위트의 PASS_TO_PASS(`test_readonly`, `test_readonly_and_editable`, `test_editable`, `test_list_editable_missing_field` 등)는 다른 체크 경로/문구를 검증하므로, E035 분기 외에는 손대지 않고 포맷 `%s` 개수=튜플 인자 개수=4로 정확히 정합시키면 깨지지 않는다. 다른 메시지 분기(예: 정상 readonly callable 경로)는 건드리지 않는다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점은 (a) "필드명을 넣자"는 의도는 맞히되 자체 문구를 창작해 골드와 띄어쓰기/단어순서/`which is`가 달라져 전문 비교에서 탈락, (b) 슬롯만 늘리고 포맷 튜플에 인자 추가를 빼먹어(또는 위치를 `label` 앞에 둬서) `TypeError`/어순 붕괴를 유발하는 것. 회피법: 같은 파일의 기존 `refers to '%s', which is not ...` 관용 문구를 그대로 복제해 단어를 한 글자도 바꾸지 말고, `field_name`을 `label` 바로 다음 슬롯에 배치해 "value of '<label>' refers to '<field_name>'" 어순을 맞춘다.
