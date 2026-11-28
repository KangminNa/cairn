import type { BrowsePlan } from './browser-mcp';
import { ChatTurn } from './chat-turn';
import { CliRuntime } from './cli-runtime';
import { JobLineage } from './job-lineage';
import { type JobNote, JobNotes } from './job-notes';
import { JobRefs, type RefPhotos } from './job-refs';
import { JobRoute } from './job-route';
import { JobTarget } from './job-target';
import type { Json } from './json';
import type { PromptPack } from './prompt-pack';
import { SubtaskResult } from './subtask-result';
import { TeamMember } from './team-member';

/**
 * 서버가 실어 보낸 스킬 한 판 (next_jobs의 skill_package). 러너는 디스크의 skills/ 대신 이것으로 깐다:
 * 콘솔에서 고친 판이 배포 없이 바로 쓰이고, 어느 러너든 같은 판으로 돈다.
 * 서버가 걸렀지만 러너도 경로 모양을 본다 (스킬 폴더 밖에 쓰지 않게). 틀리면 스킬이 없는 것으로 본다
 */
export class SkillPackage {
  static readonly ENTRY = 'SKILL.md';
  private static readonly NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
  private static readonly PATH = /^(SKILL\.md|references\/[a-z0-9][a-z0-9._-]{0,60}\.md)$/;

  private constructor(
    readonly name: string,
    /** repo(저장소 판) · console(콘솔 판) */
    readonly source: string,
    readonly revision: number | null,
    readonly hash: string,
    readonly files: ReadonlyMap<string, string>,
  ) {}

  static from(raw: Json): SkillPackage | null {
    const name = raw.text('name');
    const files = raw.field('files');
    if (!SkillPackage.NAME.test(name) || typeof files !== 'object' || files === null) return null;
    const entries = Object.entries(files as Record<string, unknown>);
    const ok = entries.every(
      ([path, text]) => SkillPackage.PATH.test(path) && typeof text === 'string',
    );
    if (!ok || !entries.some(([path]) => path === SkillPackage.ENTRY)) return null;
    return new SkillPackage(
      name,
      raw.text('source'),
      raw.optionalNumber('revision'),
      raw.text('hash'),
      new Map(entries as [string, string][]),
    );
  }

  /** 로그에 남기는 판: 콘솔 판 N (해시 앞 7자) · 저장소 판 (해시 앞 7자) */
  get label(): string {
    const where = this.source === 'console' ? `콘솔 판 ${this.revision}` : '저장소 판';
    return `${where} (${this.hash.slice(0, 7)})`;
  }

  /** SKILL.md (스킬 폴더를 읽지 못하는 CLI에게 지시문으로 준다) */
  get skillMd(): string {
    return this.files.get(SkillPackage.ENTRY) ?? '';
  }
}

// next_jobs가 빌려 준 일 하나. run_token은 AI CLI의 MCP 설정에만 쓴다.
// 연결 확인(ai_test) · 웹 로그인(ai_signin) · 세션 노트(session_note)에는 에이전트도 run_token도 없다.
// 도구는 작업의 payload에 있고, MCP 없이 지시만 돌린다.
export class Job {
  private static readonly AI_TEST = 'ai_test';
  /** 세션 노트 (2차 4단계): NoteStage가 원문으로 채운 지시문 틀(session-note) 하나를 돌리고 답(JSON)을 vault에 보낸다 */
  private static readonly SESSION_NOTE = 'session_note';
  /** 웹 AI 로그인: 러너가 로그인 명령을 대신 돌린다 (SigninRun) */
  static readonly AI_SIGNIN = 'ai_signin';
  /** 커넥터 확인 (2026-11-15 MCP 1단계): AI 없이 원격 MCP의 도구 목록을 받는다 (ToolCheckRun) */
  private static readonly TOOL_CHECK = 'tool_check';
  /** 서버 브라우저로 하는 일: 어디서 돌지는 러너가 browser_job으로 받고(BrowseStage) Playwright MCP를 붙인다 */
  static readonly BROWSE = 'browse';
  /** 코드 작업: 코드 러너 칸에서 셸로 저장소를 고친다 (docs/코드작업.md) */
  static readonly CODE = 'code';
  /** 만들기 작업: 코드 러너 칸에서 셸로 PPT · 문서 · 영상을 만든다 (결과물 2차) */
  static readonly MAKE = 'make';
  /** 러너가 이름으로 알아보는 종류. 서버의 작업 종류 목록(task-kinds.json)에 다 있어야 한다 (job.test) */
  static readonly KINDS: readonly string[] = [
    Job.AI_TEST,
    Job.SESSION_NOTE,
    Job.AI_SIGNIN,
    Job.TOOL_CHECK,
    Job.BROWSE,
    Job.CODE,
    Job.MAKE,
  ];

