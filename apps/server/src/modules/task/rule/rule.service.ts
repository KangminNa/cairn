import { Injectable } from '@nestjs/common';
import {
  type Actor,
  Database,
  EntityService,
  Forbidden,
  SettingActor,
  type SettingChangeInput,
  SettingOutcome,
  type Sql,
  SystemActor,
} from '../../platform';
import { SettingChanges } from '../setting-change/setting-change.policy';
import type { LearnedRule } from './rule';
import type { RuleStatusInput } from './rule.input';
import { LearnedRuleQuery } from './rule.query';
import { LearnedRuleRepository } from './rule.repository';
import { RuleEdit } from './rule-edit';
import { RuleMarks } from './rule-marks.policy';

// 배운 규칙 쓰기 (2026-11-28): 관리자의 내리기 · 되살리기(사람이 정한 것이라 바로), 일꾼의 제안을 승인한 바꾸기(설정 바꾸기 rule),
// 관리자의 수정 요청으로 해로움 세기(일꾼). 도움 세기는 판정을 남기는 트랜잭션에서 한다 (VerdictService)
@Injectable()
export class LearnedRuleService extends EntityService<LearnedRule> {
  constructor(
    db: Database,
    private readonly rules: LearnedRuleQuery,
  ) {
    super(db);
  }

  protected store(tx: Sql): LearnedRuleRepository {
    return new LearnedRuleRepository(tx);
  }

  /** 관리자가 내리거나 되살린다. 본 version이 지금과 다르면 409 */
  setStatus(actor: Actor, req: RuleStatusInput): Promise<LearnedRule> {
    return this.changeAsOwner(actor, req, (rule) => rule.changeStatus(req.status, new Date()));
  }

  /** 설정 바꾸기 제안의 미리 해 보기: 같은 줄(RuleEdit)을 지나고 저장하지 않는다 */
  async rehearseSetting(actor: Actor, change: SettingChangeInput): Promise<void> {
    const spaceId = SettingActor.spaceOf(actor);
    await this.transaction(async (tx) => {
      await new RuleEdit(tx, spaceId).apply(change, null, new Date());
    });
  }

  /** 승인한 설정 바꾸기: 결재마다 한 번. 만든 규칙은 그 결재를 근거로 적는다 */
  async applySetting(actor: Actor, change: SettingChangeInput): Promise<void> {
    const spaceId = SettingOutcome.spaceOf(actor, change.key);
    await SettingOutcome.settle(
      (work) => this.transaction(work),
      SettingChanges.TOPIC,
      spaceId,
      change.key,
      async (tx) => {
        const repo = new LearnedRuleRepository(tx);
        for (const rule of await new RuleEdit(tx, spaceId).apply(change, change.key, new Date()))
          await repo.save(rule);
      },
    );
  }

  /**
   * 관리자가 사람으로서 수정 요청했다: 그 일(과 아래 하위 작업)이 따른 규칙마다 해로움 하나. 결재마다 한 번.
   * 새로 센 수를 돌려준다
   */
  async harm(actor: Actor, spaceId: string, approvalId: string): Promise<number> {
    if (!(actor instanceof SystemActor)) throw new Forbidden('system');
    const taskId = await this.rules.revisedTask(actor, spaceId, approvalId);
    if (taskId === null) return 0;
    return this.transaction(async (tx) => {
      const repo = new LearnedRuleRepository(tx);
      const followed = await repo.followedIn(spaceId, taskId);
      const marks = new Map(followed.map((seq) => [seq, RuleMarks.HARMFUL]));
      return repo.mark(spaceId, RuleMarks.approvalSource(approvalId), marks, taskId);
    });
  }
}
