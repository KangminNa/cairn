import type { Json } from './json';
import type { PromptPack } from './prompt-pack';

/**
 * 계획을 다시 세울 때 (2026-11-28 진행 장부): 대표가 note_progress로 남긴 진전 없음이 이어져 서버가 payload.ledger.replan을
 * 켰으면, 깬 실행의 지시문에 "계획을 다시 세운다"를 싣는다 (틀 ledger). 이어진 수(stalled)와 마지막 판단의 다음 할 일을 함께
 */
export class JobLedger {
  constructor(
    private readonly stalled: number,
    private readonly next: string,
  ) {}

  static from(payload: Json): JobLedger | null {
    if (!payload.field('ledger')) return null;
    const ledger = payload.child('ledger');
    if (!ledger.flag('replan')) return null;
    return new JobLedger(ledger.number('stalled'), ledger.child('last').text('next'));
  }

  part(prompts: PromptPack): string {
    return prompts.fill('ledger', { stalled: String(this.stalled), next: this.next || null });
  }
}
