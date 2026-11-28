import type { AiStream } from './ai-tool';
import { type ConnectorCall, ConnectorCalls } from './connector-calls';
import { Json } from './json';
import { LoopWatch } from './loop-watch';
import { PlanWindow, RunEvent } from './progress';
import { RunTranscript } from './run-transcript';

// claude -p --output-format stream-json의 줄을 실행 기록으로 바꾼다. 한 줄 = JSON 객체 하나.
//   system(init)  →  붙은 MCP 서버를 본다
//   assistant     →  tool_use마다 read·write. 글은 마지막 답으로 기억한다
//   user          →  실패한 tool_result는 error
//   result        →  마지막 답과 남은 토큰. 실패면 error
//   rate_limit_event → 구독 사용률. 기록이 아니라 가장 최근 값만 기억한다
//
// 토큰: input + cache_creation + output. cache_read는 값이 매우 싸고 턴마다 다시 세어져 한도에 넣지 않는다.
// assistant 줄은 내용 블록마다 하나씩 나오고 같은 message.id에 같은 usage를 싣는다. 그래서 id별로 늘어난 만큼만 센다.
// 하위 에이전트까지 든 정확한 합은 result의 modelUsage에 있어서, 끝에서 모자란 만큼을 더한다.
// 인수인계 메모 (2026-11-28 고침): 답을 마치려다 Stop 훅에 막혀 메모를 쓰면, 그 뒤의 글("메모를 썼어요")이 마지막 답이 되어
// 진짜 답을 덮었다. 그래서 메모 쓰기가 마지막 도구면, 메모 전에 도구 없이 끝낸 글(끝내려던 답)이 더 길 때 그것을 답으로 둔다
export class ClaudeStream implements AiStream {
  /** 늘 허락하는 MCP 서버. 브라우저 작업에서만 playwright를 더한다 (BrowserMcp) */
  static readonly SERVER = 'moida';
  private static readonly SERVER_PREFIX = `mcp__${ClaudeStream.SERVER}__`;
  private static readonly BROWSER_PREFIX = 'mcp__playwright__';
  private static readonly READ_TOOLS: ReadonlySet<string> = new Set([
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'search_sessions',
    'get_session',
    'neighbors',
    'blog_get_post',
    'browser_snapshot',
    'browser_navigate',
    'browser_take_screenshot',
    'browser_tabs',
  ]);
  /** tool_use 입력에서 대상으로 보여 줄 칸. 내용은 남기지 않는다 */
  private static readonly TARGETS = ['file_path', 'path', 'pattern', 'query', 'url', 'command'];
  private static readonly SHELL = 'Bash';

  private readonly countedByMessage = new Map<string, number>();
  /** 커넥터(x-<이름>)를 부른 수 · 실패 */
  private readonly calls = new ConnectorCalls();
  /** 같은 동작을 되풀이하는지 (부름 → 결과를 짝지어 본다) */
  private readonly loops = new LoopWatch();
  private counted = 0;
  /** 아직 어느 기록에도 싣지 않은 토큰 */
  private owed = 0;
  private lastText = '';
  private resultText: string | null = null;
  private failureText: string | null = null;
  private strayServers: readonly string[] = [];
  private modelName: string | null = null;
  /** 셸을 열지 않은 일에서 셸을 쓴 명령 (설정이 먹지 않은 것) */
  private shellUsed: string | null = null;
  private planWindows: readonly PlanWindow[] = [];
  /** 지금 읽는 assistant 메시지 (내용 블록마다 줄이 따로 온다): id · 글 · 도구를 썼는지 */
  private msg = { id: '', text: '', tools: false };
  /** 도구 없이 글만 쓰고 끝낸 마지막 메시지의 글 (끝내려던 답) */
  private lastFinish: string | null = null;
  /** 메모를 쓰기 직전의 끝내려던 답, 메모 쓰기가 마지막 도구인가 */
  private memoAnswer: string | null = null;
  private memoLast = false;
  private session: string | null = null;
  readonly transcript = new RunTranscript();

  constructor(
    /** 이 실행에서 허락한 MCP 서버. 그 밖의 서버가 보이면 격리가 깨진 것 */
    private readonly servers: readonly string[] = [ClaudeStream.SERVER],
    /** 셸을 연 일인가 (코드 러너 칸의 코드 · 만들기 작업). 아니면 셸이 보일 때 격리가 깨진 것 */
    private readonly shellAllowed = false,
    /** 인수인계 메모 파일 (메모를 쓰는 일만) */
    private readonly memoPath: string | null = null,
  ) {}

  /** 마지막 답 */
  get finalText(): string {
    return this.answer(this.resultText ?? this.lastText);
  }