  constructor(
    readonly taskId: string,
    readonly kind: string,
    readonly title: string,
    readonly instruction: string,
    readonly target: JobTarget | null,
    readonly skill: string | null,
    readonly revisionNote: string | null,
    readonly agentName: string,
    readonly agentRole: string,
    /** 일을 돌릴 AI 도구 */
    readonly tool: string,
    readonly runToken: string | null,
    readonly leaseUntil: Date | null,
    /** 회사 목표부터 이 일의 목표까지 (제목) */
    readonly goalChain: readonly string[] = [],
    /** 바로 아래 팀. 있으면 delegate_task로 일을 나눠 맡길 수 있다 */
    readonly team: readonly TeamMember[] = [],
    /** 맡긴 하위 작업의 결과 (깨어난 일) */
    readonly subtaskResults: readonly SubtaskResult[] = [],
    /** 앞으로 위임할 수 있는 횟수 */
    readonly roundsLeft = 0,
    /** 브라우저 작업이 도는 곳 (BrowseStage가 붙인다. 그 밖의 일은 null) */
    readonly browse: BrowsePlan | null = null,
    /** 코드 작업의 payload.code 그대로. 모양은 CodeSpec이 본다 (그 밖의 일은 null) */
    readonly codePayload: unknown = null,
    /** 코드 작업에서 AI에게 더 주는 단락 (저장소 · 고칠 곳 · 검사). CodeStage가 붙인다 */
    readonly brief: string | null = null,
    /** 서버가 실어 보낸 스킬 한 판. 옛 서버면 null (그때는 디스크의 skills/에서 이름으로 찾는다) */
    readonly skillPackage: SkillPackage | null = null,
    /** 만들기 작업의 payload.make 그대로 (재료). 모양은 MakeMaterials가 본다 (그 밖의 일은 null) */
    readonly makePayload: unknown = null,
    /** 결과를 페이지로 내보내는 만들기 작업인가 (payload.page). 문(index.html)을 만들어야 하고 웹 검색을 쓴다 */
    readonly page = false,
    /** 대화의 회차 (payload.chat): 앞 대화와 답하는 법. 그 밖의 일은 null */
    readonly chat: ChatTurn | null = null,
    /** 이 러너에 묶인 에이전트의 일 (서버가 알린다). 이때만 이 러너가 나눈 폴더를 연다 (SharedFolders) */
    readonly bound = false,
    /** 서버가 실어 보낸 지시문 틀(moida-runner)의 지금 판. 옛 서버면 null (그때는 러너의 skills/) */
    readonly promptPackage: SkillPackage | null = null,
    /** 에이전트가 정한 모델 · 생각 강도 (2차 7단계). 비면 CLI의 기본 */
    readonly runtime: CliRuntime = CliRuntime.NONE,
    /** 관리자가 대화에 넣은 참조 (payload.refs, 2026-11-15 B) */
    readonly refs: JobRefs = JobRefs.NONE,
    /** 이번 실행의 세션 키 (next_jobs의 run, 2026-11-17). 작업 세션에 기록하지 않는 일은 null */
    readonly lineage: JobLineage | null = null,
    /** 맡긴 팀장이 정한 결과 형식 (위임 계약 D1). 맡긴 일이 아니거나 정하지 않았으면 null */
    readonly deliver: string | null = null,
    /** 결과를 앱 코드의 새 버전으로 내는 만들기 작업인가 (payload.appCode, 스토어 1-6). 받은 코드 위에 바뀐 파일만 낸다 */
    readonly appCode = false,
    /** 공간의 대표의 일 (agent.lead, O-2): 지시문 틀의 lead 단락(나눠 맡기기 · 설정 제안 · 결과 중심)을 넣는다 */
    readonly lead = false,
    /** 하위 작업을 기다리다 깬 까닭 (next_jobs의 wake, 팀원 기다리기). 처음 빌린 일이면 null */
    readonly wake: string | null = null,
    /** 팀장이 맡긴 일인가 (payload.delegatedBy). 아래 팀이 없으면 일이 클 때 ask_help로 도움을 청한다 (2026-11-20) */
    readonly delegated = false,
    /** 지시문에 더할 payload의 단락 (JobNotes: 계획 · 앞 단계의 결과 · 대표의 답 · 이 일의 방법) */
    readonly notes: readonly JobNote[] = [],
  ) {}

