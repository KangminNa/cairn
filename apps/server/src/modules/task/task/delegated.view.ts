import type { TaskRow } from '../task.tables';

/** delegate_task의 답. 작업은 하위 작업을 기다리므로 에이전트는 여기서 멈춘다 */
export class DelegatedView {
  constructor(
    private readonly subtasks: readonly Readonly<TaskRow>[],
    /** 위 작업이 기다리는 것 (subtasks) */
    private readonly waiting: string,
  ) {}

  toJSON() {
    return {
      subtasks: this.subtasks.map((r) => ({
        task_id: r.id,
        to_agent_id: r.agent_id,
        title: r.title,
        status: r.status,
      })),
      waiting: this.waiting,
    };
  }
}
