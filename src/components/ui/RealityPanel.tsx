import { useStore } from '../../store';
import { REALITIES } from '../../lib/content';

export default function RealityPanel() {
  const realityIdx = useStore((s) => s.realityIdx);
  const setReality = useStore((s) => s.setReality);

  return (
    <section className="panel reality-panel" aria-label="reality states">
      <div className="panel-title"><span>REALITY STATES</span><span className="pt-sub">4 CHANNELS</span></div>
      <div className="reality-grid">
        {REALITIES.map((r, i) => (
          <button
            key={r.id}
            className={`r-btn ${i === realityIdx ? 'active' : ''}`}
            style={{ ['--c' as string]: r.p }}
            onClick={() => setReality(i)}
            title={r.tagline}
          >
            <span className="r-glyph">{r.glyph}</span>
            <span className="r-idx">{r.index} · {r.id}</span>
            <span className="r-name">{r.name}</span>
          </button>
        ))}
      </div>
      <div className="panel-foot">each state loads its own patch — the sound and the world move together</div>
    </section>
  );
}
