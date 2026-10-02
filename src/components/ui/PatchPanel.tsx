import { useStore } from '../../store';
import { PATCHES } from '../../audio/presets';

export default function PatchPanel() {
  const patchIndex = useStore((s) => s.patchIndex);
  const patch = useStore((s) => s.patch);
  const morph = useStore((s) => s.morph);
  const selectPatch = useStore((s) => s.selectPatch);
  const setMorph = useStore((s) => s.setMorph);
  const randomizePatch = useStore((s) => s.randomizePatch);

  return (
    <section className="panel patch-panel" aria-label="patches">
      <div className="panel-title"><span>PATCH MEMORY</span><span className="pt-sub">{PATCHES.length} SLOTS</span></div>
      <div className="patch-list">
        {PATCHES.map((p, i) => (
          <button
            key={p.id}
            className={`p-btn ${i === patchIndex ? 'active' : ''}`}
            onClick={() => selectPatch(i)}
            title={p.tagline}
          >
            <span className="p-name">{p.name}</span>
            <span className="p-tag">{p.tagline}</span>
          </button>
        ))}
      </div>
      <div className="fader-row">
        <span className="micro">MORPH</span>
        <input
          className="fader"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={morph}
          onChange={(e) => setMorph(parseFloat(e.target.value))}
          aria-label="patch morph"
        />
        <span className="fader-val">{Math.round(morph * 100)}</span>
      </div>
      <button className="ghost-btn" onClick={randomizePatch}>
        ⚄ RESEED ATTRACTOR
      </button>
      <div className="panel-foot">
        seed 0x{patch.seed.toString(16)} · {patch.name.toLowerCase()}
      </div>
    </section>
  );
}
