import {
  BaseEntity,
  type ColumnRules,
  DomainEvent,
  Forbidden,
  RuleViolation,
  SettingKinds,
  TableEntity,
  type Unchecked,
} from '../../platform';
import type { Runner } from '../runner/runner';
import { JobTeamMemberView } from '../task/job.view';
import { type TaskKind, TaskKinds } from '../task/task-kinds';
import { AGENT_TOOL, type AgentNew, type AgentRevisionNew, type AgentRow } from '../task.tables';
import { AgentUsageView } from '../usage/usage.view';
import { AgentSavedView } from './agent.view';
import { AgentLead } from './agent-lead.policy';
import { type AgentRoleDef, AgentRoles } from './agent-roles';
import { AgentRuntime } from './agent-runtime.policy';
import { AgentScopes } from './agent-scopes.policy';

// 일을 맡는 에이전트. 할 수 있는 일(scopes)과 결재를 올려 할 수 있는 동작(approval_actions), 토큰 한도를 가진다.
// 주인이 정하는 칸은 RULES를 지나서만 바뀌고, 멈춤·다시 시작은 메서드로만 바뀐다.
// 한 달 한도는 넘기면 멈추고 결재를 받는다. 5시간 한도와 구독 사용률은 닿으면 새 일만 쉬고 시간이 지나면 저절로 돌아온다 (holds).
// 팀 없는 같은 일꾼 (2026-11-21): 보고 라인이 없고 권한은 모두 같다 (AgentScopes). 일꾼끼리는 맡기지 않는다.
// 대표(lead, O-2): 공간마다 숨은 하나. 모든 대화를 받아 일꾼 누구에게나 맡긴다 (AgentLead)
export class Agent extends TableEntity<AgentRow, AgentNew> {
  /** 이번 저장에서 쌓을 설정 판 */
  private pendingRevision: AgentRevisionNew | null = null;
  static readonly ACTIVE: AgentRow['status'] = 'active';
  static readonly PAUSED: AgentRow['status'] = 'paused';
  /** 에이전트에게 줄 수 있는 권한 (AgentScopes) */
  static readonly SCOPES: readonly string[] = AgentScopes.ALL;
  private static readonly NAME_MAX = 60;
  private static readonly ROLE_MAX = 2000;
  private static readonly PLAN_PERCENT_MAX = 100;
  private static readonly ACTION = /^[a-z]+\.[a-z_]+\.[a-z_]+$/;
  /** 이 동작은 서버가 한도를 넘었을 때만 올린다 */
  private static readonly SERVER_ACTION = 'task.agent.raise_limit';
  /** 새 에이전트의 처음 승인 동작: 모든 일꾼이 브라우저를 써서 사이트 클릭 · 로그인 승인을 올린다 (2026-11-21) */
  /**
   * 어느 에이전트나 올리는 결재 (2026-11-24 도구를 찾아 붙이기): 도구 붙이기 제안 · API 커넥터 · API 부르기,
   * 확인 필요 판단 (L3, post_update의 decision.confirm이 멈출 때 서버가 올린다).
   * 붙이고 부르는 것은 관리자의 승인이 정하므로 승인 동작 목록으로 막지 않는다 (API 커넥터 둘은 서버만 올린다, ApiApproval)
   */
  private static readonly ANY_ACTIONS: readonly string[] = [
    'task.tool.plug',
    'task.api.plug',
    'task.api.call',
    'task.decision',
  ];
  private static readonly BROWSE_ACTIONS: readonly string[] = [
    'browser.site.publish',
    'browser.site.login',
  ];

