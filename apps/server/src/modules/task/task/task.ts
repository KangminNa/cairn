import {
  Actor,
  AgentActor,
  BaseEntity,
  Conflict,
  DomainEvent,
  Forbidden,
  RuleViolation,
  type SecretBox,
  TableEntity,
  ValueList,
} from '../../platform';
import type { Agent } from '../agent/agent';
import { AiSigninRelayView, AiTestView } from '../ai/ai-login.view';
import type { Goal } from '../goal/goal';
import type { OutputRow, TaskEventRow, TaskNew, TaskRow, TaskRunNew } from '../task.tables';
import { TASK_EVENT_KIND, type TaskWaitReason } from '../task.tables';
import { CodeScope } from './code-scope';
import { DelegatedView } from './delegated.view';
import { DelegationPolicy } from './delegation.policy';
import {
  type JobSkillView,
  JobStateView,
  JobSubtaskResultView,
  JobView,
  ProgressView,
} from './job.view';
import { LeadTalk } from './lead-talk.policy';
import { MakeMaterials } from './make-materials';
import { MakeOrder } from './make-order';
import type { RunRecord } from './run-record';
import type { SubtaskOrder } from './subtask-order.input';
import { SubtaskWait } from './subtask-wait.policy';
import { TaskView } from './task.view';
import { type TaskKind, TaskKinds } from './task-kinds';
import { TaskRefs } from './task-refs.policy';
import { TaskSignin } from './task-signin';
import type { TeamRoster } from './team-roster';

// 작업 하나. 러너가 임대로 빌려 가고, 에이전트가 결재를 올리고, 결재 뒤 실행 결과로 끝난다.
//   queued → running → waiting → running → done, 그리고 failed · cancelled
// waiting은 무엇을 기다리는지(wait_reason)를 함께 적는다: 결재(approval)면 승인 뒤 running, 하위 작업(subtasks)이면
// 하위 작업이 모두 끝난 뒤 queued로 돌아가 같은 에이전트가 결과를 모은다 (위임).
// 상태는 아래 메서드로만 바꾼다. 허용되지 않은 변경은 RuleViolation.
// 실행 기록(task_events)은 추가만 하고 작업과 함께 저장한다.
export class Task extends TableEntity<TaskRow, TaskNew> {
  static readonly QUEUED = 'queued';
  static readonly RUNNING = 'running';
  static readonly WAITING = 'waiting';
  static readonly DONE = 'done';
  static readonly FAILED = 'failed';
  static readonly CANCELLED = 'cancelled';
  /** 어느 모듈이든 일을 요청하는 이벤트 */
  static readonly REQUESTED = 'task.task.requested';
  /** 상태가 바뀔 때마다. 러너의 긴 폴링과 콘솔이 이것으로 깨어난다 */
  static readonly CHANGED = 'task.task.changed';
  /**
   * 작업 점유 시간(lease) 2분 (기획서 결정 2026-11-17). report_progress(러너는 3초마다)가 늘린다.
   * 러너가 사라지면 2분 안에 다른 러너가 이어 받는다
   */
  static readonly LEASE_MS = 2 * 60_000;
  /** 임대가 이만큼 끝나면 실패로 둔다 */
  static readonly MAX_ATTEMPTS = 3;
  /** 같은 일을 이만큼 돌려받으면 실패로 (release) */
  static readonly RELEASE_MAX = 5;
  /**
   * 작업 토큰의 상한. AI CLI는 처음 받은 토큰을 바꿔 끼울 수 없어서, 임대가 늘어도 끊기지 않게 넉넉히 둔다.
   * 실제 만료는 임대다: mcp 모듈이 호출마다 임대가 살아 있는지 묻는다.
   */
  static readonly RUN_TOKEN_SECONDS = 24 * 60 * 60;
  /** AI 로그인 연결 확인. 에이전트도 작업 토큰도 없이 러너가 돌린다 */
  static readonly AI_TEST: TaskKind = 'ai_test';
  /**
   * 웹 AI 로그인. 러너가 로그인 명령을 대신 돌리고, 로그인 주소와 사람이 붙여 넣은 코드는 payload로 오간다.
   * 에이전트도 작업 토큰도 없다 (연결 확인과 같다)
   */
  static readonly AI_SIGNIN: TaskKind = 'ai_signin';
  /**
   * 세션 노트 (2차 4단계): vault가 원문을 받으면 요청한다 (task.agentless.requested). 에이전트 없이 서버의 로그인으로,
   * 러너가 vault에서 원문을 받아(read_transcript) 지시문 틀 session-note로 쓰고 답을 vault에 보낸다(save_note).
   * 원문은 작업에 싣지 않는다 (비공개 사본이 vault 밖에 남지 않게). 대상은 세션, 대상의 판은 원문 번호
   */
  static readonly SESSION_NOTE: TaskKind = 'session_note';
  /** 커넥터 확인 (2026-11-15 MCP 1단계): 러너가 원격 MCP에 붙어 도구 목록을 받는다. AI 없이, 결과는 커넥터에 적는다 */
  static readonly TOOL_CHECK: TaskKind = 'tool_check';
  /** 에이전트 없이 러너가 바로 도는 일 (task-kinds.json의 agentless) */
  static readonly AGENTLESS = TaskKinds.AGENTLESS;
  /** 서버 브라우저로 하는 작업. 브라우저가 있다고 알린 러너(next_jobs의 browser)에게만 빌려 준다 */
  static readonly BROWSE: TaskKind = 'browse';
  /** 코드 작업: 코드 러너 칸에서 셸로 저장소를 고친다 (docs/코드작업.md) */
  static readonly CODE: TaskKind = 'code';
  /** 만들기 작업: 코드 러너 칸에서 셸로 PPT · 문서 · 영상을 만들어 결과물로 남긴다 (결과물 2차) */
  static readonly MAKE: TaskKind = 'make';
  /**
   * 셸이 있는 칸(sandbox 기기)에서만 도는 일. 칸은 이 일만 받고, 다른 러너는 이 일을 받지 않는다 (lockNext).
   * 칸 수가 곧 이 일의 병렬 수라서 칸에 다른 일을 넣지 않는다
   */
  static readonly SANDBOXED = TaskKinds.SANDBOXED;
  static readonly GENERAL: TaskKind = 'general';
  static readonly WAIT_APPROVAL = 'approval';
  static readonly WAIT_SUBTASKS = 'subtasks';
  /**
   * 위임할 수 있는 일의 종류. 받는 에이전트의 권한으로 할 수 있어야 한다 (SCOPES).
   * code는 code 작업에서만: 하위 작업은 위 작업의 저장소를 물려받고 경로만 좁힌다 (CodeScope)
   * make는 재료 없이 지시만 (2026-11-14): 주인이 고른 재료(파일 · 위키)는 물려주지 않는다 (payload.make 없음)
   * browse는 대상(browser_site)이 있으면 그 사이트, 없으면 둘러보기. 맡기는 쪽도 비공개를 읽지 못해야 한다 (DelegationPolicy)
   */
  static readonly DELEGABLE = TaskKinds.DELEGABLE;
  /** 실행 기록의 종류 */
  static readonly LOG_READ = 'read';
  static readonly LOG_WRITE = 'write';
  static readonly LOG_RESULT = 'result';
  static readonly LOG_ERROR = 'error';
  /** 실패 이벤트에 싣는 이유의 길이 (알림 본문) */
  private static readonly EVENT_ERROR_MAX = 300;
  private static readonly SKILLS = TaskKinds.SKILLS;
  /** 이 종류의 일을 맡으려면 에이전트에게 있어야 하는 권한. 없는 종류는 누구나 맡는다 (세션은 기본이 비공개라 정리하려면 비공개까지 읽어야 한다) */
  static readonly SCOPES = TaskKinds.SCOPES;

