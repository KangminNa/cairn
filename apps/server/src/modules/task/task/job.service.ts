import { Injectable } from '@nestjs/common';
import {
  Actor,
  BaseService,
  ChangeStream,
  Database,
  Forbidden,
  Idempotency,
  SecretBox,
  type Sql,
} from '../../platform';
import type { Agent } from '../agent/agent';
import { AgentRepository } from '../agent/agent.repository';
import { AiLoginRepository } from '../ai/ai-login.repository';
import { Approval } from '../approval/approval';
import { ApprovalRepository } from '../approval/approval.repository';
import { ChatUpdateQuery } from '../chat/chat-update.query';
import { ExternalToolQuery } from '../external-tool/external-tool.query';
import { GoalRepository } from '../goal/goal.repository';
import { OutputQuery } from '../output/output.query';
import { LearnedRuleQuery } from '../rule/rule.query';
import { RunnerRepository } from '../runner/runner.repository';
import { PromptTemplates } from '../skill/prompt-templates';
import { RepoSkillGateway } from '../skill/repo-skill.gateway';
import { SkillRepository } from '../skill/skill.repository';
import type { SkillPackage } from '../skill/skill-package';
import type { RunnerRow } from '../task.tables';
import { PlanUsage } from '../usage/plan-usage';
import { PlanUsageRepository } from '../usage/plan-usage.repository';
import { type JobView, NextJobsView, type ProgressView } from './job.view';
import { LeasePolicy } from './lease.policy';
import { RunRecord } from './run-record';
import type { SubmitResultInput } from './submit-result.input';
import { Task } from './task';
import type { NextJobsInput, ReleaseJobInput, ReportProgressInput } from './task.input';
import { TaskQuery } from './task.query';
import { TaskRepository } from './task.repository';
import type { TeamRoster } from './team-roster';

// 러너 쪽 작업 쓰기: 빌리기 · 진행 · 끝내기 · 돌려주기(러너), 끝난 임대 되돌리기(일꾼).
// 만들기 · 취소 · 위임은 JobService. 한도 초과처럼 작업과 함께 바뀌는 에이전트 · 결재는 같은 트랜잭션에서 쓴다 (객체설계 9장).
// 잠그는 순서는 어디서나 작업 → 결재 → 에이전트.
@Injectable()
export class JobService extends BaseService {
  /** 칸이 일을 빌릴 때 겹쳐서 건너뛸 수 있는 만큼 더 보는 후보 수 */
  private static readonly CODE_LOOKAHEAD = 20;

  private static readonly REPORT = 'report_progress';
  private static readonly SUBMIT = 'submit_result';
  /** 신호를 놓쳤거나 임대가 끝났을 때를 위해 이 간격으로도 다시 찾는다 */
  private static readonly RECHECK_MS = 5_000;
  private static readonly RECLAIM_BATCH = 50;

  constructor(
    db: Database,
    private readonly box: SecretBox,
    private readonly changes: ChangeStream,
    private readonly repoSkills: RepoSkillGateway,
    private readonly outputs: OutputQuery,
    private readonly chats: ChatUpdateQuery,
    private readonly tools: ExternalToolQuery,
    private readonly progress: TaskQuery,
    private readonly rules: LearnedRuleQuery,
  ) {
    super(db);
  }

  /**
   * 러너가 일을 빌린다. 없으면 waitSeconds까지 기다리다가 일이 생기면 바로 돌려준다 (트랜잭션 밖에서 기다린다).
   * 물을 때마다 러너가 닿은 때를 남긴다. 주인이 일 받기를 꺼 둔 러너에게는 빈 목록이다 (러너는 켜진 채로 쉰다)
   */
  async next(actor: Actor, req: NextJobsInput): Promise<NextJobsView> {
    actor.assertCan(Actor.RUN);
    const [spaceId, runnerId, sandbox] = JobService.runnerAt(actor);
    const deadline = Date.now() + req.waitSeconds * 1000;
    for (;;) {
      const runner = await this.transaction((tx) =>
        new RunnerRepository(tx).seen(spaceId, runnerId, new Date(), sandbox, req.browser),
      );
      const jobs = runner.accepting ? await this.lease(actor, runner, req) : [];
      const left = deadline - Date.now();
      // 러너 메뉴에서 정한 동시 자리도 함께 보낸다: 러너가 다음 빌리기부터 그 수로 바꾼다 (2026-11-20)
      if (jobs.length > 0 || left <= 0 || this.changes.closed)
        return new NextJobsView(jobs, runner.concurrency);
      await this.changes.wait(
        (signal) => signal.spaceId === spaceId && signal.topic === Task.CHANGED,
        Math.min(left, JobService.RECHECK_MS),
      );
    }
  }