  /** 주인이 정하는 칸과 그 규칙 */
  private static readonly RULES: ColumnRules<AgentRow> = {
    name: (value) => {
      const name = value.trim();
      if (name.length < 1 || name.length > Agent.NAME_MAX)
        throw new RuleViolation(`이름은 1~${Agent.NAME_MAX}자예요`);
      return name;
    },
    role: (value) => {
      if (value.length > Agent.ROLE_MAX)
        throw new RuleViolation(`역할은 ${Agent.ROLE_MAX}자까지예요`);
      return value;
    },
    tool: (value) => AgentRuntime.tool(value),
    scopes: (value) => AgentScopes.check(value),
    approval_actions: (value) => {
      const wrong = value.filter((a) => !Agent.ACTION.test(a) || a === Agent.SERVER_ACTION);
      if (wrong.length > 0)
        throw new RuleViolation(`승인 요청으로 맡길 수 없는 동작이에요: ${wrong.join(', ')}`);
      return [...new Set(value)];
    },
    monthly_limit: (value) => Agent.atLeastOne(value, '한도'),
    five_hour_limit: (value) => Agent.atLeastOne(value, '5시간 한도'),
    plan_stop_percent: (value) => {
      if (value !== null && (value < 1 || value > Agent.PLAN_PERCENT_MAX))
        throw new RuleViolation(`구독 사용률은 1~${Agent.PLAN_PERCENT_MAX}%예요`);
      return value;
    },
    model: (value) => AgentRuntime.model(value),
    effort: (value) => AgentRuntime.effort(value),
    external_tools: (value) => AgentScopes.tools(value),
  };
  /** 설정 판에 남기는 칸: 주인이 정하는 것 전부 (규칙의 칸 + 러너. 상태 · 사용량 · 검토자는 빼고) */
  private static readonly SETTINGS: readonly (keyof AgentRow)[] = [
    ...(Object.keys(Agent.RULES) as (keyof AgentRow)[]),
    'runner_id',
  ];

  /** 새 에이전트의 빈 칸. 이 순서로 규칙을 지난다 (빈 도구는 규칙이 막는다) */
  private static readonly BLANK: Partial<Unchecked<AgentRow>> = {
    name: '',
    role: '',
    tool: '',
    scopes: [],
    approval_actions: Agent.BROWSE_ACTIONS,
    monthly_limit: null,
    five_hour_limit: null,
    plan_stop_percent: null,
    model: '',
    effort: '',
  };

  /** 새 에이전트. fields는 주인이 정한 칸이다 (권한은 늘 전부, AgentScopes) */
  static open(spaceId: string, fields: Partial<Unchecked<AgentRow>>, now: Date): Agent {
    const agent = new Agent(
      {
        id: BaseEntity.newId(),
        space_id: spaceId,
        name: '',
        // 자리만: 바로 아래 edit이 BLANK의 도구 칸부터 규칙으로 덮는다 (틀리면 저장 전에 RuleViolation)
        tool: AGENT_TOOL[0],
        status: Agent.ACTIVE,
        created_at: now,
        deleted_at: null,
      },
      true,
    );
    agent.edit({ ...Agent.BLANK, ...fields });
    agent.announce();
    return agent;
  }

  /** 공간의 대표 (O-2). tool: 서버의 로그인으로 고른 AI 도구 */
  static openLead(spaceId: string, tool: string, now: Date): Agent {
    const lead = Agent.open(spaceId, { ...AgentLead.FIELDS, tool }, now);
    lead.put('lead', true);
    return lead;
  }

  /** 역할 일꾼 (2026-11-28, AgentRoles): 서버가 공간마다 갖춘다. tool: 대표의 AI 도구 */
  static openPreset(spaceId: string, def: AgentRoleDef, tool: string, now: Date): Agent {
    const agent = Agent.open(spaceId, { ...AgentRoles.fieldsOf(def), tool }, now);
    agent.put('preset', def.key);
    return agent;
  }

  static restore(row: AgentRow): Agent {
    return new Agent(row);
  }

  private static atLeastOne(value: number | null, label: string): number | null {
    if (value !== null && value < 1) throw new RuleViolation(`${label}는 1 이상이에요`);
    return value;
  }

  /** 대표인가 (O-2). 새로 연 줄(저장 전)과 시험의 줄에는 칸이 없을 수 있다 */
  get lead(): boolean {
    return this.row.lead === true;
  }

  get spaceId(): string {
    return this.row.space_id;
  }

  get name(): string {
    return this.row.name;
  }

  get role(): string {
    return this.row.role;
  }

  get tool(): AgentRow['tool'] {
    return this.row.tool;
  }

  get scopes(): readonly string[] {
    return this.row.scopes;
  }