  private readonly logged: Omit<TaskEventRow, 'id'>[] = [];
  /** 이번 임대의 실행 기록 */
  private run: TaskRunNew | null = null;

  /**
   * 새 작업. 담당·입력·시도·임대·위임 칸은 표에 기본값이 있어도 규칙이 저장 전에 읽어서 적어 둔다.
   * 재료(payload.make)는 만들기 일에만 적고, 모양이 틀리면 RuleViolation
   */
  static open(
    spaceId: string,
    requestId: string,
    fields: Omit<TaskNew, 'id' | 'space_id'>,
    now: Date,
  ): Task {
    if (fields.kind === Task.MAKE) MakeMaterials.of(fields.payload);
    else if (MakeMaterials.given(fields.payload))
      throw new RuleViolation('재료(make)는 만들기 일에만 적어요');
    MakeOrder.check(fields.kind, Task.MAKE, fields.payload);
    const task = new Task(
      {
        agent_id: null,
        payload: {},
        attempts: 0,
        lease_until: null,
        leased_by: null,
        depth: 0,
        wait_reason: null,
        rounds: 0,
        ...fields,
        id: BaseEntity.newId(),
        space_id: spaceId,
        request_id: requestId,
        status: Task.QUEUED,
        created_at: now,
      },
      true,
    );
    task.announce();
    return task;
  }

  static restore(row: TaskRow): Task {
    return new Task(row);
  }

  /** delegate_task의 답: 맡긴 하위 작업들. 위 작업은 하위 작업을 기다린다 */
  static delegatedView(subtasks: readonly Task[]): DelegatedView {
    const rows = subtasks.map((t) => t.row);
    return new DelegatedView(rows, Task.WAIT_SUBTASKS);
  }

