# platform 모듈

## 하는 일
모든 모듈이 쓰는 공통 기반. DB 연결, 기반 클래스, 오류, 요청자(Actor), 이벤트와 outbox, 변경 신호(`/api/stream`), 서버 상태 확인.
파일 저장(blobs), 보관 형식(archive), 플러그인, 알림(콘솔 머리줄 · 알림 설정 · 브라우저 푸시). AI 일거리는 task 모듈이 맡는다.
**비즈니스 규칙을 두지 않는다.** 세션·글 같은 단어가 여기 코드에 나오면 잘못 들어온 것이다.

## 소유 데이터
스키마 `platform`: blobs, idempotency, notifications, notice_settings, push_subscriptions, outbox, plugins, plugin_settings, security_events
DB 함수: `platform.uuid_v7()`, `platform.forbid_update_delete()` (모든 모듈의 테이블이 씀)

## 데이터 묶음
- 플러그인(plugins + plugin_settings, `plugin/`): `PluginState`는 열쇠가 이름이고 version 칸이 없어 `BaseEntity`로 두 표의 행(`platform.tables.ts`)을 들고, `PluginRepository`가 늘 덮어쓴다 (ON CONFLICT). 비밀값은 암호화된 칸으로만 들고 View에는 채워졌는지(`isSet`)만 나간다. 목록은 Query가 보는 사람에 맞는 View를 고른다 (주인과 서버 자신 `PluginListView`, 그 밖 `PluginSummaryListView`)
- 서버 상태(`health/`): 표가 아니라 DB 카탈로그를 읽는다. 누구에게나 DB를 읽어 본 뒤 답하고, 방문자는 status만(`HealthView`), 주인과 서버 자신은 확장 · 마이그레이션 · 표 수까지(`HealthDetailView`)
- 알림(notifications, `notice/`): 무엇을 알리는지 모른다 (종류 · 이름 · 등급 · 제목 · 본문 · 주소는 알리는 쪽). 모듈은 `onModuleInit`에서 `NoticeCatalog.define(new NoticeKind(…).from(이벤트들, 만들기).settledOn(이벤트들, 묶음 키))`로 등록하고,
  `Outbox.listen`이 이벤트를 쓰는 같은 트랜잭션에서 `NoticeCatalog.onEvents` → `Notices.post`(경로가 off면 안 남김, 같은 `group_key`의 안 읽은 알림은 바꾸고 `push_sent_at`을 비움) · `Notices.settle`(끝난 일의 알림 읽음).
  이벤트 없이 남기는 알림도 종류는 등록한다 (설정 화면에 보이게). 읽기 `api/notifications`(최근 30개 · 안 읽은 수), 읽음 `api/notifications/read`. 주인만
