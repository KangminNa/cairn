'use client';

import { useEffect } from 'react';
import { useDevices } from '../_account/live';
import type { Device } from '../_account/types';
import { type ApiReply, api } from '../_lib/client-api';
import { useLiveValue } from '../_lib/use-live';
import type {
  AgentLead,
  AgentList,
  AiTools,
  ApiConnectorList,
  ApprovalPage,
  ChatList,
  ConnectorPresetList,
  Engine,
  EngineList,
  ExternalToolList,
  GoalList,
  GoalRunDetail,
  GoalRunList,
  RuleList,
  Runner,
  RunnerList,
  ScheduleList,
  TaskPage,
  Usage,
} from './types';

// 여러 화면이 함께 쓰는 읽기.

export const TASK_TOPICS = ['task.task.changed'];
/** 작업 줄의 마지막 기록까지 따라간다 */
export const TASK_LOG_TOPICS = [...TASK_TOPICS, 'task.event.added'];
export const APPROVAL_TOPICS = ['task.approval.*'];
/** 목표 실행의 상태 · 회차가 바뀜 (회차 보고는 회차 작업이 끝날 때 함께 보인다) */
export const GOAL_RUN_TOPICS = ['task.goal_run.changed'];
/** 대화 목록: 보내면(task.chat.changed) · 회차 작업이 바뀌면 다시 읽는다 */
export const CHAT_TOPICS = ['task.chat.changed', 'task.task.changed'];
/** 대화의 소식이 쌓임 (변경 신호, agent_updates와 같은 것: 질문 · 맡음도) */
const CHAT_NEWS_TOPICS = ['task.chat.updated'];
/** 대화 목록 (왼쪽 칸): 상태(질문 · 승인)가 소식 · 승인으로도 바뀐다 */
export const CHAT_LIST_TOPICS = [...CHAT_TOPICS, ...CHAT_NEWS_TOPICS, 'task.approval.*'];
/**
 * 대화 하나: 소식 · 승인까지 따라간다. 진행 기록(생각 중… 줄)은 CHAT_LOG_TOPICS로 이 대화에서 도는 작업의 것만
 * (2026-11-24 속도: 공간의 어느 작업이든 기록이 쌓일 때마다 대화 전체를 다시 읽었다)
 */
export const CHAT_DETAIL_TOPICS = [...CHAT_TOPICS, ...CHAT_NEWS_TOPICS, 'task.approval.*'];
/** 실행 기록이 쌓임 (신호의 id는 작업) */
export const CHAT_LOG_TOPICS = ['task.event.added'];
/** 실행 기록이 쌓이면 사용량이 바뀐다 */
export const AGENT_TOPICS = ['task.agent.changed', 'task.event.added'];
/** 외부 도구 (2차 7단계): AI의 제안 · 승인으로 붙음 · 실패 */
const EXTERNAL_TOOL_TOPICS = ['task.external_tool.*', 'task.approval.*'];
/** 구독 사용률이 오거나 실행 기록이 쌓이면 사용량이 바뀐다 */
export const USAGE_TOPICS = ['task.usage.changed', 'task.event.added'];
/** 시간이 지나 창이 끝나는 일에는 신호가 없다. 쉬던 에이전트가 돌아온 것이 보이게 이 간격으로도 읽는다 */
const USAGE_REREAD_MS = 60_000;

/** 대화 목록 (최근 것부터, 상태와 함께. 2차 1-5 왼쪽 칸) */
export function useChats() {
  return useLiveValue('chats', () => api<ChatList>('GET', '/api/chats'), CHAT_LIST_TOPICS);
}

/** 한 앱의 대화 (스토어 2단계: 앱 관리의 개요) */
export function useAppChats(appId: string) {
  return useLiveValue(
    `chats:app:${appId}`,
    () => api<ChatList>('GET', `/api/chats?app=${encodeURIComponent(appId)}`),
    CHAT_LIST_TOPICS,
  );
}

export function useAgents() {
  return useLiveValue('agents', () => api<AgentList>('GET', '/api/agents'), AGENT_TOPICS);
}