  get spaceId(): string {
    return this.row.space_id;
  }

  get agentId(): string | null {
    return this.row.agent_id;
  }

  /** 이 작업이 향하는 목표. 만들 때 정하고 바꾸지 않는다 */
  get goalId(): string | null {
    return this.row.goal_id;
  }

  get requestId(): string | null {
    return this.row.request_id;
  }

  get waitingForSubtasks(): boolean {
    return this.row.status === Task.WAITING && this.row.wait_reason === Task.WAIT_SUBTASKS;
  }

  get cancelled(): boolean {
    return this.row.status === Task.CANCELLED;
  }

  /** 이 종류의 일인가 (연결 확인 · 웹 로그인처럼 종류마다 다른 처리) */
  is(kind: TaskKind): boolean {
    return this.row.kind === kind;
  }

  /** 에이전트 없이 러너가 바로 도는 일인가 (연결 확인, 웹 로그인, 세션 노트, 커넥터 확인) */
  get agentless(): boolean {
    return Task.AGENTLESS.includes(this.row.kind);
  }

  /** 웹 로그인의 도구 (claude · codex). 웹 로그인이 아니면 null */
  get signinTool(): string | null {
    return this.is(Task.AI_SIGNIN) ? TaskSignin.toolOf(this.payload) : null;
  }

  /** 사람이 붙여 넣은 코드 (암호화한 값, TaskSignin.codeOf) */
  get signinCode(): string | null {
    return TaskSignin.codeOf(this.payload);
  }

  /** 코드 작업이 고치는 자리 (저장소 + 경로). code 작업이 아니거나 저장소 정보가 없으면 null */
  get codeScope(): CodeScope | null {
    return this.row.kind === Task.CODE ? CodeScope.of(this.row.payload) : null;
  }

  /** 만들기 작업의 재료 (주인이 고른 결과물 · 위키). 만들기 작업이 아니면 null */
  /** 대화 · 위임으로 넣은 참조 (payload.refs, 2026-11-15 B) */
  get refs(): TaskRefs {
    return TaskRefs.of(this.row.payload);
  }

  get makeMaterials(): MakeMaterials | null {
    return this.row.kind === Task.MAKE ? MakeMaterials.of(this.row.payload) : null;
  }

  /** 아직 끝나지 않았는가 (대기 · 실행 · 기다림) */
  get open(): boolean {
    return [Task.QUEUED, Task.RUNNING, Task.WAITING].includes(this.row.status);
  }

  /**
   * 같은 저장소의 겹치는 일을 막고 있는가 (빌리기): 칸에서 도는 중이거나 PR의 결재를 기다리는 code 작업.
   * 하위 작업을 기다리는 위 작업은 저장소를 쥐고 있지 않다. PR이 열린 동안 막는 것은 먼저 연 PR이 머지되면 뒤 PR이 부딪쳐서다
   */
  get holdsCode(): boolean {
    const r = this.row;
    // 결재를 기다리는 것(wait_reason approval)은 늘 waiting이다 (DB CHECK)
    const holding = r.status === Task.RUNNING || r.wait_reason === Task.WAIT_APPROVAL;
    return r.kind === Task.CODE && holding;
  }

  /** 결과를 내고 끝났는가. 취소는 결과가 없어서 뺀다 */
  get ended(): boolean {
    return this.row.status === Task.DONE || this.row.status === Task.FAILED;
  }

  /** 실패한 이유 */
  get failure(): string | null {
    const error = this.result?.error;
    return typeof error === 'string' ? error : null;
  }

  /** 연결 확인이 이 판의 로그인을 보는가. 그사이 토큰을 바꿨으면 아니다 */
  tests(loginVersion: number): boolean {
    return this.payload.loginVersion === loginVersion;
  }

  /** 이 권한을 가진 에이전트가 맡을 수 있는 일인가 */
  doableWith(scopes: readonly string[]): boolean {
    const needed = Task.SCOPES[this.row.kind];
    return needed === undefined || needed.every((scope) => scopes.includes(scope));
  }

  /**
   * 웹 로그인의 다음 모습: 러너가 찾은 로그인 주소(TaskSignin.withUrl) · 사람이 붙여 넣은 코드(withCode, 암호화한 값,
   * 러너가 가져갈 때까지만 둔다). 도는 웹 로그인에만
   */
  signin(
    next: (payload: Readonly<Record<string, unknown>>) => Record<string, unknown> | null,
  ): void {
    this.assertSigninRunning();
    this.putSignin(next(this.payload));
  }

