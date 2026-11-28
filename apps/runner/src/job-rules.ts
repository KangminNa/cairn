import type { Json } from './json';
import type { PromptPack } from './prompt-pack';

/**
 * 배운 규칙 (next_jobs의 rules, 2026-11-28): 관리자가 승인한 규칙 가운데 이 일에 맞는 것을 "# 배운 규칙"(틀 rules)으로 싣는다.
 * AI는 따른 규칙을 답 끝에 "따른 규칙: R3"으로 적고, 서버가 그 줄을 떼어 규칙마다 도움 · 해로움을 센다
 */
export class JobRules {
  constructor(readonly rules: readonly { seq: number; body: string }[]) {}

  static from(rules: readonly Json[]): JobRules | null {
    const list = rules
      .map((r) => ({ seq: r.number('seq'), body: r.text('body').trim() }))
      .filter((r) => Number.isInteger(r.seq) && r.seq > 0 && r.body !== '');
    return list.length === 0 ? null : new JobRules(list);
  }

  /** 지시문 단락 (틀 rules) */
  part(prompts: PromptPack): string {
    const rules = this.rules.map((r) => `- [R${r.seq}] ${r.body}`).join('\n');
    return prompts.fill('rules', { rules });
  }
}
