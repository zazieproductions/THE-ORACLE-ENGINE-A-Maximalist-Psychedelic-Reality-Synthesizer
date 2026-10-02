import { useStore, type LayerId } from '../../store';

const LAYERS: { id: LayerId; name: string; sub: string; color: string }[] = [
  { id: 'drones', name: 'Aeon Drones', sub: 'partial bank · 6 voice', color: '#8a5cff' },
  { id: 'seq', name: 'Chrono Sequencer', sub: 'euclid · 16 gate', color: '#00ffa3' },
  { id: 'plinks', name: 'Aether Grains', sub: 'granular cloud · 32 voice', color: '#ffd23d' },
  { id: 'chorus', name: 'Chaos Weave', sub: 'lorenz attractor mod', color: '#ff2fb3' },
  { id: 'noise', name: 'Tape Hiss', sub: 'pink noise · kellet', color: '#00e5ff' },
  { id: 'sub', name: 'Spectral Bloom', sub: 'stft freeze · 1024', color: '#ff3b1f' },
];

export default function MixPanel() {
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const master = useStore((s) => s.master);
  const setMaster = useStore((s) => s.setMaster);
  const discharge = useStore((s) => s.discharge);
  const panic = useStore((s) => s.panic);
  const running = useStore((s) => s.status) === 'running';

  return (
    <section className="panel chorus-panel" aria-label="sound chorus">
      <div className="panel-title"><span>SOUND CHORUS</span><span className="pt-sub">6 VOICES</span></div>
      <div className="layer-list">
        {LAYERS.map((l) => {
          const on = layers[l.id];
          return (
            <button
              key={l.id}
              className={`l-btn ${on ? 'on' : ''}`}
              style={{ ['--lc' as string]: l.color }}
              onClick={() => toggleLayer(l.id)}
              disabled={!running}
            >
              <span className={`led ${on ? 'on' : ''}`} style={{ ['--lc' as string]: l.color }} />
              <span className="l-txt">
                <div className="l-name">{l.name}</div>
                <div className="l-status">{on ? l.sub : 'muted'}</div>
              </span>
              <span style={{ fontSize: 10, color: on ? l.color : 'var(--dim)' }}>{on ? 'II' : 'I'}</span>
            </button>
          );
        })}
      </div>
      <div className="fader-row">
        <span className="micro">MASTER</span>
        <input
          type="range"
          className="fader"
          min={0}
          max={1}
          step={0.01}
          value={master}
          onChange={(e) => setMaster(parseFloat(e.target.value))}
          disabled={!running}
          aria-label="master volume"
        />
        <span className="fader-val">{Math.round(master * 100)}</span>
      </div>
      <div className="btn-row">
        <button className="discharge" onClick={discharge} disabled={!running}>
          ⚡ EMERGENCY DISCHARGE
        </button>
        <button className="ghost-btn" onClick={panic} disabled={!running} title="silence every voice now">
          PANIC
        </button>
      </div>
    </section>
  );
}
