import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AgentUser } from './agent-user';
import { ClaudeCli } from './claude-cli';
import { Job } from './job';
import { JobWorkspace } from './job-workspace';
import { Json } from './json';
import { SandboxRoom } from './sandbox-room';
import { SharedFolders } from './shared-folders';
import { REPO_PROMPTS } from './testing/repo-prompts';

let skillsDir: string;

before(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'moida-skills-'));
  const skill = join(skillsDir, 'moida-write');
  mkdirSync(join(skill, 'references'), { recursive: true });
  mkdirSync(join(skill, 'agents', 'claude'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# 글쓰기\n{{SKILL_DIR}}/references/style.md를 읽는다');
  writeFileSync(join(skill, 'references', 'style.md'), '문체');
  writeFileSync(join(skill, 'agents', 'claude', 'reviewer.md'), '검토자');
  writeFileSync(join(skill, '.secret'), '숨김');
  mkdirSync(join(skillsDir, 'not-a-skill'));
});

after(() => {
  rmSync(skillsDir, { recursive: true, force: true });
});

const open = (skill: string | null = null) =>
  JobWorkspace.open('{"mcpServers":{}}', '{"permissions":{}}', skill, skillsDir);

describe('일의 자리', () => {
  test('빈 폴더들과 600 권한의 MCP 설정을 만들고 지운다', async () => {
    const workspace = await open();
    assert.equal(statSync(workspace.mcpConfigPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(workspace.workDir, '..')).mode & 0o777, 0o700);
    assert.ok(!workspace.mcpConfigPath.startsWith(workspace.workDir));
    assert.equal(workspace.skillReady, false);
    await workspace.remove();
    assert.equal(existsSync(workspace.workDir), false);
    assert.equal(existsSync(workspace.mcpConfigPath), false);
  });

  test('스킬이 있으면 설정 폴더에 넣고 하위 에이전트와 숨김 파일은 뺀다', async () => {
    const workspace = await open('moida-write');
    assert.equal(workspace.skillReady, true);
    const to = join(workspace.configDir, 'skills', 'moida-write');
    assert.equal(
      readFileSync(join(to, 'SKILL.md'), 'utf8'),
      `# 글쓰기\n${to}/references/style.md를 읽는다`,
    );
    assert.equal(existsSync(join(to, 'references', 'style.md')), true);
    assert.equal(existsSync(join(to, 'agents')), false);
    assert.equal(existsSync(join(to, '.secret')), false);
    await workspace.remove();
  });

  test('스킬이 없거나 이름이 수상하면 스킬 없이 만든다', async () => {
    for (const skill of ['moida-tidy', 'not-a-skill', '../moida-write', '/etc', 'A B']) {
      const workspace = await open(skill);
      assert.equal(workspace.skillReady, false, skill);
      await workspace.remove();
    }
  });
});

