import { resolve } from 'node:path';
import { Global, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ArchiveQuery } from './archive/archive.query';
import { ArchiveRestoreService } from './archive/archive-restore.service';
import { BlobStore } from './base/blob-store';
import { Database } from './base/database';
import { EventCatalog } from './base/event-catalog';
import { Outbox } from './base/outbox';
import { SecretBox } from './base/secret-box';
import { SecretRotation } from './base/secret-rotation';
import { SensitivePolicy } from './base/sensitive-policy';
import { ActionChecks } from './directory/action-checks';
import { Lookups } from './directory/lookups';
import { FailedEvent } from './failed-event/failed-event';
import { FailedEventController } from './failed-event/failed-event.api';
import { FailedEventQuery } from './failed-event/failed-event.query';
import { FailedEventService } from './failed-event/failed-event.service';
import { HealthController } from './health/health.api';
import { HealthQuery } from './health/health.query';
import { DomainErrorFilter } from './http/domain-error.filter';
import { HostGate } from './http/host-gate';
import { LibraryController } from './library/library.api';
import { LibraryQuery } from './library/library.query';
import { LibraryTrashService } from './library/library-trash.service';
import { NoticeCatalog } from './notice/notice-catalog';
import { NoticeKind } from './notice/notice-kind';
import { NoticePushJob } from './notice/notice-push.job';
import { NoticePushService } from './notice/notice-push.service';
import { NoticeSettingsController } from './notice/notice-settings.api';
import { NoticeSettingsQuery } from './notice/notice-settings.query';
import { NoticeSettingsService } from './notice/notice-settings.service';
import { NotificationController } from './notice/notification.api';
import { NotificationQuery } from './notice/notification.query';
import { NotificationService } from './notice/notification.service';
import { PushController } from './notice/push.api';
import { PushGateway } from './notice/push.gateway';
import { PushQuery } from './notice/push.query';
import { PushService } from './notice/push.service';
import events from './platform.events.json';
import { CodeMail } from './plugin/code-mail';
import { Leases } from './plugin/leases';
import { PackageController } from './plugin/package.api';
import { PackageService } from './plugin/package.service';
import { PluginController } from './plugin/plugin.api';
import { PluginQuery } from './plugin/plugin.query';
import { PluginService } from './plugin/plugin.service';
import { PluginChats } from './plugin/plugin-chats';
import { PluginRegistry } from './plugin/plugin-registry';
import { SecurityEventController } from './security/security-event.api';
import { SecurityEventQuery } from './security/security-event.query';
import { SecurityLogService } from './security/security-log.service';
import { SecurityLogPurgeJob } from './security/security-log-purge.job';
import { PlatformSettings } from './setting/platform-settings';
import { SettingKinds } from './setting/setting-kinds';
import { ChangeStream } from './stream/change-stream';
import { StreamController } from './stream/stream.api';
import { BlobSweepJob } from './worker/blob-sweep.job';
import { CoreWorkers } from './worker/core-workers';
import { OutboxWorker } from './worker/outbox-worker';