/**
 * 공간의 대표 (O-2): 대화의 상대. 목록(useAgents)에는 없다. 첫 대화 전이면 lead가 null.
 * 이번 달 사용량까지 따라가려면 usage (설정 › AI의 대표 칸). 아니면 설정이 바뀔 때만 다시 읽는다
 */
export function useLead({ usage = false }: { usage?: boolean } = {}) {
  return useLiveValue(
    'agent-lead',
    () => api<AgentLead>('GET', '/api/agents/lead'),
    usage ? AGENT_TOPICS : LEAD_TOPICS,
  );
}
/** 대표의 설정 · 상태가 바뀜 */
const LEAD_TOPICS = ['task.agent.changed'];

/** 외부 도구 목록 (설정 › 외부 도구, 에이전트 폼의 허락 칸) */
export function useExternalTools() {
  return useLiveValue(
    'external-tools',
    () => api<ExternalToolList>('GET', '/api/external-tools'),
    EXTERNAL_TOOL_TOPICS,
  );
}

/** 추천 커넥터 (C2): 이미 더한 것은 added. 커넥터가 바뀌면 다시 읽는다 */
export function useConnectorPresets() {
  return useLiveValue(
    'connector-presets',
    () => api<ConnectorPresetList>('GET', '/api/external-tools/presets'),
    EXTERNAL_TOOL_TOPICS,
  );
}

/** API 커넥터 목록 (설정 › 커넥터, 2026-11-24). 제안 · 승인 · 부르기가 바뀌면 다시 읽는다 */
export function useApiConnectors() {
  return useLiveValue(
    'api-connectors',
    () => api<ApiConnectorList>('GET', '/api/api-connectors'),
    API_CONNECTOR_TOPICS,
  );
}
const API_CONNECTOR_TOPICS = ['task.api_connector.*', 'task.api_call.*', 'task.approval.*'];

/** AI 도구마다의 로그인 상태. 연결 확인과 웹 로그인은 작업으로 돌아서 작업이 바뀔 때 다시 읽는다 */
export function useAiTools() {
  return useLiveValue('ai', () => api<AiTools>('GET', '/api/ai'), TASK_TOPICS);
}

/** 엔진 목록 (리팩토링 E1). 서버의 파일이라 바뀌지 않아 신호 없이 한 번 읽는다. 읽기 전에는 빈 목록 */
export function useEngines(): readonly Engine[] {
  return (
    useLiveValue('engines', () => api<EngineList>('GET', '/api/ai/engines'), []).data?.engines ?? []
  );
}

/** 목표 나무. 목표마다 이어진 작업 수가 있어 작업이 바뀔 때도 다시 읽는다 */
export function useGoals() {
  return useLiveValue('goals', () => api<GoalList>('GET', '/api/goals'), TASK_TOPICS);
}

/** 배운 규칙 (2026-11-28): 만들기 · 내리기는 승인 · 콘솔에서 바뀌고, 도움 · 해로움은 판정 · 수정 요청마다 쌓인다 */
export function useRules() {
  return useLiveValue('rules', () => api<RuleList>('GET', '/api/rules'), [
    'task.rule.changed',
    'task.approval.*',
  ]);
}

/** 목표 실행 목록 (최근부터) */
export function useGoalRuns() {
  return useLiveValue(
    'goal-runs',
    () => api<GoalRunList>('GET', '/api/goal-runs'),
    GOAL_RUN_TOPICS,
  );
}

/** 목표 실행 하나와 회차 보고 전부 */
export function useGoalRun(id: string) {
  return useLiveValue(
    `goal-run:${id}`,
    () => api<GoalRunDetail>('GET', `/api/goal-runs/${id}`),
    GOAL_RUN_TOPICS,
    id,
  );
}

