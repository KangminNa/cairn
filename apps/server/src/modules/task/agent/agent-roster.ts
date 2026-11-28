import type { Sql } from '../../platform';
import { Agent } from './agent';
import { AgentRepository } from './agent.repository';
import { AgentRoles } from './agent-roles';

/**
 * 공간의 역할 일꾼을 갖춘다 (2026-11-28, AgentRoles · agent-roles.json). 부르는 쪽의 트랜잭션에서, 대표의 advisory 잠금
 * (AgentRepository.lockLeadSlot) 뒤에 부른다: 대표를 처음 만들 때(AgentEdit.lead)와 서버를 켤 때(AgentService) 공간마다.
 * 없는 역할은 대표의 AI 도구로 만들고, 이름 · 역할 설명이 정의 파일과 다르면 맞춘다(설정 판을 쌓는다).
 * 대표에게 검토자가 없고 검토자 역할 일꾼의 AI 도구가 대표와 다르면 짝짓는다 (같은 AI끼리는 검토자가 되지 못한다)
 */
export class AgentRoster {
  constructor(
    private readonly tx: Sql,
    private readonly spaceId: string,
  ) {}

  async ensure(lead: Agent, now: Date): Promise<void> {
    const agents = new AgentRepository(this.tx);
    const have = new Map((await agents.presets(this.spaceId)).map((a) => [a.preset, a]));
    for (const def of AgentRoles.ALL) {
      const found = have.get(def.key);
      if (!found) {
        const made = Agent.openPreset(this.spaceId, def, lead.tool, now);
        await agents.save(made);
        have.set(def.key, made);
      } else if (found.name !== def.name || found.role !== def.role) {
        found.edit(AgentRoles.fieldsOf(def));
        await agents.save(found);
      }
    }
    const reviewer = have.get('reviewer');
    if (reviewer && lead.reviewerId === null && reviewer.tool !== lead.tool) {
      lead.pairReviewer(reviewer);
      await agents.save(lead);
    }
  }
}
