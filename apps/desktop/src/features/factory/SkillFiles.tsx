import { useState } from "react";
import type { ChangeEvent } from "react";
import { ActionNotice, useAction } from "./FactoryControls";
import { factoryApi } from "./factory-client";
import { bytes } from "./factory-model";
import {
  contentSize,
  filePreview,
  importSkillFiles,
  verifiedBytes,
  type SkillFile,
} from "./skill-files";

type FilesEditorProps = {
  files: SkillFile[];
  markdown: string;
  onChange: (files: SkillFile[]) => void;
  onMarkdown: (markdown: string) => void;
  action: ReturnType<typeof useAction>;
  disabled: boolean;
};
export function SkillFileEditor({
  files,
  markdown,
  onChange,
  onMarkdown,
  action,
  disabled,
}: FilesEditorProps) {
  const [pendingMarkdown, setPendingMarkdown] = useState<string | null>(null);
  function choose(event: ChangeEvent<HTMLInputElement>, directory: boolean) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!selected.length) return;
    void action.run(async () => {
      const result = await importSkillFiles(files, selected, directory);
      onChange(result.files);
      if (result.markdown !== undefined) {
        if (markdown && markdown !== result.markdown)
          setPendingMarkdown(result.markdown);
        else {
          onMarkdown(result.markdown);
          setPendingMarkdown(null);
        }
      }
    });
  }
  return (
    <fieldset className="assembly-skill-files" disabled={disabled}>
      <legend>随包资料</legend>
      <p>
        已选 {files.length} / 16 个文件，合计{" "}
        {bytes(files.reduce((n, f) => n + contentSize(f.contentBase64), 0))} /
        256 KiB。导入文件夹会保留相对路径，根目录的 SKILL.md 用作正文。
      </p>
      <div className="assembly-grid">
        <label className="assembly-field">
          选择辅助文件
          <input type="file" multiple onChange={(e) => choose(e, false)} />
        </label>
        <label className="assembly-field">
          选择资料文件夹
          <input
            type="file"
            multiple
            ref={(el) => {
              el?.setAttribute("webkitdirectory", "");
            }}
            onChange={(e) => choose(e, true)}
          />
        </label>
      </div>
      {pendingMarkdown !== null && (
        <div className="live-confirm">
          <p>文件夹中的 SKILL.md 与当前正文不同。</p>
          <details>
            <summary>查看导入的正文</summary>
            <pre className="assembly-code">{pendingMarkdown}</pre>
          </details>
          <div className="fc-actions">
            <button
              className="ui-action"
              type="button"
              onClick={() => {
                onMarkdown(pendingMarkdown);
                setPendingMarkdown(null);
              }}
            >
              采用文件夹中的正文
            </button>
            <button
              className="ui-action"
              type="button"
              onClick={() => setPendingMarkdown(null)}
            >
              保留当前正文
            </button>
          </div>
        </div>
      )}
      {files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              <div>
                <strong>{file.path}</strong>
                <small>{bytes(contentSize(file.contentBase64))}</small>
              </div>
              <button
                className="ui-action ui-small"
                type="button"
                aria-label={"移除 " + file.path}
                onClick={() =>
                  onChange(files.filter((f) => f.path !== file.path))
                }
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
export function SkillFileViewer({ files }: { files: SkillFile[] }) {
  const [preview, setPreview] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const action = useAction();
  if (!files.length) return null;
  return (
    <section className="assembly-skill-files">
      <h3>随包资料 · {files.length} 个文件</h3>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <div>
              <strong>{file.path}</strong>
              <small>{bytes(contentSize(file.contentBase64))}</small>
            </div>
            <div className="fc-actions">
              <button
                type="button"
                disabled={action.busy}
                className="ui-action ui-small"
                aria-label={"查看 " + file.path}
                onClick={() =>
                  void action.run(async () => {
                    setPreview({
                      path: file.path,
                      content: filePreview(await verifiedBytes(file)),
                    });
                  })
                }
              >
                查看
              </button>
              <button
                type="button"
                disabled={action.busy}
                className="ui-action ui-small"
                aria-label={"下载 " + file.path}
                onClick={() =>
                  void action.run(async () => {
                    const data = await verifiedBytes(file);
                    const saved = await factoryApi.saveSkillFile(
                      file.path.slice(file.path.lastIndexOf("/") + 1),
                      data,
                    );
                    return saved ? "已保存文件。" : "已取消保存。";
                  })
                }
              >
                下载
              </button>
            </div>
          </li>
        ))}
      </ul>
      {preview && (
        <>
          <h4>{preview.path}</h4>
          <pre className="assembly-code">{preview.content}</pre>
        </>
      )}
      <ActionNotice action={action} />
    </section>
  );
}
