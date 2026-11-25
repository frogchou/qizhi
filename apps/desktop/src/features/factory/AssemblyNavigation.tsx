import { type KeyboardEvent } from "react";

const tabs = [
  ["manage", "智能体管理"],
  ["assemble", "智能体组装"],
  ["test", "智能体测试"],
] as const;
export type StudioTab = (typeof tabs)[number][0];

export function AssemblyNavigation({
  id,
  tab,
  onSelect,
}: {
  id: string;
  tab: StudioTab;
  onSelect: (tab: StudioTab) => void;
}) {
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + tabs.length - 1) % tabs.length;
        break;
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onSelect(tabs[next][0]);
  }
  return (
    <div className="studio-tabs" role="tablist" aria-label="智能体装配导航">
      {tabs.map(([value, label], index) => (
        <button
          key={value}
          type="button"
          role="tab"
          id={id + "-tab-" + value}
          aria-controls={id + "-panel-" + value}
          aria-selected={tab === value}
          tabIndex={tab === value ? 0 : -1}
          onClick={() => onSelect(value)}
          onKeyDown={(event) => onKey(event, index)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
