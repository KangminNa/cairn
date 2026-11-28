import { Injectable } from '@nestjs/common';
import { BaseHandler, type DomainEvent, SystemActor } from '../../platform';
import { LearnedRuleService } from './rule.service';

// 배운 규칙의 해로움 세기 (2026-11-28): 관리자가 수정 요청하면 그 일이 따른 규칙마다 해로움 하나 (LearnedRuleService.harm).
// 두 번 불려도 결재마다 한 번이다 (rule_marks의 근거)
@Injectable()
export class RuleHarmHandler extends BaseHandler {
  static readonly TOPICS: readonly string[] = ['task.approval.revision_requested'];

  constructor(private readonly rules: LearnedRuleService) {
    super();
  }

  async handle(event: DomainEvent): Promise<void> {
    const { approvalId } = event.data;
    if (typeof approvalId !== 'string') return;
    await this.rules.harm(new SystemActor(), event.spaceId, approvalId);
  }
}
