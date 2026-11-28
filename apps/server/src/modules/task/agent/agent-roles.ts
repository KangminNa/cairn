import { RuleViolation, type Unchecked } from '../../platform';
import ROLES from '../agent-roles.json';
import type { AgentRow } from '../task.tables';

// 역할 일꾼 (2026-11-28, 사용자 결정 "이미 있는 일꾼N은 지우고 그냥 강제로 남길 순 없나 그 성격 밑에 이제 에이전트들이 알아서
// 굴리는거지"): ECC의 agents/*.md처럼 일꾼의 성격을 코드 밖 정의 파일(agent-roles.json) 하나에 둔다. 역할마다
//   name      일꾼 이름 (화면 · 일꾼 목록)
//   kinds     이 역할에 맡길 수 있는 작업 종류 (task-kinds.json의 이름)
//   defaults  대표가 역할을 고르지 않고 맡겼을 때 이 역할이 받는 종류
//   role      역할 설명 (11-20 ECC형 형식: 첫 줄 "언제 맡기나" 한 문장, 그다음 하는 일 · 일하는 순서 · 결과 형식 · 끝내기 전에
//             확인 · 하지 않는 것). 지시문 맨 앞(intro)에 실리고, 대표의 일꾼 목록에는 첫 줄만 보인다
// 서버가 공간마다 역할 일꾼을 갖춘다(AgentRoster). 관리자는 이름 · 역할 설명을 바꾸거나 지우지 못한다 (도구 · 모델 · 한도 등은 바꾼다)

/** 역할 하나 (정의 파일의 한 줄) */
export type AgentRoleDef = {
  key: string;
  name: string;
  kinds: readonly string[];
  defaults: readonly string[];
  role: string;
};

// biome-ignore lint/complexity/noStaticOnlyClass: 역할 정의 파일을 읽는 한 곳 (TaskKinds · Engines와 같은 모양)
export class AgentRoles {
  static readonly ALL: readonly AgentRoleDef[] = Object.entries(
    ROLES as Record<string, Omit<AgentRoleDef, 'key'>>,
  ).map(([key, def]) => ({ key, ...def }));
  static readonly KEYS: readonly string[] = AgentRoles.ALL.map((r) => r.key);
  /** 관리자가 역할 일꾼에서 바꾸지 못하는 칸 */
  private static readonly FIXED: readonly ('name' | 'role')[] = ['name', 'role'];

  static find(key: string | null | undefined): AgentRoleDef | null {
    return AgentRoles.ALL.find((r) => r.key === key) ?? null;
  }

  /** 새 역할 일꾼의 칸 */
  static fieldsOf(def: AgentRoleDef): Partial<Unchecked<AgentRow>> {
    return { name: def.name, role: def.role };
  }

  /** 역할 일꾼의 고치기: 이름 · 역할 설명은 정의 파일 그대로만 (같은 값을 다시 보내는 것은 된다) */
  static assertEdit(preset: string | null, changes: Partial<Unchecked<AgentRow>>): void {
    const def = AgentRoles.find(preset);
    if (!def) return;
    const fixed = AgentRoles.FIXED.filter(
      (key) => changes[key] !== undefined && String(changes[key]).trim() !== def[key].trim(),
    );
    if (fixed.length > 0)
      throw new RuleViolation(
        `${def.name}은(는) 기본 역할 일꾼이라 이름 · 역할을 바꾸지 않아요 (도구 · 모델 · 한도는 바꿔요)`,
      );
  }

  /** 대표가 역할을 고르고 맡길 때: 그 역할이 받을 수 있는 종류인가 */
  static assertTakes(def: AgentRoleDef, kind: string): void {
    if (!def.kinds.includes(kind))
      throw new RuleViolation(
        `${def.name}에게는 ${def.kinds.join(' · ')} 일만 맡겨요 (${kind}는 ${AgentRoles.forKind(
          kind,
        )
          .map((r) => r.name)
          .join(' · ')})`,
      );
  }

  /** 역할을 고르지 않고 맡긴 종류를 받을 역할들: defaults에 있으면 그 역할, 없으면 kinds에 있는 역할 */
  static forKind(kind: string): readonly AgentRoleDef[] {
    const first = AgentRoles.ALL.filter((r) => r.defaults.includes(kind));
    return first.length > 0 ? first : AgentRoles.ALL.filter((r) => r.kinds.includes(kind));
  }
}