- 알림 설정(notice_settings, `NoticeSettings`): 공간마다 한 줄, 없으면 기본값. 묶음 간격 · 조용한 시간 · 시간대 · 종류별 경로(push · center · off) · 종류별 메일(`mail` on · off, 없으면 `NoticeKind.defaultMail`: `noMailByDefault()`로 등록한 종류(대화의 답)는 끔, 2026-11-27). `api/notice-settings`(주인만, 종류 목록은 `NoticeCatalog`에서)
- 멈춘 이벤트(outbox의 `failed_at`, `failed-event/`, 리팩토링 R1): 일꾼이 8번 실패한 이벤트를 멈출 때 같은 트랜잭션에서 알림 `platform.event.failed`(즉시, 묶음 키 `event-failed` 하나: `FailedEvent.notice`)를 남긴다. 읽기 `api/events/failed`(`FailedEventQuery`, 최근에 멈춘 50개), 다시 시도 `api/events/:id/retry`(`FailedEventService`: `FailedEvent.retry`가 멈춘 것만 시도 0 · `failed_at` NULL · 지금으로 돌리고, 같은 트랜잭션에서 일꾼을 깨우고(`Outbox.poke`), 공간에 멈춘 것이 더 없으면 알림을 읽음으로). 관리자는 자기 공간, 명령줄(`pnpm run events`, `SystemActor`)은 모두. 실패를 저절로 작업 실패로 바꾸지 않는다: 다시 시도해서 성공하면 어긋난다. 받는 쪽은 두 번 불려도 결과가 같아야 한다는 규칙이 있어 처음처럼 다시 넘긴다
- 보안 기록(security_events, `security/`, 2026-11-15): 무엇의 사건인지 모른다 (종류 · 내용은 기록하는 모듈이). `SecurityLog`는 `Notices`처럼 부르는 쪽의 연결을 받아 한 줄을 남기고, 1분 안의 같은 공간 · 종류 · 곳 · 내용이면 `count` · `last_at`만 올린다 (새 줄이면 true: 알림을 한 번만 보내게). 거부된 접근은 `DomainErrorFilter`가 `/api` · `/mcp` · `/oauth`의 401 · 403 · 429에서 `SecurityLogService.record`로 남긴다 (기다리지 않고, 실패는 서버 로그. 401은 토큰 · 쿠키를 내민 요청만, 모듈이 사건으로 남긴 오류는 `DomainError.recorded`로 건너뜀). 읽기 `api/security/events`(주인만, `SecurityEventQuery`, 공간을 모르는 사건도 함께), 90일 지난 줄은 `SecurityLogPurgeJob`(하루)이 지운다. 비밀번호 · 토큰 · 쿠키 값은 어디에도 넣지 않는다
- 브라우저 푸시(push_subscriptions, `PushSubscription`): 구독은 알려진 푸시 서비스의 https 주소만 (`MOIDA_PUSH_EXTRA_ORIGINS`는 시험 · 직접 운영하는 서비스). `api/push`(키 · 구독 · 끄기 · 보내 보기, 주인만).
  보내기는 `NoticePushJob`(마감 작업, 리팩토링 2단계: `Notices.post` · 알림 설정 저장이 `Notices.PUSH_JOB`을 깨우고, 남은 알림은 조용한 시간이 끝날 때 · 다음 묶음 시각(`NoticePolicy.nextAt`)에 다시 본다): 짧은 트랜잭션에서 공간의 안 다룬 알림을 `SKIP LOCKED`로 잠그고 `NoticePolicy`가 정한 뒤 `push_sent_at`을 적고, 트랜잭션 밖에서 `PushGateway`가 보낸다 → 결과를 적는다(404 · 410이나 다섯 번 실패면 구독을 지움). 암호화 · VAPID는 `base/web-push.ts`(`WebPush`), 키는 서버 키에서 (`derive('web-push-vapid')`)

## 공개 API (`index.ts`)
- 기반 클래스: `BaseService` · `EntityService` · `BaseQuery` · `BaseRepository` · `TableRepository` · `BaseEntity` · `TableEntity` · `BaseRequest`(+`RequestFields` · `VersionInput`) · `BaseGateway` · `BaseTool`
- 코어의 쿼리 도구 (`base/table-query.ts`, 2026-11-08): 조건 규칙(`Rule`)으로 표 하나를 읽고 쓴다. `TableReader`(`rows` · `row` · `exists` · `pageOf`)는 `BaseQuery`가, `TableWriter`(+ `insertRows` · `updateRows` · `deleteRows`)는 `BaseRepository`가 상속한다. 같은 모양은 한 번만 SQL로 만들어 기억한다. 그 기능만의 쿼리는 각 모듈이 `this.sql`로. 모듈은 `drizzle-orm`을 직접 가져오지 않는다
- 기능 패키지: 동작(`Operation` · `Read` · `Command`, `Work`), 입구(`PackageController` · `PackageService` · `PackageTool`), 패키지의 생성된 표가 쓰는 `TableColumns` (객체설계 12장). 임대 확인 `Leases` · `LeasedWork`(플러그인 API 0.3, 대상 0.4, 지시 0.5, 관리자 지시 `ownerText` 0.7. 0.8은 `Actor.runTask` · 결과의 `outcome: continue`): 일을 빌려 주는 모듈이 확인하는 길을 등록하고 패키지는 `work.leased(id)`로 묻는다 (platform은 누가 등록하는지 모른다). 실행 기록의 자리 `Leases.forRecord` · `RunRecordTarget`(2026-11-17): 일을 빌려 주는 모듈(task)이 `registerRecord`로 등록하고, 작업 세션을 쌓는 모듈(vault)이 "이 러너가 기록을 올릴 수 있는 작업인가, 몇 번째 실행 · 세션 키 · 작업 세션 키 · 제목 · 에이전트"를 묻는다 (잡은 러너 · 진행 중이거나 기다리는 중 · 점유 시간이 남음)
- `Database`, `Sql`·`Row`(라이브러리 타입 별칭), `Actor`와 `OwnerActor`·`DeviceActor`·`AgentActor`·`ApprovedActor`·`SystemActor`·`VisitorActor`·`MemberActor`(커뮤니티 회원, 스토어 3-1: 앱 하나, 권한 · 공간 없음, `MemberActor.require`는 아니면 401).
  권한은 `assertCan(권한)`(기기·에이전트가 받은 권한. `Actor.AGENT_OUT`은 받은 권한이 아니라 작업 토큰이면 통과: 2026-11-21부터 모든 에이전트가 비공개를 읽는 같은 일꾼이라 가르지 않는다), 관리 일은 종류로 묻는다: `assertOwner()`(주인만), `assertOwnerOrSystem()`(주인과 명령줄·일꾼: 플러그인, 서버 키 교체, 복원).
  `runTask()`: 작업 토큰이면 그 작업의 id, 아니면 null (플러그인 API 0.8, 2026-11-21: 에이전트가 부른 패키지 도구를 지금 일에 묶는다, browser-tabs의 `browser_press`). `mayRead(id)` · `hasReadGrants()`: 작업 토큰에 함께 봉인한 id 하나씩의 읽기 허락 (`AgentActor`의 `reads`). 권한이 아니라 id로 하나를 읽을 때만 본다 (무엇의 id인지는 모른다)
