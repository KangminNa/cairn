/** 진행 장부 한 줄 (MCP note_progress): 끝났나 · 나아지나 · 맴도나 · 다음은 누가 무엇을 · 까닭 */
export interface LedgerEntry {
  done: boolean;
  progressing: boolean;
  looping: boolean;
  next: string;
  why: string;
}

// 진행 장부 (2026-11-28, Microsoft Magentic-One의 progress ledger): 대표가 하위 작업의 결과를 받고 깬 실행에서 다음 동작
// (다시 맡기기 · 더 기다리기 · 답하기) 전에 한 줄 판단을 남긴다. 진전 없음(나아지지 않음 · 맴돎)이 STALL_LIMIT번 이어지면
// 계획을 다시 세울 때다: 다음 깨움의 지시문에 "계획을 다시 세운다"가 실리고(러너 JobLedger), set_plan을 한 번 더 받는다
// (단계 · 하지 말 것만, 완료 조건은 그대로, TaskPlan.declare). 이어진 수는 작업의 payload.ledger에 둔다. 상태 없음
// biome-ignore lint/complexity/noStaticOnlyClass: 상태 없는 규칙 한 곳. 소식 쓰기(ChatUpdateService) · 계획(TaskPlan)이 쓴다
export class ProgressLedger {
  /** 진전 없음이 이만큼 이어지면 계획을 다시 세운다 */
  static readonly STALL_LIMIT = 3;
  static readonly NEXT_MAX = 300;
  static readonly WHY_MAX = 500;

  /** 진전 없음인가: 아직 끝나지 않았고, 나아지지 않았거나 같은 일을 되풀이한다 */
  static stalls(entry: LedgerEntry): boolean {
    return !entry.done && (!entry.progressing || entry.looping);
  }

  /** 한 줄을 적은 payload: 진전 없음이면 이어진 수 + 1, 아니면 0. replan은 러너가 지시문에 싣는 표시 */
  static record(
    payload: Readonly<Record<string, unknown>>,
    entry: LedgerEntry,
  ): Record<string, unknown> {
    const stalled = ProgressLedger.stalls(entry) ? ProgressLedger.stalled(payload) + 1 : 0;
    return ProgressLedger.with(payload, stalled, { ...entry });
  }

  /** 진전 없음이 이어진 수 */
  static stalled(payload: unknown): number {
    const n = (payload as { ledger?: { stalled?: unknown } } | null)?.ledger?.stalled;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
  }

  /** 계획을 다시 세울 때인가 */
  static replanDue(payload: unknown): boolean {
    return ProgressLedger.stalled(payload) >= ProgressLedger.STALL_LIMIT;
  }

  /** 계획을 다시 세운 뒤: 이어진 수를 처음부터 */
  static replanned(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const last = (payload as { ledger?: { last?: unknown } }).ledger?.last ?? null;
    return ProgressLedger.with(payload, 0, last);
  }

  /** 대화의 소식 (kind progress, 화면의 상태 한 줄): 글과 장부 칸 */
  static said(
    entry: LedgerEntry,
    stalled: number,
  ): { text: string; data: Record<string, unknown> } {
    const text = entry.done
      ? '결과를 모아 답하는 중'
      : stalled >= ProgressLedger.STALL_LIMIT
        ? `진전이 없어 계획을 다시 세우는 중 (${stalled}번 이어짐)`
        : entry.looping
          ? `같은 일이 되풀이돼 방법을 바꾸는 중 · ${entry.next}`
          : `다음: ${entry.next}`;
    return {
      text,
      data: {
        ledger: {
          done: entry.done,
          progressing: entry.progressing,
          looping: entry.looping,
          next: entry.next,
          why: entry.why,
          stalled,
        },
      },
    };
  }

  private static with(
    payload: Readonly<Record<string, unknown>>,
    stalled: number,
    last: unknown,
  ): Record<string, unknown> {
    const replan = stalled >= ProgressLedger.STALL_LIMIT;
    return { ...payload, ledger: { stalled, replan, last } };
  }
}
