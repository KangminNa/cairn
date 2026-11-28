import type {
  ClickDetailView,
  ShotImageView,
  ShotListView,
} from '../../../../plugins/browser-tabs/server/click-views';
import type { IntegrationListView } from '../../../../plugins/browser-tabs/server/integration-views';
import type { LoginCardView } from '../../../../plugins/browser-tabs/server/login-views';
import type { PullView, TaskAskView } from '../../../../plugins/code-github/server/views';
import type { NewsDetailView } from '../../../../plugins/email/server/views';
import type {
  AgentLeadView,
  AgentListView,
  AgentView,
} from '../../../server/src/modules/task/agent/agent.view';
import type {
  AiTestView,
  AiToolListView,
  EngineListView,
} from '../../../server/src/modules/task/ai/ai-login.view';
import type {
  ApiCallLineView,
  ApiCallListView,
  ApiConnectorListView,
} from '../../../server/src/modules/task/api-connector/api-connector.view';
import type {
  ApprovalPageView,
  ApprovalView,
} from '../../../server/src/modules/task/approval/approval.view';
import type { ChatDetailView, ChatListView } from '../../../server/src/modules/task/chat/chat.view';
import type { ChatTrashView } from '../../../server/src/modules/task/chat/chat-trash.view';
import type {
  ConnectorPresetListView,
  ExternalToolListView,
  OAuthStartView,
} from '../../../server/src/modules/task/external-tool/external-tool.view';
import type { GoalListView, GoalView } from '../../../server/src/modules/task/goal/goal.view';
import type {
  GoalRunDetailView,
  GoalRunListView,
} from '../../../server/src/modules/task/goal-run/goal-run.view';
import type {
  OutputPageView,
  OutputSavedView,
} from '../../../server/src/modules/task/output/output.view';
import type {
  OutputShareListView,
  OutputShareView,
} from '../../../server/src/modules/task/output-share/output-share.view';
import type { RuleListView } from '../../../server/src/modules/task/rule/rule.view';
import type {
  RunnerListView,
  RunnerView,
} from '../../../server/src/modules/task/runner/runner.view';
import type {
  ScheduleCalendarView,
  ScheduleListView,
  ScheduleView,
} from '../../../server/src/modules/task/schedule/schedule.view';
import type {
  SkillDetailView,
  SkillListView,
  SkillSavedView,
} from '../../../server/src/modules/task/skill/skill.view';
import type {
  TaskDetailView,
  TaskPageView,
  TaskTrashedView,
  TaskView,
} from '../../../server/src/modules/task/task/task.view';
import type { UsageView } from '../../../server/src/modules/task/usage/usage.view';
import type { LinkPreviewView } from '../../../server/src/modules/task/web/link-preview.view';

// 서버가 돌려주는 모양. import 없는 view 파일의 toJSON()이 원본이다 (API설계 2장).
// 서버 코드가 웹 번들에 들어가지 않게 반드시 import type으로만 가져온다.