  /** 진행 보고: 기록을 남기고 임대를 늘린다. 쓴 토큰은 에이전트의 한 달 한도에 더하고, 러너가 본 구독 사용률을 남긴다 */
  async report(actor: Actor, req: ReportProgressInput): Promise<ProgressView> {
    actor.assertCan(Actor.RUN);
    const [spaceId, runnerId] = JobService.runnerAt(actor);
    const now = new Date();
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const once =
        req.requestId === null
          ? null
          : new Idempotency(tx, runnerId, req.requestId, JobService.REPORT);
      const repeated = (await once?.previous()) ?? null;
      const task = await tasks.lock(spaceId, req.taskId);
      // 다시 보낸 보고도 이 러너가 맡았던 일이어야 한다: 남겨 둔 결과에는 작업 id가 없어서,
      // 확인하지 않으면 옛 request_id에 남의 작업 id를 붙여 그 작업의 상태를 볼 수 있다
      task.assertWorkedBy(runnerId);
      if (repeated === null) {
        task.acceptReport(runnerId, now);
        for (const e of req.events) task.log(e.kind, e.body, e.tokens, now);
        await tasks.saveLease(task);
        await tasks.noteRun(task.id, runnerId, req);
        await this.charge(tx, task, req.tokens, now);
        await this.notePlan(tx, task, req, now);
        await once?.remember({ reported: true });
      }
      // 일하는 동안에는 next_jobs를 부르지 않으므로 진행 보고로 닿은 때를 남긴다 (잠그는 순서의 맨 뒤)
      await new RunnerRepository(tx).seen(spaceId, runnerId, now, actor.inSandbox());
      return task.progressView(await this.agentPaused(tx, task));
    });
  }

  /** 끝내기. 살아 있는 임대로만 된다. 같은 request_id는 처음 결과를 돌려준다 */
  async submit(actor: Actor, req: SubmitResultInput): Promise<Task> {
    actor.assertCan(Actor.RUN);
    const [spaceId, runnerId] = JobService.runnerAt(actor);
    const now = new Date();
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const once = new Idempotency(tx, runnerId, req.requestId, JobService.SUBMIT);
      const before = await once.previous();
      if (before) return tasks.load(spaceId, String(before.taskId));
      const task = await tasks.lock(spaceId, req.taskId);
      task.submit(runnerId, req.status, req.result, req.error, now, await tasks.madeBy(task));
      await tasks.save(task);
      // 팀원 기다리기: 끝나지 않은 하위 작업을 두고 마무리했으면 그 일은 멈춘다 (먼저 깨어난 뒤).
      // 승인을 기다리는 일은 관리자가 정하게 둔다 (대화의 결과 카드에 실린다). 잠그는 순서는 위 작업 → 아래 작업
      if (task.ended)
        for (const left of await tasks.lockOpenDescendants(task.id, true)) {
          left.cancel(now);
          await tasks.save(left);
        }
      await this.noteAiTest(tx, task, now);
      await once.remember({ taskId: task.id });
      return task;
    });
  }

  /** 처리하지 못한 일을 돌려준다 */
  async release(actor: Actor, req: ReleaseJobInput): Promise<Task> {
    actor.assertCan(Actor.RUN);
    const [spaceId, runnerId] = JobService.runnerAt(actor);
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const task = await tasks.lock(spaceId, req.taskId);
      task.release(runnerId, req.reason, new Date());
      await tasks.save(task);
      return task;
    });
  }

  /** 임대가 끝난 작업을 되돌린다 (일꾼이 주기적으로). 되돌린 수를 돌려준다 */
  async reclaim(actor: Actor): Promise<number> {
    actor.assertCan(Actor.RUN);
    return this.transaction((tx) => this.expire(tx, new Date()));
  }

  /** runner: 빌리는 러너의 줄 (기기 id · 칸인지 · 묶인 에이전트를 가를 id) */
  private lease(actor: Actor, runner: RunnerRow, req: NextJobsInput): Promise<readonly JobView[]> {
    const { space_id: spaceId, device_id: runnerId, sandbox } = runner;
    const now = new Date();
    return this.transaction(async (tx) => {
      const tasks = new TaskRepository(tx);
      const agents = new AgentRepository(tx);
      await this.expire(tx, now);
      // 러너가 할 수 있는 일만: 가진 CLI와 쓸 수 있는 로그인 (LeasePolicy). 빌렸다가 돌려주지 않는다
      const usable = await new AiLoginRepository(tx).usableTools(spaceId, now);
      const running = await tasks.runningAgentTools(spaceId);
      const workTools = LeasePolicy.workTools(req.tools, req.ownLogins, usable, running);
      // 쉬는지는 작업을 잠그기 전에 따진다: 쉬는 에이전트의 일은 빌렸다가 돌려주지 않고 처음부터 건너뛴다
      const usage = await agents.usage(spaceId, now);
      // 다른 러너에 묶인 에이전트의 일은 이 러너가 빌리지 않는다 (자동 배정도 그 에이전트를 고르지 않는다). 칸은 칸의 일만이라 묶임을 보지 않는다
      const ready = usage
        .filter((u) => u.ready && u.agent.runsOn(runner.id, sandbox))
        .filter((u) => workTools === null || workTools.includes(u.agent.tool))
        .map((u) => u.agent);
      const roster = await agents.roster(spaceId, usage, now);
      const jobs: JobView[] = [];
      // 칸: 공간을 잠그고(두 칸이 동시에 겹치는 일을 받지 않게) 저장소를 쥔 code 작업과 겹치는 일은 건너뛴다.
      // 건너뛸 수 있으니 후보를 넉넉히 잠근다
      if (sandbox) await tasks.lockCodeLeasing(spaceId);
      const held = sandbox
        ? (await tasks.holdingCode(spaceId)).flatMap((t) => t.codeScope ?? [])
        : [];
      const look = sandbox ? req.limit + JobService.CODE_LOOKAHEAD : req.limit;
      const picked = await tasks.lockNext(spaceId, ready, look, {
        testTools: LeasePolicy.testTools(req.tools, usable),
        ...req.leaseFilter,
        sandbox,
      });
      const busy = [...running];
      const skills = new SkillRepository(tx);
      const packageOf = (name: string) => skills.current(spaceId, name, this.repoSkills.get(name));
      // 지시문 틀(moida-runner)의 지금 판: 에이전트의 일마다 함께 보내고 실행 기록에 남긴다
      const prompts = picked.length > 0 ? await packageOf(PromptTemplates.SKILL) : null;
      for (const task of picked) {
        if (jobs.length >= req.limit) break;
        const scope = task.codeScope;
        if (scope && held.some((h) => h.overlaps(scope))) continue;
        // 담당을 정하지 않은 일은 그 일의 권한이 있는 에이전트 중 가장 먼저 만든, 일을 받을 수 있는 에이전트가 맡는다.
        // 대표(O-2)는 대화만 맡는다: 담당 없는 일을 집어 가지 않는다
        const worker = task.agentId
          ? ready.find((a) => a.id === task.agentId)
          : ready.find((a) => !a.lead && task.doableWith(a.scopes));
        const agent = task.agentless ? null : worker;
        if (agent === undefined) continue;
        if (agent && !LeasePolicy.canStart(agent.tool, req.ownLogins, busy)) continue;
        if (agent) busy.push(agent.tool);
        if (scope) held.push(scope);
        task.lease(runnerId, agent?.id ?? null, now);
        const skill = task.skill === null ? null : await packageOf(task.skill);
        const prompt = agent || task.writesNote ? prompts : null;
        const cli = req.cliVersions.get(agent?.tool ?? task.payloadTool ?? '') ?? null;
        const record = new RunRecord(agent ?? null, skill, prompt, req.runnerBuild, cli);
        task.recordRun(runnerId, record, now);
        await tasks.save(task);
        const view = await this.jobOf(actor, tx, task, agent, roster, skill, prompt);
        jobs.push(view.withRun(record.jobView(await tasks.runBefore(task.addedRun))));
      }
      return jobs;
    });
  }

  /**
   * 빌려 준 일 하나. 목표 사슬, 바로 아래 팀(팀원 정보), 깨어난 일이면 하위 작업의 결과와 그 결과물, 스킬의 지금 판을 함께 싣는다
   */
  private async jobOf(
    actor: Actor,
    tx: Sql,
    task: Task,
    agent: Agent | null,
    roster: TeamRoster,
    skill: SkillPackage | null,
    prompt: SkillPackage | null,
  ): Promise<JobView> {
    const goals = task.goalId === null ? [] : await new GoalRepository(tx).chain(task.goalId);
    const children = await new TaskRepository(tx).children(task.id);
    const ids = children.map((c) => c.id);
    const made = await this.outputs.madeBy(actor, ids);
    // 끝나지 않은 하위 작업의 최근 진행 기록 (2026-11-20): 깨어난 팀장이 어디까지 됐는지 보고 나눠 맡긴다
    const open = children.filter((c) => c.open).map((c) => c.id);
    const view = task.jobView(agent, this.box, goals, roster, children, skill?.jobView() ?? null);
    view.withOutputs(made).withProgress(await this.progress.progressOf(actor, open));
    view.withChat(await this.chats.forJob(actor, task.id));
    // 배운 규칙 (2026-11-28): 일꾼의 일에만, 모든 일꾼 · 그 역할 · 그 일의 앱에 맞는 것
    if (agent) view.withRules(await this.rules.forJob(actor, task.spaceId, task.id, agent.preset));
    // 외부 도구 (2차 7단계): 이 에이전트에게 허락한 것만, 토큰은 여기서 풀려 이 일과 함께만 나간다
    const tools = await this.tools.forJob(actor, agent, task.checkedToolId);
    return view.withPrompt(prompt?.jobView() ?? null).withTools(tools);
  }

  private async expire(tx: Sql, now: Date): Promise<number> {
    const tasks = new TaskRepository(tx);
    const expired = await tasks.lockExpired(now, JobService.RECLAIM_BATCH);
    for (const task of expired) {
      task.expire(now);
      await tasks.save(task);
      await this.noteAiTest(tx, task, now);
    }
    return expired.length;
  }

  /**
   * 연결 확인이 끝나면 결과를 로그인에 남긴다. 러너가 사라져 끝난 확인도 실패로 남긴다.
   * 작업에 적힌 판이 아니면 그사이 토큰을 바꾼 것이다: 옛 토큰의 결과를 새 토큰에 적지 않는다.
   */
  private async noteAiTest(tx: Sql, task: Task, now: Date): Promise<void> {
    if (!task.is(Task.AI_TEST) || !task.ended) return;
    const logins = new AiLoginRepository(tx);
    const login = await logins.lockTool(task.spaceId, task.payloadTool ?? '');
    if (login === null || !task.tests(login.version)) return;
    login.noteTest(task.failure, now);
    await logins.save(login);
  }

  /** 쓴 토큰을 한 달 한도에 더한다. 넘기면 에이전트를 멈추고 한도 올리기 결재를 올린다 */
  private async charge(tx: Sql, task: Task, tokens: number, now: Date): Promise<void> {
    if (tokens === 0 || task.agentId === null) return;
    const agents = new AgentRepository(tx);
    const agent = await agents.lock(task.spaceId, task.agentId);
    const used = await agents.usedThisMonth(agent.id, now);
    if (!agent.overLimit(used)) return;
    agent.pause();
    await agents.save(agent);
    await new ApprovalRepository(tx).save(Approval.raiseLimit(agent, used, now));
  }

  /** 구독 사용률을 남긴다. 어느 도구의 값인지는 러너의 말이 아니라 작업의 에이전트로 정한다. 모르는 창은 뺀다 */
  private async notePlan(tx: Sql, task: Task, req: ReportProgressInput, now: Date): Promise<void> {
    if (req.planUsage.length === 0 || task.agentId === null) return;
    const { tool } = await new AgentRepository(tx).load(task.spaceId, task.agentId);
    const seen = PlanUsage.WINDOWS.flatMap((window) => {
      const last = req.planUsage.findLast((p) => p.fields.period === window);
      return last ? [PlanUsage.seen(task.spaceId, tool, last.fields, now)] : [];
    });
    await new PlanUsageRepository(tx).save(seen);
  }

  private async agentPaused(tx: Sql, task: Task): Promise<boolean> {
    if (task.agentId === null) return false;
    return (await new AgentRepository(tx).load(task.spaceId, task.agentId)).paused;
  }

  /** 러너의 공간과 기기 id, 코드 러너 칸인지 (run 권한 기기만 닿는다) */
  private static runnerAt(actor: Actor): readonly [string, string, boolean] {
    if (!actor.spaceId || !actor.id) throw new Forbidden(Actor.RUN);
    return [actor.spaceId, actor.id, actor.inSandbox()];
  }
}
