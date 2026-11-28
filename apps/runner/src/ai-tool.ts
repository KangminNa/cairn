import type { AiProcess } from './ai-process';
import type { ConnectorCall } from './connector-calls';
import type { Job } from './job';
import type { JobWorkspace } from './job-workspace';
import type { LineagePlace } from './lineage-store';
import type { PlanWindow, RunEvent } from './progress';
import type { PromptPack } from './prompt-pack';
import type { RunTranscript } from './run-transcript';
import type { SandboxRoom } from './sandbox-room';

/** AI CLI의 출력을 한 줄씩 실행 기록으로 바꾼다. 실행마다 새로 만든다 */
export interface AiStream {
  read(line: string): readonly RunEvent[];
  /** 끝까지 읽은 뒤 어느 기록에도 싣지 못한 것 */
  finish(): readonly RunEvent[];
  /** 마지막 답 */
  readonly finalText: string;
  /** CLI가 실패로 끝냈다면 그 이유 */
  readonly failure: string | null;
  /** 격리가 깨졌으면 그 이유 (허락하지 않은 MCP 서버, 열린 셸). 보이면 바로 끈다 */
  readonly breach: string | null;
  /** 같은 동작을 되풀이해 맴돌면 그 까닭 (LoopWatch, 2026-11-28). 보이면 끄고 일을 실패로 끝낸다 */
  readonly stuck: string | null;
  /** 가장 최근에 본 구독 사용률. 새로 본 것이 없으면 비어 있다 */
  takePlanUsage(): readonly PlanWindow[];
  /** CLI가 알린 모델. 모르면 null */
  readonly model: string | null;
  /** 이 실행에서 커넥터(x-<이름>)를 부른 수 · 실패 (2026-11-15 MCP 1단계). 서버가 마지막 사용 · 실패를 적는다 */
  readonly connectorCalls: readonly ConnectorCall[];
  /** CLI가 알린 세션 id (CLI 세션 재개, 2026-11-17). 모르면 null */
  readonly sessionId: string | null;
  /** 이번 실행의 원문: AI 말 · 부른 도구와 짧은 입력 · 오류 (작업 세션에 쌓는다) */
  readonly transcript: RunTranscript;
}

/**
 * AI 도구 하나 (Claude Code, Codex). 일은 도구와 상관없이 같은 순서로 돈다 (JobRun):
 * 자리 만들기 → 띄우기 → 출력 읽기 → 바뀐 자격 되돌려 쓰기 → 끝 알리기.
 * 도구마다 다른 것만 여기에 둔다: 설정 파일, MCP를 붙이는 법, 셸을 막는 법, 출력 모양, 자격 모양.
 * 엔진 이름에서 어댑터를 고르는 곳은 EngineAdapters 하나다 (engine-adapter.ts).
 * 각 회사의 공식 CLI를 고치지 않고 그대로 띄운다 (구독 로그인을 쓰는 길. 기획서 2026-11-07).
 */
export interface AiTool {
  readonly id: string;
  /** 실행 파일 (실행하지 못했을 때 알리려고) */
  readonly bin: string;
  /**
   * 작업 자리를 만들고 이 도구의 설정을 쓴다. 코드 작업이면 코드 러너 칸의 자리 안에.
   * place: 세션 키의 고정 자리 (CLI 세션을 남기고 재개하는 엔진만, LineageStore). 없으면 일마다 새 임시 자리
   */
  open(job: Job, room?: SandboxRoom | null, place?: LineagePlace | null): Promise<JobWorkspace>;
  /** AI CLI를 띄운다. 지시문은 prompts(지시문 틀)로 채운다 */
  start(
    job: Job,
    workspace: JobWorkspace,
    prompts: PromptPack,
    onLine: (line: string) => void,
  ): AiProcess;
  stream(): AiStream;
  /** 실행하는 동안 CLI가 갱신한 자격. 바뀌지 않았으면 null */
  changedCredential(workspace: JobWorkspace): Promise<string | null>;
  /** 로그와 기록에서 지울 값 (자격 안의 토큰들) */
  readonly secrets: readonly string[];
}
