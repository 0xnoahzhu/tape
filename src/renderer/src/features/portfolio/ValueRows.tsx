// Label / value rows of the account panels (design: Performance tab account groups, 38px rows).

export interface ValueRow {
  label: string;
  value: string;
  color?: string;
}

export function ValueRows({ rows }: { rows: ValueRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{ height: 38, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '0 28px', fontSize: 13 }}
        >
          <div style={{ color: 'var(--mu)' }}>{r.label}</div>
          <div className="selectable" style={{ fontFamily: 'var(--num)', color: r.color ?? 'var(--tx)' }}>
            {r.value}
          </div>
        </div>
      ))}
    </>
  );
}