// 공통 기반. 비즈니스 규칙을 두지 않는다. 다른 모듈은 index.ts로만 가져다 쓴다.
@Global()
@Module({
  providers: [
    CodeMail,
    PackageService,
    Leases,
    PluginChats,
    Database,
    BlobStore,
    BlobSweepJob,
    HealthQuery,
    NotificationQuery,
    NotificationService,
    NoticeCatalog,
    NoticeSettingsQuery,
    NoticeSettingsService,
    PushGateway,
    PushQuery,
    PushService,
    NoticePushService,
    NoticePushJob,
    SecurityLogService,
    SecurityEventQuery,
    SecurityLogPurgeJob,
    FailedEventQuery,
    FailedEventService,
    PluginQuery,
    PluginService,
    { provide: SecretBox, useFactory: () => SecretBox.fromEnv(process.env) },
    SecretRotation,
    SensitivePolicy,
    ArchiveQuery,
    ArchiveRestoreService,
    LibraryQuery,
    LibraryTrashService,
    Lookups,
    HostGate,
    ActionChecks,
    SettingKinds,
    PlatformSettings,
    ChangeStream,
    CoreWorkers,
    OutboxWorker,
    {
      // 들어 있는 플러그인을 시작할 때 모두 읽고(목록 파일이 틀리면 서버가 뜨지 않음), 켜짐·설정은 DB에서
      provide: PluginRegistry,
      useFactory: (
        db: Database,
        archive: ArchiveQuery,
        box: SecretBox,
        restore: ArchiveRestoreService,
      ) =>
        PluginRegistry.boot(resolve(process.cwd(), '../../plugins'), db.sql, archive, box, restore),
      inject: [Database, ArchiveQuery, SecretBox, ArchiveRestoreService],
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  controllers: [
    HealthController,
    NotificationController,
    NoticeSettingsController,
    PushController,
    PluginController,
    PackageController,
    StreamController,
    LibraryController,
    SecurityEventController,
    FailedEventController,
  ],
  exports: [
    Database,
    BlobStore,
    SecretBox,
    SecretRotation,
    SensitivePolicy,
    PluginRegistry,
    CodeMail,
    PluginService,
    PackageService,
    Leases,
    PluginChats,
    ArchiveQuery,
    ArchiveRestoreService,
    LibraryQuery,
    LibraryTrashService,
    Lookups,
    HostGate,
    ActionChecks,
    SettingKinds,
    ChangeStream,
    CoreWorkers,
    OutboxWorker,
    NoticeCatalog,
    FailedEventQuery,
    FailedEventService,
  ],
})
export class PlatformModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly rotation: SecretRotation,
    private readonly plugins: PluginService,
    private readonly workers: CoreWorkers,
    private readonly sweep: BlobSweepJob,
    private readonly notices: NoticeCatalog,
    private readonly push: NoticePushJob,
    private readonly securityPurge: SecurityLogPurgeJob,
    private readonly gate: HostGate,
  ) {}

  onModuleInit(): void {
    EventCatalog.define('platform', events);
    // 모듈이 등록한 알림 종류로, 이벤트를 남기는 같은 트랜잭션에서 알림도 남긴다
    Outbox.listen('notices', (tx, events) => this.notices.onEvents(tx, events));
    // 일꾼이 8번 실패한 이벤트를 멈출 때 남기는 알림 (이벤트 없이, 리팩토링 R1)
    this.notices.define(new NoticeKind(FailedEvent.NOTICE, '처리 실패', NoticeKind.IMMEDIATE));
    this.rotation.register('플러그인 설정', (actor) => this.plugins.resealSecrets(actor));
    this.workers.every(this.sweep, BlobSweepJob.EVERY_MS);
    this.workers.due(this.push);
    this.workers.every(this.securityPurge, SecurityLogPurgeJob.EVERY_MS);
    // 기능 패키지의 입구(/api/p/…)는 앱 도메인 · 공통 앱 도메인에서도 연다 (2026-11-28: 앱 보기의 메일 구독이 "없는 주소예요"로
    // 막히던 것). 앱 도메인의 요청은 늘 방문자라(ActorGuard) 지나가는 것은 누구나 부르는 동작(Operation.ANYONE)뿐이다
    this.gate.openPaths([PlatformModule.PACKAGE_PATHS], true);
  }

  /** 기능 패키지의 입구 */
  static readonly PACKAGE_PATHS = /^\/api\/p\/[a-z0-9-]+\//;

  /** 모든 모듈이 등록을 마친 뒤: 듣는 무늬(받기 · 마감 작업 · 알림)가 이벤트 목록의 주제와 맞는지. 틀리면 서버가 뜨지 않는다 */
  onApplicationBootstrap(): void {
    const unknown = EventCatalog.unknownPatterns([
      ...this.workers.patterns(),
      ...this.notices.all().flatMap((kind) => kind.watched),
    ]);
    if (unknown.length > 0)
      throw new Error(
        `이벤트 목록(<모듈>.events.json)에 없는 주제를 들어요: ${unknown.join(', ')}`,
      );
  }
}
