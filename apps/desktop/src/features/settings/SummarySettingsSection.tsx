import { useEffect, useRef, useState } from "react";

import type {
  QizhiCommands,
  SummaryPromptTemplateInput,
} from "../../lib/tauri";

type Props = { commands: QizhiCommands };
type EditableTemplate = SummaryPromptTemplateInput & { clientKey: string };

function editableTemplate(
  template: SummaryPromptTemplateInput,
  clientKey: string,
): EditableTemplate {
  return { ...template, clientKey };
}

export function SummarySettingsSection({ commands }: Props) {
  const nextTemplateNumber = useRef(1);
  const [model, setModel] = useState("gpt-5.6-sol");
  const [templates, setTemplates] = useState<EditableTemplate[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    commands
      .getSummarySettings?.()
      .then((settings) => {
        if (!active || !settings) return;
        setModel(settings.model);
        setTemplates(
          settings.templates.map((template) =>
            editableTemplate(template, `saved-${template.id}`),
          ),
        );
      })
      .catch(() => {
        if (active) setError("无法读取今日总结设置。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [commands]);

  function updateTemplate(
    clientKey: string,
    update: Partial<SummaryPromptTemplateInput>,
  ) {
    setTemplates((current) =>
      current.map((template) =>
        template.clientKey === clientKey
          ? { ...template, ...update }
          : template,
      ),
    );
  }

  function addTemplate() {
    const number = nextTemplateNumber.current++;
    const clientKey = `new-${Date.now()}-${number}`;
    setTemplates((current) => [
      ...current,
      editableTemplate(
        {
          id: null,
          title: number === 1 ? "新总结方式" : `新总结方式 ${number}`,
          prompt: "请根据所选文件完成总结。",
          sortOrder: current.length,
          isDefault: current.length === 0,
        },
        clientKey,
      ),
    ]);
    setExpandedKey(clientKey);
    setNotice(null);
  }

  function moveTemplate(clientKey: string, offset: -1 | 1) {
    setTemplates((current) => {
      const index = current.findIndex(
        (template) => template.clientKey === clientKey,
      );
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((template, itemIndex) => ({
        ...template,
        sortOrder: itemIndex,
      }));
    });
  }

  function makeDefault(clientKey: string) {
    setTemplates((current) =>
      current.map((template) => ({
        ...template,
        isDefault: template.clientKey === clientKey,
      })),
    );
  }

  function removeTemplate(clientKey: string) {
    setTemplates((current) => {
      if (current.length <= 1) return current;
      const removed = current.find(
        (template) => template.clientKey === clientKey,
      );
      const remaining = current
        .filter((template) => template.clientKey !== clientKey)
        .map((template, index) => ({ ...template, sortOrder: index }));
      if (removed?.isDefault && remaining[0]) remaining[0].isDefault = true;
      return remaining;
    });
    if (expandedKey === clientKey) setExpandedKey(null);
  }

  async function save() {
    setError(null);
    setNotice(null);
    if (!commands.saveSummarySettings) {
      setError("当前版本暂不支持今日总结设置。");
      return;
    }
    const titles = templates.map((template) =>
      template.title.trim().toLocaleLowerCase(),
    );
    if (
      !model.trim() ||
      templates.length === 0 ||
      templates.some(
        (template) =>
          !template.title.trim() ||
          template.title.length > 60 ||
          !template.prompt.trim() ||
          template.prompt.length > 4_000,
      ) ||
      new Set(titles).size !== titles.length ||
      templates.filter((template) => template.isDefault).length !== 1
    ) {
      setError(
        "标题需唯一且不超过 60 字，提示词不超过 4000 字，并设置一个默认项。",
      );
      return;
    }
    setSaving(true);
    try {
      const saved = await commands.saveSummarySettings({
        model: model.trim(),
        templates: templates.map((template, index) => ({
          id: template.id,
          title: template.title,
          prompt: template.prompt,
          sortOrder: index,
          isDefault: template.isDefault,
        })),
      });
      setModel(saved.model);
      setTemplates(
        saved.templates.map((template) =>
          editableTemplate(template, `saved-${template.id}`),
        ),
      );
      setExpandedKey(null);
      setNotice(`已保存 ${saved.templates.length} 个提示词。`);
    } catch {
      setError("今日总结设置未保存，请检查模型、标题和提示词。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="summary-settings-title"
      className="settings-block summary-settings-section"
    >
      <header className="summary-settings-header">
        <div>
          <p className="settings-section-kicker">AI 工作流</p>
          <h2 id="summary-settings-title">今日总结</h2>
          <p>管理总结模型和快捷提示词；提示词可供未来接入的其他模型共用。</p>
        </div>
        <button
          aria-label="新增提示词"
          className="button outline"
          disabled={loading || saving}
          onClick={addTemplate}
          type="button"
        >
          ＋ 新增提示词
        </button>
      </header>

      <label className="summary-model-field">
        默认总结模型
        <input
          aria-label="总结模型"
          disabled={loading || saving}
          maxLength={120}
          onChange={(event) => setModel(event.currentTarget.value)}
          placeholder="gpt-5.6-sol"
          value={model}
        />
        <span>当前使用 OpenAI 兼容服务；后续可在这里选择其他模型来源。</span>
      </label>

      {loading ? (
        <p className="summary-settings-empty">正在读取提示词…</p>
      ) : null}
      {!loading && templates.length === 0 ? (
        <p className="summary-settings-empty">尚未配置提示词。</p>
      ) : null}
      <div className="summary-prompt-list">
        {templates.map((template, index) => {
          const expanded = expandedKey === template.clientKey;
          return (
            <article
              className={`summary-prompt-row${expanded ? " expanded" : ""}`}
              key={template.clientKey}
            >
              <div className="summary-prompt-row-main">
                <button
                  aria-expanded={expanded}
                  aria-label={`编辑 ${template.title}`}
                  className="summary-prompt-toggle"
                  onClick={() =>
                    setExpandedKey(expanded ? null : template.clientKey)
                  }
                  type="button"
                >
                  <span className="summary-prompt-index">{index + 1}</span>
                  <span className="summary-prompt-copy">
                    <strong>{template.title}</strong>
                    <span>{template.prompt}</span>
                  </span>
                  {template.isDefault ? (
                    <span className="summary-default-badge">默认</span>
                  ) : null}
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m6 8 4 4 4-4" />
                  </svg>
                </button>
                <div className="summary-prompt-row-actions">
                  <button
                    aria-label={`上移 ${template.title}`}
                    disabled={index === 0 || saving}
                    onClick={() => moveTemplate(template.clientKey, -1)}
                    type="button"
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`下移 ${template.title}`}
                    disabled={index === templates.length - 1 || saving}
                    onClick={() => moveTemplate(template.clientKey, 1)}
                    type="button"
                  >
                    ↓
                  </button>
                </div>
              </div>
              {expanded ? (
                <div className="summary-prompt-editor">
                  <label>
                    标题
                    <input
                      aria-label={`总结模板标题 ${index + 1}`}
                      disabled={saving}
                      maxLength={60}
                      onChange={(event) =>
                        updateTemplate(template.clientKey, {
                          title: event.currentTarget.value,
                        })
                      }
                      value={template.title}
                    />
                  </label>
                  <label>
                    提示词
                    <textarea
                      aria-label={`总结提示词 ${index + 1}`}
                      disabled={saving}
                      maxLength={4000}
                      onChange={(event) =>
                        updateTemplate(template.clientKey, {
                          prompt: event.currentTarget.value,
                        })
                      }
                      rows={5}
                      value={template.prompt}
                    />
                  </label>
                  <div className="summary-prompt-editor-actions">
                    <button
                      className="button outline"
                      disabled={template.isDefault || saving}
                      onClick={() => makeDefault(template.clientKey)}
                      type="button"
                    >
                      设为默认
                    </button>
                    <button
                      className="button quiet danger"
                      disabled={templates.length <= 1 || saving}
                      onClick={() => removeTemplate(template.clientKey)}
                      type="button"
                    >
                      删除提示词
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <footer className="summary-settings-footer">
        <span>{templates.length} 个提示词</span>
        <button
          className="button primary"
          disabled={loading || saving || templates.length === 0}
          onClick={() => void save()}
          type="button"
        >
          {saving ? "保存中…" : "保存今日总结设置"}
        </button>
      </footer>
      {error ? <p className="settings-error">{error}</p> : null}
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
