// 자동으로 만든 파일이라 고치지 않는다. 마이그레이션 뒤 pnpm db:rows로 다시 만든다 (scripts/db-rows.mjs).
// 조건 규칙(platform/base의 TableQuery)이 쓰는 Drizzle 표: 표 이름 · 칸 · 행 타입. 칸 이름은 DB 그대로다.
// drizzle-orm을 직접 가져오는 곳은 이 생성 파일들과 platform/base뿐이다 (모듈 경계 검사).
import { bigint, boolean, customType, integer, jsonb, pgSchema, real, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AgentEffort, AgentScope, AgentStatus, AgentTool, AiLoginTool, ApiCallEffect, ApiCallHeldReason, ApiCallStatus, ApiConnectorStatus, ApprovalStatus, ChatDeliver, ChatEffort, ChatStopMode, ChatUpdateKind, ExternalToolAuth, ExternalToolStatus, GoalRunCheckpoint, GoalRunStatus, GoalStatus, LearnedRuleScope, LearnedRuleStatus, OutputKind, PlanUsagePeriod, PlanUsageStatus, PlanUsageTool, RuleMarkMark, ScheduleDeliver, ScheduleDestination, ScheduleMode, ScheduleTrigger, TaskEventKind, TaskRunPromptSource, TaskRunSkillSource, TaskStatus, TaskWaitReason, VerdictKind, VerdictVerdict } from './task.tables';

const byteaColumn = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const xid8Column = customType<{ data: string }>({ dataType: () => 'xid8' });
const taskSchema = pgSchema('task');

/** task.agent_revisions */
export const agentRevisions = taskSchema.table('agent_revisions', {
  id: uuid('id').notNull(),
  agent_id: uuid('agent_id').notNull(),
  revision: integer('revision').notNull(),
  settings: jsonb('settings').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** task.agents */
export const agents = taskSchema.table('agents', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  tool: text('tool').$type<AgentTool>().notNull(),
  scopes: text('scopes').array().$type<AgentScope[]>().notNull(),
  approval_actions: text('approval_actions').array().notNull(),
  monthly_limit: bigint('monthly_limit', { mode: 'number' }),
  status: text('status').$type<AgentStatus>().notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  five_hour_limit: bigint('five_hour_limit', { mode: 'number' }),
  plan_stop_percent: integer('plan_stop_percent'),
  settings_revision: integer('settings_revision').notNull(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  runner_id: uuid('runner_id'),
  reviewer_id: uuid('reviewer_id'),
  model: text('model').notNull(),
  effort: text('effort').$type<AgentEffort>().notNull(),
  external_tools: text('external_tools').array().notNull(),
  lead: boolean('lead').notNull(),
  reviewer_approves: boolean('reviewer_approves').notNull(),
  second_inspector_id: uuid('second_inspector_id'),
  preset: text('preset'),
});

/** task.ai_logins */
export const aiLogins = taskSchema.table('ai_logins', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  tool: text('tool').$type<AiLoginTool>().notNull(),
  secret: byteaColumn('secret').notNull(),
  nonce: byteaColumn('nonce').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }),
  checked_at: timestamp('checked_at', { withTimezone: true }),
  last_error: text('last_error'),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** task.api_calls */
export const apiCalls = taskSchema.table('api_calls', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  connector_id: uuid('connector_id').notNull(),
  operation: text('operation').notNull(),
  effect: text('effect').$type<ApiCallEffect>().notNull(),
  task_id: uuid('task_id'),
  run_id: uuid('run_id'),
  agent_id: uuid('agent_id'),
  request_id: text('request_id').notNull(),
  input: jsonb('input').notNull(),
  status: text('status').$type<ApiCallStatus>().notNull(),
  held_reason: text('held_reason').$type<ApiCallHeldReason>(),
  approval_id: uuid('approval_id'),
  answer: jsonb('answer'),
  vars: jsonb('vars').notNull(),
  file_urls: text('file_urls').array().notNull(),
  output_ids: uuid('output_ids').array().notNull(),
  error: text('error'),
  polls: integer('polls').notNull(),
  next_at: timestamp('next_at', { withTimezone: true }),
  give_up_at: timestamp('give_up_at', { withTimezone: true }),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
});

