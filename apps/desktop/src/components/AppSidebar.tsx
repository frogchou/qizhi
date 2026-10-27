export type AppRoute = "today" | "knowledge" | "codex" | "settings";

const items: { route: AppRoute; label: string; glyph: string }[] = [
  { route: "today", label: "今日", glyph: "□" },
  { route: "knowledge", label: "知识库", glyph: "◇" },
  { route: "codex", label: "Codex 工作", glyph: "✦" },
  { route: "settings", label: "设置", glyph: "⚙" },
];

export function AppSidebar({
  active,
  onNavigate,
}: {
  active: AppRoute;
  onNavigate: (route: AppRoute) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">Q</span>
        <span>栖知</span>
      </div>
      <nav aria-label="主导航">
        {items.map((item) => (
          <button
            key={item.route}
            className={active === item.route ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate(item.route)}
          >
            <span>{item.glyph}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <p className="sidebar-note">
        本地优先
        <br />
        知识工作空间
      </p>
    </aside>
  );
}