describe('AI CLI 부르기', () => {
  const cli = new ClaudeCli('claude', 'oauth-token');

  test('MCP 설정에 작업 토큰과 moida 서버 하나만 적는다', () => {
    const settings = JSON.parse(ClaudeCli.settings('/Users/owner/'));
    assert.deepEqual(settings.permissions.deny, [
      'Read(//Users/owner/**)',
      'Write(//Users/owner/**)',
      'Edit(//Users/owner/**)',
    ]);
    assert.deepEqual(JSON.parse(ClaudeCli.settings(undefined)).permissions.deny, []);
    // Fable은 쓰지 않는다 (2026-11-19): 서버 · 러너가 먼저 거르고, CLI 안에서 고르는 모델도 이 셋으로
    assert.deepEqual(settings.availableModels, ['opus', 'sonnet', 'haiku']);
    const config = JSON.parse(ClaudeCli.mcpConfig('https://blog/mcp', 'run-token'));
    assert.deepEqual(config, {
      mcpServers: {
        moida: {
          type: 'http',
          url: 'https://blog/mcp',
          headers: { Authorization: 'Bearer run-token' },
        },
      },
    });
  });

  test('셸을 주지 않고 moida MCP만 허락한다', async () => {
    const workspace = await open();
    const args = [...cli.args(workspace)];
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Write,Edit');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__moida__*');
    assert.equal(args[args.indexOf('--mcp-config') + 1], workspace.mcpConfigPath);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    for (const banned of ['--bare', '--dangerously-skip-permissions', 'Bash'])
      assert.equal(args.join(' ').includes(banned), false, banned);
    await workspace.remove();
  });

  test('모델 · 생각 강도는 정했을 때만 넘긴다 (2차 7단계)', async () => {
    const tuned = new ClaudeCli('claude', 'oauth-token');
    const job = Job.from(
      Json.of({
        task: { id: 't', title: '정리' },
        agent: { name: '정리', tool: 'claude', model: 'opus[1m]', effort: 'xhigh' },
        run_token: 'run-token',
      }),
    );
    const workspace = await tuned.open(job);
    const args = [...tuned.args(workspace)];
    assert.equal(args[args.indexOf('--model') + 1], 'opus[1m]');
    assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
    await workspace.remove();
    const plain = await open();
    assert.equal(cli.args(plain).includes('--model'), false, '비었으면 CLI의 기본');
    assert.equal(cli.args(plain).includes('--effort'), false);
    await plain.remove();
  });

  test('Fable 모델이 실려 오면 돌지 않을 까닭을 낸다 (옛 서버 · 그 전에 저장된 값)', () => {
    const runtime = (model: string) =>
      Job.from(
        Json.of({
          task: { id: 't', title: '정리' },
          agent: { name: '정리', tool: 'claude', model },
          run_token: 'run-token',
        }),
      ).runtime.refusal;
    for (const model of ['fable', 'claude-fable-5-2', 'best'])
      assert.match(String(runtime(model)), /Fable 모델\(.+\)은 쓰지 않아요/, model);
    for (const model of ['', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'bestow'])
      assert.equal(runtime(model), null, model);
  });

  test('연결 확인은 MCP 설정도 도구도 없이 띄운다', async () => {
    const workspace = await JobWorkspace.open(null, '{"permissions":{}}', null, '/nowhere');
    const args = [...cli.args(workspace)];
    assert.equal(workspace.mcpReady, false);
    assert.equal(existsSync(workspace.mcpConfigPath), false);
    assert.equal(args.includes('--mcp-config'), false);
    assert.ok(args.includes('--strict-mcp-config'), '사용자의 MCP 서버를 물려받지 않는다');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args.at(-2), '--tools', '값을 여럿 받는 옵션이라 맨 뒤에 둔다');
    await workspace.remove();
  });

  test('나눈 폴더는 작업 폴더의 folders/로 복사하고, 그 단락을 지시에 더한다 (주지 않으면 그대로)', async () => {
    const source = join(skillsDir, '..', 'shared', 'notes');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'todo.md'), '할 일');
    const plain = Job.from(Json.of({ task: { id: 't', title: '정리' }, instruction: '읽어 줘' }));
    const shared = await JobWorkspace.open(null, null, null, '/nowhere');
    await shared.handOver(new SharedFolders([source]));
    assert.equal(
      readFileSync(join(shared.workDir, 'folders', 'notes', 'todo.md'), 'utf8'),
      '할 일',
    );
    assert.match(
      shared.withShared(plain, REPO_PROMPTS).prompt(REPO_PROMPTS, false),
      /folders\/notes \(파일 1개\)/,
    );
    await shared.remove();
    const folders = new SharedFolders([source]);
    const bound = Job.from(
      Json.of({ task: { id: 't', title: '정리' }, agent: { name: '내 폴더', bound: true } }),
    );
    assert.equal(bound.sharedFolders(folders), folders, '이 러너에 묶인 에이전트의 일');
    assert.equal(
      plain.sharedFolders(folders),
      null,
      '묶이지 않은 에이전트의 일은 폴더를 받지 않는다',
    );
    const none = await JobWorkspace.open(null, null, null, '/nowhere');
    await none.handOver(null);
    assert.equal(existsSync(join(none.workDir, 'folders')), false);
    assert.equal(none.withShared(plain, REPO_PROMPTS), plain);
    await none.remove();
  });

  test('스킬이 있을 때만 Skill 도구를 준다', async () => {
    const workspace = await open('moida-write');
    const args = [...cli.args(workspace)];
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Write,Edit,Skill');
    assert.ok(args.includes('Skill'));
    await workspace.remove();
  });

  test('정해 둔 환경만 넘긴다', async () => {
    const workspace = await open();
    const env = cli.env(workspace, {
      PATH: '/bin',
      HOME: '/Users/me',
      MOIDA_RUNNER_TOKEN: 'device-token',
      ANTHROPIC_API_KEY: 'api-key',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude',
    });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.HOME, workspace.homeDir);
    assert.equal(env.CLAUDE_CONFIG_DIR, workspace.configDir);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-token');
    assert.equal(env.MOIDA_RUNNER_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    await workspace.remove();
  });
});

