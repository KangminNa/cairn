import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ApiClient, type ApiResult, TestUser } from './api-client';
import { CommunitySite } from './community-site';

// 공통 앱 도메인 (2026-11-27, 기획서 결정 "apps.moida.ai.kr"): MOIDA_APPS_URL의 호스트로 온 요청은 앱 도메인처럼 등록한 경로만 지나고,
// 앱은 웹이 경로의 첫 칸에서 읽어 x-moida-app 머리글로 알린다. 그 도메인으로 연 공개 화면은 격리를 풀고(open),
// 계정 하나로 로그인하면 그 도메인의 모든 앱에 같은 쿠키로 참여한다. 자기 도메인 앱 · 기본 도메인은 지금 그대로

const APPS = 'apps.example.com';
const mark = randomUUID().slice(0, 8);
let api: ApiClient;
let owner: TestUser;
const apps: { id: string; slug: string }[] = [];

/** 공통 도메인으로 보내는 요청. app이 있으면 그 앱 (웹이 경로에서 읽어 붙이는 머리글), 쓰기에는 Origin */
function shared(
  path: string,
  app: string | null,
  options: { method?: string; as?: TestUser; body?: object; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const write = (options.method ?? 'GET') !== 'GET';
  return api.viaHost(path, APPS, {
    ...options,
    headers: {
      ...(app ? { 'x-moida-app': app } : {}),
      ...(write ? { origin: `http://${APPS}`, 'x-forwarded-for': CommunitySite.nextPlace() } : {}),
      ...options.headers,
    },
  });
}

/** 도메인 없이 공개한(open이 false면 비공개로 둔), 회원을 받는 페이지 앱 하나 (앱의 약관도 공개) */
async function sharedApp(slug: string, open = true): Promise<{ id: string; slug: string }> {
  const made = await api.request('POST', '/api/apps', owner, {
    requestId: randomUUID(),
    kind: 'page',
    name: `공통 ${slug}`,
    slug,
  });
  assert.equal(made.status, 201, made.text);
  const id = String(made.json().id);
  const app = await new CommunitySite.Probe(api, id).deploy(owner, { members: true });
  for (const kind of ['terms', 'privacy']) {
    const res = await api.request('POST', `/api/community/admin/${id}/terms/${kind}`, owner, {
      version: 0,
      body: `# ${kind}\n\n테스트 약관`,
    });
    assert.equal(res.status, 201, res.text);
  }
  if (!open) return { id, slug };
  const opened = await api.request('PATCH', `/api/apps/${id}`, owner, {
    version: app.version,
    visibility: 'public',
  });
  assert.equal(opened.status, 200, opened.text);
  return { id, slug };
}

before(async () => {
  process.env.MOIDA_APPS_URL = `http://${APPS}`;
  api = await ApiClient.start();
  owner = await api.signIn();
  CommunitySite.mailbox(api);
  // 공통 약관(스토어)은 다른 앱을 여는 도우미가 공개한다
  await CommunitySite.openPage(api, owner, `own-${mark}`, { members: true });
  apps.push(await sharedApp(`one-${mark}`), await sharedApp(`two-${mark}`));
});
after(async () => {
  delete process.env.MOIDA_APPS_URL;
  await api.close();
});

describe('공통 앱 도메인', () => {
  test('그 도메인으로 연 공개 화면은 격리를 풀고 앱은 /<앱> 아래에 있다. 기본 도메인은 격리 그대로', async () => {
    const [one] = apps;
    const screen = async (host: string) =>
      (await api.get(`/api/apps/site/${one?.slug}/screen?path=&host=${host}`)).json() as {
        open: boolean;
      };
    assert.equal((await screen(APPS)).open, true);
    assert.equal((await screen('localhost')).open, false);
  });

  test('관리 API · 콘솔 경로는 없는 주소, 앱 없이도 스토어 가입 · 공통 약관은 열린다', async () => {
    const [one] = apps;
    assert.equal((await shared('/api/auth/me', one?.slug ?? null, { as: owner })).status, 404);
    assert.equal(
      (await shared(`/api/community/admin/${one?.id}/data`, null, { as: owner })).status,
      404,
    );
    assert.equal((await shared('/api/store/terms/terms', null)).status, 200);
    // 앱을 알리지 않은 회원 API는 어느 앱인지 몰라 없는 주소
    assert.equal((await shared('/api/community/me', null)).status, 404);
    assert.equal((await shared('/api/community/me', 'no-such-app')).status, 404);
  });

  test('옛 이름의 머리글(x-cairn-app, 2026-11-28 이름 바꾸기 전의 웹 · 앱 스크립트)도 앱을 알린다', async () => {
    const [one] = apps as unknown as [{ slug: string }];
    const old = await api.viaHost('/api/community/me', APPS, {
      headers: { 'x-cairn-app': one.slug },
    });
    assert.equal(old.status, 200, old.text);
    assert.equal((await shared('/api/community/me', one.slug)).status, 200);
  });

  test('한 번 로그인하면 같은 쿠키로 공통 도메인의 다른 앱에도 참여한다', async () => {
    const [one, two] = apps as unknown as [{ slug: string }, { slug: string }];
    const email = CommunitySite.emailOf(`shared_${mark}`);
    const sent = await shared('/api/community/join/code', one.slug, {
      method: 'POST',
      body: { email },
    });
    assert.equal(sent.status, 204, `${sent.status} ${sent.text}`);
    const code = CommunitySite.mailbox(api).codeFor(email);
    const joined = await shared('/api/community/join', one.slug, {
      method: 'POST',
      body: {
        email,
        code,
        nickname: '공통회원',
        password: CommunitySite.PASSWORD,
        ageConfirmed: true,
        loginId: CommunitySite.loginIdOf(email),
        ...CommunitySite.AGREED,
      },
    });
    assert.equal(joined.status, 201, joined.text);
    const member = new TestUser(joined.cookies());
    const meOne = (await shared('/api/community/me', one.slug, { as: member })).json() as {
      member: { nickname: string } | null;
    };
    assert.equal(meOne.member?.nickname, '공통회원');

    // 두 번째 앱: 같은 쿠키라 로그인은 되어 있고, 참여만 하면 된다
    const meTwo = (await shared('/api/community/me', two.slug, { as: member })).json() as {
      account: unknown;
      member: unknown;
      csrf: string;
    };
    assert.ok(meTwo.account, '같은 도메인의 쿠키라 계정이 보인다');
    assert.equal(meTwo.member, null, '아직 이 앱에는 참여 전');
    const { termsVersion, privacyVersion, ...agreed } = CommunitySite.AGREED;
    const entered = await shared('/api/community/enter', two.slug, {
      method: 'POST',
      as: member,
      body: { nickname: '두번째앱', ...agreed },
      headers: { 'x-moida-csrf': String(meTwo.csrf) },
    });
    assert.equal(entered.status, 201, entered.text);
    assert.equal(
      (
        (await shared('/api/community/me', two.slug, { as: member })).json() as {
          member: { nickname: string } | null;
        }
      ).member?.nickname,
      '두번째앱',
    );
  });

  test('3-5: 비공개 앱의 주소를 머리글에 넣어도 회원 API · 앱 데이터는 없는 주소다', async () => {
    const hidden = await sharedApp(`hidden-${mark}`, false);
    for (const path of ['/api/community/me', '/api/community/terms/terms']) {
      const res = await shared(path, hidden.slug);
      assert.equal(res.status, 404, `${path} ${res.status} ${res.text}`);
    }
    const sent = await shared('/api/community/join/code', hidden.slug, {
      method: 'POST',
      body: { email: CommunitySite.emailOf(`hidden_${mark}`) },
    });
    assert.equal(sent.status, 404, sent.text);
  });

  test('3-5: 회원 쿠키는 관리 경로에서 통하지 않고, 공통 도메인에 관리자 쿠키를 실어도 회원 · 관리자가 아니다', async () => {
    const [one] = apps as unknown as [{ slug: string; id: string }];
    assert.equal((await shared('/api/apps', one.slug, { as: owner })).status, 404);
    const me = (await shared('/api/community/me', one.slug, { as: owner })).json() as {
      account: unknown;
      member: unknown;
    };
    assert.equal(me.account, null);
    assert.equal(me.member, null);
  });

  test('기능 패키지의 방문자 동작은 공통 도메인에서도 닿고, 관리자 동작은 방문자로 막힌다 (2026-11-28 메일 구독)', async () => {
    const enabled = await api.request('POST', '/api/plugins/email/enable', owner);
    assert.ok(enabled.status < 300, enabled.text);
    // SMTP를 정하지 않아 구독은 닫혀 있다: 문지기의 "없는 주소예요"가 아니라 패키지 동작의 답이면 닿은 것이다
    const subscribe = await shared('/api/p/email/subscribe', null, {
      method: 'POST',
      body: { apps: [apps[0]?.slug], address: 'reader@example.com', agree: true },
    });
    assert.equal(subscribe.status, 404, subscribe.text);
    assert.match(subscribe.text, /메일 구독을 받지 않아요/);
    // 관리자 동작은 관리자 쿠키를 실어도 앱 도메인에서는 방문자라 막힌다
    const remove = await shared(`/api/p/email/subscribers/${randomUUID()}/remove`, null, {
      method: 'POST',
      as: owner,
      body: {},
    });
    assert.ok([401, 403].includes(remove.status), remove.text);
    // 그 밖의 관리 경로는 그대로 없는 주소
    const plugins = await shared('/api/plugins', null, { as: owner });
    assert.equal(plugins.status, 404, plugins.text);
    assert.match(plugins.text, /없는 주소예요/);
  });

  test('3-5: 공통 도메인의 쓰기도 다른 출처 · 다른 사이트에서 오면 403', async () => {
    const [one] = apps as unknown as [{ slug: string }];
    for (const origin of ['https://evil.example', `http://other.${APPS}`]) {
      const res = await shared('/api/community/join/code', one.slug, {
        method: 'POST',
        body: { email: CommunitySite.emailOf(`csrf_${mark}`) },
        headers: { origin },
      });
      assert.equal(res.status, 403, `${origin} ${res.status} ${res.text}`);
    }
  });
});
