// 콘솔 메뉴. 메뉴 하나 = app/admin/<주소>/ 폴더 하나 + 여기 한 줄. 기능이 생길 때 더한다.
// 왼쪽에 떠 있는 독(DOCK)이 보는 화면 여섯(대화 · 에이전트 · 스토어 · 오피스 · 승인 · 보관함)이고, 대화가 처음 화면이다 (2026-11-16 떠 있는 화면, 스토어 1-5).
// 설정에는 바꾸는 것만 둔다: 설정 묶음과 접어 둔 "고급" (MENU, 2026-11-15 화면 정리: 설정은 대화에서 하고 화면은 덜어 둔다).
// 아이콘 이름은 _ui/Icon.tsx의 선 아이콘이다 (2026-11-16 테마 B).

export const CHAT_HREF = '/admin';
export const CHATS_HREF = '/admin/chats';
export const APPROVALS_HREF = '/admin/approvals';
/** 일꾼: 대표와 일꾼 (2026-11-21 팀 없는 에이전트, 메뉴 이름은 사용자 결정 "일꾼"). 이 제품의 핵심 설정 */
const AGENTS_HREF = '/admin/agents';
/** 스토어 (스토어 1-5): 내 앱 · 앱 종류 고르기 · 앱 관리(/admin/store/<앱 id>) */
export const STORE_HREF = '/admin/store';
/** 보관함 (2차 5단계): 결과물 · 페이지 · 읽은 글 · 세션 · 위키 · 글을 한 목록으로. 결과물 · 페이지 · 스크랩 관리는 그 아래 */
export const LIBRARY_HREF = '/admin/library';
/** 설정의 첫 화면: AI 계정 */
export const SETTINGS_HREF = '/admin/ai';

/** 옆 칸(대화 목록 · 설정 메뉴)을 접어 둔 것을 기억하는 쿠키. 콘솔 틀(layout)이 서버에서 읽어 처음부터 그 모양으로 그린다 */
export const SIDE_COOKIE = 'moida_side';

/** 새 대화 (대화 목록 맨 위) */
export const NEW_CHAT = { href: CHAT_HREF, name: '새 대화', icon: 'new' };

/**
 * 독 (2026-11-16 떠 있는 화면): 보는 화면 여섯. 이 순서가 화면이 위아래로 넘어가는 방향이다 (page-flip.ts).
 * pages는 그 화면에 속한 주소들이고, tabs면 카드 위에 탭 줄로 보인다. side면 옆 칸(대화 목록)이 있다.
 * 설정(SETTINGS_SECTION)은 독의 아래 묶음이고, 그 밖의 콘솔 주소는 모두 설정에 속한다.
 */
export const DOCK = [
  {
    key: 'chat',
    href: CHAT_HREF,
    name: '대화',
    icon: 'chat',
    side: true,
    tabs: false,
    pages: [NEW_CHAT, { href: CHATS_HREF, name: '대화' }],
  },
  {
    key: 'agents',
    href: AGENTS_HREF,
    name: '일꾼',
    icon: 'worker',
    side: false,
    tabs: true,
    pages: [
      { href: AGENTS_HREF, name: '일꾼' },
      { href: '/admin/rules', name: '배운 규칙' },
      { href: '/admin/tasks', name: '작업 기록' },
    ],
  },
  {
    key: 'store',
    href: STORE_HREF,
    name: '스토어',
    icon: 'store',
    side: false,
    tabs: true,
    pages: [
      { href: STORE_HREF, name: '내 앱' },
      { href: `${STORE_HREF}/new`, name: '스토어' },
    ],
  },
  {
    key: 'office',
    href: '/admin/office',
    name: '오피스',
    icon: 'office',
    side: false,
    tabs: false,
    pages: [{ href: '/admin/office', name: '오피스' }],
  },
  {
    key: 'approvals',
    href: APPROVALS_HREF,
    name: '승인',
    icon: 'approve',
    side: false,
    tabs: false,
    pages: [{ href: APPROVALS_HREF, name: '승인' }],
  },
  {
    key: 'library',
    href: LIBRARY_HREF,
    name: '보관함',
    icon: 'box',
    side: false,
    tabs: true,
    pages: [
      { href: LIBRARY_HREF, name: '전체' },
      { href: `${LIBRARY_HREF}/outputs`, name: '결과물' },
      { href: `${LIBRARY_HREF}/pages`, name: '페이지' },
      { href: `${LIBRARY_HREF}/basket`, name: '스크랩' },
      { href: '/admin/wiki', name: '위키' },
      { href: '/admin/graph', name: '지식 그래프' },
      { href: '/admin/sessions', name: '세션' },
      { href: '/admin/posts', name: '글' },
    ],
  },
];

