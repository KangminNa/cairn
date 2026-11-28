import { Injectable } from '@nestjs/common';
import type { BaseTool, ToolTextBody } from '../platform';
import { AiLoginRefreshTool, AiLoginTool, AiSigninTool } from './ai/ai-login.tool';
import {
  ApiCallTool,
  ApiRunTool,
  ApiToolsTool,
  ProposeApiTool,
} from './api-connector/api-connector.tool';
import { RequestApprovalTool } from './approval/approval.tool';
import { AskAgentTool } from './chat/chat.tool';
import { PublishAppTool } from './chat/chat-publish.tool';
import {
  AgentUpdatesTool,
  AskBriefTool,
  NoteProgressTool,
  PostUpdateTool,
  SetDeliverTool,
} from './chat/chat-update.tool';
import { ProposeToolTool } from './external-tool/external-tool.tool';
import { ReportRoundTool } from './goal-run/goal-run.tool';
import { InboxTool } from './inbox/inbox.tool';
import {
  BeginDownloadTool,
  BeginUploadTool,
  GetOutputTool,
  ListOutputsTool,
} from './output/output.tool';
import { GetSettingsTool, ProposeSettingTool } from './setting-change/setting-change.tool';
import { AskHelpTool, DelegateTaskTool, SetPlanTool, WaitSubtasksTool } from './task/delegate.tool';
import { AskLeadTool, ReplyWorkerTool } from './task/lead-talk.tool';
import {
  NextJobsTool,
  ReleaseJobTool,
  ReportProgressTool,
  SubmitResultTool,
} from './task/task.tool';
import texts from './task.tools.ko.json';
import { FindToolTool } from './tool-finder/tool-finder.tool';
import { ReadUrlTool } from './web/web.tool';

// task가 AI에게 여는 MCP 도구 목록. 새 도구는 여기에만 더한다 (mcp 모듈은 모듈별 목록을 모으기만 한다).
@Injectable()
export class TaskTools {
  /** 모듈의 providers에 펼치는 도구 클래스 (도구를 더하면 여기와 아래 생성자에) */
  static readonly PROVIDERS = [
    NextJobsTool,
    ReportProgressTool,
    SubmitResultTool,
    ReleaseJobTool,
    RequestApprovalTool,
    DelegateTaskTool,
    WaitSubtasksTool,
    AskHelpTool,
    AskLeadTool,
    ReplyWorkerTool,
    SetPlanTool,
    AiLoginTool,
    AiLoginRefreshTool,
    AiSigninTool,
    BeginUploadTool,
    BeginDownloadTool,
    ListOutputsTool,
    GetOutputTool,
    ReadUrlTool,
    ReportRoundTool,
    AskAgentTool,
    InboxTool,
    AgentUpdatesTool,
    PostUpdateTool,
    SetDeliverTool,
    AskBriefTool,
    NoteProgressTool,
    PublishAppTool,
    ProposeToolTool,
    FindToolTool,
    ProposeApiTool,
    ApiToolsTool,
    ApiRunTool,
    ApiCallTool,
    GetSettingsTool,
    ProposeSettingTool,
  ] as const;
  readonly tools: readonly BaseTool[];
  /** 도구의 설명 · 칸 설명 (AI가 읽는 글). 코드가 아니라 설명서 파일이 기본이다 */
  readonly texts: Readonly<Record<string, ToolTextBody>> = texts;

  constructor(
    nextJobs: NextJobsTool,
    reportProgress: ReportProgressTool,
    submitResult: SubmitResultTool,
    releaseJob: ReleaseJobTool,
    requestApproval: RequestApprovalTool,
    delegateTask: DelegateTaskTool,
    waitSubtasks: WaitSubtasksTool,
    askHelp: AskHelpTool,
    askLead: AskLeadTool,
    replyWorker: ReplyWorkerTool,
    setPlan: SetPlanTool,
    aiLogin: AiLoginTool,
    aiLoginRefresh: AiLoginRefreshTool,
    aiSignin: AiSigninTool,
    beginUpload: BeginUploadTool,
    beginDownload: BeginDownloadTool,
    listOutputs: ListOutputsTool,
    getOutput: GetOutputTool,
    readUrl: ReadUrlTool,
    reportRound: ReportRoundTool,
    askAgent: AskAgentTool,
    inbox: InboxTool,
    agentUpdates: AgentUpdatesTool,
    postUpdate: PostUpdateTool,
    setDeliver: SetDeliverTool,
    askBrief: AskBriefTool,
    noteProgress: NoteProgressTool,
    publishApp: PublishAppTool,
    proposeTool: ProposeToolTool,
    findTool: FindToolTool,
    proposeApi: ProposeApiTool,
    apiTools: ApiToolsTool,
    apiRun: ApiRunTool,
    apiCall: ApiCallTool,
    getSettings: GetSettingsTool,
    proposeSetting: ProposeSettingTool,
  ) {
    this.tools = [
      nextJobs,
      reportProgress,
      submitResult,
      releaseJob,
      requestApproval,
      delegateTask,
      waitSubtasks,
      askHelp,
      askLead,
      replyWorker,
      setPlan,
      aiLogin,
      aiLoginRefresh,
      aiSignin,
      beginUpload,
      beginDownload,
      listOutputs,
      getOutput,
      readUrl,
      reportRound,
      askAgent,
      inbox,
      agentUpdates,
      postUpdate,
      setDeliver,
      askBrief,
      noteProgress,
      publishApp,
      proposeTool,
      findTool,
      proposeApi,
      apiTools,
      apiRun,
      apiCall,
      getSettings,
      proposeSetting,
    ];
  }
}
