import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { REALITIES } from '../../lib/content';
import { frames } from '../../visual/frameDriver';

function useMissionClock(running: boolean) {
  const [t, setT] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    startRef.current = performance.now() - t * 1000;
    const id = window.setInterval(() => setT((performance.now() - startRef.current) / 1000), 100);
    return () => window.clearInterval(id);
  }, [running, t]);
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = Math.floor(t % 60).toString().padStart(2, '0');
  return `T+${mm}:${ss}`;
}

/** Live signal meters, driven by the analysis frame stream (never the DOM). */
function Meters() {
  const b1 = useRef<HTMLElement>(null);
  const b2 = useRef<HTMLElement>(null);
  const b3 = useRef<HTMLElement>(null);
  useEffect(() => {
    return frames.subscribe((_f, _dt, s) => {
      if (b1.current) b1.current.style.height = `${Math.min(100, s.bands[0] * 150 + 5)}%`;
      if (b2.current) b2.current.style.height = `${Math.min(100, s.bands[2] * 150 + 5)}%`;
      if (b3.current) b3.current.style.height = `${Math.min(100, s.onset * 140)}%`;
    });
  }, []);
  return (
    <div className="meters" title="sub / mid / onset">
      <div className="meter-bar"><i ref={b1} /></div>
      <div className="meter-bar"><i ref={b2} /></div>
      <div className="meter-bar"><i ref={b3} /></div>
      <span className="meter-label">SIG</span>
    </div>
  );
}

export default function TopBar() {
  const realityIdx = useStore((s) => s.realityIdx);
  const status = useStore((s) => s.status);
  const micOn = useStore((s) => s.micOn);
  const toggleMic = useStore((s) => s.toggleMic);
  const telemetry = useStore((s) => s.telemetry);
  const ringStats = useStore((s) => s.ringStats);
  const sampleRate = useStore((s) => s.sampleRate);
  const sharedMemory = useStore((s) => s.sharedMemory);
  const seqOn = useStore((s) => s.seqOn);
  const toggleSeq = useStore((s) => s.toggleSeq);
  const bpm = useStore((s) => s.bpm);
  const setBpm = useStore((s) => s.setBpm);
  const recording = useStore((s) => s.recording);
  const recordingSupported = useStore((s) => s.recordingSupported);
  const toggleRecording = useStore((s) => s.toggleRecording);
  const downloadRecording = useStore((s) => s.downloadRecording);
  const clock = useMissionClock(status === 'running');
  const pal = REALITIES[realityIdx];
  const running = status === 'running';

  const load = telemetry ? Math.min(100, (telemetry.avgProcessUs / (sampleRate / 128) / 1000) * 100) : 0;

  return (
    <header className="topbar">
      <div className="tb-col">
        <div className="tb-title font-display">THE ORACLE ENGINE</div>
        <div className="tb-sub">
          audioworklet dsp · {sampleRate} hz · {sharedMemory ? 'shared-memory ring' : 'postmessage ring'}
        </div>
      </div>

      <div className="tb-col tb-center" key={realityIdx}>
        <div className="tr-name font-display flicker">{pal.name.toUpperCase()}</div>
        <div className="tr-epithet">{pal.epithet}</div>
        <div className="tr-meta">REALITY {pal.index} / IV · {pal.tagline}</div>
      </div>

      <div className="tb-col tb-right">
        <div className="tb-row">
          <Meters />
          <button
            className={`mic-btn ${micOn ? 'on' : ''}`}
            onClick={() => void toggleMic()}
            disabled={!running}
            style={{ opacity: running ? 1 : 0.45 }}
          >
            {micOn ? '◉ LYRIC ENGINE: LIVE' : '○ RAISE THE VOICE'}
          </button>
        </div>
        <div className="tb-row tb-transport">
          <button
            className={`t-btn ${seqOn ? 'on' : ''}`}
            onClick={toggleSeq}
            disabled={!running}
            title="chrono sequencer"
          >
            {seqOn ? '❚❚' : '▶'}
          </button>
          <input
            className="bpm"
            type="range"
            min={30}
            max={180}
            step={1}
            value={bpm}
            onChange={(e) => setBpm(parseFloat(e.target.value))}
            disabled={!running}
            aria-label="tempo"
          />
          <span className="micro">{bpm} BPM</span>
          <button
            className={`t-btn rec ${recording ? 'on' : ''}`}
            onClick={() => void toggleRecording()}
            disabled={!running || !recordingSupported}
            title={recordingSupported ? 'record the master bus' : 'recording unsupported'}
          >
            ●
          </button>
          {recording && (
            <button className="t-btn" onClick={() => void downloadRecording()} title="download capture">
              ↓
            </button>
          )}
        </div>
        <div className="tb-row tb-telemetry">
          <span className="rec-dot" />
          <span className="tb-clock">{clock}</span>
          <span className="micro">REC</span>
          <span className="micro dim" title="average worklet process() time per 128-sample quantum">
            CPU {load.toFixed(1)}%
          </span>
          <span className="micro dim" title="voices currently sounding">
            V {telemetry?.activeVoices ?? 0}
          </span>
          <span className="micro dim" title="grains currently active">
            G {telemetry?.activeGrains ?? 0}
          </span>
          <span className="micro dim" title="analysis frames consumed by the render thread">
            F {ringStats.framesRead}
          </span>
          {ringStats.overwritten > 0 && (
            <span className="micro warn" title="frames overwritten before the render thread read them">
              ! {ringStats.overwritten}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