  static from(raw: Json): Job {
    const task = raw.child('task');
    const agent = raw.child('agent');
    const target = raw.child('target');
    const payload = task.child('payload');
    const lease = task.optionalText('lease_until');
    return new Job(
      task.text('id'),
      task.text('kind'),
      task.text('title'),
      raw.text('instruction'),
      JobTarget.from(target),
      raw.optionalText('skill'),
      raw.optionalText('revision_note'),
      agent.text('name'),
      agent.text('role'),
      agent.text('tool') || payload.text('tool'),
      raw.optionalText('run_token'),
      lease === null ? null : new Date(lease),
      raw
        .list('goal_chain')
        .map((g) => g.text('title'))
        .filter(Boolean),
      raw.list('team').map((m) => TeamMember.from(m)),
      raw.list('subtask_results').map((r) => SubtaskResult.from(r)),
      raw.number('rounds_left'),
      null,
      task.text('kind') === Job.CODE ? payload.field('code') : null,
      null,
      raw.field('skill_package') ? SkillPackage.from(raw.child('skill_package')) : null,
      task.text('kind') === Job.MAKE ? (payload.field('make') ?? null) : null,
      task.text('kind') === Job.MAKE && Boolean(payload.field('page')),
      ChatTurn.from(payload, raw.field('chat_updates') ? raw.child('chat_updates') : null),
      agent.flag('bound'),
      raw.field('prompt_package') ? SkillPackage.from(raw.child('prompt_package')) : null,
      CliRuntime.from(agent, JobRoute.from(payload)?.skipsConnectors ? [] : raw.list('tools')),
      JobRefs.from(payload),
      JobLineage.from(raw.child('run')),
      raw.optionalText('deliver'),
      task.text('kind') === Job.MAKE && Boolean(payload.field('appCode')),
      agent.flag('lead'),
      raw.optionalText('wake'),
      Boolean(payload.optionalText('delegatedBy')),
      JobNotes.from(payload, raw.list('rules')),
    );
  }

  /** 지시에 단락 하나를 더한 같은 일 (코드 작업의 저장소 단락, 만들기 작업의 재료 단락) */
  withBrief(brief: string): Job {
    return this.withBrowse(this.browse, brief);
  }

  /** 브라우저 작업이 도는 곳과 그 단락(사이트 · 둘러보기)을 더한 같은 일 (BrowseStage) */
  withBrowse(browse: BrowsePlan | null, brief: string): Job {
    return this.copy(this.instruction, browse, brief);
  }

