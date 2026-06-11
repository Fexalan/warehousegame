/**
 * Realistic-mode anomaly banner. This is how a cascading error from another
 * role surfaces on YOUR screen — with the actions to resolve it.
 */
import type { Anomaly, Intent, RoleId } from "@shared/types";

export function AnomalyPanel({
  anomalies,
  role,
  send,
  children,
}: {
  anomalies: Anomaly[];
  role: RoleId;
  send: (i: Intent) => void;
  children?: (a: Anomaly) => React.ReactNode;
}) {
  const mine = anomalies.filter((a) => a.role === role);
  if (mine.length === 0) return null;
  return (
    <div className="anomaly-panel">
      {mine.map((a) => (
        <div key={a.id} className="anomaly">
          <span className="anomaly-text">⚠ {a.detail}</span>
          <div className="anomaly-actions">
            {children?.(a) ?? (
              <button className="btn btn-warn" onClick={() => send({ type: "resolve_anomaly", anomalyId: a.id })}>
                Traiter l'anomalie
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