/** task.api_connectors */
export const apiConnectors = taskSchema.table('api_connectors', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  name: text('name').notNull(),
  title: text('title').notNull(),
  base: text('base').notNull(),
  spec: jsonb('spec').notNull(),
  pending_spec: jsonb('pending_spec'),
  history: jsonb('history').notNull(),
  secret: byteaColumn('secret'),
  nonce: byteaColumn('nonce'),
  status: text('status').$type<ApiConnectorStatus>().notNull(),
  daily_max: integer('daily_max').notNull(),
  source: jsonb('source').notNull(),
  note: text('note').notNull(),
  proposed_by: uuid('proposed_by'),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
  last_error: text('last_error'),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/** task.approvals */
export const approvals = taskSchema.table('approvals', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  task_id: uuid('task_id'),
  agent_id: uuid('agent_id'),
  action: text('action').notNull(),
  target_kind: text('target_kind').notNull(),
  target_id: uuid('target_id').notNull(),
  target_version: integer('target_version').notNull(),
  status: text('status').$type<ApprovalStatus>().notNull(),
  decided_by: uuid('decided_by'),
  decided_at: timestamp('decided_at', { withTimezone: true }),
  note: text('note'),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  chat_id: uuid('chat_id'),
  card_id: uuid('card_id'),
  payload: jsonb('payload'),
  inspected_at: timestamp('inspected_at', { withTimezone: true }),
  agent_decided: boolean('agent_decided').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }),
});

/** task.chat_updates */
export const chatUpdates = taskSchema.table('chat_updates', {
  id: uuid('id').notNull(),
  n: bigint('n', { mode: 'number' }).notNull(),
  tx: xid8Column('tx').notNull(),
  space_id: uuid('space_id').notNull(),
  chat_id: uuid('chat_id').notNull(),
  kind: text('kind').$type<ChatUpdateKind>().notNull(),
  task_id: uuid('task_id'),
  agent_id: uuid('agent_id'),
  text: text('text').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  choices: uuid('choices').array(),
  data: jsonb('data'),
});

/** task.chats */
export const chats = taskSchema.table('chats', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  agent_id: uuid('agent_id'),
  title: text('title').notNull(),
  turns: integer('turns').notNull(),
  request_id: text('request_id').notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  device_id: uuid('device_id'),
  goal: text('goal'),
  project: text('project'),
  deliver: text('deliver').$type<ChatDeliver>(),
  pending: text('pending'),
  model: text('model'),
  effort: text('effort').$type<ChatEffort>(),
  pending_refs: jsonb('pending_refs'),
  app_id: uuid('app_id'),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  stop_mode: text('stop_mode').$type<ChatStopMode>().notNull(),
});

/** task.external_tools */
export const externalTools = taskSchema.table('external_tools', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  name: text('name').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  header_name: text('header_name'),
  secret: byteaColumn('secret'),
  nonce: byteaColumn('nonce'),
  status: text('status').$type<ExternalToolStatus>().notNull(),
  note: text('note').notNull(),
  proposed_by: uuid('proposed_by'),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  catalog: jsonb('catalog').notNull(),
  checked_at: timestamp('checked_at', { withTimezone: true }),
  check_error: text('check_error'),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
  last_failed_at: timestamp('last_failed_at', { withTimezone: true }),
  last_error: text('last_error'),
  auth: text('auth').$type<ExternalToolAuth>().notNull(),
  oauth: jsonb('oauth').notNull(),
  oauth_pending: text('oauth_pending'),
  token: byteaColumn('token'),
  token_nonce: byteaColumn('token_nonce'),
  token_expires_at: timestamp('token_expires_at', { withTimezone: true }),
  token_refresh_at: timestamp('token_refresh_at', { withTimezone: true }),
  oauth_error: text('oauth_error'),
  catalog_pending: jsonb('catalog_pending'),
  catalog_changed_at: timestamp('catalog_changed_at', { withTimezone: true }),
});

