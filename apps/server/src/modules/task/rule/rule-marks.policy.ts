// 배운 규칙의 도움 · 해로움 세기 (2026-11-28, ACE의 helpful · harmful). 상태 없음.
// 일꾼은 답 끝에 "따른 규칙: R3, R7" 한 줄을 적고(지시문 틀 rules), 서버가 submit_result에서 그 줄을 떼어 result.rules(번호)로 둔다.
// 검토자는 판정 JSON의 rules에 번호마다 helpful · harmful을 적을 수 있다 (틀 result-review). 둘 다 AI가 쓴 글이라 모양을 믿지 않는다:
// 번호가 아니거나 너무 많으면 버린다. 세는 근거(source)는 판정 작업 · 결재마다 하나라 두 번 와도 한 번만 센다
// biome-ignore lint/complexity/noStaticOnlyClass: 상태 없는 판단 한 곳. 결과 받기 · 판정 · 수정 요청이 함께 쓴다
export class RuleMarks {
  static readonly HELPFUL = 'helpful';
  static readonly HARMFUL = 'harmful';
  /** 일 하나가 따랐다고 적는 규칙 수 */
  static readonly FOLLOWED_MAX = 20;
  /** 규칙 번호의 상한 (공간마다 이보다 많이 만들 일은 없다) */
  private static readonly SEQ_MAX = 1_000_000;
  /** 답 끝의 따른 규칙 줄: "따른 규칙: R3, R7" (쉼표 · 가운뎃점 · 띄어쓰기로 나눈다) */
  private static readonly LINE = /^[ \t]*따른 규칙[ \t]*[:：][ \t]*((?:R\d+[ \t,·]*)+)[ \t]*$/m;

  /** 판정 작업 하나의 근거 */
  static verdictSource(judgeTaskId: string): string {
    return `verdict:${judgeTaskId}`;
  }

  /** 관리자의 수정 요청 하나의 근거 */
  static approvalSource(approvalId: string): string {
    return `approval:${approvalId}`;
  }

  /** 받은 번호 목록 (result.rules): 1 이상의 정수만, 겹친 것은 하나로, FOLLOWED_MAX개까지. 모양이 틀리면 null */
  static seqsOf(value: unknown): number[] | null {
    if (!Array.isArray(value) || value.length > RuleMarks.FOLLOWED_MAX) return null;
    const seqs = value.filter(
      (v): v is number => Number.isInteger(v) && v >= 1 && v <= RuleMarks.SEQ_MAX,
    );
    return seqs.length === value.length ? [...new Set(seqs)] : null;
  }

  /** 결과 글에서 따른 규칙 줄을 떼어 낸다: 남은 글과 번호. 줄이 없으면 그대로와 빈 목록 */
  static split(text: string): { text: string; seqs: number[] } {
    const found = RuleMarks.LINE.exec(text);
    if (!found) return { text, seqs: [] };
    const seqs = [...(found[1] ?? '').matchAll(/R(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 1 && n <= RuleMarks.SEQ_MAX);
    const rest = `${text.slice(0, found.index)}${text.slice(found.index + found[0].length)}`;
    return {
      text: rest.replace(/\n{3,}/g, '\n\n').trimEnd(),
      seqs: [...new Set(seqs)].slice(0, RuleMarks.FOLLOWED_MAX),
    };
  }

  /** 검토자가 판정 JSON의 rules에 적은 표시: 번호 → helpful · harmful. 못 읽는 줄은 버린다 */
  static fromReview(text: string): Map<number, string> {
    const marks = new Map<number, string>();
    const json = RuleMarks.jsonOf(text);
    const rules = Array.isArray(json?.rules) ? json.rules.slice(0, RuleMarks.FOLLOWED_MAX) : [];
    for (const line of rules) {
      const row = (line ?? {}) as { id?: unknown; mark?: unknown };
      const seq = typeof row.id === 'string' ? Number(/^R(\d+)$/i.exec(row.id.trim())?.[1]) : NaN;
      if (!Number.isInteger(seq) || seq < 1) continue;
      if (row.mark === RuleMarks.HELPFUL || row.mark === RuleMarks.HARMFUL)
        marks.set(seq, row.mark);
    }
    return marks;
  }

  /**
   * 판정 하나로 셀 표시: 검토자가 적은 것은 그대로, 따른 규칙 가운데 적지 않은 것은 통과면 도움.
   * 따르지 않은 규칙에 적은 표시도 센다 (검토자가 "이 규칙을 따랐으면 좋았다"고 본 것)
   */
  static ofVerdict(
    followed: readonly number[],
    passed: boolean,
    reviewed: ReadonlyMap<number, string>,
  ): Map<number, string> {
    const marks = new Map(reviewed);
    if (passed) for (const seq of followed) if (!marks.has(seq)) marks.set(seq, RuleMarks.HELPFUL);
    return marks;
  }

  /** 글 안의 JSON 한 덩어리 (검토의 답은 JSON 한 줄이지만 앞뒤에 글이 붙기도 한다) */
  private static jsonOf(text: string): Record<string, unknown> | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
