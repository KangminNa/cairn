import { BaseRequest } from '../../platform';

/** 관리자가 콘솔에서 규칙을 내리거나 되살린다 (PATCH api/rules/:id { status, version }) */
export class RuleStatusInput extends BaseRequest {
  private constructor(
    readonly id: string,
    readonly version: number,
    readonly status: string,
  ) {
    super();
  }

  static from(id: string, raw: unknown): RuleStatusInput {
    return BaseRequest.read(
      { ...(raw as object), id },
      (f) => new RuleStatusInput(f.uuid('id'), f.version(), f.text('status', 20)),
    );
  }
}
