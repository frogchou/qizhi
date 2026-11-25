import { Facts } from "./FactoryControls";
import { effectLabel } from "./assembly-model";
import { stateName, type AssemblyReceipt } from "./factory-model";

export function ReceiptDetails({ item }: { item: Partial<AssemblyReceipt> }) {
  return (
    <Facts
      rows={[
        ["工具版本", item.resource],
        ["执行效果", effectLabel(item.effect)],
        [
          "验证方式",
          item.mode === "real"
            ? "实际调用"
            : item.mode === "simulated"
              ? "模拟回执"
              : "未验证",
        ],
        ["回执状态", item.status ? stateName(item.status) : undefined],
        ["适配器", item.provider],
        ["调用标识", item.requestKey],
        ["说明", item.reason],
      ]}
    />
  );
}
export function TrialReceipts({
  items,
}: {
  items?: (Partial<AssemblyReceipt> | null)[];
}) {
  const receipts = items?.filter((item): item is Partial<AssemblyReceipt> =>
    Boolean(item),
  );
  if (!receipts?.length) return null;
  return (
    <details className="assembly-disclosure">
      <summary>试跑工具回执</summary>
      {receipts.map((item, i) => (
        <article className="live-card" key={item.requestKey ?? i}>
          <ReceiptDetails item={item} />
        </article>
      ))}
    </details>
  );
}
