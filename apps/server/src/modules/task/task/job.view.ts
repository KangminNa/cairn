import type { AgentRow, ChatUpdateRow, ExternalToolRow, OutputRow, TaskRow } from '../task.tables';

// 러너 · 에이전트가 MCP로 받는 작업의 모양 (next_jobs · report_progress · submit_result · delegate_task). 도구의 모양이라 snake_case.
// 화면이 받는 모양은 task.view.ts. view끼리는 서로 가져오지 않는다 (경계 검사: view는 표 인터페이스만)

/** 하위 작업이 만든 결과물 한 줄 (깨어난 위 작업에게 보인다) */
export type SubtaskOutputRow = Pick<OutputRow, 'id' | 'task_id' | 'name' | 'kind'>;

/** 일에 실린 모델 · 생각 강도 (payload.runtime): 대화의 회차, 모델을 정해 맡긴 하위 작업 */
function runtimeOf(r: Readonly<TaskRow>): { model?: string; effort?: string } | null {
  return (r.payload as { runtime?: { model?: string; effort?: string } } | null)?.runtime ?? null;
}

/** 위 작업이 정한 결과 형식 (payload.deliver, delegate_task의 deliver, D1). 맡긴 일이 아니거나 없으면 null */
function deliverOf(r: Readonly<TaskRow>): string | null {
  const deliver = (r.payload as { deliver?: unknown } | null)?.deliver;
  return typeof deliver === 'string' && deliver !== '' ? deliver : null;
}

/** 하위 작업을 기다리다 깬 까닭 (payload.wake: all · failed · deadline · owner, 팀원 기다리기 SubtaskWait). 없으면 null */
function wakeOf(r: Readonly<TaskRow>): string | null {
  const wake = (r.payload as { wake?: unknown } | null)?.wake;
  return typeof wake === 'string' ? wake : null;
}

/** 작업의 대상. 없으면 null (task.view.ts와 같은 모양) */
function targetOf(r: Readonly<TaskRow>) {
  return r.target_kind === null
    ? null
    : { kind: r.target_kind, id: r.target_id, version: r.base_version };
}

/** 팀원 한 명의 일 수 (AgentRepository.roster가 읽는 줄): 쥔 일, 최근 7일의 끝냄 · 실패 · 고쳐 달라 · 반려, 허락받았고 켜진 커넥터 */
export interface TeamStatRow {
  agent_id: string;
  open: number;
  done: number;
  failed: number;
  revised: number;
  connectors: readonly string[];
  /**
   * 최근 30일 성적표 (2026-11-20, AgentRepository.scores의 한 줄): judged · first_pass · avg_fixes · decided · sent_back ·
   * tokens_per_done. 러너가 이름으로 읽는다. 없으면 null
   */
  scorecard: Readonly<Record<string, number | null>> | null;
}

/** next_jobs의 일꾼 한 명: 대표가 일을 맡길 수 있는 에이전트 (팀원 정보 D1, TeamRoster. 팀은 2026-11-21에 없앴다) */
export class JobTeamMemberView {
  private stat: Readonly<TeamStatRow> | null = null;

  constructor(
    private readonly row: Readonly<AgentRow>,
    /** 이 팀원에게 맡길 수 있는 일의 종류 */
    private readonly kinds: readonly string[],
  ) {}

  /** 일 수 · 커넥터 · 성적표 (팀원 정보, 2026-11-17) */
  withStats(stat: Readonly<TeamStatRow> | null): this {
    this.stat = stat;
    return this;
  }

  toJSON() {
    const r = this.row;
    const s = this.stat;
    // bound: 정해진 러너에서만 일한다 (관리자의 컴퓨터일 수 있어 그 컴퓨터의 폴더를 읽는 일은 이 팀원에게)
    const bound = Boolean(r.runner_id);
    return {
      agent_id: r.id,
      name: r.name,
      role: r.role,
      /** 역할 일꾼의 열쇠 (delegate_task의 role, 2026-11-28). null이면 예전 일꾼 */
      preset: r.preset ?? null,
      status: r.status,
      kinds: this.kinds,
      bound,
      tool: r.tool,
      open: s?.open ?? 0,
      recent: { done: s?.done ?? 0, failed: s?.failed ?? 0, revised: s?.revised ?? 0 },
      scorecard: s?.scorecard ?? null,
      connectors: s?.connectors ?? [],
    };
  }
}

