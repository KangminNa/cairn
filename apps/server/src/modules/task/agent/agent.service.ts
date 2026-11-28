import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type Actor,
  Database,
  EntityService,
  Idempotency,
  NotFound,
  RuleViolation,
  SettingActor,
  type SettingChangeInput,
  SettingOutcome,
  type Sql,
  type VersionInput,
} from '../../platform';
import { SettingChanges } from '../setting-change/setting-change.policy';
import { Agent } from './agent';
import type { CreateAgentInput, DeleteAgentInput, UpdateAgentInput } from './agent.input';
import { AgentQuery } from './agent.query';
import { AgentRepository } from './agent.repository';
import { AgentEdit } from './agent-edit';
import { AgentRoster } from './agent-roster';

// 에이전트 쓰기: 만들기, 고치기, 멈추기, 다시 시작, 휴지통 · 복원. 모두 주인만.
@Injectable()
export class AgentService extends EntityService<Agent> implements OnApplicationBootstrap {
  private static readonly CREATE = 'create_agent';
  private readonly log = new Logger('AgentService');

  constructor(
    db: Database,
    private readonly agents: AgentQuery,
  ) {
    super(db);
  }

  protected store(tx: Sql): AgentRepository {
    return new AgentRepository(tx);
  }

  /**
   * 서버를 켤 때 대표가 있는 공간마다 역할 일꾼을 갖춘다 (2026-11-28, AgentRoster). 대표의 advisory 잠금 안에서 해
   * 서버와 일꾼이 함께 켜져도 하나만 만든다. 실패하면 로그만 남기고 켜기를 막지 않는다 (다음에 켤 때 다시)
   */
  async onApplicationBootstrap(): Promise<void> {
    const spaces = await this.transaction((tx) => new AgentRepository(tx).leadSpaces());
    for (const spaceId of spaces)
      await this.transaction(async (tx) => {
        const lead = await new AgentRepository(tx).lockLeadSlot(spaceId);
        if (lead) await new AgentRoster(tx, spaceId).ensure(lead, new Date());
      }).catch((error: unknown) =>
        this.log.error(`역할 일꾼을 갖추지 못했어요 (${spaceId}): ${String(error)}`),
      );
  }

  /**
   * 휴지통으로 (기획서 결정 2026-11-14). 진행 중인 작업 · 스케줄 · 도는 목표 실행이 있으면 지우지 않고 까닭을 알린다
   * (조용히 취소하지 않는다)
   */
  async delete(actor: Actor, req: DeleteAgentInput): Promise<Agent> {
    actor.assertOwner();
    const spaceId = actor.requireSpace();
    return this.transaction(async (tx) => {
      const agents = new AgentRepository(tx);
      const agent = await agents.lock(spaceId, req.id);
      agent.assertVersion(req.version);
      // 대표 · 이미 지운 것은 엔티티가 먼저 막는다 (막히면 트랜잭션째 되돌린다)
      agent.delete(new Date());
      const why = await this.agents.blockers(actor, [agent.id]);
      if (why.length > 0) throw new RuleViolation(`삭제할 수 없어요: ${why.join(', ')}`);
      await agents.save(agent);
      return agent;
    });
  }

  /** 휴지통에서 되돌린다 */
  async restore(actor: Actor, req: VersionInput): Promise<Agent> {
    actor.assertOwner();
    const spaceId = actor.requireSpace();
    return this.transaction(async (tx) => {
      const agents = new AgentRepository(tx);
      const agent = (await agents.lockAll(spaceId)).find((a) => a.id === req.id);
      if (!agent) throw new NotFound('에이전트를 찾을 수 없어요');
      agent.assertVersion(req.version);
      agent.restore();
      await agents.save(agent);
      return agent;
    });
  }

  /** 같은 requestId가 다시 오면 처음 만든 에이전트를 돌려준다 */
  async create(actor: Actor, req: CreateAgentInput): Promise<Agent> {
    actor.assertOwner();
    const spaceId = actor.requireSpace();
    return this.transaction(async (tx) => {
      const agents = new AgentRepository(tx);
      const once = new Idempotency(tx, actor.id ?? spaceId, req.requestId, AgentService.CREATE);
      const before = await once.previous();
      if (before) return agents.load(spaceId, String(before.agentId));
      const agent = await new AgentEdit(tx, spaceId).open(req, new Date());
      await agents.save(agent);
      await once.remember({ agentId: agent.id });
      return agent;
    });
  }

  /** 러너 · 검토자의 규칙은 AgentEdit (제안 · 승인 뒤 적용과 같은 줄) */
  async update(actor: Actor, req: UpdateAgentInput): Promise<Agent> {
    actor.assertOwner();
    const spaceId = actor.requireSpace();
    return this.transaction(async (tx) => {
      const agent = await new AgentEdit(tx, spaceId).update(req);
      await new AgentRepository(tx).save(agent);
      return agent;
    });
  }

  /** 설정 바꾸기 제안의 미리 해 보기 (2026-11-15 C · D): 관리자의 고치기와 같은 줄(AgentEdit)을 지나고 저장하지 않는다 */
  async rehearseSetting(actor: Actor, change: SettingChangeInput): Promise<void> {
    const spaceId = SettingActor.spaceOf(actor);
    await this.transaction(async (tx) => {
      await new AgentEdit(tx, spaceId).apply(change, new Date());
    });
  }

  /**
   * 승인한 설정 바꾸기 (2026-11-15 C, SettingApplyHandler): 관리자의 고치기와 같은 줄(AgentEdit).
   * 결재마다 한 번만 적용하고 결과(task.setting.changed)를 남긴다. 승인한 뒤 바뀌었으면 실패로 끝난다
   */
  async applySetting(actor: Actor, change: SettingChangeInput): Promise<void> {
    const spaceId = SettingOutcome.spaceOf(actor, change.key);
    await SettingOutcome.settle(
      (work) => this.transaction(work),
      SettingChanges.TOPIC,
      spaceId,
      change.key,
      async (tx) => {
        const agent = await new AgentEdit(tx, spaceId).apply(change, new Date());
        await new AgentRepository(tx).save(agent);
      },
    );
  }

  pause(actor: Actor, req: VersionInput): Promise<Agent> {
    return this.changeAsOwner(actor, req, (agent) => agent.pause());
  }

  resume(actor: Actor, req: VersionInput): Promise<Agent> {
    return this.changeAsOwner(actor, req, (agent) => agent.resume());
  }
}
