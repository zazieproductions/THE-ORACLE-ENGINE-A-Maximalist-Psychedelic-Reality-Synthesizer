import { useStore } from '../../store';
import { LAYERS } from '../../lib/content';
import type { LayerId } from '../../lib/audioEngine';

export default function ChorusPanel() {
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const discharge = useStore((s) => s.discharge);
  const master = useStore((s) => s.master);
  const setMaster = useStore((s) => s.setMaster);
  const started = useStore((s) => s.started);

  return (
    <section className="panel chorus-panel" aria-label="sound chorus">
      <div className="panel-title"><span>SOUND CHORUS</span><span className="pt-sub">6 VOICES</span></div>
      <div className="layer-list">
        {LAYERS.map((l) => {
          const on = layers[l.id as LayerId];
          return (
            <button
              key={l.id}
              className={`l-btn ${on ? 'on' : ''}`}
              style={{ ['--lc' as string]: l.color }}
              onClick={() => toggleLayer(l.id as LayerId)}
              disabled={!started}
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
          disabled={!started}
          aria-label="master volume"
        />
        <span className="fader-val">{Math.round(master * 100)}</span>
      </div>
      <button className="discharge" onClick={discharge} disabled={!started}>
        ⚡ EMERGENCY DISCHARGE
      </button>
    </section>
  );
}