  /** AI CLI에 넘길 모델. 빈 글이면 CLI의 기본 (2차 7단계) */
  get model(): string {
    return this.row.model ?? '';
  }

  /** AI CLI에 넘길 생각 강도. 빈 글이면 CLI의 기본 */
  get effort(): AgentRow['effort'] {
    return this.row.effort ?? '';
  }

  /** 허락한 외부 도구의 이름 (2차 7단계). 러너가 이 에이전트의 일에만 붙인다 */
  get externalTools(): readonly string[] {
    return this.row.external_tools ?? [];
  }

  /** 외부 도구 하나를 더 붙일 수 없는 까닭 (제안의 결재를 실행하기 전에 본다). 붙일 수 있으면 null */
  toolProblem(name: string): string | null {
    if (this.deleted) return '제안한 에이전트를 지웠어요';
    return AgentScopes.toolProblem(this.externalTools, name);
  }

  /** 외부 도구 하나를 더 허락한다 (제안을 승인했을 때). 권한 조합 · 개수는 고치기와 같은 규칙 */
  plugTool(name: string): void {
    const tools = this.externalTools;
    if (!tools.includes(name)) this.edit({ external_tools: [...tools, name] });
  }

  /** 지운 외부 도구를 뺀다 */
  unplugTool(name: string): void {
    this.edit({ external_tools: this.externalTools.filter((t) => t !== name) });
  }

  get monthlyLimit(): number | null {
    return this.row.monthly_limit;
  }

  /** 역할 일꾼의 역할 key (agent-roles.json). 대표 · 관리자가 만든 일꾼은 null */
  get preset(): string | null {
    return this.row.preset ?? null;
  }

  get paused(): boolean {
    return this.row.status === Agent.PAUSED;
  }

  /** 휴지통에 있는지: 목록 · 조직도에서 빠지고 새 일을 받지 않는다 (기록은 남는다). 새로 연 줄(저장 전)과 시험의 줄에는 칸이 없을 수 있어 값이 있을 때만 */
  get deleted(): boolean {
    return this.row.deleted_at instanceof Date;
  }

  /**
   * 휴지통으로 (행은 지우지 않는다: 작업 · 결재 · 설정 판이 이 에이전트를 가리킨다).
   * 진행 중인 작업 · 스케줄 · 목표 실행은 Service가 먼저 본다
   */
  delete(now: Date): void {
    if (this.lead) throw new RuleViolation('대표는 지울 수 없어요');
    if (this.preset) throw new RuleViolation('기본 역할 일꾼은 지울 수 없어요');
    if (this.deleted) throw new RuleViolation('이미 삭제한 에이전트예요');
    this.put('deleted_at', now);
    this.announce();
  }

  /** 휴지통에서 되돌린다 */
  restore(): void {
    if (!this.deleted) throw new RuleViolation('삭제하지 않은 에이전트예요');
    this.put('deleted_at', null);
    this.announce();
  }

  /**
   * 주인이 고친 칸을 적는다. runner를 주면 일을 맡을 러너도 정한다 (null이면 아무 러너). 설정이 바뀌면 설정 판을 하나 올린다.
   * 묶이면 그 러너만 이 에이전트의 일을 빌리고(칸에서 도는 code · make 일은 칸 러너가 빌린다), 꺼져 있으면 일이 기다린다.
   * 코드 러너 칸에는 묶지 않는다
   */
  edit(changes: Partial<Unchecked<AgentRow>>, runner?: Runner | null): void {
    const before = this.settingsSnapshot();
    if (this.lead) AgentLead.assertEdit(changes, runner !== undefined);
    AgentRoles.assertEdit(this.preset, changes);
    if (runner?.sandbox) throw new RuleViolation('샌드박스에는 묶을 수 없어요');
    if (runner !== undefined) this.put('runner_id', runner?.id ?? null);
    this.accept(changes, Agent.RULES);
    AgentRuntime.assertFits(this.row.tool, this.row.effort ?? '');
    this.noteSettings(before);
  }

  /** 검토자 짝 (2차 2단계): 이 에이전트가 끝낸 대화의 회차를 결재 전에 검토하는 에이전트 */
  get reviewerId(): string | null {
    return this.row.reviewer_id ?? null;
  }

