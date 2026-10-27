import type { ReactNode } from "react";

export function StatusNotice({ children }: { children: ReactNode }) {
  return (
    <div className="status-notice" role="status">
      {children}
    </div>
  );
}