  /**
   * 이 러너가 맡았던 일인가 (지금 상태와 상관없이). 실행 중에 CLI가 갱신한 자격은 주인이 취소한 뒤에도
   * 되돌려 써야 한다: 버리면 다음 실행이 이미 쓴 갱신 토큰을 내밀어 로그인이 깨진다
   */
  assertWorkedBy(runnerId: string): void {
    if (this.row.leased_by !== runnerId) throw new RuleViolation('다른 러너가 맡은 작업이에요');
  }

  /** 세션 노트 일인가: 에이전트 없이 돌지만 러너가 지시문 틀(session-note)로 AI에게 줄 글을 만든다 */
  get writesNote(): boolean {
    return this.row.kind === Task.SESSION_NOTE;
  }

  /** 이 러너가 자격을 넘겨 이미 끝난 웹 로그인인가. 응답을 잃은 러너가 다시 보내도 같은 답을 준다 */
  signinDoneBy(runnerId: string): boolean {
    const r = this.row;
    return this.is(Task.AI_SIGNIN) && r.status === Task.DONE && r.leased_by === runnerId;
  }

  /**
   * 이번 실행의 규칙 판을 남긴다 (임대할 때): 에이전트 설정 판, 스킬 판, 러너 빌드, CLI 버전.
   * 몇 번째 실행인지는 Repository가 매긴다 (attempts는 고쳐 달라 · 깨우기에서 0으로 돌아간다)
   */
  recordRun(runnerId: string, record: RunRecord, now: Date): void {
    this.run = record.row(BaseEntity.newId(), this.row, runnerId, now);
  }

  /** 남길 실행 기록 (Repository가 seq를 매겨 넣는다) */
  get addedRun(): TaskRunNew | null {
    return this.run;
  }

  /** 이번에 쌓인 실행 기록 (Repository가 저장한다) */
  get addedLog(): readonly Omit<TaskEventRow, 'id'>[] {
    return this.logged;
  }

  /** 러너가 빌려 간다: queued → running. 담당이 없던 일은 agentId가 맡는다. 연결 확인은 담당 없이 돈다 */
  lease(runnerId: string, agentId: string | null, now: Date): void {
    this.move([Task.QUEUED], Task.RUNNING);
    if (this.row.agent_id === null && agentId !== null) this.put('agent_id', agentId);
    this.holdLease(runnerId, new Date(now.getTime() + Task.LEASE_MS));
    this.put('attempts', this.row.attempts + 1);
    // 웹 로그인을 다시 빌리면(앞 러너가 사라짐) 앞 시도의 주소와 코드는 쓸모가 없다
    if (this.is(Task.AI_SIGNIN)) this.putSignin(TaskSignin.restarted(this.payload));
  }

  /**
   * 진행 보고를 받는다. 임대를 늘리되, 취소됐으면 기록만 받아 러너가 응답으로 알게 하고,
   * 결재를 기다리는 중이면 임대를 늘리지 않는다 (에이전트가 남긴 마지막 기록을 받으려고 기록만).
   * 늘린 임대는 version 없이 저장한다 (TaskRepository.saveLease)
   */
  acceptReport(runnerId: string, now: Date): void {
    this.assertWorkedBy(runnerId);
    if (this.cancelled || this.row.status === Task.WAITING) return;
    this.assertHeldBy(runnerId, now);
    this.put('lease_until', new Date(now.getTime() + Task.LEASE_MS));
  }

  /** 임대를 쥔 러너가 살아 있는 임대로 부르는가. 늦은 제출은 여기서 막힌다 */
  assertHeldBy(runnerId: string, now: Date): void {
    if (this.row.status !== Task.RUNNING)
      throw new RuleViolation(`진행 중인 작업이 아니에요 (${this.row.status})`);
    this.assertWorkedBy(runnerId);
    if (!this.leaseAlive(now)) throw new RuleViolation('임대가 끝난 작업이에요');
  }

  /**
   * 결재(또는 대표의 답, ask_lead)를 기다린다: running → waiting. 임대는 남은 시간까지 두고 늘리지 않으며, 끝나도 되돌리지 않는다.
   * 러너는 진행 보고의 답으로 AI를 끄고 제출하지 않는다
   */
  waitFor(now: Date, reason: TaskWaitReason = Task.WAIT_APPROVAL): void {
    if (this.row.status === Task.RUNNING && !this.leaseAlive(now))
      throw new RuleViolation('임대가 끝난 작업이에요');
    this.move([Task.RUNNING], Task.WAITING, reason);
  }

  /** 결재 승인: waiting → running. 임대 없이 실행 결과 이벤트를 기다린다 */
  resume(): void {
    this.assertWaitingFor(Task.WAIT_APPROVAL);
    this.move([Task.WAITING], Task.RUNNING);
    this.holdLease(null, null);
  }

