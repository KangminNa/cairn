import type { ChatRow, ChatUpdateRow } from '../task.tables';

// MCP agent_updates · post_update의 모양 (snake_case, docs/API설계.md 4장). 화면(chat.view.ts)과 나눴다 (O-1, 줄 수).
// view끼리는 서로 가져오지 못해서(경계 검사) 줄 모양 둘은 chat.view.ts의 ChatUpdateLine · ChatBoardRow와 같은 모양을 여기에도 둔다.

/** 소식 한 줄 (chat.view.ts의 ChatUpdateLine과 같은 모양) */
type UpdateLine = ChatUpdateRow & { agent: string | null };
/** 상태판의 대화 한 줄 (chat.view.ts의 ChatBoardRow와 같은 모양) */
type BoardLine = ChatRow & { partner: string | null; state: string; active: number };

export class ChatUpdateView {
  constructor(private readonly row: Readonly<UpdateLine>) {}

  toJSON() {
    const r = this.row;
    return {
      n: Number(r.n),
      chat_id: r.chat_id,
      kind: r.kind,
      text: r.text,
      agent: r.agent,
      task_id: r.task_id,
      created_at: r.created_at.toISOString(),
      /** 판단의 모양 (L1, kind decision만, post_update의 decision 그대로). 없으면 null */
      decision: r.data,
    };
  }
}

export class ChatBoardView {
  constructor(private readonly row: Readonly<BoardLine>) {}

  toJSON() {
    const r = this.row;
    return {
      chat_id: r.id,
      title: r.title,
      goal: r.goal,
      project: r.project,
      /** 맡은 에이전트 (맡기 전이면 null, state는 routing · asking) */
      partner: r.partner,
      state: r.state,
      active: Number(r.active),
      turns: r.turns,
      updated_at: r.updated_at.toISOString(),
    };
  }
}

/** agent_updates의 답: 새 소식(n 오름차순), 다음에 보낼 커서, 대화마다의 상태판 */
export class AgentUpdatesView {
  constructor(
    private readonly news: readonly UpdateLine[],
    private readonly cursor: number,
    private readonly board: readonly BoardLine[],
  ) {}

  toJSON() {
    return {
      news: this.news.map((r) => new ChatUpdateView(r).toJSON()),
      cursor: this.cursor,
      board: this.board.map((r) => new ChatBoardView(r).toJSON()),
    };
  }
}

/**
 * ask_agent의 답 (2026-11-27): 대화(콘솔과 같은 모양)에 answer를 더한다. wait_seconds를 주면 그 안에 온 이 대화의 소식 ·
 * 커서 · 상태판(agent_updates와 같은 모양), 답이 오지 않았거나 기다리지 않았으면 null 또는 답 없는 소식만
 */
export class AskedView {
  constructor(
    private readonly chat: { toJSON(): object },
    private readonly answer: AgentUpdatesView | null,
  ) {}

  toJSON() {
    return { ...this.chat.toJSON(), answer: this.answer?.toJSON() ?? null };
  }
}

/** post_update의 답 */
export class PostedUpdateView {
  constructor(
    private readonly n: number,
    /** 판단이 멈춤 기준에 걸려 승인을 올렸으면 (L3) 그 승인과 기한 */
    private readonly stop: { approval_id: string; expires_at: string | null } | null = null,
  ) {}

  toJSON() {
    if (!this.stop) return { n: this.n };
    // 일은 승인을 기다린다: 여기서 실행을 끝내면 고른 안을 받아 다시 시작한다 (지시문의 decided)
    return { n: this.n, waiting: 'approval', ...this.stop };
  }
}

/** set_deliver의 답 (O-3): 이번 회차의 받을 것과 누가 정했는지 (관리자 · 레시피가 정한 대화면 admin) */
export class DeliverSetView {
  constructor(
    private readonly deliver: string,
    private readonly byAdmin: boolean,
  ) {}

  toJSON() {
    return { deliver: this.deliver, by: this.byAdmin ? 'admin' : 'lead' };
  }
}

/** ask_brief의 답: 물은 수. 이 회차는 답을 짧게 쓰고 끝낸다 (관리자의 답이 다음 회차로 온다) */
export class BriefAskedView {
  constructor(private readonly questions: number) {}

  toJSON() {
    return { asked: this.questions, next: 'finish_turn' as const };
  }
}

/**
 * note_progress의 답 (2026-11-28 진행 장부): 진전 없음이 이어진 수와 계획을 다시 세울 때인지.
 * replan이면 set_plan으로 단계 · 하지 말 것을 다시 정하고(완료 조건은 그대로) 다른 길로 맡긴다
 */
export class ProgressNotedView {
  constructor(
    private readonly stalled: number,
    private readonly replan: boolean,
  ) {}

  toJSON() {
    return { stalled: this.stalled, replan: this.replan };
  }
}