describe('지시문', () => {
  const job = (more: object = {}) =>
    Job.from(
      Json.of({
        task: { id: 't', title: '초안 쓰기', lease_until: '2026-11-01T00:15:00.000Z' },
        instruction: '세션으로 글을 써 주세요',
        target: null,
        skill: null,
        revision_note: null,
        agent: { id: 'a', name: '글쓰기', role: '블로그 글을 쓴다', tool: 'claude' },
        run_token: 'run-token',
        ...more,
      }),
    );

  test('역할과 지시를 담는다. 작업 토큰은 담지 않는다', () => {
    const prompt = job().prompt(REPO_PROMPTS, false);
    assert.ok(prompt.includes('글쓰기'));
    assert.ok(prompt.includes('블로그 글을 쓴다'));
    assert.ok(prompt.includes('세션으로 글을 써 주세요'));
    assert.equal(prompt.includes('run-token'), false);
    assert.equal(prompt.includes('# 대상'), false);
    assert.equal(prompt.includes('# 주인이'), false);
  });

  test('대상과 고쳐 달라는 말이 있으면 담는다', () => {
    const prompt = job({
      target: { kind: 'post', id: 'p1', version: 3 },
      revision_note: '더 짧게',
    }).prompt(REPO_PROMPTS, false);
    assert.ok(prompt.includes('post p1, 판 3'));
    assert.ok(prompt.includes('더 짧게'));
  });

  test('결과물 폴더를 알려 주면 그 폴더와 한도를 담는다', () => {
    assert.equal(job().prompt(REPO_PROMPTS, false).includes('결과물'), false);
    const prompt = job().prompt(REPO_PROMPTS, false, null, '/tmp/run/work/outputs');
    assert.match(prompt, /만들면 \/tmp\/run\/work\/outputs 바로 아래에 둡니다/);
    assert.match(prompt, /100MB, 200개까지/);
  });

  test('스킬은 넣어 둔 때만 말한다', () => {
    const skilled = job({ skill: 'moida-write' });
    assert.ok(skilled.prompt(REPO_PROMPTS, true).includes('moida-write'));
    assert.equal(skilled.prompt(REPO_PROMPTS, false).includes('moida-write'), false);
  });

  test('목표 사슬, 내 팀과 위임하는 법, 하위 작업의 결과를 담는다', () => {
    const prompt = job({
      goal_chain: [{ title: '회사' }, { title: '이번 달 글 4편' }],
      team: [
        {
          agent_id: 'w1',
          name: '글쓰기 팀원',
          role: '초안을 쓴다\n둘째 줄',
          status: 'active',
          kinds: ['general', 'draft_post'],
        },
      ],
      subtask_results: [
        {
          title: '초안',
          agent: '글쓰기 팀원',
          status: 'done',
          summary: '썼어요',
          error: null,
          outputs: [{ id: 'o1', name: '발표.pptx', kind: 'slides' }],
        },
        {
          title: '정리',
          agent: '정리 팀원',
          status: 'failed',
          summary: null,
          error: '세션이 없어요',
        },
      ],
      rounds_left: 2,
    }).prompt(REPO_PROMPTS, false);
    assert.ok(prompt.includes('회사 › 이번 달 글 4편'));
    assert.ok(
      prompt.includes(
        '글쓰기 팀원 (agent_id: w1): 초안을 쓴다 · 맡길 수 있는 일: general, draft_post',
      ),
    );
    assert.equal(prompt.includes('둘째 줄'), false);
    assert.ok(prompt.includes('delegate_task'));
    assert.ok(prompt.includes('남은 위임 · 기다리기 횟수: 2'));
    assert.ok(
      prompt.includes('## [완료] 초안 (글쓰기 팀원)\n썼어요\n결과물: 발표.pptx (output_id: o1)'),
    );
    assert.ok(prompt.includes('## [실패] 정리 (정리 팀원)\n세션이 없어요'));
  });

  test('일꾼 정보(일 수 · 최근 결과 · 도구 · 커넥터)와 나누는 법, 결과 형식을 담는다', () => {
    const prompt = job({
      team: [
        {
          agent_id: 'm1',
          name: '조사 팀장',
          role: '',
          status: 'active',
          kinds: ['general'],
          tool: 'codex',
          open: 2,
          recent: { done: 5, failed: 1, revised: 0 },
          scorecard: {
            judged: 4,
            first_pass: 3,
            avg_fixes: 0.25,
            decided: 0,
            sent_back: 0,
            tokens_per_done: 1200,
          },
          connectors: ['notion', 'linear'],
        },
        { agent_id: 'w1', name: '글쓰기', role: '', status: 'active', kinds: ['general'] },
        {
          agent_id: 'r1',
          name: '리서처',
          role: '사실 · 자료가 필요한 조사를 맡긴다.\n하는 일: 웹 검색',
          preset: 'researcher',
          status: 'active',
          kinds: ['general', 'tidy_session'],
        },
      ],
      subtask_results: [
        { title: '조사', agent: '조사 팀장', status: 'done', summary: '표', deliver: '표 하나' },
      ],
      rounds_left: 1,
    }).prompt(REPO_PROMPTS, false);
    assert.ok(
      prompt.includes(
        '조사 팀장 (agent_id: m1) · 맡길 수 있는 일: general · AI 도구: codex · 쥔 일 2개 · 최근 7일 끝냄 5 · 실패 1 · 고쳐 달라 · 반려 0 · 최근 30일 성적: 첫 판정 통과 3/4 · 평균 고친 횟수 0.25 · 일 하나에 토큰 1200 · 커넥터: notion, linear',
      ),
    );
    // 옛 서버(일꾼 정보 없음)면 0으로, 커넥터 · 성적 칸은 없다
    assert.ok(prompt.includes('글쓰기 (agent_id: w1) · 맡길 수 있는 일: general · 쥔 일 0개'));
    assert.equal(/글쓰기 \(agent_id: w1\)[^\n]*(커넥터|성적)/.test(prompt), false);
    // 역할 일꾼은 role 열쇠와 역할의 첫 줄만 (2026-11-28)
    assert.ok(
      prompt.includes(
        '리서처 (agent_id: r1 · role: researcher): 사실 · 자료가 필요한 조사를 맡긴다. · 맡길 수 있는 일: general, tidy_session',
      ),
    );
    assert.ok(prompt.includes('역할로 맡깁니다'));
    assert.ok(prompt.includes('## 나누는 법'));
    // 모델은 맡기는 쪽이 일마다 고르고, 상한은 내 모델 (2026-11-19). 정하지 않았으면 CLI 기본(opus)
    assert.ok(prompt.includes('delegate_task의 model로 고릅니다'));
    assert.ok(prompt.includes('내 모델(opus)보다 높게 고를 수 없습니다'));
    assert.ok(prompt.includes('propose_setting'), '커넥터가 없으면 붙이기를 제안한다');
    assert.ok(prompt.includes('## [완료] 조사 (조사 팀장)\n요청한 형식: 표 하나\n표'));

    const child = job({ deliver: '후보 3개를 표로' }).prompt(REPO_PROMPTS, false);
    assert.ok(child.includes('# 돌려줄 결과의 형식'));
    assert.ok(child.includes('후보 3개를 표로'));
    assert.equal(job({}).prompt(REPO_PROMPTS, false).includes('돌려줄 결과의 형식'), false);
  });

  test('정한 계획(payload.plan)은 단계 · 완료 조건 · 하지 말 것으로 다시 보인다 (2026-11-20)', () => {
    const plan = { steps: ['조사 → 리서처'], criteria: ['표에 5개'], mustNot: ['메일 보내기'] };
    const task = { id: 't', title: '비교', payload: { plan } };
    const prompt = job({ task }).prompt(REPO_PROMPTS, false);
    assert.ok(prompt.includes('# 내 계획 (set_plan으로 정함, 바꿀 수 없음)'));
    assert.ok(prompt.includes('## 완료 조건\n- 표에 5개'));
    assert.ok(prompt.includes('## 하지 말 것\n- 메일 보내기'));
    assert.equal(job({}).prompt(REPO_PROMPTS, false).includes('내 계획'), false);
    // 팀이 있으면 큰 일은 맡기기 전에 계획을 정하라고 한다
    const lead = job({
      team: [{ agent_id: 'm', name: '팀원', role: '', status: 'active', kinds: [] }],
      rounds_left: 1,
    });
    assert.ok(lead.prompt(REPO_PROMPTS, false).includes('set_plan으로 계획을 한 번 정합니다'));
  });

  test('먼저 깬 일 (팀원 기다리기): 깬 까닭, 끝나지 않은 일의 상태 · 몇 분째 · task_id, 고르는 법. 관리자가 재촉했으면 마무리만', () => {
    const since = new Date(Date.now() - 7 * 60_000).toISOString();
    const open = { summary: null, error: null, deliver: null, since };
    const results = [
      { task_id: 'c1', title: '조사', agent: '조사 팀원', status: 'failed', error: '자료 없음' },
      { ...open, task_id: 'c2', title: '정리', agent: '정리 팀원', status: 'running' },
      {
        ...open,
        task_id: 'c3',
        title: '공개',
        agent: '글쓰기',
        status: 'waiting',
        waiting: 'approval',
      },
    ];
    const woke = job({ subtask_results: results, wake: 'failed', rounds_left: 2 }).prompt(
      REPO_PROMPTS,
      false,
    );
    assert.ok(woke.includes('하위 작업 하나가 실패해 다른 일꾼을 기다리지 않고 먼저 깨웠습니다'));
    assert.ok(woke.includes('## [실패] 조사 (조사 팀원)\n자료 없음'));
    assert.ok(woke.includes('## [일하는 중 · 7분째] 정리 (정리 팀원) · task_id: c2'));
    assert.ok(woke.includes('## [승인 기다림 · 7분째] 공개 (글쓰기) · task_id: c3'));
    assert.ok(woke.includes('wait_subtasks로 더 기다립니다'));
    assert.ok(woke.includes('남은 위임 · 기다리기 횟수: 2'));
    assert.equal(
      woke.includes('결과 글 없음'),
      false,
      '끝나지 않은 일은 결과 글이 없다고 하지 않는다',
    );

    const hurried = job({ subtask_results: results, wake: 'owner', rounds_left: 2 }).prompt(
      REPO_PROMPTS,
      false,
    );
    assert.ok(hurried.includes('관리자가 더 기다리지 말고 지금까지의 결과로 답해 달라고 했습니다'));
    assert.equal(hurried.includes('wait_subtasks로 더 기다립니다'), false, '마무리만');

    const all = job({ subtask_results: [results[0]], wake: 'all' }).prompt(REPO_PROMPTS, false);
    assert.ok(all.includes('결과를 모아 할 일을 마무리하고'));
    assert.equal(all.includes('아직 끝나지 않은 일'), false);
    assert.equal(all.includes('먼저 깨웠습니다'), false);
  });

  test('팀원 돕기 (2026-11-20): 끝나지 않은 일의 진행 기록, 나눠 돕기, 도움 요청으로 깬 까닭', () => {
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const results = [
      {
        task_id: 'c2',
        title: '정리',
        agent: '정리 팀원',
        status: 'running',
        since,
        progress: ['자료 10개 중 4개 읽음', '도움 요청: 6~10번 자료 요약'],
      },
      { task_id: 'c1', title: '조사', agent: '조사 팀원', status: 'done', summary: '표' },
    ];
    const woke = job({ subtask_results: results, wake: 'help', rounds_left: 2 }).prompt(
      REPO_PROMPTS,
      false,
    );
    assert.ok(woke.includes('일꾼 하나가 나눌 부분을 적어 도움을 청해 먼저 깨웠습니다'));
    assert.ok(
      woke.includes(
        '## [일하는 중 · 30분째] 정리 (정리 팀원) · task_id: c2\n진행 기록:\n- 자료 10개 중 4개 읽음\n- 도움 요청: 6~10번 자료 요약',
      ),
    );
    assert.ok(woke.includes('나눠 돕기: "일하는 중"인 일이 오래 걸리면'));
    assert.ok(woke.includes('## [완료] 조사 (조사 팀원)\n표'));
    assert.equal(woke.includes('- 표\n진행 기록'), false, '끝난 일에는 진행 기록을 싣지 않는다');
    const deadline = job({ subtask_results: results, wake: 'deadline' }).prompt(
      REPO_PROMPTS,
      false,
    );
    assert.equal(deadline.includes('도움을 청해'), false);
  });

  test('도움 요청 (ask_help)은 대표가 맡긴 일에서만 알린다', () => {
    const delegated = { id: 't', title: '정리', payload: { delegatedBy: 'boss' } };
    const member = job({ task: delegated }).prompt(REPO_PROMPTS, false);
    assert.ok(member.includes('ask_help로 그 부분'));
    assert.equal(job({}).prompt(REPO_PROMPTS, false).includes('ask_help'), false, '맨 위 일');
  });

  test('대표의 일(agent.lead, O-2)에는 lead 단락을 넣는다: 직접 할 일 · 나눠 맡기기 · continue로 커넥터 붙이기 제안 · 결과 중심', () => {
    const team = [{ agent_id: 'h1', name: '조사', role: '', status: 'active', kinds: ['general'] }];
    const lead = job({
      agent: {
        id: 'l',
        name: '대표',
        role: '대화를 받아 일꾼에게 나눠 맡긴다',
        tool: 'claude',
        lead: true,
      },
      team,
      rounds_left: 2,
    }).prompt(REPO_PROMPTS, false);
    assert.ok(lead.includes('# 대표로 일하는 법'));
    assert.ok(lead.includes('continue: true'));
    assert.ok(lead.includes('바로 할 수 있는 일은 직접 하고'), '작은 일은 대표가 직접');
    assert.ok(lead.indexOf('# 일꾼') < lead.indexOf('# 대표로 일하는 법'), '일꾼 목록 뒤에');
    const worker = job({}).prompt(REPO_PROMPTS, false);
    assert.equal(worker.includes('대표로 일하는 법'), false, '일꾼의 일에는 없다');
  });

  test('대표의 대화 회차 (O-3): 받을 것을 set_deliver로 정하고, 자동화는 이 대화 id로 찾는다. 정해진 받을 것이면 그것을 낸다', () => {
    const lead = { id: 'l', name: '대표', role: '', tool: 'claude', lead: true };
    const turn = (chat: object) =>
      job({
        agent: lead,
        task: {
          id: 't',
          title: '대화 · 브리핑',
          payload: { chat: { turn: 1, history: [], ...chat } },
        },
      }).prompt(REPO_PROMPTS, false);
    const free = turn({ chatId: 'chat-7' });
    assert.ok(free.includes('set_deliver로 이번 회차의 받을 것을 정합니다'));
    assert.ok(free.includes('chat_id가 이 대화(chat-7)인 것'));
    assert.ok(
      free.includes('propose_setting setting: schedule'),
      '되풀이할 일은 자동화를 제안한다',
    );
    assert.ok(free.includes('답 글은 두세 줄로'));
    const fixed = turn({ chatId: 'chat-8', deliver: 'blog' });
    assert.ok(fixed.includes('이번 회차의 받을 것은 이미 정해져 있습니다: blog'));
    assert.equal(fixed.includes('set_deliver로 이번 회차의'), false);
  });

  test('덧붙인 말의 답 (병렬, 2026-11-20): 새 일이면 기다리지 않고 바로 맡기고, 받을 것은 정하지 않는다', () => {
    const lead = { id: 'l', name: '대표', role: '', tool: 'claude', lead: true };
    const reply = job({
      agent: lead,
      task: {
        id: 't',
        title: '대화 · 일정표도',
        payload: { chat: { chatId: 'chat-3', turn: 1, history: [], reply: true, appId: 'app-1' } },
      },
    }).prompt(REPO_PROMPTS, false);
    assert.ok(reply.includes('# 덧붙인 말에 답하는 법'));
    assert.ok(reply.includes('지금 일이 끝나기를 기다리지 않습니다'));
    assert.equal(reply.includes('새로 나눠 맡기거나 큰 일을 하지 않습니다'), false);
    assert.equal(reply.includes('set_deliver로 이번 회차의'), false, 'set_deliver는 회차만');
    assert.ok(reply.includes('받을 것(set_deliver)은 회차의 것이라 정하지 않습니다'));
    assert.ok(reply.includes('이 대화는 앱 하나의 일입니다 (app_id: app-1)'), '그 앱의 일만');
  });

  test('대표의 앱 일 (스토어 2단계): 앱의 편집 방침을 지시에 적고, 앱으로 연 대화면 그 앱 하나만', () => {
    const lead = { id: 'l', name: '대표', role: '', tool: 'claude', lead: true };
    const turn = (chat: object) =>
      job({
        agent: lead,
        task: { id: 't', title: '대화 · 글', payload: { chat: { turn: 1, history: [], ...chat } } },
      }).prompt(REPO_PROMPTS, false);
    const plain = turn({ chatId: 'chat-1' });
    assert.ok(plain.includes('get_settings kind: apps'), '앱의 편집 방침을 읽는다 (늘 있는 줄)');
    assert.equal(plain.includes('agent_id }'), false, '운영 팀장은 없다 (2026-11-21)');
    assert.equal(plain.includes('이 대화는 앱 하나의 일입니다'), false);
    const inApp = turn({ chatId: 'chat-2', appId: 'app-9' });
    assert.ok(inApp.includes('이 대화는 앱 하나의 일입니다 (app_id: app-9)'));
  });

  test('대표의 새 앱 만들기 (스토어 2-6): 방문자가 하는 일로 종류를 고르고 승인 한 번에', () => {
    const lead = { id: 'l', name: '대표', role: '', tool: 'claude', lead: true };
    const prompt = job({
      agent: lead,
      task: {
        id: 't',
        title: '대화 · 앱',
        payload: { chat: { chatId: 'c', turn: 1, history: [] } },
      },
    }).prompt(REPO_PROMPTS, false);
    assert.ok(prompt.includes('방문자가 무엇을 하는지로 종류를 고릅니다'), '늘 있는 줄');
    assert.ok(prompt.includes('kind: page (페이지 없이 만들고 화면은 앱 코드로'));
    assert.ok(prompt.includes('page면 app_code(첫 화면)'), '받을 것은 앱의 첫 결과');
    assert.equal(prompt.includes('new_team'), false, '앱 운영 팀은 없다 (2026-11-21)');
  });

  test('묶인 일꾼은 정해진 컴퓨터에서 일한다고 대표에게 알린다', () => {
    const prompt = job({
      team: [
        {
          agent_id: 'm1',
          name: '내 폴더',
          role: '',
          status: 'active',
          kinds: ['general'],
          bound: true,
        },
        { agent_id: 'm2', name: '조사', role: '', status: 'active', kinds: ['general'] },
      ],
      rounds_left: 1,
    }).prompt(REPO_PROMPTS, false);
    assert.match(prompt, /내 폴더 \(agent_id: m1\).*정해진 컴퓨터에서 일함/);
    assert.doesNotMatch(prompt, /조사 \(agent_id: m2\).*정해진 컴퓨터/);
  });

  test('대화의 회차면 이전 대화를 자료로, 답하는 법과 함께 담는다', () => {
    const chat = (history: object[]) =>
      job({
        task: {
          id: 't',
          title: '대화 · 저녁은?',
          payload: { chat: { chatId: 'c', turn: 2, history } },
        },
      });
    const prompt = chat([
      { from: 'owner', text: '주말 계획 세워 줘' },
      { from: 'agent', text: '성수 카페 어때요' },
    ]).prompt(REPO_PROMPTS, false);
    assert.ok(prompt.includes('# 이전 대화 (자료)'));
    assert.ok(prompt.includes('[관리자] 주말 계획 세워 줘\n[나] 성수 카페 어때요'));
    assert.ok(prompt.indexOf('# 할 일') < prompt.indexOf('# 이전 대화'));
    assert.ok(prompt.includes('# 대화로 답하는 법'));
    const first = chat([]).prompt(REPO_PROMPTS, false);
    assert.equal(first.includes('# 이전 대화'), false, '첫 회차에는 앞 대화가 없다');
    assert.ok(first.includes('# 대화로 답하는 법'));
    assert.equal(
      job().prompt(REPO_PROMPTS, false).includes('대화로 답하는 법'),
      false,
      '대화가 아닌 일',
    );
  });

  test('대화의 일: 덧붙인 말 · 팀 소식(자료) 단락, 덧붙인 말에 답하는 일은 짧게 답하는 법 (2차 1-1)', () => {
    const turn = job({
      task: {
        id: 't',
        title: '대화 · 대회 분석',
        payload: { chat: { chatId: 'c', turn: 1, history: [] } },
      },
      chat_updates: {
        appended: [{ n: 3, text: '마감일만 먼저 알려 줘' }],
        team: [{ n: 4, kind: 'assumption', agent: '리서처', text: '본선은 오프라인이라고 가정' }],
      },
    }).prompt(REPO_PROMPTS, false);
    assert.ok(turn.includes('# 덧붙인 말\n관리자가 이 회차에 덧붙인 말입니다'));
    assert.ok(turn.includes('- 마감일만 먼저 알려 줘'));
    assert.ok(turn.includes('# 일꾼 소식 (자료)'));
    assert.ok(turn.includes('- [assumption] 리서처: 본선은 오프라인이라고 가정'));
    assert.ok(turn.includes('post_update'), '대표에게 가정을 남기는 법');
    const reply = job({
      task: {
        id: 'r',
        title: '대화 · 마감일만',
        payload: { chat: { chatId: 'c', turn: 1, reply: true, history: [] } },
      },
    }).prompt(REPO_PROMPTS, false);
    assert.ok(reply.includes('# 덧붙인 말에 답하는 법'));
    assert.equal(reply.includes('# 대화로 답하는 법'), false);
    assert.equal(reply.includes('# 일꾼 소식'), false, '소식이 없으면 단락도 없다');
  });

  test('팀이 없으면 위임을 말하지 않고, 횟수를 다 쓰면 직접 마무리한다', () => {
    assert.equal(job().prompt(REPO_PROMPTS, false).includes('delegate_task'), false);
    const spent = job({
      team: [{ agent_id: 'w1', name: '팀원', role: '', status: 'active', kinds: ['general'] }],
      rounds_left: 0,
    }).prompt(REPO_PROMPTS, false);
    assert.equal(spent.includes('delegate_task'), false);
    assert.ok(spent.includes('더 맡길 수 없습니다'));
  });

  test('임대 끝을 시각으로 읽는다', () => {
    assert.equal(job().leaseUntil?.toISOString(), '2026-11-01T00:15:00.000Z');
  });
});