- 같은 트랜잭션에 들어가는 것: `Outbox`(이벤트, 변경 신호, 일꾼 깨우기. `wake(이름)`: 이벤트 없이 마감을 바꾸는 쓰기가 그 마감 작업을 깨운다 (신호 `due:<이름>`). `Outbox.listen`: 이벤트를 쓰기 전에 같은 트랜잭션에서 부르는 듣는 쪽, 지금은 알림과 account의 보안 기록 둘), `ChangeSignal`(내용 없는 신호), `Idempotency`(같은 request_id는 한 번만), `Notices`(콘솔 알림, 변경 신호 `platform.notification`), `SecurityLog`(보안 기록, 2026-11-15)
- `Trace` (리팩토링 R1): 지금 하는 일의 추적 번호 (`AsyncLocalStorage`). `HttpSetup`이 본문을 읽은 뒤 요청 번호 안에서 다음 단계를 부르고, `Outbox.publish`가 `trace_id`에 적고, 일꾼이 그 번호 안에서 받는 쪽을 부른다 (반복 · 마감 작업은 실행마다 새 번호). 추적 번호 하나에만 쓴다
- `HostGate` (스토어 3-0): 요청이 기본 도메인으로 왔는지 앱 도메인으로 왔는지 가른다. 무엇이 도메인을 갖는지 모른다: 모듈이 시작할 때 `registerApps(도메인 → 앱 id 읽기)`(blog) · `registerSite(사이트 주소 읽기)`(account) · `openPaths(경로, writes)`(blog: GET 셋, community: 회원 API를 쓰기까지, 스토어 3-1)로 등록한다. `HttpSetup`이 본문 읽기 전에 거는 미들웨어가 `Host` · `X-Forwarded-Host` 가운데 하나라도 앱 도메인이면 `request.appHost` · `appId`를 적고, 등록한 경로가 아니면 404 `not_found`로 답한다. 관리자 쿠키 · 토큰은 보지 않는다 (`ActorGuard`, 회원은 community의 `MemberGuard`). 사이트 주소의 호스트는 앱 도메인으로 치지 않는다 (콘솔이 잠기지 않게). 목록은 30초 기억하고, 바꾼 모듈이 `stale()`로 바로 다시 읽게 한다. `siteOrigin` · `siteHost`: 기본 도메인 (blog가 도메인 규칙 · 화면 주소에 쓴다). 기본 도메인으로 온 요청에는 `request.siteSpaceId`(기본 도메인의 공간, account가 사이트 주소와 함께 등록)를 적는다 (community의 스토어 가입, 2026-11-26). `normalize`: 머리글의 호스트(첫 값 · 소문자 · 포트와 끝의 점 빼기).
  공통 앱 도메인 (2026-11-27, `MOIDA_APPS_URL`, `appsHost()` · `appsOrigin()`): 그 호스트로 온 요청은 앱 도메인처럼 등록한 경로만 지나고 `request.appsDomain = true` · `siteSpaceId`를 적는다. 앱은 웹이 경로의 첫 칸에서 읽어 붙인 `x-moida-app`(앱 주소)으로 고른다 (`registerApps`의 읽기가 `slugs`도 돌려준다). 머리글이 없거나 모르는 앱이면 `appId`가 없다 (회원 API는 404, 스토어 가입 · 공통 약관은 열림). 머리글을 바꿔 보내도 같은 도메인의 다른 공개 앱을 고를 뿐이다. 기능 패키지의 입구(`/api/p/<패키지>/…`)는 platform이 앱 도메인 · 공통 앱 도메인에도 연다 (2026-11-28, `PlatformModule.PACKAGE_PATHS`: 앱 보기의 메일 구독이 "없는 주소예요"로 막히던 것). 앱 도메인의 요청은 늘 방문자라 지나가는 것은 `Operation.ANYONE` 동작뿐이다
