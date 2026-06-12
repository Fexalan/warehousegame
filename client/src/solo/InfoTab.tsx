/** Small, collapsible "what is this task" panel shown on each solo step. */
import { useState } from "react";

export function InfoTab({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`info-tab ${open ? "open" : ""}`}>
      <button className="info-toggle" onClick={() => setOpen((o) => !o)}>
        ℹ️ À propos de cette tâche — {title}
        <span className="info-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && <p className="info-body">{text}</p>}
    </div>
  );
}
