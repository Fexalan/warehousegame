import type { Toast } from "../useGame";

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.severity}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