export function useUsage() {
  const usage = useLiveValue('usage', () => api<Usage>('GET', '/api/usage'), USAGE_TOPICS);
  const { reload } = usage;
  useEffect(() => {
    const timer = setInterval(() => void reload(), USAGE_REREAD_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return usage;
}

/** 스케줄 목록. 스케줄이 작업을 만들면 오늘 횟수와 다음 시각이 바뀌므로 작업이 바뀔 때도 다시 읽는다 */
export function useSchedules(agentId: string | null) {
  const query = agentId ? `?agentId=${agentId}` : '';
  return useLiveValue(
    `schedules:${agentId ?? ''}`,
    () => api<ScheduleList>('GET', `/api/schedules${query}`),
    TASK_TOPICS,
  );
}

/** 상태 하나의 작업 첫 쪽 (홈과 에이전트의 요약) */
export function useTasksIn(status: string) {
  return useLiveValue(
    `tasks:${status}`,
    () => api<TaskPage>('GET', `/api/tasks?status=${status}`),
    TASK_LOG_TOPICS,
  );
}

/** 결과를 페이지로 내보내는 일 가운데 아직 끝나지 않은 것 (페이지 메뉴의 "만드는 중"). 대기와 실행의 첫 쪽에서 고른다 */
/** 대기 · 실행 중인 작업 (한 작업은 한 번만) */
function useOpenTasks() {
  const running = useTasksIn('running');
  const queued = useTasksIn('queued');
  // 두 목록은 따로 읽는다: 대기에서 실행으로 넘어가는 순간에는 같은 작업이 양쪽에 있을 수 있어 하나만 남긴다
  const byId = new Map(
    [...(queued.data?.tasks ?? []), ...(running.data?.tasks ?? [])].map((t) => [t.id, t]),
  );
  return { tasks: [...byId.values()], error: running.error ?? queued.error };
}

export function usePageTasks() {
  const open = useOpenTasks();
  return { tasks: open.tasks.filter((t) => t.page !== null), error: open.error };
}

/** 이 앱의 코드를 고치는 중인 작업 (스토어 1-6, payload.appCode) */
export function useAppCodeTasks(appId: string) {
  const open = useOpenTasks();
  return { tasks: open.tasks.filter((t) => t.appCode?.appId === appId), error: open.error };
}

export function usePendingApprovals() {
  return useLiveValue(
    'approvals:pending',
    () => api<ApprovalPage>('GET', '/api/approvals?status=pending'),
    APPROVAL_TOPICS,
  );
}

/**
 * 커서 목록을 앞에서부터 pages쪽까지 읽어 하나로 합친다. 신호가 오면 읽어 둔 쪽을 모두 다시 읽는다:
 * 첫 쪽만 읽으면 뒤쪽 줄의 상태가 옛것으로 남고, 거르는 상태를 벗어난 줄이 사라지지 않는다.
 */
export async function readPages<Page extends { next: string | null }>(
  path: string,
  pages: number,
  merge: (before: Page, more: Page) => Page,
): Promise<ApiReply<Page>> {
  const join = path.includes('?') ? '&' : '?';
  let reply = await api<Page>('GET', path);
  for (let i = 1; i < pages && reply.ok && reply.data.next; i++) {
    const before: Page = reply.data;
    const more = await api<Page>('GET', `${path}${join}cursor=${before.next}`);
    reply = more.ok ? { ok: true, data: merge(before, more.data) } : more;
  }
  return reply;
}

/** 목록의 개수. 한 쪽을 넘으면 뒤에 + */
export function countOf(rows: readonly unknown[] | undefined, next: string | null | undefined) {
  if (rows === undefined) return '–';
  return `${rows.length}${next ? '+' : ''}`;
}

/** 러너와 그 기기 (이름은 기기의 것) */
export type RunnerChoice = { runner: Runner; device: Device };

/** 에이전트를 묶을 수 있는 러너: 끊기지 않은 기기의 일반 러너 (코드 러너 칸은 묶을 수 없다) */
export function useRunnerChoices(): readonly RunnerChoice[] {
  const runners = useLiveValue('runners', () => api<RunnerList>('GET', '/api/runners'), []);
  const devices = useDevices();
  const live = new Map(
    (devices.data?.devices ?? []).filter((d) => d.revokedAt === null).map((d) => [d.id, d]),
  );
  return (runners.data?.runners ?? []).flatMap((runner) => {
    const device = live.get(runner.deviceId);
    return device && !runner.sandbox ? [{ runner, device }] : [];
  });
}