/** next_jobs의 하위 작업 결과 하나. 깨어난 위 작업이 결과를 모을 때 */
export class JobSubtaskResultView {
  /** 위 작업에게 보이는 결과 글의 길이 */
  private static readonly SUMMARY_MAX = 2000;

  constructor(
    private readonly row: Readonly<TaskRow>,
    /** 맡은 에이전트의 이름 */
    private readonly agent: string | null,
    /** 러너가 낸 결과 글 (앞부분만 내보낸다) */
    private readonly summary: string | null,
    private readonly error: string | null,
  ) {}

  get taskId(): string {
    return this.row.id;
  }

  toJSON() {
    const r = this.row;
    return {
      task_id: r.id,
      title: r.title,
      agent: this.agent,
      status: r.status,
      summary: this.summary?.slice(0, JobSubtaskResultView.SUMMARY_MAX) ?? null,
      error: this.error,
      deliver: deliverOf(r),
      // 끝나지 않은 일(먼저 깨어났을 때): 기다리는 것(approval · subtasks)과 맡긴 때 (러너가 몇 분째인지 센다)
      waiting: r.wait_reason,
      since: r.created_at.toISOString(),
    };
  }
}

/**
 * 러너에게 실어 보내는 스킬 한 판 (next_jobs의 skill_package, 지시문 틀은 prompt_package). 러너는 디스크의 skills/ 대신 이것으로 깐다.
 * source: repo(서버 이미지의 저장소 판) · console(주인이 고친 판, revision은 그 판 번호)
 */
export class JobSkillView {
  constructor(
    readonly name: string,
    private readonly source: string,
    private readonly revision: number | null,
    private readonly hash: string,
    private readonly files: Readonly<Record<string, string>>,
  ) {}

  toJSON() {
    return {
      name: this.name,
      source: this.source,
      revision: this.revision,
      hash: this.hash,
      files: this.files,
    };
  }
}

/**
 * 러너에게 가는 외부 도구 하나 (2차 7단계): 표의 칸에 일을 빌려 줄 때 푼 머리글(토큰)을 더했다.
 * 봉인한 칸을 푸는 것은 엔티티(`ExternalTool.jobView`)다 (객체설계 4장의 예외: 비밀값을 푸는 읽기)
 */
export class JobToolView {
  constructor(
    private readonly row: Readonly<Pick<ExternalToolRow, 'name' | 'title' | 'url'>>,
    /** 푼 머리글. 머리글이 없는 도구는 빈 객체 */
    private readonly headers: Readonly<Record<string, string>>,
    /** 지시문에 싣는 도구 한 줄씩 ("search — 문서 찾기", 2026-11-15 MCP 1단계). MCP 먼저의 순서를 정할 만큼만 */
    private readonly catalog: readonly string[] = [],
  ) {}

  toJSON() {
    const r = this.row;
    return {
      name: r.name,
      title: r.title,
      url: r.url,
      headers: this.headers,
      catalog: this.catalog,
    };
  }
}

/**
 * 이번 실행의 세션 키와 CLI 세션 (기획서 결정 2026-11-17, RunLineage). 작업 세션에 기록하지 않는 일에는 없다.
 * keep: 러너가 CLI 세션 파일을 남겨도 되는지 (브라우저 · 샌드박스 일은 false). resume: 재개할 수 있는 CLI 세션 (서버의 후보,
 * 러너는 세션 파일이 있고 앞 실행이 잘 끝났을 때만 재개한다)
 */
export class JobRunView {
  constructor(
    private readonly lineage: string,
    private readonly keep: boolean,
    private readonly resume: string | null,
  ) {}

  toJSON() {
    return {
      lineage: this.lineage,
      keep: this.keep,
      resume: this.resume === null ? null : { cli_session: this.resume },
    };
  }
}

