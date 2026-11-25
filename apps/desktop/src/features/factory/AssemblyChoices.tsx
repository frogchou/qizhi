import { Badge } from "./FactoryControls";
import {
  effectLabel,
  type AssemblyOption,
  type AssemblyOptions,
  type ResourceSelection,
} from "./assembly-model";
import { when } from "./factory-model";

export function ChoiceGroup({
  label,
  options,
  selected,
  onSelect,
  suggested = [],
  clearLabel,
  disabled = false,
}: {
  label: string;
  options: AssemblyOption[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  suggested?: string[];
  clearLabel?: string;
  disabled?: boolean;
}) {
  const available = new Set(options.map((option) => option.id));
  const choices = [
    ...new Map(options.map((o) => [o.id, o])).values(),
    ...selected
      .filter((id) => !available.has(id))
      .map((id) => ({
        id,
        label: id,
        description: "已选记录 · 当前目录不可用",
      })),
  ];
  return (
    <fieldset className="assembly-choices" disabled={disabled}>
      <legend>{label}</legend>
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
      {choices.map((option: AssemblyOption) => (
        <label key={option.id} className="assembly-choice">
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
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
            {suggested.includes(option.id) && !selected.includes(option.id) && (
              <em>中台建议</em>
            )}
            <small>
              {[
                option.id !== option.label ? option.id : "",
                effectLabel(option.effect),
                option.destination && "目的地 " + option.destination,
                option.description,
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
        </label>
      ))}
      {!choices.length && <p className="live-subtle">目录中暂无可选项</p>}
    </fieldset>
  );
}

export function ResourceChoices({
  options,
  selection,
  suggestions,
  onEdit,
  includeSkills = true,
  disabled = false,
}: {
  options: AssemblyOptions;
  selection: ResourceSelection;
  suggestions?: Partial<ResourceSelection>;
  onEdit: (field: keyof ResourceSelection, selected: string[]) => void;
  includeSkills?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="assembly-resource-grid">
      {includeSkills && (
        <ChoiceGroup
          label="精选 Skill"
          options={options.skills}
          selected={selection.skills}
          suggested={suggestions?.skills}
          onSelect={(ids) => onEdit("skills", ids)}
          disabled={disabled}
        />
      )}
      <ChoiceGroup
        label="MCP 工具"
        options={options.mcpTools}
        selected={selection.mcpTools}
        suggested={suggestions?.mcpTools}
        onSelect={(ids) => onEdit("mcpTools", ids)}
        disabled={disabled}
      />
      <ChoiceGroup
        label="业务能力"
        options={options.capabilities}
        selected={selection.capabilities}
        suggested={suggestions?.capabilities}
        onSelect={(ids) => onEdit("capabilities", ids)}
        disabled={disabled}
      />
      <section className="assembly-datasets">
        <ChoiceGroup
          label="RAGFlow 知识库"
          clearLabel="不用知识库"
          options={options.datasets.map((d) => ({ id: d.id, label: d.name }))}
          selected={selection.datasetIds}
          suggested={suggestions?.datasetIds}
          onSelect={(ids) => onEdit("datasetIds", ids)}
          disabled={disabled}
        />
        {options.connection && (
          <p className="assembly-connection" role="status">
            <Badge
              value={options.connection.status}
              label={options.connection.message}
            />
            {options.connection.observedAt && (
              <time>{when(options.connection.observedAt, true)}</time>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
