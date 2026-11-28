import { Module, type OnModuleInit } from '@nestjs/common';
import {
  BlobStore,
  CoreWorkers,
  EventCatalog,
  Leases,
  LibraryQuery,
  LibraryTrashService,
  PluginChats,
  SecretRotation,
} from '../platform';
import { AgentController } from './agent/agent.api';
import { AgentQuery } from './agent/agent.query';
import { AgentService } from './agent/agent.service';
import { AiLoginController } from './ai/ai-login.api';
import { AiLoginQuery } from './ai/ai-login.query';
import { AiLoginService } from './ai/ai-login.service';
import { ApiConnectorController } from './api-connector/api-connector.api';
import { ApprovalController } from './approval/approval.api';
import { ApprovalQuery } from './approval/approval.query';
import { ApprovalService } from './approval/approval.service';
import { ApprovalResultHandler } from './approval/approval-result.handler';
import { DecisionLapseJob } from './approval/decision-lapse.job';
import { AppCodeCardHandler } from './chat/app-code-card.handler';
import { ChatController } from './chat/chat.api';
import { ChatQuery } from './chat/chat.query';
import { ChatService } from './chat/chat.service';
import { ChatCardHandler } from './chat/chat-card.handler';
import { ChatContinueHandler } from './chat/chat-continue.handler';
import { ChatInspectHandler } from './chat/chat-inspect.handler';
import { ChatInspectService } from './chat/chat-inspect.service';
import { ChatPublishService } from './chat/chat-publish.service';
import { ChatResultHandler } from './chat/chat-result.handler';
import { ChatResultService } from './chat/chat-result.service';
import { ChatTalk } from './chat/chat-talk';
import { ChatUpdateHandler } from './chat/chat-update.handler';
import { ChatUpdateQuery } from './chat/chat-update.query';
import { ChatUpdateService } from './chat/chat-update.service';
import { ExternalToolController } from './external-tool/external-tool.api';
import { ExternalToolQuery } from './external-tool/external-tool.query';
import { ExternalToolService } from './external-tool/external-tool.service';
import { ExternalToolCheckJob } from './external-tool/external-tool-check.job';
import { ExternalToolCheckService } from './external-tool/external-tool-check.service';
import { ExternalToolOAuthController } from './external-tool/external-tool-oauth.api';
import { ExternalToolOAuthService } from './external-tool/external-tool-oauth.service';
import { ExternalToolPlugHandler } from './external-tool/external-tool-plug.handler';
import { ExternalToolRefreshJob } from './external-tool/external-tool-refresh.job';
import { ExternalToolTaskHandler } from './external-tool/external-tool-task.handler';
import { OAuthGateway } from './external-tool/oauth.gateway';
import { GoalController } from './goal/goal.api';
import { GoalQuery } from './goal/goal.query';
import { GoalService } from './goal/goal.service';
import { GoalRunController } from './goal-run/goal-run.api';
import { GoalRunHandler } from './goal-run/goal-run.handler';
import { GoalRunQuery } from './goal-run/goal-run.query';
import { GoalRunService } from './goal-run/goal-run.service';
import { InboxQuery } from './inbox/inbox.query';
import { OutputController } from './output/output.api';
import { OutputPolicy } from './output/output.policy';
import { OutputQuery } from './output/output.query';
import { OutputService } from './output/output.service';
import { OutputPurgeJob } from './output/output-purge.job';
import { OutputShareController } from './output-share/output-share.api';
import { OutputShareQuery } from './output-share/output-share.query';
import { OutputShareService } from './output-share/output-share.service';
import { RuleController } from './rule/rule.api';
import { RunnerController } from './runner/runner.api';
import { RunnerQuery } from './runner/runner.query';
import { RunnerService } from './runner/runner.service';
import { ScheduleController } from './schedule/schedule.api';
import { ScheduleJob } from './schedule/schedule.job';
import { ScheduleQuery } from './schedule/schedule.query';
import { ScheduleService } from './schedule/schedule.service';
import { ScheduleFollowHandler } from './schedule/schedule-follow.handler';
import { SettingApplyHandler } from './setting-change/setting-apply.handler';
import { SettingQuery } from './setting-change/setting-change.query';
import { SettingChangeService } from './setting-change/setting-change.service';
import { RepoSkillGateway } from './skill/repo-skill.gateway';
import { SkillController } from './skill/skill.api';
import { SkillQuery } from './skill/skill.query';
import { SkillService } from './skill/skill.service';
import { AgentlessService } from './task/agentless.service';
import { AgentlessRequestHandler } from './task/agentless-request.handler';
import { JobService } from './task/job.service';
import { LeadTalkService } from './task/lead-talk.service';
import { LeaseJob } from './task/lease.job';
import { SubtaskService } from './task/subtask.service';
import { SubtaskSettledHandler } from './task/subtask-settled.handler';
import { SubtaskWaitJob } from './task/subtask-wait.job';
import { Task } from './task/task';
import { TaskController } from './task/task.api';
import { TaskQuery } from './task/task.query';
import { TaskService } from './task/task.service';
import { TaskRequestedHandler } from './task/task-requested.handler';
import { TaskTrashService } from './task/task-trash.service';
import events from './task.events.json';
import { TaskConnectors } from './task-connectors';
import { TaskNotices } from './task-notices';
import { TaskRules } from './task-rules';
import { TaskSettings } from './task-settings';
import { TaskTools } from './task-tools';
import { UsageController } from './usage/usage.api';
import { UsageQuery } from './usage/usage.query';
import { VerdictHandler } from './verdict/verdict.handler';
import { VerdictService } from './verdict/verdict.service';
import { LinkPreviewController } from './web/link-preview.api';
import { LinkPreviewQuery } from './web/link-preview.query';
import { WebQuery } from './web/web.query';
import { WebPageGateway } from './web/web-page.gateway';