/** 링크 미리보기 카드 (F3, 2026-11-21) */
export type LinkPreview = ReturnType<LinkPreviewView['toJSON']>;
export type Task = ReturnType<TaskView['toJSON']>;
export type TaskPage = ReturnType<TaskPageView['toJSON']>;
export type TaskTrashed = ReturnType<TaskTrashedView['toJSON']>;
export type TaskDetail = ReturnType<TaskDetailView['toJSON']>;
export type TaskEvent = TaskDetail['events'][number];
export type TaskRun = TaskDetail['runs'][number];
export type TaskOutput = TaskDetail['outputs'][number];
export type OutputPage = ReturnType<OutputPageView['toJSON']>;
export type Output = OutputPage['outputs'][number];
export type OutputUsage = OutputPage['usage'];
export type OutputSaved = ReturnType<OutputSavedView['toJSON']>;
export type OutputShare = ReturnType<OutputShareView['toJSON']>;
export type OutputShareList = ReturnType<OutputShareListView['toJSON']>;
export type Goal = ReturnType<GoalView['toJSON']>;
export type GoalList = ReturnType<GoalListView['toJSON']>;
export type RuleList = ReturnType<RuleListView['toJSON']>;
export type Rule = RuleList['rules'][number];
export type GoalRunList = ReturnType<GoalRunListView['toJSON']>;
export type GoalRun = GoalRunList['runs'][number];
export type GoalRunDetail = ReturnType<GoalRunDetailView['toJSON']>;
export type GoalRound = GoalRunDetail['rounds'][number];
export type SkillList = ReturnType<SkillListView['toJSON']>;
export type SkillDetail = ReturnType<SkillDetailView['toJSON']>;
export type SkillSaved = ReturnType<SkillSavedView['toJSON']>;
export type Runner = ReturnType<RunnerView['toJSON']>;
export type RunnerList = ReturnType<RunnerListView['toJSON']>;
export type Approval = ReturnType<ApprovalView['toJSON']>;
/** 설정 바꾸기의 바뀔 칸 한 줄 (2026-11-15 C) */
export type SettingChangeLine = NonNullable<Approval['changes']>[number];
export type ApprovalPage = ReturnType<ApprovalPageView['toJSON']>;
export type Agent = ReturnType<AgentView['toJSON']>;
export type AgentList = ReturnType<AgentListView['toJSON']>;
/** 공간의 대표 (O-2, 숨은 에이전트). 첫 대화 전이면 lead가 null */
export type AgentLead = ReturnType<AgentLeadView['toJSON']>;
/** 외부 도구 (2차 7단계). 토큰은 실리지 않는다 (hasSecret만) */
export type ExternalToolList = ReturnType<ExternalToolListView['toJSON']>;
export type ExternalTool = ExternalToolList['tools'][number];
/** 추천 커넥터 (C2): 저장소의 공식 원격 MCP 목록과 이미 더했는지 */
export type ConnectorPresetList = ReturnType<ConnectorPresetListView['toJSON']>;
/** OAuth 커넥터의 로그인 시작 (C1): 같은 탭으로 열 로그인 서버의 주소 */
/** API 커넥터 (2026-11-24): 일꾼이 낸 정의서로 붙인 REST API. 키는 넣었는지만 */
export type ApiConnectorList = ReturnType<ApiConnectorListView['toJSON']>;
export type ApiConnector = ApiConnectorList['connectors'][number];
export type ApiCallList = ReturnType<ApiCallListView['toJSON']>;
export type ApiCallLine = ReturnType<ApiCallLineView['toJSON']>;
export type ExternalToolOAuthStart = ReturnType<OAuthStartView['toJSON']>;
export type Schedule = ReturnType<ScheduleView['toJSON']>;
export type ScheduleList = ReturnType<ScheduleListView['toJSON']>;
/** 스케줄 캘린더 (2026-11-27): 돌 시각 · 짧은 주기 · 지난 실행 */
export type ScheduleCalendar = ReturnType<ScheduleCalendarView['toJSON']>;
export type Usage = ReturnType<UsageView['toJSON']>;
export type UsageAgent = Usage['agents'][number];
export type UsageWindow = Usage['plan'][number];
/** AI 도구마다의 로그인 상태 (AI 메뉴, 러너 메뉴) */
export type AiTools = ReturnType<AiToolListView['toJSON']>;
export type AiTool = AiTools['tools'][number];
/** 엔진 목록 (task/engines.json, 리팩토링 E1): 도구 이름 · 생각 강도 · 모델 · 로그인 흐름 */
export type EngineList = ReturnType<EngineListView['toJSON']>;
export type Engine = EngineList['engines'][number];
/** 맡긴 연결 확인 · 웹 로그인의 작업 */
export type AiTest = ReturnType<AiTestView['toJSON']>;
/** code-github 패키지의 PR (승인 화면의 code.pr.merge 대상). 패키지의 view가 원본이다 */
export type CodePull = ReturnType<PullView['toJSON']>;
/** code-github 패키지의 코드 작업 요청 (승인 화면의 code.task.start 대상, 2026-11-15 C) */
export type CodeAsk = ReturnType<TaskAskView['toJSON']>;
/** email 패키지의 가입자 소식 메일 (승인 화면의 email.news.send 대상, 2026-11-27) */
export type NewsMail = ReturnType<NewsDetailView['toJSON']>;
/** browser-tabs 패키지의 사이트 도구 목록 (외부 도구 화면의 "만든 도구", 2026-11-27) */
export type SiteToolList = ReturnType<IntegrationListView['toJSON']>;
export type SiteTool = SiteToolList['integrations'][number];
/** browser-tabs 패키지의 승인된 클릭 하나 (승인 화면이 그린다) */
export type BrowserClick = ReturnType<ClickDetailView['toJSON']>;
/** browser-tabs 패키지의 작업 화면 목록 · 하나 */
export type BrowserShots = ReturnType<ShotListView['toJSON']>;
export type BrowserShot = ReturnType<ShotImageView['toJSON']>;
/** browser-tabs 패키지의 로그인 카드: 칸(종류만) · 값이 갈 곳 · 러너의 진행 상태 (2026-11-19) */
export type BrowserLoginCard = ReturnType<LoginCardView['toJSON']>;
export type ChatList = ReturnType<ChatListView['toJSON']>;
export type ChatSummary = ChatList['chats'][number];
/** 휴지통의 대화들 (2026-11-19 휴지통 A) */
export type ChatTrash = ReturnType<ChatTrashView['toJSON']>;
export type TrashedChat = ChatTrash['chats'][number];
export type ChatDetail = ReturnType<ChatDetailView['toJSON']>;
/** 대화 하나의 머리 (만들기 · 보내기의 응답도 이 모양) */
export type Chat = ChatDetail['chat'];
export type ChatTurn = ChatDetail['turns'][number];
/** 회차에 넣은 참조 하나 (2026-11-15 B) */
export type ChatRef = ChatTurn['refs'][number];
/** 일꾼이 동시에 일하는 칸의 한 줄 */
export type ChatTeamMember = ChatDetail['team'][number];
/** 기다리는 결과 카드 (2차 2단계) */
export type ChatCard = NonNullable<ChatDetail['card']>;
/** 대화의 소식 한 줄 (과정 · 맡기 전의 질문 · 답 · 맡음) */
export type ChatNews = ChatDetail['news'][number];
/** 대화가 쓴 토큰 (O-1): 대화 전체 · 에이전트별, 회차마다 */
export type ChatUsage = ChatDetail['usage'];
export type ChatTurnUsage = ChatUsage['turns'][number];
