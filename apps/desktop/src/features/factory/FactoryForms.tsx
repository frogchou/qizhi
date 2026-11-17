import { useState } from "react";
import { factoryApi } from "./factory-client";
import {
  FactoryAttachments,
  useFactoryAttachments,
} from "./FactoryAttachments";
import { useFactoryRead } from "./factory-feed";
import {
  ActionNotice,
  Badge,
  Empty,
  Facts,
  Modal,
  ReadNotice,
  useAction,
} from "./FactoryControls";
import {
  type Agent,
  type ManagedPackage,
  type OpenAgent,
  type OpenTask,
  type Page,
} from "./factory-model";

export function RequirementForm({
  onClose,
  onCreated,
  refresh,
  stale,
}: {
  onClose: () => void;
  onCreated: OpenTask;
  refresh: () => void;
  stale: boolean;
}) {
  const attachments = useFactoryAttachments();
  const [goal, setGoal] = useState(""),
    [manual, setManual] = useState(true),
    action = useAction(refresh);
  return (
    <Modal
      title="新建需求"
      closeDisabled={action.busy || attachments.busy}
      onClose={() => {
        if (!action.busy && !attachments.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !goal.trim() ||
            stale ||
            attachments.busy ||
            attachments.failures.length
          )
            return;
          void action.run(async () => {
            const inputIds = await attachments.resolveIds();
            const result = await factoryApi.post<{
              taskId: string;
              state: string;
            }>("/v1/tasks", {
              goal: goal.trim(),
              acceptanceMode: manual ? "human_review" : "platform_auto",
              sourceSystem: "qizhi_desktop",
              ...(inputIds.length ? { inputIds } : {}),
            });
            if (!result.taskId)
              throw new Error(
                "中台已响应，但没有返回工单号，请刷新接待大厅核对提交记录",
              );
            onCreated(result.taskId, goal.trim());
            onClose();
          });
        }}
      >
        <label>
          需求内容
          <textarea
            required
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="说明需要完成的工作、交付形式和验收要求"
          />
        </label>
        <FactoryAttachments
          attachments={attachments}
          disabled={action.busy || stale}
        />
        <label className="fc-check">
          <input
            type="checkbox"
            checked={manual}
            onChange={(e) => setManual(e.target.checked)}
          />{" "}
          由我确认最终交付
        </label>
        <p className="live-subtle">提交来源 · 栖知桌面端</p>
        {stale && <p role="alert">连接已中断，请在恢复后提交。</p>}
        <ActionNotice action={action} />
        <footer>
          <button
            type="button"
            className="ui-action ui-quiet"
            disabled={action.busy || attachments.busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="ui-action ui-primary"
            disabled={
              !goal.trim() ||
              action.busy ||
              attachments.busy ||
              !!attachments.failures.length ||
              stale
            }
          >
            提交并跟随
          </button>
        </footer>
      </form>
    </Modal>
  );
}
type ReleaseResult = { agentId: string; version: string; status: string };
export function ReleaseForm({
  agent,
  onClose,
  onAgent,
  refresh,
  stale,
}: {
  agent: Agent | null;
  onClose: () => void;
  onAgent: OpenAgent;
  refresh: () => void;
  stale: boolean;
}) {
  const [mode, setMode] = useState<"template" | "package">("template"),
    [agentId, setAgentId] = useState(agent?.agentId ?? ""),
    [version, setVersion] = useState(""),
    [displayName, setName] = useState(agent?.displayName ?? ""),
    [description, setDesc] = useState(agent?.description ?? ""),
    [instructions, setInstructions] = useState(""),
    [packageName, setPackage] = useState(""),
    [created, setCreated] = useState<ReleaseResult | null>(null);
  const packages = useFactoryRead<Page<ManagedPackage>>(
    mode === "package" ? "/v1/factory/packages" : null,
    0,
  );
  const choices = (packages.data?.items ?? []).filter(
    (p) => !p.status && (!agent || p.agentId === agent.agentId),
  );
  const selected = choices.find((p) => p.packageName === packageName);
  const action = useAction(refresh);
  const canSubmit =
    mode === "template"
      ? Boolean(
          agentId.trim() &&
          version.trim() &&
          displayName.trim() &&
          description.trim() &&
          instructions.trim(),
        )
      : Boolean(selected);
  const intent = agent ? "upgrade" : "create";
  const close = () => {
    if (!action.busy) onClose();
  };
  return (
    <Modal
      title={agent ? "升级智能体版本" : "新建智能体"}
      onClose={close}
      closeDisabled={action.busy}
    >
      {created ? (
        <>
          <Badge value={created.status} />
          <p>
            {created.agentId} · v{created.version} 已登记。
          </p>
          <p className="live-subtle">
            请在版本详情中审核并运行自检。通过后，中台可以分配新任务。
          </p>
          <footer>
            <button
              type="button"
              className="ui-action ui-quiet"
              onClick={close}
            >
              关闭
            </button>
            <button
              className="ui-action ui-primary"
              onClick={() => {
                onAgent(created.agentId, created.version);
                onClose();
              }}
            >
              查看版本详情
            </button>
          </footer>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit || stale) return;
            void action.run(async () => {
              const result = await factoryApi.post<ReleaseResult>(
                "/v1/factory/releases",
                mode === "template"
                  ? {
                      template: "codex-text",
                      intent,
                      agentId: agentId.trim(),
                      version: version.trim(),
                      displayName: displayName.trim(),
                      description: description.trim(),
                      instructions: instructions.trim(),
                    }
                  : {
                      packageName: selected!.packageName,
                      intent,
                      ...(agent ? { agentId: agent.agentId } : {}),
                    },
              );
              if (!result.agentId || !result.version)
                throw new Error("中台未返回登记后的版本，请刷新版本列表核对");
              setCreated(result);
            });
          }}
        >
          <label>
            登记方式
            <select
              value={mode}
              onChange={(e) =>
                setMode(e.target.value as "template" | "package")
              }
            >
              <option value="template">创建托管的 Codex 文本智能体</option>
              <option value="package">登记服务器上已安装的包</option>
            </select>
          </label>
          {agent && (
            <p className="live-subtle">
              当前版本 · {agent.agentId} v{agent.version}
            </p>
          )}
          {mode === "template" ? (
            <>
              <label>
                智能体标识
                <input
                  required
                  maxLength={63}
                  value={agentId}
                  readOnly={!!agent}
                  pattern={"[a-z][a-z0-9\\-]{1,62}"}
                  title="2–63 个小写字母、数字或连字符，以字母开头"
                  placeholder="例如 research-editor"
                  onChange={(e) => setAgentId(e.target.value)}
                />
              </label>
              <div className="live-form-pair">
                <label>
                  版本号
                  <input
                    required
                    pattern="(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})"
                    title="使用 X.Y.Z 三段版本号，每段最多六位数字"
                    placeholder={agent ? "高于现有版本" : "1.0.0"}
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                  />
                </label>
                <label>
                  显示名称
                  <input
                    required
                    maxLength={100}
                    value={displayName}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </div>
              <label>
                能力说明
                <input
                  required
                  maxLength={500}
                  value={description}
                  placeholder="中台在什么任务中应选择此智能体"
                  onChange={(e) => setDesc(e.target.value)}
                />
              </label>
              <label>
                执行指令
                <textarea
                  required
                  maxLength={8000}
                  value={instructions}
                  placeholder="描述处理方法和输出要求"
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <ReadNotice read={packages} />
              {packages.data && (
                <>
                  <label>
                    已安装但尚未登记的包
                    <select
                      required
                      value={selected?.packageName ?? ""}
                      onChange={(e) => setPackage(e.target.value)}
                    >
                      <option value="">请选择服务器软件包</option>
                      {choices.map((p) => (
                        <option key={p.packageName} value={p.packageName}>
                          {p.displayName} · {p.version} · {p.packageName}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!choices.length && (
                    <Empty>
                      {agent
                        ? "没有为此智能体安装的未登记版本"
                        : "没有可登记的软件包"}
                    </Empty>
                  )}
                  {selected && (
                    <Facts
                      rows={[
                        ["智能体", selected.agentId],
                        ["版本", selected.version],
                        ["包名", selected.packageName],
                      ]}
                    />
                  )}
                </>
              )}
            </>
          )}
          {stale && <p role="alert">连接已中断，请在恢复后提交。</p>}
          <ActionNotice action={action} />
          <footer>
            <button
              type="button"
              className="ui-action ui-quiet"
              disabled={action.busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="ui-action ui-primary"
              disabled={action.busy || !canSubmit || stale}
            >
              {agent ? "登记升级版本" : "创建并登记"}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
