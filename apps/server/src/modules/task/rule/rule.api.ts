import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { type Actor, CurrentActor } from '../../platform';
import { RuleStatusInput } from './rule.input';
import { LearnedRuleQuery } from './rule.query';
import { LearnedRuleService } from './rule.service';
import type { RuleListView, RuleView } from './rule.view';

// 배운 규칙 (일꾼 › 배운 규칙, 2026-11-28). 관리자만 (Service · Query 첫 줄에서 확인).
// 규칙을 만들고 고치는 것은 일꾼의 제안(propose_setting rule)을 승인해서, 내리기 · 되살리기는 여기서 바로
@Controller('api/rules')
export class RuleController {
  constructor(
    private readonly query: LearnedRuleQuery,
    private readonly service: LearnedRuleService,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<RuleListView> {
    return this.query.list(actor);
  }

  /** 내리기 · 되살리기 { status, version } */
  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RuleView> {
    return (await this.service.setStatus(actor, RuleStatusInput.from(id, body))).view();
  }
}