  /**
   * 검토자를 짝짓는다 (null이면 뺀다). 같은 AI가 만들고 검토하면 같은 곳에서 틀려 다른 AI 도구의 에이전트만.
   * 자기 자신 · 지운 에이전트는 안 된다 (DB CHECK agents_reviewer_other)
   */
  pairReviewer(reviewer: Agent | null): void {
    if (reviewer !== null) {
      if (reviewer.id === this.id) throw new RuleViolation('자기 자신은 검토자가 될 수 없어요');
      if (reviewer.deleted) throw new RuleViolation('지운 에이전트는 검토자가 될 수 없어요');
      if (reviewer.tool === this.tool)
        throw new RuleViolation('검토자는 다른 AI 도구를 쓰는 에이전트예요');
    }
    this.put('reviewer_id', reviewer?.id ?? null);
    // 검토자를 빼면 검수 승인과 두 번째 검수자도 뺀다 (검수할 에이전트가 없다)
    if (reviewer === null && this.row.reviewer_approves) this.put('reviewer_approves', false);
    if (reviewer === null && this.row.second_inspector_id) this.put('second_inspector_id', null);
  }

  /** 두 번째 검수자 (2026-11-20, 선택): 검수 승인이 켜졌을 때만 있다. 둘 다 통과해야 관리자 대신 승인한다 (ChatInspect) */
  get secondInspectorId(): string | null {
    return this.reviewerApproves ? (this.row.second_inspector_id ?? null) : null;
  }

  /** 두 번째 검수자를 정한다 (null이면 뺀다). 규칙은 AgentLead.assertSecond: 대표만 · 검토자와 다른 AI 도구 */
  pairSecondInspector(second: Agent | null, reviewer: Agent | null): void {
    if (second !== null) AgentLead.assertSecond(this, reviewer, second);
    this.put('second_inspector_id', second?.id ?? null);
  }

  /** 검수 승인을 켜 두었는가: 검토자가 앱 안의 공개를 검수해 통과하면 관리자 대신 승인한다 (2026-11-20) */
  get reviewerApproves(): boolean {
    return this.row.reviewer_approves === true && this.row.reviewer_id !== null;
  }

  /**
   * 검수 승인을 켜거나 끈다 (원칙 7, 2026-11-20 사용자 결정): 대표만, 검토자가 있어야 켠다.
   * 앱 안의 공개(글 · 호 · 앱 화면)만 검수자가 승인하고, 그 밖의 승인은 늘 관리자에게 간다 (ChatInspect)
   */
  letReviewerApprove(on: boolean): void {
    if (on) AgentLead.assertInspector(this.lead, this.row.reviewer_id);
    this.put('reviewer_approves', on);
  }

  /** 정해진 러너에 묶였는가 (그 러너만 일을 빌린다) */
  get bound(): boolean {
    return Boolean(this.row.runner_id);
  }

  /**
   * 이 러너(task.runners의 id)가 이 에이전트의 일을 빌릴 수 있는가: 묶이지 않았거나 이 러너에 묶였다.
   * 칸(sandbox)은 묶임과 상관없이 빌린다: 칸은 칸의 일(만들기 · 코드)만 빌리고 묶인 러너는 그 일을 빌리지 않아서다 (2026-11-21, 같은 일꾼)
   */
  runsOn(runnerId: string, sandbox = false): boolean {
    return sandbox || !this.row.runner_id || this.row.runner_id === runnerId;
  }

  /** 지금 설정 판 (실행 기록에 남긴다) */
  get settingsRevision(): number {
    return this.row.settings_revision ?? 1;
  }

  /** 이번에 쌓을 설정 판 (Repository가 넣는다) */
  get addedRevision(): AgentRevisionNew | null {
    return this.pendingRevision;
  }

  /** 설정 칸 전부 (판의 내용) */
  private settingsSnapshot(): Record<string, unknown> {
    return Object.fromEntries(Agent.SETTINGS.map((column) => [column, this.row[column] ?? null]));
  }