/** 독 아래 묶음의 설정: 옆 칸이 설정 메뉴(MENU)다 */
export const SETTINGS_SECTION = {
  key: 'settings',
  href: SETTINGS_HREF,
  name: '설정',
  icon: 'gear',
  side: true,
  tabs: false,
  pages: [] as { href: string; name: string }[],
};

/** 설정 칸의 묶음. advanced는 "고급" 안에 접어 둔다 (대화로 하게 될 것 · 직접 손볼 때만 쓰는 것) */
export const MENU = [
  {
    label: '설정',
    advanced: false,
    items: [
      { href: SETTINGS_HREF, name: 'AI 계정', icon: 'key' },
      { href: '/admin/external-tools', name: '커넥터', icon: 'plug' },
      { href: '/admin/site', name: '사이트', icon: 'site' },
      { href: '/admin/notices', name: '알림', icon: 'bell' },
      { href: '/admin/account', name: '계정', icon: 'user' },
      { href: '/admin/members', name: '회원 계정', icon: 'team' },
      { href: '/admin/security', name: '보안', icon: 'lock' },
    ],
  },
  {
    label: '일',
    advanced: true,
    items: [
      { href: '/admin/goals', name: '목표', icon: 'goal' },
      { href: '/admin/schedules', name: '스케줄', icon: 'clock' },
      { href: '/admin/events', name: '처리 실패', icon: 'warn' },
    ],
  },
  {
    label: '연결',
    advanced: true,
    items: [
      { href: '/admin/runners', name: '러너', icon: 'runner' },
      { href: '/admin/devices', name: '연결된 기기', icon: 'device' },
      { href: '/admin/plugins', name: '플러그인', icon: 'brick' },
      { href: '/admin/skills', name: '스킬', icon: 'puzzle' },
      { href: '/admin/tool-texts', name: 'MCP 도구 설명', icon: 'wrench' },
    ],
  },
];

/** 기능 패키지가 목록 파일에 적은 묶음(옛 이름 포함) → 지금 묶음. 모르는 묶음은 "고급"의 맨 아래 */
export const PACKAGE_GROUPS: Readonly<Record<string, string>> = {
  운영: '일',
  자동화: '일',
  일: '일',
  연결: '연결',
  설정: '설정',
};

/** 콘솔 주소 → 속한 화면과 그 안의 페이지. 가장 길게 맞는 주소가 이긴다 (보관함 › 결과물). 독에 없으면 설정 */
export function placeOf(pathname: string | null): {
  section: (typeof DOCK)[number] | typeof SETTINGS_SECTION;
  index: number;
  page: { href: string; name: string } | null;
} {
  const path = pathname ?? '';
  const fits = (href: string) =>
    path === href || (href !== CHAT_HREF && path.startsWith(`${href}/`));
  let found: ReturnType<typeof placeOf> | null = null;
  for (const [index, section] of DOCK.entries())
    for (const page of section.pages)
      if (fits(page.href) && page.href.length > (found?.page?.href.length ?? 0))
        found = { section, index, page };
  if (found) return found;
  const item = MENU.flatMap((g) => g.items).find((i) => fits(i.href)) ?? null;
  return { section: SETTINGS_SECTION, index: DOCK.length, page: item };
}
