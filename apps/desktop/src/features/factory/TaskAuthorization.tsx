import { useState } from "react";
import { ResourceChoices } from "./AssemblyChoices";
import { ReadNotice } from "./FactoryControls";
import { useFactoryRead } from "./factory-feed";
import {
  assemblies,
  emptyConfig,
  type AssemblyOptions,
  type TaskScope,
} from "./assembly-model";

type Capability = {
  capability: string;
  displayName: string;
  description: string;
  effect: string;
  defaultDelegation: boolean;
  agentId: string;
  version: string;
};
export function useTaskAuthorization(seed?: TaskScope) {
  const [open, setOpen] = useState(Boolean(seed)),
    [explicit, setExplicit] = useState(Boolean(seed));
  const [edit, setEdit] = useState<TaskScope | null>(null),
    [destination, setDestination] = useState("");
  const asked = open || explicit;
  const capabilities = useFactoryRead<Capability[]>(
    asked ? "/v1/tasks/capability-options" : null,
    0,
  );
  const directory = useFactoryRead<AssemblyOptions>(
    asked ? `${assemblies}/options` : null,
    0,
  );
  const catalog = capabilities.data ?? [];
  const unique = catalog.filter(
    (c, index) =>
      catalog.findIndex((other) => other.capability === c.capability) === index,
  );
  const options = directory.data
    ? {
        ...directory.data,
        capabilities: unique.map((c) => ({
          id: c.capability,
          label: c.displayName,
          description: c.description,
          effect: c.effect,
        })),
      }
    : null;
  const defaults: TaskScope = {
    capabilities: seed
      ? seed.capabilities.filter(
          (id) =>
            unique.find((c) => c.capability === id)?.effect !==
            "external_write",
        )
      : unique
          .filter((c) => c.effect === "read" && c.defaultDelegation)
          .map((c) => c.capability),
    datasetIds: seed?.datasetIds ?? [],
    mcpTools: (seed?.mcpTools ?? []).filter(
      (id) =>
        options?.mcpTools.find((m) => m.id === id)?.effect !== "external_write",
    ),
  };
  const scope = edit ?? defaults;
  const external = Boolean(
    options &&
    [
      ...options.capabilities.filter((c) => scope.capabilities.includes(c.id)),
      ...options.mcpTools.filter((m) => scope.mcpTools.includes(m.id)),
    ].some((c) => c.effect === "external_write"),
  );
  const missing =
    options &&
    (scope.capabilities.some(
      (id) => !options.capabilities.some((c) => c.id === id),
    ) ||
      scope.mcpTools.some((id) => !options.mcpTools.some((c) => c.id === id)) ||
      scope.datasetIds.some(
        (id) => !options.datasets.some((c) => c.id === id),
      ));
  const ready =
    !explicit ||
    Boolean(
      options &&
      capabilities.data &&
      !capabilities.error &&
      !directory.error &&
      !missing &&
      (!external || destination.trim()),
    );
  const body = explicit
    ? {
        authorizedCapabilities: scope.capabilities,
        authorizedDatasetIds: scope.datasetIds,
        authorizedMcpTools: scope.mcpTools,
      }
    : {};
  return {
    open,
    setOpen,
    explicit,
    setExplicit,
    capabilities,
    directory,
    scope,
    options,
    external,
    destination,
    setDestination,
    ready,
    body,
    missing,
    goal: (text: string) =>
      explicit && external
        ? text + "\n\n授权的对外写入目的地或接收方：" + destination.trim()
        : text,
    select: (field: keyof TaskScope, ids: string[]) =>
      setEdit({ ...scope, [field]: ids }),
  };
}
export function TaskAuthorization({
  auth,
  disabled,
}: {
  auth: ReturnType<typeof useTaskAuthorization>;
  disabled: boolean;
}) {
  return (
    <details
      className="assembly-disclosure assembly-task-auth"
      open={auth.open}
      onToggle={(e) => auth.setOpen(e.currentTarget.open)}
    >
      <summary>本次任务授权</summary>
      <label className="assembly-choice">
        <input
          type="checkbox"
          checked={auth.explicit}
          disabled={disabled}
          onChange={(e) => auth.setExplicit(e.target.checked)}
        />
        <span>明确指定本次授权</span>
      </label>
      {!auth.explicit && (
        <p className="live-subtle">当前采用中台默认的只读委托范围。</p>
      )}
      {auth.explicit && (
        <>
          <ReadNotice read={auth.capabilities} />
          <ReadNotice read={auth.directory} />
          {auth.options && auth.capabilities.data && (
            <ResourceChoices
              includeSkills={false}
              disabled={disabled}
              options={auth.options}
              selection={{ ...emptyConfig(), ...auth.scope }}
              onEdit={(field, ids) => {
                if (field !== "skills") auth.select(field, ids);
              }}
            />
          )}
          {auth.missing && (
            <p className="live-subtle">
              所选资源已不可用，请核对当前目录并调整范围。
            </p>
          )}
          {auth.external && (
            <label className="assembly-field">
              对外写入的目的地或接收方
              <input
                required
                value={auth.destination}
                disabled={disabled}
                onChange={(e) => auth.setDestination(e.target.value)}
                placeholder="将随本单需求发给中台"
              />
            </label>
          )}
        </>
      )}
    </details>
  );
}