// 에이전트가 일하고 주인이 결재하는 구조: 에이전트(조직도 · 하트비트), 목표, 작업(실행 기록 · 위임), 결재. platform에만 의존한다.
// 결재 뒤 실행은 대상을 가진 모듈이 이벤트로 한다. task.approval.granted를 받는 모듈이 expect도 적는다 (지금은 blog).
@Module({
  providers: [
    TaskNotices,
    TaskSettings,
    AgentQuery,
    AgentService,
    TaskQuery,
    TaskService,
    TaskTrashService,
    LeadTalkService,
    JobService,
    ApprovalQuery,
    ApprovalService,
    UsageQuery,
    GoalQuery,
    GoalService,
    ScheduleQuery,
    ScheduleService,
    ScheduleJob,
    RunnerQuery,
    RunnerService,
    AiLoginQuery,
    AiLoginService,
    TaskTools,
    ...TaskTools.PROVIDERS,
    TaskRequestedHandler,
    AgentlessRequestHandler,
    AgentlessService,
    InboxQuery,
    SubtaskSettledHandler,
    SubtaskService,
    ApprovalResultHandler,
    LeaseJob,
    SubtaskWaitJob,
    DecisionLapseJob,
    // 저장소 skills/의 러너 스킬 (서버 이미지에 함께 든 판). 처음 한 번 읽는다
    { provide: RepoSkillGateway, useFactory: () => RepoSkillGateway.fromEnv() },
    SkillQuery,
    SkillService,
    // 결과물의 공간 한도 · 디스크 여유 (MOIDA_OUTPUTS_MAX_GB · MOIDA_DISK_RESERVE_GB)
    { provide: OutputPolicy, useFactory: () => OutputPolicy.fromEnv() },
    OutputQuery,
    OutputService,
    OutputShareQuery,
    OutputShareService,
    // 목표 실행: 회차 루프와 결재 (GoalRunHandler가 회차 끝 · 결재를 받는다)
    GoalRunQuery,
    GoalRunService,
    ChatQuery,
    ChatService,
    // 대화의 소식 (2차 1-1): 끝난 작업 → 소식(ChatUpdateHandler), agent_updates · post_update
    ChatUpdateService,
    ChatPublishService,
    ChatUpdateQuery,
    ChatUpdateHandler,
    // 결과 결재 (2차 2단계): 가라앉은 회차 → 검사 · 검토 · 결과 카드, 카드의 수정 요청 · 반려 → 멈추고 다음 회차
    ChatResultService,
    ChatResultHandler,
    // 검수 (2026-11-20): 끝난 검수 작업 → 결재에 검수의 결정 (통과면 검수자가 승인)
    ChatInspectService,
    ChatInspectHandler,
    ChatCardHandler,
    // 평가가 남는 팀 (2026-11-20): 끝난 검토 · 검수 작업 → 판정을 점수와 함께 쌓는다 (성적표)
    VerdictService,
    VerdictHandler,
    // 대화의 만들기 일이 낸 앱 코드의 확인 대기 버전 → 결과 카드의 공개 승인 (스토어 1-6b)
    AppCodeCardHandler,
    // 승인 뒤 이어서 (O-2): 대표가 continue로 올린 설정 바꾸기가 적용되어 끝난 회차 → 같은 대화의 다음 회차
    ChatContinueHandler,
    GoalRunHandler,
    // 주소 읽기 (read_url): 서버가 AI 대신 연다. 목줄은 WebReach
    WebPageGateway,
    WebQuery,
    LinkPreviewQuery,
    OutputPurgeJob,
    // 자동화 레시피 (2차 5단계): 레시피의 일이 끝나면 그 뒤의 레시피 (계기 after)
    ScheduleFollowHandler,
    // 외부 도구 꽂기 (2차 7단계)
    ExternalToolService,
    ExternalToolQuery,
    ExternalToolPlugHandler,
    // MCP 먼저 1단계 (2026-11-15): 커넥터 확인 · 사용 기록
    ExternalToolCheckService,
    ExternalToolTaskHandler,
    ExternalToolCheckJob,
    // C1 OAuth 커넥터 (2026-11-21): 서버가 연 로그인 · 토큰 잠금 · 갱신. 바깥 호출은 OAuthGateway 하나
    OAuthGateway,
    ExternalToolOAuthService,
    ExternalToolRefreshJob,
    // 설정 바꾸기 제안 (2026-11-15 C · D): 미리 해 보고 결재로, 승인 뒤 그 설정을 가진 모듈이 적용 (platform SettingKinds)
    SettingQuery,
    SettingChangeService,
    SettingApplyHandler,
    // API 커넥터 · 도구 찾기 (2026-11-24): 정의서 · 서버가 부르기 · 레지스트리 찾기. 목록과 잇기는 TaskConnectors
    ...TaskConnectors.PROVIDERS,
    // 피드백에서 배우기 (2026-11-20) · 배운 규칙과 도움 · 해로움 세기 (2026-11-28). 잇기는 TaskRules
    ...TaskRules.PROVIDERS,
  ],
  controllers: [
    AgentController,
    TaskController,
    ApprovalController,
    UsageController,
    AiLoginController,
    GoalController,
    ScheduleController,
    RunnerController,
    SkillController,
    OutputController,
    OutputShareController,
    GoalRunController,
    ChatController,
    ExternalToolController,
    ExternalToolOAuthController,
    ApiConnectorController,
    LinkPreviewController,
    RuleController,
  ],
  exports: [TaskTools, TaskQuery],
})
export class TaskModule implements OnModuleInit {
  /** 스케줄의 가장 작은 단위가 분이라 1분마다 본다 */