/**
 * 러너가 빌려 간 일 하나 (next_jobs). MCP 도구의 모양이라 snake_case. run_token은 여기서 한 번만 나간다.
 * 연결 확인(task.kind가 ai_test)에는 에이전트도 run_token도 없다. 어느 도구인지는 task.payload.tool에 있다.
 */
export class JobView {
  constructor(
    private readonly row: Readonly<TaskRow>,
    private readonly skill: string | null,
    private readonly revisionNote: string | null,
    /** bound: 정해진 러너에 묶였다 (Agent.bound), lead: 공간의 대표 (Agent.lead, O-2) */
    private readonly agent: Readonly<
      Pick<AgentRow, 'id' | 'name' | 'role' | 'tool' | 'model' | 'effort'> & {
        bound: boolean;
        lead: boolean;
      }
    > | null,
    private readonly runToken: string | null,
    /** 회사 목표부터 이 작업의 목표까지 (제목) */
    private readonly goalChain: readonly string[],
    /** 바로 아래 팀. 팀이 없으면 비어 있다 */
    private readonly team: readonly JobTeamMemberView[],
    /** 맡긴 하위 작업의 결과. 하위 작업이 끝나 깨어난 일에만 있다 */
    private readonly subtaskResults: readonly JobSubtaskResultView[],
    /** 앞으로 위임할 수 있는 횟수 */
    private readonly roundsLeft: number,
    /** 스킬의 지금 판 (파일까지). 스킬이 없는 일이면 null */
    private readonly skillPackage: JobSkillView | null = null,
  ) {}

  /** 지시문 틀(러너 스킬 moida-runner)의 지금 판. 에이전트 없는 일(연결 확인 · 웹 로그인)은 null */
  private promptPackage: JobSkillView | null = null;

  withPrompt(prompt: JobSkillView | null): this {
    this.promptPackage = prompt;
    return this;
  }

  /** 대화의 일이면 덧붙인 말 · 팀 소식 (러너가 지시문의 단락으로 그린다). 그 밖의 일은 null */
  private chat: JobChatView | null = null;

  withChat(chat: JobChatView | null): this {
    this.chat = chat;
    return this;
  }

  /** 하위 작업마다 만든 결과물 (작업 id → 결과물). 깨어난 위 작업이 결재문의 근거(output_id)로 건다 */
  private made: ReadonlyMap<string, readonly SubtaskOutputRow[]> = new Map();

  withOutputs(made: ReadonlyMap<string, readonly SubtaskOutputRow[]>): this {
    this.made = made;
    return this;
  }

  /** 끝나지 않은 하위 작업마다 최근 진행 기록 (작업 id → 줄, 2026-11-20). 도움 요청 줄도 여기 있다 */
  private progress: ReadonlyMap<string, readonly string[]> = new Map();

  withProgress(progress: ReadonlyMap<string, readonly string[]>): this {
    this.progress = progress;
    return this;
  }

  /** 이 에이전트에게 허락한 외부 도구 (2차 7단계). 러너가 MCP 설정에 더한다. headers에만 토큰이 있다 */
  private tools: readonly JobToolView[] = [];

  withTools(tools: readonly JobToolView[]): this {
    this.tools = tools;
    return this;
  }

  /** 이번 실행의 세션 키 · CLI 세션 (2026-11-17). 기록하지 않는 일은 null */
  private run: JobRunView | null = null;

  withRun(run: JobRunView | null): this {
    this.run = run;
    return this;
  }