  /** 이번에 count개를 맡길 수 있는가. 이 작업의 에이전트가 살아 있는 임대로 일하는 중이어야 한다. 한도는 DelegationPolicy */
  assertCanDelegate(agentId: string, count: number, made: number, now: Date): void {
    const r = this.row;
    if (r.agent_id !== agentId) throw new Forbidden(Actor.AGENT, '이 에이전트의 작업이 아니에요');
    if (r.status !== Task.RUNNING || !this.leaseAlive(now))
      throw new Conflict(`실행 중인 작업이 아니에요 (${r.status})`);
    DelegationPolicy.assertLimits(r, count, made);
  }

  /** 하위 작업 하나를 만든다. 받는 쪽 · 종류 · 물려주는 것은 DelegationPolicy.subtask */
  subtask(manager: Agent, worker: Agent | null, order: SubtaskOrder, now: Date) {
    const fields = DelegationPolicy.subtask(this.row, this.codeScope, manager, worker, order);
    const requestId = DelegationPolicy.requestIdOf(this.id, order.requestId);
    return Task.open(this.row.space_id, requestId, fields, now);
  }

  /**
   * 하위 작업을 기다린다: running → waiting(subtasks). 맡겼을 때(delegate_task)와 더 기다릴 때(wait_subtasks).
   * until: 기한 (SubtaskWait, 지나면 다 끝나지 않아도 깨운다). 임대는 결재 대기처럼 남은 시간까지 둔다:
   * 러너는 진행 보고의 답으로 AI를 끄고 제출하지 않는다.
   */
  waitForSubtasks(note: string, until: Date, now: Date, round = true): void {
    this.move([Task.RUNNING], Task.WAITING, Task.WAIT_SUBTASKS);
    this.put('rounds', this.row.rounds + (round ? 1 : 0));
    this.put('wait_until', until);
    this.log(Task.LOG_WRITE, note, 0, now);
  }

  /**
   * 하위 작업을 기다리다 깬다: waiting(subtasks) → queued. 같은 에이전트가 결과를 받아 모은다.
   * reason: 깬 까닭 (SubtaskWait: 모두 끝남 · 실패 · 기한 · 관리자). 끝나지 않은 하위 작업은 계속 돈다.
   * 다시 빌려 가는 일이라 시도 횟수는 새로 센다.
   */
  wakeAfterSubtasks(reason: string, now: Date): void {
    this.reopen(Task.WAIT_SUBTASKS);
    this.put('payload', SubtaskWait.woken(this.payload, reason));
    this.log(Task.LOG_READ, SubtaskWait.noteOf(reason), 0, now);
  }

  /** 기한이 지났으면 깨운다 (마감 작업). 그사이 깨어났거나 기한을 다시 정했으면 그대로 */
  wakeIfOverdue(now: Date): void {
    if (this.waitingForSubtasks && SubtaskWait.overdue(this.row.wait_until, now))
      this.wakeAfterSubtasks(SubtaskWait.DEADLINE, now);
  }

  /**
   * 팀원이 나눌 부분을 적어 팀장에게 도움을 청한다 (2026-11-20, SubtaskWait.assertHelpable): 맡긴 일 · 살아 있는 임대 ·
   * 이 에이전트의 일만. 요청은 실행 기록 한 줄로 남아 깨어난 팀장의 진행 기록(subtask_results[].progress)에 보인다
   */
  askHelp(agentId: string, line: string, now: Date): void {
    SubtaskWait.assertHelpable(this.row, agentId, this.leaseAlive(now));
    this.log(Task.LOG_WRITE, line, 0, now);
  }

  /**
   * 관리자가 지금까지의 결과로 답하라고 한다: 하위 작업을 기다리는 중이면 바로 깨우고,
   * 대기 · 실행 중(먼저 깨어난 뒤)이면 더 맡기거나 기다리지 못하게 적어 둔다 (SubtaskWait.assertNotHurried)
   */
  hurry(now: Date): void {
    SubtaskWait.assertHurriable(this.row);
    this.put('payload', SubtaskWait.woken(this.payload, SubtaskWait.OWNER));
    if (this.waitingForSubtasks) this.wakeAfterSubtasks(SubtaskWait.OWNER, now);
  }

  /**
   * 결재에서 고쳐 달라고 함: waiting → queued. 에이전트가 말을 받아 다시 하므로 시도 횟수는 새로 센다.
   * 다음 실행은 앞 실행을 기억하지 못하므로 결재의 대상을 작업의 대상으로 넘긴다.
   */
  returnForRevision(note: string | null, kind: string, id: string, version: number): void {
    this.reopen(Task.WAIT_APPROVAL);
    this.put('payload', { ...this.payload, revisionNote: note });
    this.put('target_kind', kind);
    this.put('target_id', id);
    this.put('base_version', version);
  }

