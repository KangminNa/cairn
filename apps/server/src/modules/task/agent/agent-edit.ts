import {
  RuleViolation,
  type SettingChangeInput,
  type SettingShape,
  type Sql,
} from '../../platform';
import { AiLoginRepository } from '../ai/ai-login.repository';
import { Engines } from '../ai/engines';
import { ExternalToolRepository } from '../external-tool/external-tool.repository';
import { RunnerRepository } from '../runner/runner.repository';
import { LeasePolicy } from '../task/lease.policy';
import { Agent } from './agent';
import { CreateAgentInput, UpdateAgentInput } from './agent.input';
import { AgentRepository } from './agent.repository';
import { AgentRoster } from './agent-roster';

/**
 * 에이전트 만들기 · 고치기 한 번을 부르는 쪽의 트랜잭션에서 (2026-11-15 C).
 * 관리자의 고치기(AgentService), 설정 바꾸기 제안의 미리 해 보기(SettingChangeService), 승인 뒤 적용이 같은 줄을 지난다.
 * 필요한 것만 잠그고 읽어 엔티티 메서드를 부른다. 저장은 부르는 쪽이 정한다 (미리 해 보기는 저장하지 않는다)
 */
export class AgentEdit {
  /** 대화로 바꾸는 에이전트 (get_settings team · propose_setting agent, 2026-11-15 C). 굵게: 권한을 더하는 칸 */
  static readonly SETTING: SettingShape = {
    setting: 'agent',
    list: 'team',
    ops: ['create', 'edit', 'pause', 'resume'],
    fields: [
      'name',
      'role',
      'tool',
      'model',
      'effort',
      'approval_actions',
      'reviewer_id',
      'runner_id',
      'external_tools',
      'monthly_limit',
      'five_hour_limit',
      'plan_stop_percent',
    ],
    target: 'id',
    versioned: true,
    grants: ['approval_actions', 'external_tools', 'runner_id'],
  };

  constructor(
    private readonly tx: Sql,
    private readonly spaceId: string,
  ) {}

  /** 새 에이전트 (아직 저장 전) */
  async open(req: CreateAgentInput, now: Date): Promise<Agent> {
    await this.assertKnownTools(req.fields.external_tools);
    const agent = Agent.open(this.spaceId, req.fields, now);
    if (req.runnerId !== null) agent.edit({}, await this.runner(req.runnerId));
    return agent;
  }

  /**
   * 공간의 대표 (O-2). 없으면 만들어 저장한다 (마이그레이션은 에이전트가 있던 공간에만 만들었다: 새 공간은 첫 대화에서).
   * 도구는 서버의 로그인 순서(LeasePolicy.serverTool), 로그인이 없으면 엔진 목록의 첫 줄. 관리자가 설정 › AI에서 바꾼다
   */
  async lead(now: Date): Promise<Agent> {
    const agents = new AgentRepository(this.tx);
    const found =
      (await agents.findLead(this.spaceId)) ?? (await agents.lockLeadSlot(this.spaceId));
    if (found) return found;
    const usable = await new AiLoginRepository(this.tx).usableTools(this.spaceId, now);
    const tool = LeasePolicy.serverTool(usable) ?? Engines.preferred();
    const lead = Agent.openLead(this.spaceId, tool, now);
    await agents.save(lead);
    // 새 공간: 역할 일꾼도 함께 (2026-11-28). 있던 공간은 서버를 켤 때 갖춘다 (AgentService)
    await new AgentRoster(this.tx, this.spaceId).ensure(lead, now);
    return lead;
  }

  /** 그 에이전트만 잠근다. 러너 · 검토자는 같은 공간의 것만 (없으면 404) */
  async update(req: UpdateAgentInput): Promise<Agent> {
    await this.assertKnownTools(req.changes.external_tools);
    const { runnerId, reviewerId, reviewerApproves, secondInspectorId } = req;
    const agents = new AgentRepository(this.tx);
    const agent = await agents.lock(this.spaceId, req.id);
    agent.assertVersion(req.version);
    agent.edit(req.changes, typeof runnerId === 'string' ? await this.runner(runnerId) : runnerId);
    if (reviewerId !== undefined)
      agent.pairReviewer(reviewerId === null ? null : await agents.load(this.spaceId, reviewerId));
    if (reviewerApproves !== undefined) agent.letReviewerApprove(reviewerApproves);
    if (secondInspectorId !== undefined) {
      const load = (id: string | null) => (id === null ? null : agents.load(this.spaceId, id));
      agent.pairSecondInspector(await load(secondInspectorId), await load(agent.reviewerId));
    }
    return agent;
  }

  /**
   * 설정 바꾸기 하나 (2026-11-15 C): 제안의 미리 해 보기와 승인 뒤 적용이 같은 줄.
   * body는 관리자 REST(POST · PATCH api/agents)와 같은 본문, key는 만들기의 requestId (결재 id)
   */
  async apply(change: SettingChangeInput, now: Date): Promise<Agent> {
    const { op, body, version } = change;
    const id = String(change.targetId);
    if (op === 'create')
      return this.open(CreateAgentInput.from({ ...body, requestId: change.key }), now);
    const agent =
      op === 'edit'
        ? await this.update(UpdateAgentInput.from(id, { ...body, version }))
        : await this.toggle(id, version, op === 'pause');
    if (agent.lead) throw new RuleViolation('대표는 관리자가 설정 › AI에서 바꿔요');
    return agent;
  }

  private async toggle(id: string, version: number, pause: boolean): Promise<Agent> {
    const agent = await new AgentRepository(this.tx).lock(this.spaceId, id);
    agent.assertVersion(version);
    if (pause) agent.pause();
    else agent.resume();
    return agent;
  }

  private runner(id: string) {
    return new RunnerRepository(this.tx).load(this.spaceId, id);
  }

  /** 허락할 외부 도구가 공간에 있는가 (2차 7단계). 없는 이름이 있으면 422 */
  private async assertKnownTools(names: readonly string[] | undefined): Promise<void> {
    const missing = names?.length
      ? await new ExternalToolRepository(this.tx).missing(this.spaceId, names)
      : [];
    if (missing.length > 0) throw new RuleViolation(`없는 외부 도구예요: ${missing.join(', ')}`);
  }
}
