import { useMaterialBasket } from "../features/materials/MaterialBasket";
import { ControlIcon } from "./ControlIcon";
import { BrandLogo } from "./BrandLogo";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

export type AppRoute =
  "today" | "knowledge" | "codex" | "factory" | "assembly" | "settings";
type IconName = AppRoute;
const items: { route: AppRoute; label: string; icon: IconName }[] = [
  { route: "today", label: "今日", icon: "today" },
  { route: "knowledge", label: "知识库", icon: "knowledge" },
  { route: "codex", label: "Codex 工作", icon: "codex" },
  { route: "factory", label: "智能工厂", icon: "factory" },
  { route: "assembly", label: "智能体装配", icon: "assembly" },
  { route: "settings", label: "设置", icon: "settings" },
];

function NavIcon({ name }: { name: IconName }) {
  if (name === "assembly") return <ControlIcon name="layers" size={17} />;
  if (name === "factory")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 20V9l6 3V7l6 4V4h4l2 16Z" />
        <path d="M7 16h2m3 0h2m3 0h1" />
      </svg>
    );
  if (name === "today")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2" />
        <path d="m8 12 2.2 2.2L16 8.7" />
      </svg>
    );
  if (name === "knowledge")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 7 7-7 7-7-7 7-7Z" />
        <path d="M9 17.3v2.2h6v-2.2" />
      </svg>
    );
  if (name === "codex")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 1.5 5.2L19 10l-5.5 1.8L12 17l-1.5-5.2L5 10l5.5-1.8L12 3Z" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-1.8-1L14.4 3h-4.8l-.3 3.1a7.6 7.6 0 0 0-1.8 1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 1.8 1l.3 3.1h4.8l.3-3.1a7.6 7.6 0 0 0 1.8-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z" />
    </svg>
  );
}

export function AppSidebar({
  active,
  onNavigate,
  onOpenBasket,
}: {
  active: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onOpenBasket?: () => void;
}) {
  const basket = useMaterialBasket();
  const [version, setVersion] = useState("0.1.5");
  useEffect(() => {
    void getVersion()
      .then((runtimeVersion) => {
        if (typeof runtimeVersion === "string" && runtimeVersion.trim())
          setVersion(runtimeVersion);
      })
      .catch(() => undefined);
  }, []);
  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandLogo />
        <span>栖知</span>
      </div>
      <nav aria-label="主导航">
        {items.map((item) => (
          <button
            key={item.route}
            type="button"
            aria-label={item.label}
            title={item.label}
            aria-current={active === item.route ? "page" : undefined}
            className={active === item.route ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate(item.route)}
          >
            <NavIcon name={item.icon} />
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        {onOpenBasket && (
          <button
            type="button"
            className="basket-navigation"
            aria-label="资料筐"
            title="资料筐"
            aria-haspopup="dialog"
            onClick={onOpenBasket}
          >
            <ControlIcon name="basket" size={17} />
            <span className="basket-nav-label">资料筐</span>
            {basket.loaded && basket.items.length > 0 && (
              <span className="basket-nav-count" aria-hidden="true">
                {basket.items.length}
              </span>
            )}
          </button>
        )}
        <p className="sidebar-note">v{version}</p>
      </div>
    </aside>
  );
}