  /** 러너가 끝을 알린다. 살아 있는 임대로만 */
  submit(
    runnerId: string,
    status: string,
    result: Readonly<Record<string, unknown>>,
    error: string | null,
    now: Date,
    /** 결과를 페이지 · 앱 코드로 내보내는 일이면 이번 실행의 결과물 (MakeOrder) */
    made: readonly OutputRow[] | null = null,
  ): void {
    this.assertHeldBy(runnerId, now);
    const page = status === Task.DONE && made !== null ? MakeOrder.of(this.row.payload) : null;
    const refusal = page === null || made === null ? null : page.refusal(made);
    // 웹 로그인은 자격(ai_signin credential)이 와야 끝난다. 러너가 실패만 알린다 (웹 로그인은 만들기 일이 아니다)
    if (this.is(Task.AI_SIGNIN) && status === Task.DONE)
      throw new RuleViolation('웹 로그인은 ai_signin으로 자격을 보내야 끝나요');
    if (refusal !== null) this.fail(refusal, now);
    else if (status === Task.DONE) this.finish(result, now);
    else if (status === Task.FAILED) this.fail(error ?? '러너가 실패로 끝냈어요', now, result);
    else throw new RuleViolation(`결과는 ${Task.DONE} · ${Task.FAILED} 중 하나예요`);
    if (refusal === null && page && made) this.record(page.built(this.row, made));
  }

  /**
   * 결재한 동작의 실행 결과를 받는다. 같은 결과가 두 번 와도 같게, 이미 끝난 작업은 그대로 둔다.
   * 결재 뒤 주인이 취소한 작업도 여기서는 건드리지 않는다.
   */
  concludeExecution(succeeded: boolean, error: string | null, now: Date): void {
    if (this.row.status !== Task.RUNNING) return;
    if (succeeded) this.finish({}, now);
    else this.fail(error ?? '실행하지 못했어요', now);
  }

  /**
   * 승인한 것을 같은 작업이 이어서 한다 (플러그인 API 0.8, browser-tabs의 누르기 계획): 승인 뒤 결과를 기다리던
   * running(임대 없음) → queued. 다시 빌려 가는 일이라 시도 횟수는 새로 센다. 그 밖의 상태면 그대로 (두 번 와도 같다)
   */
  continueAfterApproval(now: Date): void {
    if (this.row.status !== Task.RUNNING || this.row.lease_until !== null) return;
    this.move([Task.RUNNING], Task.QUEUED);
    this.put('attempts', 0);
    this.log(Task.LOG_READ, '승인받아 이어서 해요', 0, now);
  }

  /** 끝낸다: running → done */
  finish(result: Readonly<Record<string, unknown>>, now: Date): void {
    this.move([Task.RUNNING], Task.DONE);
    this.close(result, now);
    this.log(Task.LOG_RESULT, '', 0, now);
  }

  /** 실패로 끝낸다: running → failed. 러너가 함께 보낸 결과 칸(커넥터 사용 connector_calls 등)도 남긴다 */
  fail(error: string, now: Date, result: Readonly<Record<string, unknown>> = {}): void {
    this.move([Task.RUNNING], Task.FAILED, null, { error: error.slice(0, Task.EVENT_ERROR_MAX) });
    this.close({ ...result, error }, now);
    this.log(Task.LOG_ERROR, error, 0, now);
  }

  /** 주인이 멈춘다. 임대를 쥔 러너는 다음 보고의 응답으로 안다 */
  cancel(now: Date): void {
    this.move([Task.QUEUED, Task.RUNNING, Task.WAITING], Task.CANCELLED);
    this.put('lease_until', null);
    this.put('finished_at', now);
    this.forgetSignin();
  }

  /**
   * 러너가 처리하지 못하고 돌려준다: running → queued. 실패가 아니라 시도로 세지 않는다.
   * 다만 RELEASE_MAX번째 돌려받으면 실패로 끝낸다 (센 수는 payload.released): 러너가 같은 까닭으로 멈추고 다시 떠
   * 같은 일을 또 빌려 가는 되풀이를 끊는다 (2026-11-21 배포 서버, 만들기 일이 30초마다 50번 돌려졌다)
   */
  release(runnerId: string, reason: string, now: Date): void {
    this.assertHeldBy(runnerId, now);
    const n = Number(this.payload.released ?? 0) + 1;
    this.put('payload', { ...this.payload, released: n });
    if (n >= Task.RELEASE_MAX) this.expire(now, `${n}번 돌려받아 멈췄어요: ${reason}`);
    else this.requeue(`돌려줌: ${reason}`, now, Math.max(0, this.row.attempts - 1));
  }