  /** 지시만 바꾼 같은 일 (검사에 떨어져 AI에게 한 번 더 맡길 때. 단락 · 작업 토큰은 그대로) */
  withInstruction(instruction: string): Job {
    return this.copy(instruction, this.browse, this.brief);
  }

  /** 러너가 정한 이번 실행(재개할 세션 · 지난 메모)을 실은 같은 일 (RunRecorder) */
  withLineage(lineage: JobLineage | null): Job {
    return this.copy(this.instruction, this.browse, this.brief, lineage);
  }

  /** 받은 대화의 사진을 참조에 실은 같은 일 (JobPhotos, 대화에 사진 넣기 ②-b) */
  withPhotos(received: RefPhotos): Job {
    return this.copy(this.instruction, this.browse, this.brief, this.lineage, received);
  }

  private copy(
    instruction: string,
    browse: BrowsePlan | null,
    brief: string | null,
    lineage = this.lineage,
    photos: RefPhotos | null = null,
  ): Job {
    return new Job(
      this.taskId,
      this.kind,
      this.title,
      instruction,
      this.target,
      this.skill,
      this.revisionNote,
      this.agentName,
      this.agentRole,
      this.tool,
      this.runToken,
      this.leaseUntil,
      this.goalChain,
      this.team,
      this.subtaskResults,
      this.roundsLeft,
      browse,
      this.codePayload,
      brief,
      this.skillPackage,
      this.makePayload,
      this.page,
      this.chat,
      this.bound,
      this.promptPackage,
      this.runtime,
      photos ? this.refs.withPhotos(photos) : this.refs,
      lineage,
      this.deliver,
      this.appCode,
      this.lead,
      this.wake,
      this.delegated,
      this.notes,
    );
  }

  /** 이 일에 나눠 줄 폴더: 이 러너에 묶인 에이전트의 일에만 (아무 에이전트나 내 파일을 보지 않게). 칸의 일은 늘 없음 */
  sharedFolders<T>(folders: T | null): T | null {
    return this.bound && !this.sandboxed ? folders : null;
  }

  /** 콘솔에 넣은 AI 토큰이 도는지 보는 일 */
  get isAiTest(): boolean {
    return this.kind === Job.AI_TEST;
  }

  /** 세션 노트를 쓰는 일 (NoteStage) */
  get writesNote(): boolean {
    return this.kind === Job.SESSION_NOTE;
  }

  /** 주인이 웹에서 누른 AI 로그인. 도구(tool)는 작업의 payload에 있다 */
  get isAiSignin(): boolean {
    return this.kind === Job.AI_SIGNIN;
  }

  /** 커넥터 확인. 확인할 커넥터 하나가 tools에 실려 온다 */
  get isToolCheck(): boolean {
    return this.kind === Job.TOOL_CHECK;
  }

  /** 서버 브라우저로 하는 일 */
  get isBrowse(): boolean {
    return this.kind === Job.BROWSE;
  }

  /** 저장소를 고치는 일 (코드 러너 칸) */
  get isCode(): boolean {
    return this.kind === Job.CODE;
  }

  /** 파일을 만드는 일 (코드 러너 칸) */
  get isMake(): boolean {
    return this.kind === Job.MAKE;
  }

  /** 셸이 있는 코드 러너 칸에서만 하는 일 (서버의 Task.SANDBOXED와 같다) */
  get sandboxed(): boolean {
    return this.isCode || this.isMake;
  }

