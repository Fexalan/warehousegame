/** Step navigation shared by all four role screens. */
export function StepTabs({
  labels,
  badges,
  active,
  onSelect,
}: {
  labels: [string, string, string];
  badges: [number, number, number];
  active: number;
  onSelect: (i: number) => void;
}) {
  return (
    <nav className="step-tabs">
      {labels.map((label, i) => (
        <button key={i} className={`step-tab ${active === i ? "on" : ""}`} onClick={() => onSelect(i)}>
          {label}
          {badges[i] > 0 && <span className="badge">{badges[i]}</span>}
        </button>
      ))}
    </nav>
  );
}