  /** 임대가 끝남 (러너가 죽음): 다시 대기열로, MAX_ATTEMPTS번째면 실패로. stopped를 주면 그 까닭으로 바로 실패 */
  expire(now: Date, stopped: string | null = null): void {
    this.holdLease(null, null);
    if (stopped === null && this.row.attempts < Task.MAX_ATTEMPTS)
      this.requeue('임대가 끝나 다시 대기열로 돌아갔어요', now);
    else this.fail(stopped ?? '임대가 세 번 끝나 멈췄어요', now);
  }

  /**
   * waiting(reason) → queued: 다시 빌려 가는 일이라 시도 횟수는 새로 센다. 깨우기 · 고쳐 달라 · 대표의 답(LeadTalkService:
   * 답을 payload에 쌓은 뒤 부른다). 그 까닭으로 기다리는 일이 아니면 Conflict
   */
  reopen(reason: TaskWaitReason): void {
    this.assertWaitingFor(reason);
    this.move([Task.WAITING], Task.QUEUED);
    this.holdLease(null, null);
    this.put('attempts', 0);
  }

  /** running → queued: 임대를 비우고 까닭을 남긴다. attempts: 다음 시도 횟수 (돌려준 일은 이번 실행을 세지 않는다) */
  private requeue(note: string, now: Date, attempts = this.row.attempts): void {
    this.move([Task.RUNNING], Task.QUEUED);
    this.holdLease(null, null);
    this.put('attempts', attempts);
    this.log(Task.LOG_ERROR, note, 0, now);
    this.forgetSignin();
  }

  log(kind: string, body: string, tokens: number, now: Date): void {
    if (!ValueList.has(TASK_EVENT_KIND, kind))
      throw new RuleViolation(`기록 종류는 ${TASK_EVENT_KIND.join(' · ')} 중 하나예요`);
    this.logged.push({ task_id: this.id, at: now, kind, body, tokens });
  }

  /**
   * 이 작업을 하는 에이전트의 요청자. 그 에이전트의 권한만 담아 작업 토큰이 된다.
   * 만들기 작업이면 주인이 고른 재료 위키에 읽기 허락을 더한다 (get_wiki만 본다)
   */
  actorFor(agent: Agent): AgentActor {
    const reads = new Set([...(this.makeMaterials?.wikis ?? []), ...this.refs.readIds]);
    const only = TaskKinds.toolsOf(this.row.kind);
    return new AgentActor(this.row.space_id, agent.id, this.id, new Set(agent.scopes), reads, only);
  }

  /** 바꾼 작업 하나. 목록의 한 줄과 같은 모양이고, 화면은 이 version으로 다음 변경을 보낸다 */
  view(): TaskView {
    return new TaskView(this.row);
  }

  /**
   * 빌려 준 일 하나. 맡은 에이전트의 작업 토큰을 여기서 만든다.
   * 목표 사슬(goals), 바로 아래 팀(roster: 팀원 정보, D1), 깨어난 일이면 하위 작업(children)의 결과를 함께 싣는다
   */
  jobView(
    agent: Agent | null,
    box: SecretBox,
    goals: readonly Goal[],
    roster: TeamRoster,
    children: readonly Task[],
    skill: JobSkillView | null = null,
  ): JobView {
    const runToken = agent && this.actorFor(agent).seal(box, Task.RUN_TOKEN_SECONDS);
    return new JobView(
      this.row,
      this.skill,
      this.revisionNote,
      agent,
      runToken,
      goals.map((g) => g.title),
      roster.members(agent),
      children.map((c) => c.resultView(roster.nameOf(c.row.agent_id))),
      DelegationPolicy.roundsLeft(this.row),
      skill,
    );
  }

  /** 진행 보고의 답. agentPaused는 이 작업의 에이전트가 멈췄는가 */
  progressView(agentPaused: boolean): ProgressView {
    return new ProgressView(this.row, this.cancelled, agentPaused);
  }

  /** submit_result · release_job의 답 */
  stateView(): JobStateView {
    return new JobStateView(this.row);
  }

  /** 맡긴 연결 확인이나 시작한 웹 로그인 */
  testView(): AiTestView {
    return new AiTestView(this.row);
  }

  /** 웹 로그인을 진행하는 러너에게 주는 답. code는 푼 코드 */
  relayView(code: string | null): AiSigninRelayView {
    return new AiSigninRelayView(this.row, this.cancelled, code);
  }

  /** 하위 작업 하나의 결과. 러너는 결과를 { text }로 낸다 */
  private resultView(agentName: string | null): JobSubtaskResultView {
    const text = this.result?.text;
    // 대표의 답을 기다리는 일은 결과 글 대신 그 질문을 싣는다 (waiting: lead, LeadTalk)
    const answer =
      typeof text === 'string' && text !== '' ? text : LeadTalk.questionOf(this.payload);
    return new JobSubtaskResultView(this.row, agentName, answer, this.failure);
  }

