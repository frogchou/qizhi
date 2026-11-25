import { useId, useState, type ReactNode } from "react";
import {
  ControlIcon,
  type ControlIconName,
} from "../../components/ControlIcon";
import { Badge } from "./FactoryControls";
import {
  effectLabel,
  type AssemblyOption,
  type AssemblyOptions,
  type ResourceSelection,
} from "./assembly-model";
import { when } from "./factory-model";

type ChoiceProps = {
  label: string;
  options: AssemblyOption[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  suggested?: string[];
  clearLabel?: string;
  disabled?: boolean;
  disclosureIcon?: ControlIconName;
  children?: ReactNode;
};

export function ChoiceGroup({
  label,
  options,
  selected,
  onSelect,
  suggested = [],
  clearLabel,
  disabled = false,
  disclosureIcon,
  children,
}: ChoiceProps) {
  const [expanded, setExpanded] = useState(false);
  const region = useId();
  const catalog = new Map(options.map((option) => [option.id, option]));
  const choices: AssemblyOption[] = [
    ...catalog.values(),
    ...selected
      .filter((id) => !catalog.has(id))
      .map((id) => ({
        id,
        label: id,
        available: false,
        description: "已选记录已离开当前目录，仍可取消授权",
      })),
  ];
  const selectedIds = new Set(selected);
  const suggestedIds = new Set(suggested);
  const checked = selected.map((id) => catalog.get(id)?.label || id);
  const summary = checked.length ? checked.join("、") : clearLabel || "未选用";
  const suggestedCount = choices.filter(
    (item) => !selectedIds.has(item.id) && suggestedIds.has(item.id),
  ).length;
  const hasWrite = choices.some(
    (item) => selectedIds.has(item.id) && item.effect === "external_write",
  );
  const hasUnavailable = selected.some(
    (id) => !catalog.has(id) || catalog.get(id)?.available === false,
  );
  const caption = [
    hasWrite && "包含对外写入",
    hasUnavailable && "含不可用资源",
    summary,
  ]
    .filter(Boolean)
    .join(" · ");
  const nameCounts = new Map<string, number>();
  for (const choice of choices)
    nameCounts.set(choice.label, (nameCounts.get(choice.label) ?? 0) + 1);
  const choiceList = (!disclosureIcon || expanded) && (
    <fieldset
      className="assembly-choices"
      disabled={disabled}
      aria-label={label}
    >
      {!disclosureIcon && <legend>{label}</legend>}
      <div className="assembly-choice-list">
        {clearLabel && (
          <label className="assembly-choice">
            <input
              type="checkbox"
              checked={selected.length === 0}
              onChange={() => onSelect([])}
            />
            <span>{clearLabel}</span>
          </label>
        )}
        {choices.map((option) => {
          const isSelected = selectedIds.has(option.id);
          const metadata = [
            !disclosureIcon && option.id !== option.label ? option.id : "",
            disclosureIcon && option.version ? "v" + option.version : "",
            option.available === false ? "当前不可用" : "",
            effectLabel(option.effect),
            option.destination && "目的地 " + option.destination,
            option.description,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <label
              key={option.id}
              className="assembly-choice"
              title={option.id}
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={option.available === false && !isSelected}
                onChange={(e) =>
                  onSelect(
                    e.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              <span>
                <strong>{option.label}</strong>
                {suggestedIds.has(option.id) && !isSelected && (
                  <em>中台建议</em>
                )}
                {metadata && <small>{metadata}</small>}
                {disclosureIcon && (nameCounts.get(option.label) ?? 0) > 1 && (
                  <small>{option.id}</small>
                )}
              </span>
            </label>
          );
        })}
        {!choices.length && <p className="live-subtle">目录中暂无可选项</p>}
      </div>
    </fieldset>
  );
  if (!disclosureIcon)
    return (
      <>
        {choiceList}
        {children}
      </>
    );
  return (
    <div className="studio-resource-group">
      <button
        type="button"
        className="studio-resource-toggle"
        aria-expanded={expanded}
        aria-controls={region}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="studio-resource-icon">
          <ControlIcon name={disclosureIcon} size={17} />
        </span>
        <span className="studio-resource-caption">
          <strong>{label}</strong>
          <small title={caption}>{caption}</small>
        </span>
        <span className="studio-resource-count">
          {selected.length
            ? "已选 " + selected.length
            : suggestedCount
              ? suggestedCount + " 项建议"
              : options.length + " 项可选"}
        </span>
        <ControlIcon
          name="chevron"
          size={15}
          className="studio-resource-arrow"
        />
      </button>
      <div id={region} className="studio-resource-options" hidden={!expanded}>
        {choiceList}
        {children}
      </div>
    </div>
  );
}

export function ResourceChoices({
  options,
  selection,
  suggestions,
  onEdit,
  includeSkills = true,
  disabled = false,
  collapsible = false,
}: {
  options: AssemblyOptions;
  selection: ResourceSelection;
  suggestions?: Partial<ResourceSelection>;
  onEdit: (field: keyof ResourceSelection, selected: string[]) => void;
  includeSkills?: boolean;
  disabled?: boolean;
  collapsible?: boolean;
}) {
  const groups: {
    key: keyof ResourceSelection;
    label: string;
    icon: ControlIconName;
    options: AssemblyOption[];
  }[] = [
    {
      key: "skills",
      label: "精选 Skill",
      icon: "file",
      options: options.skills,
    },
    {
      key: "mcpTools",
      label: "MCP 工具",
      icon: "sliders",
      options: options.mcpTools,
    },
    {
      key: "capabilities",
      label: "业务能力",
      icon: "layers",
      options: options.capabilities,
    },
    {
      key: "datasetIds",
      label: "RAGFlow 知识库",
      icon: "folder",
      options: options.datasets.map((d) => ({ id: d.id, label: d.name })),
    },
  ];
  const status = options.connection;
  const connection = status && (
    <p className="assembly-connection" role="status">
      <Badge value={status.status} label={status.message} />
      {status.observedAt && <time>{when(status.observedAt, true)}</time>}
    </p>
  );
  const connectionIssue =
    collapsible && status && status.status !== "connected";
  return (
    <div
      className={
        collapsible ? "studio-resource-groups" : "assembly-resource-grid"
      }
    >
      {groups
        .filter((g) => includeSkills || g.key !== "skills")
        .map((g) => (
          <div key={g.key}>
            <ChoiceGroup
              label={g.label}
              options={g.options}
              selected={selection[g.key]}
              suggested={suggestions?.[g.key]}
              onSelect={(ids) => onEdit(g.key, ids)}
              disabled={disabled}
              disclosureIcon={collapsible ? g.icon : undefined}
              clearLabel={g.key === "datasetIds" ? "不用知识库" : undefined}
            >
              {g.key === "datasetIds" && !connectionIssue && connection}
            </ChoiceGroup>
            {g.key === "datasetIds" && connectionIssue && connection}
          </div>
        ))}
    </div>
  );
}