describe('코드 러너 칸의 코드 작업', () => {
  const TASK = '0190f5a2-0000-7000-8000-0000000000c1';
  const codeJob = (kind = 'code') =>
    Job.from(
      Json.of({
        task: { id: TASK, kind, title: '고치기', payload: { code: {} } },
        instruction: '고쳐 주세요',
        agent: { name: '코드 담당', role: '', tool: 'claude' },
        run_token: 'run-token',
      }),
    );
  const self = AgentUser.parse('self') as AgentUser;

  test('칸의 자리 안에서 셸과 찾기를 묻지 않고 허락한다. 작업 폴더는 저장소 사본, 홈 · 임시는 그 자리', async () => {
    const base = mkdtempSync(join(tmpdir(), 'moida-room-'));
    const room = await SandboxRoom.open(base, TASK, self);
    mkdirSync(room.cleanDir);
    await room.handOver();
    const cli = new ClaudeCli('claude', 'oauth-token', 'http://moida-server:4000/mcp', skillsDir);
    const workspace = await cli.open(codeJob(), room);
    await workspace.handOver();
    const args = [...cli.args(workspace)];
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Write,Edit,Bash,Glob,Grep,WebSearch');
    for (const tool of ['Bash', 'Glob', 'Grep']) assert.ok(args.includes(tool), tool);
    assert.equal(workspace.workDir, room.workDir);
    assert.equal(workspace.user, self);
    const env = cli.env(workspace, {
      PATH: '/bin',
      HTTPS_PROXY: 'http://egress:3128',
      MOIDA_RUNNER_TOKEN: 'x',
    });
    assert.equal(env.HOME, room.homeDir);
    assert.equal(env.TMPDIR, room.tmpDir);
    assert.equal(env.HTTPS_PROXY, 'http://egress:3128', '바깥은 나가는 프록시로');
    assert.equal(env.MOIDA_RUNNER_TOKEN, undefined);
    await workspace.remove();
    assert.ok(existsSync(workspace.mcpConfigPath), '칸의 자리는 SandboxRoom이 지운다');
    await room.close();
    rmSync(base, { recursive: true, force: true });
  });

  test('칸의 자리 밖이면 코드 작업이어도 셸을 열지 않는다', async () => {
    const cli = new ClaudeCli('claude', 'oauth-token', 'http://moida-server:4000/mcp', skillsDir);
    const workspace = await cli.open(codeJob());
    const args = cli.args(workspace).join(' ');
    assert.equal(args.includes('Bash'), false);
    await workspace.remove();
  });
});