- `HttpSetup` · `RequestTrace` (리팩토링 6단계): 서버와 시험이 같은 HTTP 설정(`MoidaApp.api`가 건다). 맨 앞에서 요청 번호(UUIDv7, 들어온 `X-Request-Id`는 믿지 않음)를 붙여 응답 머리글로 돌려주고, 응답이 끝나거나 끊길 때 한 줄을 남긴다 (번호 · 메서드 · 쿼리 없는 경로 · 상태 · 걸린 시간 · 요청자 종류 · MCP 도구, 건강 확인의 2xx와 러너가 몇 초마다 되풀이해 묻는 도구(`BaseTool.polled`: `next_jobs`, 기능 패키지는 목록 파일 도구의 `"polled": true`)의 성공은 빼고, 5xx는 오류 등급. 2026-11-26). 본문은 JSON 512KB, 그대로(Buffer) 받는 본문은 그림(`…/assets` · `logo` · `icon`, 10MB)과 zip(`…/code/versions`, 20MB, 스토어 1-6 앱 코드)뿐이다. 알 수 없는 오류는 `DomainErrorFilter`가 `RequestTrace.fail`로 스택을 번호와 함께 남기고 500 `internal` + 번호로 답한다. MCP 입구는 `McpEndpoint.handle`의 `McpTrace`(부른 것 · 알 수 없는 오류)로 같은 로그에 잇는다
- `ChangeStream`: Postgres LISTEN 연결 하나(`Listener`)로 변경 신호를 나눠 준다. SSE와 긴 폴링이 쓴다. 신호는 깨우기용이고 내용은 늘 테이블에 있다
- `SecretRotation`: 서버 키 교체. 비밀값을 가진 모듈이 `register`로 다시 잠그는 방법을 등록
- `SensitivePolicy` · `Redaction`: AI가 보낸 글이 판이 되기 전에 비밀값(토큰 · 키 · 비밀번호 값)을 `[지움: 종류]`로 바꾼다. 모양만 보고, 어느 칸을 지울지는 쓰는 모듈이 정한다 (vault 세션 · wiki, blog 초안). `scrub(칸, 글, personal)`의 personal이면 개인정보(전화번호 · 이메일 · Luhn이 맞는 카드 번호 · 주민등록번호)도 마스킹한다: 에이전트 실행의 기록(vault 작업 세션)에만 켠다 (2026-11-17, 사람이 쓴 글의 연락처까지 지우지 않게)
- `NoticeCatalog` · `NoticeKind`: 알림 종류 등록 (7단계). 등급은 `NoticeKind.IMMEDIATE` · `DIGEST` · `LOG`
- `CoreWorkers`: 코어 모듈의 이벤트 받기 · 반복 작업 · 마감 작업 등록 (`on`, `every`, `due`, `expect`). 마감 작업은 `BaseDueJob`(다음에 깰 시각을 돌려준다, 리팩토링 2단계): 일꾼은 쉬는 동안 DB를 조회하지 않고 신호와 마감 타이머(`WorkScheduler`)로만 깬다. 들을 때마다(처음 · 끊겼다 다시) outbox와 모든 마감 작업을 한 번씩 돈다
- `ArchiveQuery`: 보관 형식 파일 묶음. 내용을 가진 모듈이 `onModuleInit`에서 `register`로 자기 파일을, `registerRestore`로 복원을 등록한다
- `EventCatalog` (리팩토링 R3c): 이벤트 목록. 모듈마다 `<모듈>.events.json`(주제 → `fields`(`이름?`은 없어도 됨) · 다른 곳이 내면 `from`)을 `onModuleInit` 첫 줄에서 `define`한다. `Outbox.publish`가 내보내기 전에 `check`(모르는 주제는 오류, 칸이 다르면 개발 · 시험은 오류 · 운영은 경고), `PlatformModule.onApplicationBootstrap`이 `CoreWorkers.patterns()`와 알림 종류의 주제를 `unknownPatterns`로 보고 틀리면 시작하지 않는다. 시험이 자기만의 주제를 내려면 그 모듈 이름으로 `define`한다 (`task.probe.*`). 경계 검사(8)가 주제의 모듈 이름 · `from` · 플러그인 목록 파일의 `event:` 무늬를 맞춘다
- `Lookups` (리팩토링 R3b): 모듈 사이 읽기. 가진 모듈이 종류마다 한 번 `provide(종류, (actor, ids) => 볼 수 있는 것의 id → 제목)`, 묻는 모듈은 `visible` · `assertVisible(종류, actor, ids, 없을 때 문구)`. platform은 무엇의 id인지 모른다. 지금은 vault의 `wiki` · `session`을 blog가 묻는다. `modules.json`의 lookups(provides · asks)와 코드를 경계 검사가 맞춰 본다
- `PluginChats` · `ChatSent` (플러그인 API 0.10, 2026-11-23): 기능 패키지의 대화 입구. 대화를 가진 모듈(task)이 보내기를 한 번 `register`하고, `PackageService`가 `uses`에 `chat`이 있는 패키지의 쓰기 동작에만 같은 트랜잭션에 묶어 `work.sendChat`으로 준다 (platform은 대화가 무엇인지 모른다). 결재는 이 길로 하지 못한다
- 모듈 사이를 잇는 등록부(`Lookups` · `ActionChecks` · `Leases` · `PluginChats` · `SettingKinds` · `HostGate`)는 누가 주고 누가 묻는지 `modules.json`의 `lookups` · `registries`에 적고 경계 검사가 코드와 맞춰 본다 (2026-11-19, 객체설계 9장). 새 등록부는 `scripts/module-links.mjs`의 `REGISTRIES`에 메서드를 적는다
- 코어 스키마 목록 `Database.MODULE_SCHEMAS`: 상태 확인의 표 수 · 기능 패키지가 못 쓰는 이름. 서버 이미지에 `modules.json`이 없어 여기 두고 경계 검사가 맞춰 본다
- `SettingKinds` · `SettingKind` · `SettingShape` (`setting/`, 2026-11-15 D): 대화로 바꾸는 설정의 등록부. 설정을 가진 모듈이 시작할 때(`<모듈>-settings.ts`) 설정 하나를 `register`한다: 모양(`<X>Edit.SETTING`: 동작 · 칸 · 대상 id · one · name · version 여부 · 굵은 칸 · 펼칠 목록형 칸)과 읽기(`read` · `current`) · 미리 해 보기(`rehearse`) · 적용(`apply`), 필요하면 `normalize` · `bodyOf` · `labelOf`. task가 `get_settings` · `propose_setting` · 승인 뒤 적용(`SettingApplyHandler`)에서 찾는다. 읽기 · 미리 해 보기는 `SettingActor`(task가 제안자를 확인한 뒤 만든다, 모듈은 첫 줄에서 `SettingActor.spaceOf`), 적용은 `ApprovedActor`(`SettingOutcome.spaceOf`). `SettingChangeInput`: 제안과 승인 이벤트가 같은 모양 (version 없는 설정은 `assertUnchanged`로 제안 때 본 값과 비교). `SettingOutcome.settle`: 결재마다 한 번 적용하고 `<모듈>.setting.changed`를 남긴다 (`topicOf`). platform이 등록하는 것: 알림 설정(`NoticeSettingsEdit`), 플러그인 설정(`PluginEdit`, 켜진 것의 비밀이 아닌 칸만, 줄은 모두 굵게) — `PlatformSettings`
- `ActionChecks` · `ActionTarget`: 결과 카드에 싣기 전에 결재 동작의 대상을 가진 모듈이 "빠진 점"을 짚는 길 (2차 6단계). 동작마다 한 번 `register(action, (actor, targetId) => 문구 | null)`, task가 `problemsOf`로 묻고 받을 것이 정해진 대화면 다시 맡긴다
- `LibraryQuery` · `LibraryInput` · `LibraryRow`: 보관함 (2차 5단계, `api/library`, 주인만). 종류를 가진 모듈이 `onModuleInit`에서 `register(종류들, (actor, filter) => 행들)`로 자기 읽기를 등록하고(같은 종류를 두 번 등록하면 오류), platform은 종류를 모르는 채 시간 · id 내림차순으로 합쳐 30개씩 자른다. 줄의 `place` · `placeId`는 놓인 곳(블로그 메뉴)이다. 모듈의 읽기는 `BaseQuery.libraryWindow`로 같은 기간 · 커서 조건을 쓴다
- `LibraryTrashService` · `TrashLibraryInput`: 보관함 일괄 지우기 (2026-11-23, `POST api/library/trash`, 주인만, 100개까지). 종류를 가진 모듈이 `onModuleInit`에서 `register(종류들, (actor, ids) => 지운 수)`로 자기 지우기를 등록한다 (글 · 위키 · 세션 · 결과물은 휴지통, 스크랩은 바로 지움). 등록하지 않은 종류(페이지)는 `skipped`로 돌려준다. 같은 줄은 한 번만 넘기고, 이미 휴지통에 있으면 세지 않는다
- `ArchiveRestoreService`: 빈 Moida에 복원 (`preview` · `apply`). GitHub와 zip이 같은 길이다. 주인과 `SystemActor`만 부른다. `steadyRead`: 복원과 겹치지 않게 읽기
- `ArchivePart`(모듈의 복원 몫), `ArchiveRecord`(보관 파일의 앞부분·항목 읽기), `ArchiveBlob`, `ArchiveReport`(개수와 알림)
- `BlobStore`: 내용 주소 파일 저장소 (`Blob`). 트랜잭션 밖에서 부른다. 큰 파일은 `saveStream`(받으며 크기 · 해시를 세고 한도 · 해시가 틀리면 아무것도 남기지 않음), 디스크 여유는 `freeBytes`
  - 지우기: 모듈은 파일을 값으로만 가리켜 DB가 지켜 주지 않는다. 파일을 가리키는 칸을 가진 모듈은 `onModuleInit`에서 `registerUse([칸], (actor, hashes) => 쓰는 해시)`로 등록하고, `BlobSweepJob`(6시간마다)이 아무도 쓰지 않는 7일 지난 파일만 지운다. 같은 해시의 저장 · 지우기는 advisory 잠금으로 겹치지 않고, 다시 저장하면 `created_at`이 새로 된다. `blob-sweep.api.test`가 DB의 `*blob_hash` 칸이 모두 등록됐는지 본다