/** task.goal_rounds */
export const goalRounds = taskSchema.table('goal_rounds', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  run_id: uuid('run_id').notNull(),
  round: integer('round').notNull(),
  task_id: uuid('task_id').notNull(),
  summary: text('summary').notNull(),
  completed: text('completed').array().notNull(),
  remaining: text('remaining').array().notNull(),
  evidence: jsonb('evidence').notNull(),
  next_plan: text('next_plan').notNull(),
  done: boolean('done').notNull(),
  milestone: boolean('milestone').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** task.goal_runs */
export const goalRuns = taskSchema.table('goal_runs', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  goal_id: uuid('goal_id').notNull(),
  agent_id: uuid('agent_id').notNull(),
  title: text('title').notNull(),
  instruction: text('instruction').notNull(),
  criteria: text('criteria').array().notNull(),
  checkpoint: text('checkpoint').$type<GoalRunCheckpoint>().notNull(),
  round: integer('round').notNull(),
  max_rounds: integer('max_rounds').notNull(),
  status: text('status').$type<GoalRunStatus>().notNull(),
  request_id: text('request_id').notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
});

/** task.goals */
export const goals = taskSchema.table('goals', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  parent_id: uuid('parent_id'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').$type<GoalStatus>().notNull(),
  sort: integer('sort').notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** task.learned_rules */
export const learnedRules = taskSchema.table('learned_rules', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  seq: integer('seq').notNull(),
  scope: text('scope').$type<LearnedRuleScope>().notNull(),
  scope_key: text('scope_key'),
  body: text('body').notNull(),
  helpful: integer('helpful').notNull(),
  harmful: integer('harmful').notNull(),
  status: text('status').$type<LearnedRuleStatus>().notNull(),
  approval_id: uuid('approval_id'),
  replaced_by: uuid('replaced_by'),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  retired_at: timestamp('retired_at', { withTimezone: true }),
});

/** task.output_shares */
export const outputShares = taskSchema.table('output_shares', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  output_id: uuid('output_id').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

/** task.outputs */
export const outputs = taskSchema.table('outputs', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  task_id: uuid('task_id'),
  run_id: uuid('run_id'),
  name: text('name').notNull(),
  kind: text('kind').$type<OutputKind>().notNull(),
  mime: text('mime').notNull(),
  size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  blob_hash: text('blob_hash').notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  purge_after: timestamp('purge_after', { withTimezone: true }),
  card_id: uuid('card_id'),
});

/** task.plan_usage */
export const planUsage = taskSchema.table('plan_usage', {
  space_id: uuid('space_id').notNull(),
  tool: text('tool').$type<PlanUsageTool>().notNull(),
  period: text('period').$type<PlanUsagePeriod>().notNull(),
  percent: integer('percent').notNull(),
  resets_at: timestamp('resets_at', { withTimezone: true }).notNull(),
  status: text('status').$type<PlanUsageStatus>(),
  seen_at: timestamp('seen_at', { withTimezone: true }).notNull(),
});

/** task.rule_marks */
export const ruleMarks = taskSchema.table('rule_marks', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  rule_id: uuid('rule_id').notNull(),
  source: text('source').notNull(),
  mark: text('mark').$type<RuleMarkMark>().notNull(),
  task_id: uuid('task_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** task.runners */
export const runners = taskSchema.table('runners', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  device_id: uuid('device_id').notNull(),
  accepting: boolean('accepting').notNull(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  sandbox: boolean('sandbox').notNull(),
  browser: boolean('browser').notNull(),
  concurrency: smallint('concurrency'),
});

/** task.schedules */
export const schedules = taskSchema.table('schedules', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  title: text('title').notNull(),
  agent_id: uuid('agent_id'),
  mode: text('mode').$type<ScheduleMode>().notNull(),
  at_minute: integer('at_minute'),
  weekdays: integer('weekdays').array().notNull(),
  every_hours: integer('every_hours'),
  time_zone: text('time_zone').notNull(),
  instruction: text('instruction').notNull(),
  goal_id: uuid('goal_id'),
  daily_max: integer('daily_max').notNull(),
  run_day: text('run_day'),
  day_runs: integer('day_runs').notNull(),
  enabled: boolean('enabled').notNull(),
  next_run_at: timestamp('next_run_at', { withTimezone: true }),
  last_run_at: timestamp('last_run_at', { withTimezone: true }),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  page_id: uuid('page_id'),
  destination: text('destination').$type<ScheduleDestination>().notNull(),
  deliver: text('deliver').$type<ScheduleDeliver>(),
  rules: text('rules').notNull(),
  trigger: text('trigger').$type<ScheduleTrigger>().notNull(),
  after_id: uuid('after_id'),
  chat_id: uuid('chat_id'),
  every_minutes: integer('every_minutes'),
  mail: boolean('mail').notNull(),
  run_at: timestamp('run_at', { withTimezone: true }),
});

/** task.skill_revisions */
export const skillRevisions = taskSchema.table('skill_revisions', {
  id: uuid('id').notNull(),
  skill_id: uuid('skill_id').notNull(),
  revision: integer('revision').notNull(),
  files: jsonb('files').notNull(),
  hash: text('hash').notNull(),
  based_on: text('based_on').notNull(),
  note: text('note').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** task.skills */
export const skills = taskSchema.table('skills', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  name: text('name').notNull(),
  active_revision: integer('active_revision'),
  revisions: integer('revisions').notNull(),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/** task.task_events */
export const taskEvents = taskSchema.table('task_events', {
  id: bigint('id', { mode: 'number' }).notNull(),
  task_id: uuid('task_id').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  kind: text('kind').$type<TaskEventKind>().notNull(),
  body: text('body').notNull(),
  tokens: integer('tokens').notNull(),
});

/** task.task_runs */
export const taskRuns = taskSchema.table('task_runs', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  task_id: uuid('task_id').notNull(),
  seq: integer('seq').notNull(),
  runner_id: uuid('runner_id').notNull(),
  agent_id: uuid('agent_id'),
  agent_revision: integer('agent_revision'),
  skill: text('skill'),
  skill_source: text('skill_source').$type<TaskRunSkillSource>(),
  skill_revision: integer('skill_revision'),
  skill_hash: text('skill_hash'),
  runner_build: text('runner_build'),
  cli_version: text('cli_version'),
  model: text('model'),
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  prompt_source: text('prompt_source').$type<TaskRunPromptSource>(),
  prompt_revision: integer('prompt_revision'),
  prompt_hash: text('prompt_hash'),
  lineage: text('lineage'),
  cli_session: text('cli_session'),
  resumed: boolean('resumed'),
});

/** task.tasks */
export const tasks = taskSchema.table('tasks', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  agent_id: uuid('agent_id'),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  instruction: text('instruction').notNull(),
  payload: jsonb('payload').notNull(),
  result: jsonb('result'),
  target_kind: text('target_kind'),
  target_id: uuid('target_id'),
  base_version: integer('base_version'),
  status: text('status').$type<TaskStatus>().notNull(),
  priority: integer('priority').notNull(),
  lease_until: timestamp('lease_until', { withTimezone: true }),
  leased_by: uuid('leased_by'),
  attempts: integer('attempts').notNull(),
  request_id: text('request_id'),
  version: integer('version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  goal_id: uuid('goal_id'),
  parent_id: uuid('parent_id'),
  depth: integer('depth').notNull(),
  wait_reason: text('wait_reason').$type<TaskWaitReason>(),
  rounds: integer('rounds').notNull(),
  wait_until: timestamp('wait_until', { withTimezone: true }),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

/** task.verdicts */
export const verdicts = taskSchema.table('verdicts', {
  id: uuid('id').notNull(),
  space_id: uuid('space_id').notNull(),
  task_id: uuid('task_id').notNull(),
  agent_id: uuid('agent_id').notNull(),
  kind: text('kind').$type<VerdictKind>().notNull(),
  target: text('target').notNull(),
  round: integer('round').notNull(),
  verdict: text('verdict').$type<VerdictVerdict>().notNull(),
  score: real('score'),
  low: integer('low'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});