describe('서버가 실어 보낸 스킬', () => {
  const withPackage = (pkg: unknown) =>
    Job.from(
      Json.of({
        task: { id: 'task-1', kind: 'draft_post', title: '초안', payload: {} },
        instruction: '글을 써 주세요',
        agent: { name: '글쓰기', role: '', tool: 'claude' },
        run_token: 'run-token',
        skill: 'moida-write',
        skill_package: pkg,
      }),
    );
  const pkg = {
    name: 'moida-write',
    source: 'console',
    revision: 3,
    hash: 'a'.repeat(64),
    files: {
      'SKILL.md':
        '---\nname: moida-write\nmoida-where: runner\n---\n콘솔 판. {{SKILL_DIR}}/references/style.md를 읽는다',
      'references/style.md': '콘솔 문체',
    },
  };

  test('받은 판을 깐다: 디스크의 skills/는 보지 않는다', async () => {
    const job = withPackage(pkg);
    assert.equal(job.skillPackage?.revision, 3);
    const cli = new ClaudeCli('claude', 'oauth-token', 'http://x/mcp', skillsDir);
    const workspace = await cli.open(job);
    const to = join(workspace.configDir, 'skills', 'moida-write');
    assert.equal(workspace.skillReady, true);
    assert.equal(
      readFileSync(join(to, 'SKILL.md'), 'utf8').includes(`${to}/references/style.md`),
      true,
      '{{SKILL_DIR}}는 깐 자리로',
    );
    assert.equal(readFileSync(join(to, 'references', 'style.md'), 'utf8'), '콘솔 문체');
    assert.equal(existsSync(join(to, 'agents')), false, '디스크의 판(agents/ 포함)을 섞지 않는다');
    await workspace.remove();
  });

  test('경로가 스킬 폴더 밖이거나 SKILL.md가 없으면 받은 판은 없는 것이다 (옛 길로 디스크의 판을 쓴다)', async () => {
    for (const files of [
      { 'SKILL.md': 'x', '../escape.md': 'x' },
      { 'SKILL.md': 'x', 'scripts/run.sh': 'x' },
      { 'references/a.md': 'x' },
      { 'SKILL.md': 1 },
    ])
      assert.equal(withPackage({ ...pkg, files }).skillPackage, null, JSON.stringify(files));
    assert.equal(withPackage({ ...pkg, name: '../x' }).skillPackage, null);
    const old = withPackage(null);
    assert.equal(old.skillPackage, null);
    const workspace = await new ClaudeCli('claude', 'oauth-token', 'http://x/mcp', skillsDir).open(
      old,
    );
    assert.equal(workspace.skillReady, true, '옛 서버: 디스크의 moida-write');
    await workspace.remove();
  });
});