  /** 메모 쓰기로 끝났으면 메모 전에 끝내려던 답이 더 길 때 그것 (위 설명) */
  private answer(text: string): string {
    const before = this.memoLast ? this.memoAnswer : null;
    return before !== null && before.trim().length > text.trim().length ? before : text;
  }

  /** 내용 블록 하나를 메시지별로 모은다. 새 메시지가 시작되면 앞 메시지가 글만 썼는지 본다 */
  private noteBlock(id: string, text: string | null, tool: boolean): void {
    if (id !== this.msg.id) {
      if (this.msg.text && !this.msg.tools) this.lastFinish = this.msg.text;
      this.msg = { id, text: '', tools: false };
    }
    if (text) this.msg.text += (this.msg.text ? '\n\n' : '') + text;
    if (tool) this.msg.tools = true;
  }

  /** CLI가 실패로 끝냈다면 그 이유 */
  get failure(): string | null {
    return this.failureText;
  }

  /** CLI가 처음에 알린 모델 (system/init). 모르면 null */
  get model(): string | null {
    return this.modelName;
  }

  /** 허락하지 않은 MCP 서버 이름들. 있으면 격리가 깨진 것이다 */
  get stray(): readonly string[] {
    return this.strayServers;
  }

  get breach(): string | null {
    if (this.strayServers.length > 0)
      return `허락하지 않은 MCP 서버: ${this.strayServers.join(', ')}`;
    return this.shellUsed === null ? null : `셸이 열려 있어요: ${this.shellUsed}`;
  }

  get stuck(): string | null {
    return this.loops.stuck;
  }

  /** 가장 최근에 본 구독 사용률을 꺼낸다. 새로 본 것이 없으면 비어 있다 */
  takePlanUsage(): readonly PlanWindow[] {
    const windows = this.planWindows;
    this.planWindows = [];
    return windows;
  }

  /** CLI가 처음에 알린 세션 id (system/init). 모르면 null */
  get sessionId(): string | null {
    return this.session;
  }

  /** 한 줄을 읽는다. JSON이 아니거나 모르는 줄은 넘어간다. 만든 기록은 원문에도 남긴다 */
  read(line: string): readonly RunEvent[] {
    const events = this.parse(line);
    this.transcript.did(events);
    return events;
  }

  private parse(line: string): readonly RunEvent[] {
    const event = Json.parse(line);
    if (event === null) return [];
    switch (event.text('type')) {
      case 'system':
        return this.system(event);
      case 'assistant':
        return this.assistant(event);
      case 'user':
        return this.user(event);
      case 'result':
        return this.result(event);
      case 'rate_limit_event':
        return this.rateLimit(event);
      default:
        return [];
    }
  }

  /** 끝까지 읽은 뒤 어느 기록에도 싣지 못한 토큰 (도중에 멈춘 실행) */
  finish(): readonly RunEvent[] {
    return this.owed > 0 ? [new RunEvent(RunEvent.READ, '', this.takeOwed())] : [];
  }

  private system(event: Json): readonly RunEvent[] {
    const subtype = event.text('subtype');
    if (subtype === 'api_retry') {
      const tries = `${event.number('attempt')}/${event.number('max_retries')}`;
      return [new RunEvent(RunEvent.ERROR, `API 재시도 ${tries}: ${event.text('error')}`, 0)];
    }
    if (subtype !== 'init') return [];
    this.modelName = event.optionalText('model') ?? this.modelName;
    this.session = event.optionalText('session_id') ?? this.session;
    const servers = event.list('mcp_servers');
    this.strayServers = servers
      .map((server) => server.text('name'))
      .filter((name) => !this.servers.includes(name));
    const broken = servers.filter(
      (server) => server.text('name') === ClaudeStream.SERVER && server.text('status') === 'failed',
    );
    return broken.length > 0 ? [new RunEvent(RunEvent.ERROR, 'moida MCP에 붙지 못했어요', 0)] : [];
  }

  private assistant(event: Json): readonly RunEvent[] {
    const message = event.child('message');
    this.count(message);
    const events: RunEvent[] = [];
    const id = message.text('id');
    for (const block of message.list('content')) {
      if (block.text('type') === 'text') {
        this.noteBlock(id, block.text('text'), false);
        this.lastText = block.text('text') || this.lastText;
        this.transcript.said(block.text('text'));
      } else if (block.text('type') === 'tool_use') {
        const name = block.text('name');
        this.noteBlock(id, null, true);
        const memo =
          this.memoPath !== null && block.child('input').text('file_path') === this.memoPath;
        if (memo && !this.memoLast) this.memoAnswer = this.lastFinish;
        this.memoLast = memo;
        this.calls.called(ConnectorCalls.serverOf(name) ?? '', block.text('id'));
        this.loops.called(block.text('id'), ClaudeStream.shortName(name), block.field('input'));
        if (name === ClaudeStream.SHELL && !this.shellAllowed)
          this.shellUsed ??= block.child('input').text('command') || '(명령)';
        const kind = ClaudeStream.kindOf(name);
        events.push(
          new RunEvent(kind, ClaudeStream.describe(name, block.child('input')), this.takeOwed()),
        );
      }
    }
    return events;
  }