  /**
   * 설정이 바뀌었으면 판을 쌓는다. 새 에이전트는 판 1. 한 번의 저장 안에서 여러 번 바뀌면(고치기 + 보고 대상)
   * 판은 하나만 올리고 마지막 모습을 남긴다
   */
  private noteSettings(before: Record<string, unknown>): void {
    const after = this.settingsSnapshot();
    if (!this.isNew && JSON.stringify(after) === JSON.stringify(before)) return;
    const revision = this.pendingRevision?.revision ?? (this.isNew ? 1 : this.settingsRevision + 1);
    if (revision !== this.row.settings_revision) this.put('settings_revision', revision);
    this.pendingRevision = { id: BaseEntity.newId(), agent_id: this.id, revision, settings: after };
  }

  /** 이 에이전트가 other에게 맡길 수 있는가: 대표만, 지우지 않은 일꾼 누구에게나 (일꾼끼리는 맡기지 않는다) */
  manages(other: Agent): boolean {
    return this.lead && AgentLead.leads(other);
  }

  /** 멈춘다. 새 일을 빌려주지 않는다. 이미 멈췄으면 그대로 */
  pause(): void {
    this.moveTo(Agent.PAUSED);
  }

  resume(): void {
    this.moveTo(Agent.ACTIVE);
  }

  /** 이번 달 사용량이 한도를 넘었는데 아직 움직이고 있는가 (이미 멈췄으면 결재를 또 올리지 않는다) */
  overLimit(usedThisMonth: number): boolean {
    const limit = this.row.monthly_limit;
    return !this.paused && limit !== null && usedThisMonth > limit;
  }

  /**
   * 새 일을 받지 않고 쉬는가. 지난 5시간 토큰이나 구독 사용률이 정한 값에 닿으면 쉰다.
   * 결재도 상태 변경도 없고, 달리는 작업은 끝까지 간다. 시간이 지나 값이 내려가면 저절로 다시 일한다.
   * planPercent가 null이면 확인 전이라 토큰 한도만 본다.
   */
  holds(fiveHourTokens: number, planPercent: number | null): boolean {
    const { five_hour_limit: tokens, plan_stop_percent: percent } = this.row;
    if (tokens !== null && fiveHourTokens >= tokens) return true;
    return percent !== null && planPercent !== null && planPercent >= percent;
  }

  /** 한도 올리기 결재가 승인됨: 한도를 두 배로 하고 다시 움직인다 */
  raiseLimit(): void {
    const limit = this.row.monthly_limit;
    if (limit !== null) this.edit({ monthly_limit: limit * 2 });
    this.resume();
  }

  /** 이 에이전트가 결재를 올릴 수 있는 동작인가. 주인이 정해 둔 동작만 */
  assertMayRequest(action: string, task: { is(kind: TaskKind): boolean } | null = null): void {
    // 설정을 정해 둔 일(task-kinds.json의 settings, 신고 검토)은 그 일꾼이 설정 바꾸기를 올린다
    // (어느 설정인지는 SettingQuery.reader가 막았다)
    if (task !== null && action === SettingKinds.ACTION && TaskKinds.proposes(task)) return;
    if (this.row.lead && AgentLead.PARTNER_ACTIONS.includes(action)) return;
    if (Agent.ANY_ACTIONS.includes(action)) return;
    if (!this.row.approval_actions.includes(action))
      throw new Forbidden(action, `이 에이전트에게 맡기지 않은 동작이에요: ${action}`);
  }

  view(): AgentSavedView {
    return new AgentSavedView(this.row);
  }

  usageView(fiveHourTokens: number, monthTokens: number, holding: boolean): AgentUsageView {
    return new AgentUsageView(this.row, fiveHourTokens, monthTokens, holding);
  }

  /** 팀장이 받는 일에 실리는 팀원 하나. kinds는 이 팀원에게 맡길 수 있는 일의 종류 */
  memberView(kinds: readonly string[]): JobTeamMemberView {
    return new JobTeamMemberView(this.row, kinds);
  }

  private moveTo(status: AgentRow['status']): void {
    if (this.row.status === status) return;
    this.put('status', status);
    this.announce();
  }

  private announce(): void {
    this.record(
      new DomainEvent('task.agent.changed', 1, this.row.space_id, {
        agentId: this.id,
        status: this.row.status,
      }),
    );
  }
}