  /**
   * AI CLI에게 줄 글. 글은 지시문 틀(prompts, 러너 스킬 moida-runner)에서 오고, 여기서는 어느 단락을 어떤 순서로 넣을지만 정한다.
   * skillReady: 스킬을 CLI의 스킬 폴더에 넣어 두었는가 (Claude).
   * skillText: 스킬 폴더를 읽지 못하는 CLI(셸이 없는 Codex)에게 지시문으로 넣을 SKILL.md.
   * outputsDir: 사람에게 줄 파일을 둘 폴더 (일이 잘 끝나면 러너가 결과물로 올린다).
   * memoPath: 인수인계 메모 파일 (작업 세션에 기록하는 일만). 재개한 실행은 머리글을 앞에 두고 이전 대화를 뺀다
   */
  prompt(
    prompts: PromptPack,
    skillReady: boolean,
    skillText: string | null = null,
    outputsDir: string | null = null,
    memoPath: string | null = null,
  ): string {
    if (this.isAiTest) return this.instruction;
    if (this.writesNote) return this.brief ?? '';
    const parts = [
      this.lineage?.head(prompts) ?? '',
      prompts.fill('intro', { agent: this.agentName, role: this.agentRole }),
      prompts.fill('task', { title: this.title, instruction: this.instruction }),
      this.deliver ? prompts.fill('deliver', { deliver: this.deliver }) : '',
    ].filter(Boolean);
    if (this.chat) parts.push(this.chat.part(prompts, !this.lineage?.resumed));
    if (this.target) {
      const { kind, id, version } = this.target;
      parts.push(
        prompts.fill('target', { kind, id, version: version === null ? null : String(version) }),
      );
    }
    if (this.goalChain.length > 0)
      parts.push(prompts.fill('goal', { chain: this.goalChain.join(' › ') }));
    if (this.revisionNote) parts.push(prompts.fill('revision', { note: this.revisionNote }));
    for (const note of this.notes) parts.push(note.part(prompts));
    if (this.subtaskResults.length > 0)
      parts.push(SubtaskResult.part(prompts, this.subtaskResults, this.wake, this.roundsLeft));
    if (this.brief) parts.push(this.brief);
    if (this.team.length > 0)
      parts.push(
        prompts.fill('team', {
          members: this.team.map((m) => m.line(prompts)).join('\n'),
          rounds: this.roundsLeft,
          // 하위 작업 모델의 상한 (서버 ModelTier): 이 일이 쓰는 모델, 빈 글이면 CLI 기본(구독은 opus)
          ceiling: (this.tool === 'claude' && this.runtime.model) || 'opus',
        }),
      );
    // 대표 (O-2 · O-3 · 스토어 2단계): 이 대화의 id(자동화 찾기), 이미 정해진 받을 것, 대화의 앱
    if (this.lead)
      parts.push(
        prompts.fill('lead', {
          chat: this.chat?.chatId ?? null,
          deliver: this.chat?.deliver ?? null,
          app: this.chat?.appId ?? null,
          // 덧붙인 말의 답: 받을 것은 회차의 것이라 정하지 않는다 (set_deliver는 회차만)
          reply: this.chat?.reply ?? false,
        }),
      );
    if (this.skill && skillReady) parts.push(prompts.fill('skill', { name: this.skill }));
    else if (this.skill && skillText)
      parts.push(prompts.fill('skill', { name: this.skill, text: skillText.trim() }));
    // 도움 요청 (2026-11-20): 대표가 맡긴 일에서만 (일꾼은 맡기지 않고 대표에게 나눌 부분을 알린다, 2026-11-21)
    const help = this.delegated;
    parts.push(prompts.fill('work', { outputs: outputsDir, browse: this.isBrowse, help }));
    // 외부 도구 (2차 7단계): 어댑터가 붙이는 조건과 같다 (MCP가 붙는 일, 셸이 없는 일)
    const tools = this.runToken === null || this.sandboxed ? [] : this.runtime.tools;
    if (tools.length > 0)
      parts.push(
        prompts.fill('tools', {
          names: tools.map((t) => t.server).join(', '),
          list: tools.map((t) => t.promptLines).join('\n'),
        }),
      );
    if (!this.refs.empty) parts.push(this.refs.brief(prompts, this.kind === Job.MAKE));
    if (this.lineage && memoPath) parts.push(this.lineage.part(prompts, memoPath));
    return parts.join('\n\n');
  }
}