- `FileSniff`: 파일 앞부분으로 형식 알아보기 (blog의 사진, task의 결과물)
- `ZipFile`: 라이브러리 없이 zip 만들기 (node:zlib). 앱에 올릴 스킬 묶음, 보관 형식 내보내기
- `ZipReader` · `ZipLimits`: 믿을 수 없는 zip 읽기. 개수·크기 한도, 위험한 이름 거절, CRC 검사. 넘치면 `TooLarge`
- 오류: `DomainError`와 단계별 하위 클래스, `DomainEvent`, `CurrentActor`(Controller 인자 데코레이터)

## DB 연결
- 프로세스(server · worker · 명령줄)마다 풀 하나, 최대 10개 (`Database`). LISTEN은 듣기마다 전용 연결 하나(`Listener`, server의 `ChangeStream`, worker의 outbox). 끊기면 1 · 2 · 4 … 30초 간격으로 될 때까지 다시 듣고 그때마다 `onReady`로 놓친 것을 메운다 (라이브러리의 `sql.listen`은 한 번만 다시 시도하고 실패를 삼켜 쓰지 않는다). web · runner는 DB에 닿지 않는다
- 연결마다 시간 제한 (`Database.LIMITS`): 잠금 대기 5초, 쿼리 30초, 트랜잭션을 연 채 쉬기 60초. 앞의 둘은 입구(REST 필터 · MCP)에서 `Busy`(503 `busy`)가 되고 러너는 busy면 같은 요청을 다시 보낸다. 쉬다 끊긴 트랜잭션은 우리 코드의 버그라 500으로 둔다
- 시간 제한 없는 트랜잭션(`unlimitedTransaction`)은 복원 쓰기와 `steadyRead` 두 곳만. 새로 쓰기 전에 일을 나눌 수 있는지 먼저 본다
- 트랜잭션은 짧게: 안에서 외부 호출 · AI 응답 · 파일 저장(`BlobStore`)을 기다리지 않는다. 긴 폴링 · SSE는 트랜잭션 밖에서 LISTEN 신호로 기다린다
- 일 빌리기는 `SKIP LOCKED`, 잠그는 순서는 모듈 규칙대로 (task: 작업 → 결재 → 에이전트), 줄이 없을 수도 있는 자리는 advisory 잠금(`pg_advisory_xact_lock`, 트랜잭션이 끝나면 풀림)

