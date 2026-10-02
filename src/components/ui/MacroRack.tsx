import { useStore } from '../../store';

interface Macro {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** display transform */
  fmt?: (v: number) => string;
}

const SYNTH_MACROS: Macro[] = [
  { key: 'cutoff', label: 'CUTOFF', min: 40, max: 16000, step: 10, fmt: (v) => `${Math.round(v)} hz` },
  { key: 'resonance', label: 'RESONANCE', min: 0.4, max: 24, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'fmIndex', label: 'FM INDEX', min: 0, max: 12, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'fmRatio', label: 'FM RATIO', min: 0.25, max: 8, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'drive', label: 'DRIVE', min: 0.2, max: 24, step: 0.1, fmt: (v) => `${v.toFixed(1)}x` },
  { key: 'chaos', label: 'CHAOS', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'width', label: 'WIDTH', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'duck', label: 'DUCK', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
];

const FX_MACROS: Macro[] = [
  { key: 'grainMix', label: 'GRAIN MIX', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'grainSize', label: 'GRAIN SIZE', min: 0.005, max: 0.6, step: 0.005, fmt: (v) => `${Math.round(v * 1000)} ms` },
  { key: 'grainScatter', label: 'SCATTER', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'grainPitch', label: 'PITCH SPREAD', min: 0, max: 1, step: 0.01, fmt: (v) => `±${Math.round(v * 12)} st` },
  { key: 'grainFeedback', label: 'GRAIN FB', min: 0, max: 0.92, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'spectralMix', label: 'SPECTRAL', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'spectralFreeze', label: 'FREEZE', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'spectralShift', label: 'BIN SHIFT', min: -1, max: 1, step: 0.01, fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 24)}` },
  { key: 'reverbMix', label: 'REVERB', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'reverbSize', label: 'TANK SIZE', min: 0.05, max: 0.98, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'reverbDamp', label: 'DAMPING', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'reverbWidth', label: 'TANK WIDTH', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
];

function Rack({ title, sub, macros, values, onChange }: {
  title: string;
  sub: string;
  macros: Macro[];
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
}) {
  return (
    <section className="panel macro-panel" aria-label={title}>
      <div className="panel-title"><span>{title}</span><span className="pt-sub">{sub}</span></div>
      <div className="macro-grid">
        {macros.map((m) => {
          const v = values[m.key] ?? m.min;
          return (
            <label key={m.key} className="macro">
              <span className="macro-label">{m.label}</span>
              <input
                className="macro-slider"
                type="range"
                min={m.min}
                max={m.max}
                step={m.step}
                value={v}
                onChange={(e) => onChange(m.key, parseFloat(e.target.value))}
              />
              <span className="macro-val">{m.fmt ? m.fmt(v) : v.toFixed(2)}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

export default function MacroRack() {
  const patch = useStore((s) => s.patch);
  const setSynthParam = useStore((s) => s.setSynthParam);
  const setFxParam = useStore((s) => s.setFxParam);

  return (
    <>
      <Rack title="SYNTH MACROS" sub="8 · a-rate" macros={SYNTH_MACROS} values={patch.synth} onChange={setSynthParam} />
      <Rack title="FX RACK" sub="12 · custom dsp" macros={FX_MACROS} values={patch.fx} onChange={setFxParam} />
    </>
  );
}
