import type { Json } from './json';
import type { PromptPack } from './prompt-pack';

/**
 * 대표가 일을 맡길 수 있는 일꾼 한 명 (위임, 팀은 2026-11-21에 없앴다). 서버가 계산한 일꾼 정보(D1, 2026-11-17)를 함께 받는다:
 * 쥔 일 수 · 최근 7일의 끝냄 · 실패 · 고쳐 달라 · 반려 수 · AI 도구 · 커넥터 · 성적표
 */
export class TeamMember {
  constructor(
    readonly agentId: string,
    readonly name: string,
    readonly role: string,
    readonly status: string,
    readonly kinds: readonly string[],
    /** 정해진 러너(관리자의 컴퓨터일 수 있음)에서만 일한다: 그 컴퓨터의 폴더를 읽는 일은 이 팀원에게 */
    readonly bound = false,
    readonly tool = '',
    /** 대기 · 실행 · 기다림인 작업 수 */
    readonly open = 0,
    /** 최근 7일: 끝냄 · 실패 · 결재에서 고쳐 달라거나 반려된 수 */
    readonly done = 0,
    readonly failed = 0,
    readonly revised = 0,
    /** 허락받았고 켜진 커넥터 */
    readonly connectors: readonly string[] = [],
    /** 최근 30일 성적표 한 줄 (2026-11-20, 예: "첫 판정 통과 3/4 · 평균 고친 횟수 0.25"). 판정 · 결정이 없으면 null */
    readonly score: string | null = null,
    /** 역할 일꾼의 열쇠 (delegate_task의 role, 2026-11-28). 예전 일꾼은 null */
    readonly preset: string | null = null,
  ) {}

  static from(raw: Json): TeamMember {
    const recent = raw.child('recent');
    return new TeamMember(
      raw.text('agent_id'),
      raw.text('name'),
      raw.text('role'),
      raw.text('status'),
      raw.texts('kinds'),
      raw.flag('bound'),
      raw.text('tool'),
      raw.number('open'),
      recent.number('done'),
      recent.number('failed'),
      recent.number('revised'),
      raw.texts('connectors'),
      TeamMember.scoreLine(raw.child('scorecard')),
      raw.optionalText('preset'),
    );
  }

  /**
   * 성적표 한 줄 (서버가 판정 · 관리자 결정 · 토큰으로 계산, 2026-11-20): 첫 판정 통과 · 평균 고친 횟수 · 관리자가 고쳐
   * 달라거나 반려한 수 · 끝낸 일 하나에 든 토큰. 셀 것이 없으면 null
   */
  private static scoreLine(card: Json): string | null {
    const judged = card.number('judged');
    const decided = card.number('decided');
    const fixes = card.optionalNumber('avg_fixes');
    const tokens = card.optionalNumber('tokens_per_done');
    const parts = [
      judged > 0 ? `첫 판정 통과 ${card.number('first_pass')}/${judged}` : '',
      fixes !== null ? `평균 고친 횟수 ${fixes}` : '',
      decided > 0 ? `관리자 반려 · 고쳐 달라 ${card.number('sent_back')}/${decided}` : '',
      tokens !== null ? `일 하나에 토큰 ${tokens}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  /** 지시문의 한 줄 (틀 member). 역할은 첫 줄만 */
  line(prompts: PromptPack): string {
    return prompts.fill('member', {
      name: this.name,
      id: this.agentId,
      preset: this.preset,
      role: this.role.split('\n')[0]?.trim() ?? '',
      kinds: this.kinds.join(', '),
      tool: this.tool,
      open: this.open,
      done: this.done,
      failed: this.failed,
      revised: this.revised,
      connectors: this.connectors.join(', '),
      score: this.score,
      paused: this.status === 'paused',
      bound: this.bound,
    });
  }
}