  toJSON() {
    const r = this.row;
    const a = this.agent;
    return {
      task: {
        id: r.id,
        kind: r.kind,
        title: r.title,
        payload: r.payload,
        lease_until: r.lease_until?.toISOString() ?? null,
      },
      instruction: r.instruction,
      deliver: deliverOf(r),
      target: targetOf(r),
      skill: this.skill,
      skill_package: this.skillPackage?.toJSON() ?? null,
      prompt_package: this.promptPackage?.toJSON() ?? null,
      chat_updates: this.chat?.toJSON() ?? null,
      revision_note: this.revisionNote,
      // 하위 작업을 기다리다 깬 까닭 (팀원 기다리기). 처음 빌려 가는 일이면 null
      wake: wakeOf(r),
      // bound: 이 러너에 묶인 에이전트 (묶인 일은 그 러너만 빌린다). 러너는 이때만 나눈 폴더를 연다
      // model · effort: AI CLI에 넘길 모델 · 생각 강도. 빈 글이면 CLI의 기본 (2차 7단계).
      // 대화가 정해 둔 것(payload.runtime, 2026-11-15 B)이 있으면 그 회차에는 그것을 쓴다. 하위 작업에는 맡긴 쪽이 고르거나
      // 상한으로 낮춘 모델이 실린다 (ModelTier, 2026-11-19).
      // lead: 대표의 일 (O-2). 러너가 지시문 틀의 lead 단락을 넣는다 (나눠 맡기기 · 설정 제안 · 결과 중심)
      agent:
        a === null
          ? null
          : {
              id: a.id,
              name: a.name,
              role: a.role,
              tool: a.tool,
              model: runtimeOf(r)?.model || a.model,
              effort: runtimeOf(r)?.effort || a.effort,
              bound: a.bound,
              lead: a.lead,
            },
      run_token: this.runToken,
      goal_chain: this.goalChain.map((title) => ({ title })),
      team: this.team.map((m) => m.toJSON()),
      subtask_results: this.subtaskResults.map((s) => ({
        ...s.toJSON(),
        progress: [...(this.progress.get(s.taskId) ?? [])],
        outputs: (this.made.get(s.taskId) ?? []).map((o) => ({
          id: o.id,
          name: o.name,
          kind: o.kind,
        })),
      })),
      rounds_left: this.roundsLeft,
      tools: this.tools.map((t) => t.toJSON()),
      run: this.run?.toJSON() ?? null,
    };
  }
}

/** next_jobs의 답. concurrency: 러너 메뉴에서 정한 동시에 하는 일의 수 (null이면 러너가 띄울 때의 값, 2026-11-20) */
export class NextJobsView {
  constructor(
    private readonly jobs: readonly JobView[],
    private readonly concurrency: number | null = null,
  ) {}

  toJSON() {
    return { jobs: this.jobs.map((j) => j.toJSON()), concurrency: this.concurrency };
  }
}

/** 진행 보고의 답 (report_progress). cancelled면 러너가 작업을 멈춘다 */
export class ProgressView {
  constructor(
    private readonly row: Readonly<TaskRow>,
    private readonly cancelled: boolean,
    /** 에이전트가 멈췄는가 (한도를 넘겼거나 주인이 멈춤). 러너는 release_job으로 돌려줄 수 있다 */
    private readonly paused: boolean,
  ) {}

  toJSON() {
    return {
      status: this.row.status,
      cancelled: this.cancelled,
      paused: this.paused,
      lease_until: this.row.lease_until?.toISOString() ?? null,
    };
  }
}

/** submit_result · release_job의 답 */
export class JobStateView {
  constructor(private readonly row: Readonly<TaskRow>) {}

  toJSON() {
    return { task_id: this.row.id, status: this.row.status };
  }
}

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

/**
 * 대화의 일에 실어 보내는 소식 (next_jobs의 chat_updates, 2차 1-1): 이 회차에 덧붙인 말, 그리고 이 일 아래 팀원이 남긴 소식
 * (중간 보고 · 정한 것 · 가정). 둘 다 자료다: 지시는 관리자의 말(덧붙인 말 포함)뿐이다
 */
export class JobChatView {
  constructor(
    private readonly appended: readonly Readonly<ChatUpdateRow>[],
    private readonly team: readonly Readonly<ChatUpdateRow & { agent: string | null }>[],
  ) {}

  get empty(): boolean {
    return this.appended.length === 0 && this.team.length === 0;
  }

  toJSON() {
    return {
      appended: this.appended.map((u) => ({ n: Number(u.n), text: u.text })),
      team: this.team.map((u) => ({ n: Number(u.n), kind: u.kind, agent: u.agent, text: u.text })),
    };
  }
}