  private user(event: Json): readonly RunEvent[] {
    const results = event
      .child('message')
      .list('content')
      .filter((block) => block.text('type') === 'tool_result');
    for (const block of results)
      this.loops.answered(
        block.text('tool_use_id'),
        block.field('content'),
        block.flag('is_error'),
      );
    const failed = results.filter((block) => block.flag('is_error'));
    for (const block of failed)
      this.calls.failed(block.text('tool_use_id'), ClaudeStream.resultBody(block));
    return failed.map((block) => new RunEvent(RunEvent.ERROR, ClaudeStream.resultBody(block), 0));
  }

  get connectorCalls(): readonly ConnectorCall[] {
    return this.calls.lines;
  }

  private result(event: Json): readonly RunEvent[] {
    this.settle(event);
    const text = event.text('result');
    if (event.flag('is_error') || event.text('subtype').startsWith('error')) {
      this.failureText = text || event.texts('errors').join('\n') || event.text('subtype');
      return [new RunEvent(RunEvent.ERROR, this.failureText, this.takeOwed())];
    }
    this.resultText = this.answer(text || this.lastText);
    return [new RunEvent(RunEvent.RESULT, this.resultText, this.takeOwed())];
  }

  /** 쓸 수 있는 창이 하나도 없으면 앞의 값을 지킨다 */
  private rateLimit(event: Json): readonly RunEvent[] {
    const windows = PlanWindow.listFrom(event.child('rate_limit_info'));
    if (windows.length > 0) this.planWindows = windows;
    return [];
  }

  /** assistant 줄의 usage에서 이 메시지가 늘어난 만큼만 센다 */
  private count(message: Json): void {
    const usage = message.child('usage');
    const tokens = ClaudeStream.tokensOf(
      usage.number('input_tokens'),
      usage.number('cache_creation_input_tokens'),
      usage.number('output_tokens'),
    );
    const id = message.text('id');
    const before = id ? (this.countedByMessage.get(id) ?? 0) : 0;
    if (id) this.countedByMessage.set(id, Math.max(before, tokens));
    this.owe(Math.max(0, tokens - before));
  }

  /** result의 합계와 비교해 모자란 토큰을 더한다 */
  private settle(event: Json): void {
    const models = event.child('modelUsage').values();
    const usage = event.child('usage');
    const total =
      models.length > 0
        ? models.reduce(
            (sum, model) =>
              sum +
              ClaudeStream.tokensOf(
                model.number('inputTokens'),
                model.number('cacheCreationInputTokens'),
                model.number('outputTokens'),
              ),
            0,
          )
        : ClaudeStream.tokensOf(
            usage.number('input_tokens'),
            usage.number('cache_creation_input_tokens'),
            usage.number('output_tokens'),
          );
    this.owe(Math.max(0, total - this.counted));
  }

  private owe(tokens: number): void {
    this.counted += tokens;
    this.owed += tokens;
  }

  private takeOwed(): number {
    const tokens = this.owed;
    this.owed = 0;
    return tokens;
  }

  private static tokensOf(input: number, cacheCreation: number, output: number): number {
    return Math.max(0, Math.trunc(input + cacheCreation + output));
  }

  private static shortName(name: string): string {
    const prefix = [ClaudeStream.SERVER_PREFIX, ClaudeStream.BROWSER_PREFIX].find((p) =>
      name.startsWith(p),
    );
    return prefix ? name.slice(prefix.length) : name;
  }

  /** 모르는 도구는 쓰기로 본다: 무언가 바꿨을 수 있다 */
  private static kindOf(name: string): string {
    return ClaudeStream.READ_TOOLS.has(ClaudeStream.shortName(name))
      ? RunEvent.READ
      : RunEvent.WRITE;
  }

  private static describe(name: string, input: Json): string {
    const target = ClaudeStream.TARGETS.map((key) => input.text(key)).find((value) => value);
    return target ? `${ClaudeStream.shortName(name)} ${target}` : ClaudeStream.shortName(name);
  }

  /** tool_result의 content는 글이거나 블록 목록이다 */
  private static resultBody(block: Json): string {
    return (
      block.text('content') ||
      block
        .list('content')
        .map((part) => part.text('text'))
        .join('\n')
    );
  }
}
