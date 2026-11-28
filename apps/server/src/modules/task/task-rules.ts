import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CoreWorkers, SettingKinds } from '../platform';
import { RuleHarmHandler } from './rule/rule.handler';
import { LearnedRuleQuery } from './rule/rule.query';
import { LearnedRuleService } from './rule/rule.service';
import { RuleEdit } from './rule/rule-edit';
import { LessonHandler } from './task/lesson.handler';
import { LessonQuery } from './task/lesson.query';

// 피드백에서 배우기 (2026-11-20)와 배운 규칙 (2026-11-28, ACE의 규칙 목록)을 일꾼 · 설정 바꾸기에 잇는다
// (task.module이 길어지지 않게 TaskConnectors처럼 따로).
//   관리자의 수정 요청 → 배우기 일이 될 만큼 쌓였는지(LessonHandler) · 그 일이 따른 규칙의 해로움(RuleHarmHandler),
//   대표의 제안 propose_setting rule → 승인 뒤 규칙 만들기 · 내리기 · 합치기 (RuleEdit)
@Injectable()
export class TaskRules implements OnModuleInit {
  /** 모듈의 providers에 펼치는 것 */
  static readonly PROVIDERS = [
    TaskRules,
    LessonQuery,
    LessonHandler,
    LearnedRuleQuery,
    LearnedRuleService,
    RuleHarmHandler,
  ] as const;

  constructor(
    private readonly workers: CoreWorkers,
    private readonly kinds: SettingKinds,
    private readonly lessons: LessonHandler,
    private readonly harms: RuleHarmHandler,
    private readonly query: LearnedRuleQuery,
    private readonly rules: LearnedRuleService,
  ) {}

  onModuleInit(): void {
    for (const topic of LessonHandler.TOPICS) this.workers.on(topic, this.lessons);
    for (const topic of RuleHarmHandler.TOPICS) this.workers.on(topic, this.harms);
    this.kinds.register({
      ...RuleEdit.SETTING,
      read: (a) => this.query.settings(a),
      current: async (a, c) => (await this.query.settingNow(a, c))?.toJSON() ?? null,
      rehearse: (a, c) => this.rules.rehearseSetting(a, c),
      apply: (a, c) => this.rules.applySetting(a, c),
    });
  }
}