  /** 커넥터 확인(tool_check)이면 확인할 도구, 아니면 null */
  get checkedToolId(): string | null {
    return this.row.kind === Task.TOOL_CHECK ? String(this.payload.toolId ?? '') || null : null;
  }

  get payloadTool(): string | null {
    return typeof this.payload.tool === 'string' ? this.payload.tool : null;
  }

  /**
   * 일이 스스로 정하는 payload의 칸: 대화 회차의 받을 것(O-3 set_deliver, 규칙은 TurnDeliver.declare) · 계획(2026-11-20
   * set_plan, 규칙은 TaskPlan.declare: 한 번만). 규칙은 정책이 지금 payload를 받아 새 payload를 돌려주며 지킨다
   */
  declare(next: (payload: Readonly<Record<string, unknown>>) => Record<string, unknown>): void {
    this.put('payload', next(this.payload));
  }

  private get payload(): Readonly<Record<string, unknown>> {
    return (this.row.payload ?? {}) as Readonly<Record<string, unknown>>;
  }

  private get result(): Readonly<Record<string, unknown>> | null {
    return (this.row.result ?? null) as Readonly<Record<string, unknown>> | null;
  }

  /** 러너가 쓸 스킬. 없으면 지시만으로 일한다 */
  /** 이 일의 스킬 이름 (Task.SKILLS). 없으면 null */
  get skill(): string | null {
    return Task.SKILLS[this.row.kind] ?? null;
  }

  /** 주인이 결재에서 고쳐 달라고 남긴 말 */
  private get revisionNote(): string | null {
    return typeof this.payload.revisionNote === 'string' ? this.payload.revisionNote : null;
  }

  private assertSigninRunning(): void {
    if (!this.is(Task.AI_SIGNIN)) throw new RuleViolation('웹 로그인 작업이 아니에요');
    if (this.row.status !== Task.RUNNING)
      throw new Conflict(`진행 중인 로그인이 아니에요 (${this.row.status})`);
  }

  private leaseAlive(now: Date): boolean {
    return this.row.lease_until !== null && this.row.lease_until.getTime() > now.getTime();
  }

  private holdLease(runnerId: string | null, until: Date | null): void {
    this.put('leased_by', runnerId);
    this.put('lease_until', until);
  }

  private close(result: Readonly<Record<string, unknown>>, now: Date): void {
    this.put('result', result);
    this.put('finished_at', now);
    this.forgetSignin();
  }

  /** 끝나거나 대기열로 돌아간 웹 로그인에는 주소도 코드도 남기지 않는다 (TaskSignin.forgotten) */
  private forgetSignin(): void {
    if (this.is(Task.AI_SIGNIN)) this.putSignin(TaskSignin.forgotten(this.payload));
  }

  /** 웹 로그인 payload의 다음 모습. null이면 그대로 */
  private putSignin(next: Readonly<Record<string, unknown>> | null): void {
    if (next !== null) this.put('payload', next);
  }

  private assertWaitingFor(reason: string): void {
    const r = this.row;
    if (r.status === Task.WAITING && r.wait_reason !== reason)
      throw new RuleViolation(`${reason}을(를) 기다리는 작업이 아니에요 (${r.wait_reason})`);
  }

  /**
   * 메서드마다 어느 상태에서 올 수 있는지 적는다. 상태 쌍만 보면 lease()가 결재 대기를 가로챌 수 있다.
   * waiting으로 갈 때만 무엇을 기다리는지 적고, 나머지 상태로 가면 지운다 (DB의 CHECK와 같다)
   */
  private move(
    from: readonly string[],
    to: TaskRow['status'],
    waitReason: TaskRow['wait_reason'] = null,
    more: Readonly<Record<string, unknown>> = {},
  ): void {
    if (!from.includes(this.row.status))
      throw new RuleViolation(`${this.row.status} 상태의 작업은 ${to}(으)로 바꿀 수 없어요`);
    this.put('status', to);
    const reason = to === Task.WAITING ? waitReason : null;
    if (reason !== this.row.wait_reason) this.put('wait_reason', reason);
    // 기한은 하위 작업을 기다리는 동안만 (waitForSubtasks가 이 뒤에 적는다, DB CHECK)
    if (this.row.wait_until) this.put('wait_until', null);
    this.announce(more);
  }

  /** 상태가 바뀌었다. 제목은 알림이 쓴다 (실패면 이유의 앞부분도) */
  private announce(more: Readonly<Record<string, unknown>> = {}): void {
    this.record(
      new DomainEvent(Task.CHANGED, 1, this.row.space_id, {
        taskId: this.id,
        status: this.row.status,
        title: this.row.title,
        ...more,
      }),
    );
  }
}
