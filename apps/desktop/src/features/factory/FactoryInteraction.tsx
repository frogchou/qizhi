import { useState } from "react";
import { useRequestId } from "./assembly-model";
import {
  FactoryAttachments,
  useFactoryAttachments,
} from "./FactoryAttachments";
import { ActionNotice, ReadNotice, useAction } from "./FactoryControls";
import { useFactoryRead } from "./factory-feed";
import { factoryApi } from "./factory-client";
import type { ResponseField, TaskInteraction } from "./factory-model";

function scalar(type: string, value: string): string | boolean | number {
  if (type === "boolean") {
    if (value === "true" || value === "是") return true;
    if (value === "false" || value === "否") return false;
    throw Error("布尔值请填写「是」或「否」。");
  }
  if (type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw Error("请输入有效数字。");
    return n;
  }
  return value;
}
function fieldValue(field: ResponseField, value: string) {
  if (field.enum) return JSON.parse(value) as unknown;
  if (field.type !== "array") return scalar(field.type, value);
  const lines =
    value === "[]"
      ? []
      : value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
  if (
    lines.length < (field.minItems ?? 0) ||
    lines.length > (field.maxItems ?? Infinity)
  )
    throw Error("答复的条目数量超出工单要求。");
  return lines.map((line) => scalar(field.items?.type ?? "string", line));
}
const names: Record<string, string> = {
  answer: "答复",
  decision: "决定",
  note: "补充说明",
  message: "说明",
};
const values: Record<string, string> = {
  confirm: "确认",
  reject: "拒绝",
  true: "是",
  false: "否",
};
export function FactoryInteraction({
  taskId,
  question,
  stale,
  onChange,
}: {
  taskId: string;
  question: TaskInteraction;
  stale: boolean;
  onChange: () => void;
}) {
  const path =
    `/v1/tasks/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(question.id)}` as const;
  const read = useFactoryRead<TaskInteraction>(
    question.responseSchema ? null : path,
    0,
  );
  const schema = question.responseSchema ?? read.data?.responseSchema;
  const [entries, setEntries] = useState<Record<string, string>>({}),
    [submitted, setSubmitted] = useState(false);
  const attachments = useFactoryAttachments(),
    request = useRequestId(),
    action = useAction(onChange);
  const busy = stale || submitted || action.busy || attachments.busy;
  return (
    <form
      className="assembly-question"
      onSubmit={(e) => {
        e.preventDefault();
        if (!schema || busy) return;
        void action.run(async () => {
          const response = Object.fromEntries(
            Object.entries(schema.properties)
              .filter(([key]) => entries[key]?.trim())
              .map(([key, field]) => [key, fieldValue(field, entries[key])]),
          );
          const inputIds = await attachments.resolveIds();
          const body = { response, ...(inputIds.length ? { inputIds } : {}) };
          await factoryApi.post(`${path}/respond`, body, {
            idempotencyKey: request.forPayload(body),
          });
          request.confirmed();
          setSubmitted(true);
          return "已交给中台继续处理。";
        });
      }}
    >
      <h3>{question.title}</h3>
      <p>{question.prompt}</p>
      <ReadNotice read={read} />
      {schema &&
        Object.entries(schema.properties).map(([key, field]) => {
          const label = names[key] ?? key,
            required = schema.required?.includes(key),
            value = entries[key] ?? "";
          const set = (next: string) =>
            setEntries((old) => ({ ...old, [key]: next }));
          const choices =
            field.enum ?? (field.type === "boolean" ? [true, false] : null);
          return (
            <label className="assembly-field" key={key}>
              {label}
              {choices ? (
                <select
                  value={value}
                  required={required}
                  disabled={busy}
                  onChange={(e) => set(e.target.value)}
                >
                  <option value="">请选择</option>
                  {choices.map((v) => (
                    <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
                      {values[String(v)] ?? String(v)}
                    </option>
                  ))}
                </select>
              ) : field.type === "number" ? (
                <input
                  type="number"
                  step="any"
                  required={required}
                  min={field.minimum}
                  max={field.maximum}
                  value={value}
                  disabled={busy}
                  onChange={(e) => set(e.target.value)}
                />
              ) : (
                <textarea
                  required={required}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  value={value}
                  disabled={busy}
                  placeholder={
                    field.type === "array"
                      ? "每行一项，空列表填写 []"
                      : undefined
                  }
                  onChange={(e) => set(e.target.value)}
                />
              )}
            </label>
          );
        })}
      {schema && (
        <>
          <FactoryAttachments attachments={attachments} disabled={busy} />
          <button
            className="ui-action ui-primary"
            disabled={
              busy ||
              Boolean(attachments.failures.length) ||
              schema.required?.some((k) => !entries[k]?.trim())
            }
          >
            提交答复并继续
          </button>
        </>
      )}
      <ActionNotice action={action} />
    </form>
  );
}
