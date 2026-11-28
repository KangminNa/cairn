import { createHash } from 'node:crypto';

/** 도구를 한 번 부르고 받은 것: 도구 이름 · 입력의 해시 · 결과의 해시 · 오류였는가 */
interface LoopStep {
  tool: string;
  action: string;
  outcome: string;
  error: boolean;
}

/**
 * 맴도는 일꾼 멈추기 (2026-11-28, OpenHands StuckDetector의 기준): AI CLI가 부른 도구와 받은 결과를 보며
 *   같은 도구 · 같은 입력이 같은 결과를 SAME_RESULT번 연달아,
 *   같은 도구 · 같은 입력이 오류를 SAME_ERROR번 연달아,
 *   두 동작을 번갈아 ALTERNATE번 (A B A B A B, 결과도 같음)
 * 하면 맴도는 것으로 본다. 러너는 그때 CLI를 끄고 일을 실패로 끝낸다 (대표가 먼저 깨어 다른 길로 맡긴다).
 * 입력 · 결과는 해시만 비교하고 남기지 않는다. 까닭 글에는 도구 이름만 적는다.
 * Claude는 부름(tool_use)과 결과(tool_result)가 따로 오고, Codex는 끝난 항목에 둘 다 있다
 */
export class LoopWatch {
  static readonly SAME_RESULT = 4;
  static readonly SAME_ERROR = 3;
  static readonly ALTERNATE = 6;
  /** 맴돌아 멈춘 까닭의 머리 (대표에게 가는 실패 까닭에 보인다) */
  static readonly PREFIX = '맴돌아 멈췄어요';

  private readonly steps: LoopStep[] = [];
  private readonly pending = new Map<string, { tool: string; action: string }>();
  private reason: string | null = null;

  /** 맴돌아 멈출 까닭. 아직 아니면 null */
  get stuck(): string | null {
    return this.reason;
  }

  /** 도구를 불렀다 (결과는 id로 나중에 온다) */
  called(id: string, tool: string, input: unknown): void {
    if (id) this.pending.set(id, { tool, action: LoopWatch.hash(tool, input) });
  }

  /** 부른 도구의 결과가 왔다. 모르는 id면 넘어간다 */
  answered(id: string, result: unknown, error: boolean): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    this.push({ ...call, outcome: LoopWatch.hash(result), error });
  }

  /** 부름과 결과를 함께 (끝난 항목에 둘 다 있을 때) */
  done(tool: string, input: unknown, result: unknown, error: boolean): void {
    this.push({
      tool,
      action: LoopWatch.hash(tool, input),
      outcome: LoopWatch.hash(result),
      error,
    });
  }

  private push(step: LoopStep): void {
    this.steps.push(step);
    if (this.steps.length > LoopWatch.ALTERNATE) this.steps.shift();
    this.reason ??= this.check();
  }

  private check(): string | null {
    const last = (n: number) => (this.steps.length >= n ? this.steps.slice(-n) : null);
    const same = (a: LoopStep, b: LoopStep) => a.action === b.action && a.outcome === b.outcome;
    const errors = last(LoopWatch.SAME_ERROR);
    if (errors?.every((s) => s.error && s.action === errors[0]?.action))
      return `${LoopWatch.PREFIX}: 같은 ${errors[0]?.tool} 호출이 오류를 ${LoopWatch.SAME_ERROR}번 냈어요`;
    const repeats = last(LoopWatch.SAME_RESULT);
    const first = repeats?.[0];
    if (repeats && first && repeats.every((s) => same(s, first)))
      return `${LoopWatch.PREFIX}: 같은 ${first.tool} 호출이 같은 결과를 ${LoopWatch.SAME_RESULT}번 냈어요`;
    const turns = last(LoopWatch.ALTERNATE);
    const [a, b] = turns ?? [];
    if (turns && a && b && a.action !== b.action && turns.every((s, i) => same(s, i % 2 ? b : a)))
      return `${LoopWatch.PREFIX}: ${a.tool} · ${b.tool} 호출을 번갈아 ${LoopWatch.ALTERNATE}번 되풀이했어요`;
    return null;
  }

  private static hash(...parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
}
