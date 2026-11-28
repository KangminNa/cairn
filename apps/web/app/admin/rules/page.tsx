import { RulesPanel } from './RulesPanel';

// 배운 규칙 (2026-11-28): 피드백에서 배워 승인한 규칙과 도움 · 해로움 횟수. 내리기 · 되살리기는 여기서 바로
export default function RulesPage() {
  return (
    <section className="console-inner wide" aria-label="배운 규칙">
      <header className="page-head">
        <h1>배운 규칙</h1>
      </header>
      <RulesPanel />
    </section>
  );
}