  constructor(
    private readonly workers: CoreWorkers,
    private readonly requested: TaskRequestedHandler,
    private readonly settled: SubtaskSettledHandler,
    private readonly chatUpdates: ChatUpdateHandler,
    private readonly results: ApprovalResultHandler,
    private readonly leases: LeaseJob,
    private readonly waits: SubtaskWaitJob,
    private readonly lapses: DecisionLapseJob,
    private readonly schedules: ScheduleJob,
    private readonly rotation: SecretRotation,
    private readonly logins: AiLoginService,
    private readonly outputPurge: OutputPurgeJob,
    private readonly blobs: BlobStore,
    private readonly outputs: OutputQuery,
    private readonly leaseChecks: Leases,
    private readonly pluginChats: PluginChats,
    private readonly tasks: TaskQuery,
    private readonly goalRuns: GoalRunHandler,
    private readonly chatResults: ChatResultHandler,
    private readonly chatInspections: ChatInspectHandler,
    private readonly verdicts: VerdictHandler,
    private readonly chatCards: ChatCardHandler,
    private readonly appCodeCards: AppCodeCardHandler,
    private readonly chatContinues: ChatContinueHandler,
    private readonly agentless: AgentlessRequestHandler,
    private readonly library: LibraryQuery,
    private readonly libraryTrash: LibraryTrashService,
    private readonly outputService: OutputService,
    private readonly follows: ScheduleFollowHandler,
    private readonly toolPlugs: ExternalToolPlugHandler,
    private readonly externalTools: ExternalToolService,
    private readonly settingApply: SettingApplyHandler,
    private readonly toolTasks: ExternalToolTaskHandler,
    private readonly toolChecks: ExternalToolCheckJob,
    private readonly toolRefresh: ExternalToolRefreshJob,
  ) {}