## 내보내는 이벤트 / 받는 이벤트
칸의 원본은 `platform.events.json` (모듈마다 같다: 아래 표 · 목록은 뜻을 적고, 칸은 그 파일이 정한다).

`platform.setting.changed { approvalId, outcome, error? }` (승인한 알림 · 플러그인 설정 바꾸기의 결과, 2026-11-15 D. task의 `ApprovalResultHandler`가 결재를 끝낸다), `platform.notice.sent { title, body, link, tag }` (`NoticePushService`가 푸시로 보내기로 정한 것 가운데 종류의 메일이 켜진 것(`PushPlan.mails`)마다 같은 트랜잭션에 남긴다. 브라우저 구독이 없어도. 플러그인 `email`이 받아 메일로, 2026-11-26) / 없음. 대신 `Outbox.listen`으로 모든 이벤트를 쓰는 트랜잭션 안에서 보고, 모듈이 등록한 종류의 알림을 남긴다 (`NoticeCatalog.onEvents`)

## 써도 되는 모듈
없음. platform은 다른 모듈을 모른다.

## 지켜야 할 것
- 외부 라이브러리는 `base/` 안에서만 가져온다. 새 라이브러리는 docs/객체설계.md 10장 순서로 제안하고 승인받은 뒤 넣는다
- 기반 클래스는 얇게: 모든 하위 클래스가 똑같이 하는 일만 넣는다
- 기반 클래스의 동작을 바꾸면 `base/base.test.ts`에 테스트를 더한다
- 같은 트랜잭션에 들어가야 하는 기능(outbox 등)은 호출한 쪽의 `Sql`(트랜잭션)을 받는 클래스로 만든다
- 쿠키는 `Cookies`로만 쓴다: 늘 HttpOnly · SameSite=Lax, Secure는 요청이 https(앞단 프록시의 X-Forwarded-Proto, trust proxy)이거나 `MOIDA_WEB_URL`이 https면 (웹 보안 S2). 개발(http://localhost)에서는 붙이지 않는다. 그때(https)는 이름도 `__Host-<이름>`이다 (3-5, 2026-11-27: 공통 앱 도메인 같은 하위 도메인이 Domain=<사이트>로 같은 이름을 심어 덮지 못하게). 읽기는 `__Host-` 이름을 먼저, https면 그것만. 모듈은 앞머리 없는 이름(`moida_session` 등)만 안다
- 복원은 모듈을 한 트랜잭션에 묶는 유일한 곳이다: 실패하면 Moida이 비어 있는 채로 남아야 해서다. `ArchiveRestoreService`가 트랜잭션을 열고 모듈은 자기 스키마에만 쓴다. 이벤트는 남기지 않는다
- 복원의 잠금은 두 가지다: 복원끼리와 `steadyRead`는 advisory 잠금, 빈 곳 확인은 모듈이 표를 잠근다 (`ArchivePart.existing`)
- 푸시는 트랜잭션 밖에서 보낸다. 보내기 전에 다룬 것으로 적는다 (많아야 한 번: 두 번 울리는 것보다 빠지는 것이 낫고, 알림 센터에는 남는다)
- 푸시 주소는 알려진 서비스만 받는다: 아무 주소나 받으면 서버가 주인 대신 내부망에 요청하는 길이 된다

## 하지 말 것
- 다른 모듈 import
- 특정 모듈에만 필요한 기능을 기반 클래스에 넣기
- 기반 클래스를 거치지 않고 다른 모듈이 라이브러리를 쓰게 내보내기
