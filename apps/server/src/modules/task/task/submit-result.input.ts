import { BaseRequest } from '../../platform';
import { RuleMarks } from '../rule/rule-marks.policy';

// submit_result의 입력 (러너가 일을 끝낸다). 결과는 자유 형식이고, 하네스 검사(result.checks)만 모양을 본다 (검증 고리 V)
/** submit_result. status는 done · failed, 실패면 error에 이유를 적는다 */
export class SubmitResultInput extends BaseRequest {
  private constructor(
    readonly taskId: string,
    readonly requestId: string,
    readonly status: string,
    readonly result: Readonly<Record<string, unknown>>,
    readonly error: string | null,
  ) {
    super();
  }

  /** 하네스 검사(result.checks)의 수 (검증 고리 V) */
  private static readonly CHECKS_MAX = 20;

  static from(raw: unknown): SubmitResultInput {
    return BaseRequest.read(raw, (f) => {
      const result = SubmitResultInput.followed(f.optionalRecord('result'));
      if (result.rules !== undefined && RuleMarks.seqsOf(result.rules) === null)
        f.reject('result.rules', `규칙 번호(1 이상의 정수) ${RuleMarks.FOLLOWED_MAX}개까지예요`);
      // 결과는 자유 형식이지만 하네스 검사는 결과 카드가 읽으므로 모양을 본다 (검증 고리 V)
      if (result.checks !== undefined) {
        const checks = f.nested('result').nestedList('checks', SubmitResultInput.CHECKS_MAX);
        for (const c of checks) {
          c.text('name', 200);
          c.boolean('ok');
          c.text('how', 80);
          c.boolean('retried');
        }
      }
      return new SubmitResultInput(
        f.uuid('task_id'),
        f.text('request_id', 200),
        f.text('status', 20),
        result,
        f.optionalText('error', 4000),
      );
    });
  }

  /**
   * 따른 배운 규칙 (2026-11-28): 결과 글 끝의 "따른 규칙: R3, R7" 줄을 떼어 result.rules(번호)로 둔다.
   * 러너가 rules를 이미 실었으면 글은 그대로 둔다 (관리자에게 보이는 답에 그 줄이 남지 않게 서버가 뗀다)
   */
  private static followed(result: Readonly<Record<string, unknown>>) {
    if (result.rules !== undefined || typeof result.text !== 'string') return result;
    const { text, seqs } = RuleMarks.split(result.text);
    return seqs.length === 0 ? result : { ...result, text, rules: seqs };
  }
}