  onModuleInit(): void {
    EventCatalog.define('task', events);
    this.workers.on(Task.REQUESTED, this.requested);
    this.workers.on(AgentlessRequestHandler.TOPIC, this.agentless);
    this.workers.on(Task.CHANGED, this.settled);
    this.workers.on(Task.CHANGED, this.chatUpdates);
    this.workers.on(Task.CHANGED, this.goalRuns);
    for (const topic of GoalRunHandler.DECIDED) this.workers.on(topic, this.goalRuns);
    for (const topic of ChatResultHandler.TOPICS) this.workers.on(topic, this.chatResults);
    this.workers.on(Task.CHANGED, this.chatInspections);
    this.workers.on(Task.CHANGED, this.verdicts);
    for (const topic of ChatCardHandler.TOPICS) this.workers.on(topic, this.chatCards);
    this.workers.on(AppCodeCardHandler.TOPIC, this.appCodeCards);
    this.workers.on(Task.CHANGED, this.chatContinues);
    this.workers.on(Task.CHANGED, this.follows);
    for (const topic of ApprovalResultHandler.TOPICS) this.workers.on(topic, this.results);
    this.workers.due(this.leases, Task.CHANGED);
    this.workers.due(this.waits, Task.CHANGED);
    this.workers.due(this.lapses, DecisionLapseJob.TOPIC);
    this.workers.due(this.schedules);
    this.rotation.register('task.ai_logins', (actor) => this.logins.resealSecrets(actor));
    // 외부 도구 (2차 7단계): 제안의 결재가 정해지면 붙이거나 지우고, 서버 키를 바꾸면 토큰을 다시 잠근다
    for (const topic of ExternalToolPlugHandler.TOPICS) this.workers.on(topic, this.toolPlugs);
    // 설정 바꾸기 (2026-11-15 C · D): 승인되면 그 설정을 가진 모듈이 적용하고 결과(<모듈>.setting.changed)를 남긴다
    this.workers.on(SettingApplyHandler.TOPIC, this.settingApply);
    // MCP 먼저 (2026-11-15): 끝난 작업에서 커넥터 확인 결과 · 사용을 적고, 때가 된 커넥터에 확인을 맡긴다
    this.workers.on(Task.CHANGED, this.toolTasks);
    this.workers.due(this.toolChecks, Task.CHANGED);
    // C1 OAuth 커넥터: 끝나 가는 토큰을 갱신한다 (로그인 칸의 저장이 깨운다)
    this.workers.due(this.toolRefresh);
    this.rotation.register('task.external_tools', (actor) =>
      this.externalTools.resealSecrets(actor),
    );
    this.workers.due(this.outputPurge);
    // 기능 패키지의 도구(code-github의 code_credential 등)가 묻는 임대 확인
    this.leaseChecks.register((actor, id) => this.tasks.leasedWork(actor, id));
    this.leaseChecks.registerRecord((actor, id) => this.tasks.recordTarget(actor, id));
    // S2: 작업 세션의 요청이 끝났는지 (vault가 끝난 요청만 wiki로 정리한다)
    this.leaseChecks.registerSettled((actor, spaceId, id, card) =>
      this.tasks.settledFlow(actor, spaceId, id, card),
    );
    // 기능 패키지의 대화 입구 (플러그인 API 0.10, 텔레그램): 패키지의 트랜잭션에서 관리자의 대화에 말을 넣는다
    this.pluginChats.register((sql, spaceId, chatId, requestId, text) =>
      new ChatTalk(sql).fromPlugin(spaceId, chatId, requestId, text, new Date()),
    );
    // 결과물이 가리키는 파일: 쓰는 동안 platform이 지우지 않게
    this.blobs.registerUse(['task.outputs.blob_hash'], (actor, hashes) =>
      this.outputs.usedBlobs(actor, hashes),
    );
    // 보관함의 결과물 (2차 5단계)
    this.library.register([OutputQuery.LIBRARY_KIND], (a, f) => this.outputs.library(a, f));
    this.libraryTrash.register([OutputQuery.LIBRARY_KIND], (a, ids) =>
      this.outputService.trashMany(a, ids),
    );
  }
}
