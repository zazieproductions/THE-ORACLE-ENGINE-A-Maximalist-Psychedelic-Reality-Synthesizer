import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../store';
import { REALITIES } from '../../lib/content';
import { audio } from '../../lib/audioEngine';

function useMissionClock(started: boolean) {
  const [t, setT] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!started) return;
    startRef.current = performance.now() - t * 1000;
    const id = window.setInterval(() => setT((performance.now() - startRef.current) / 1000), 100);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = Math.floor(t % 60).toString().padStart(2, '0');
  return `T+${mm}:${ss}`;
}

function Meters() {
  const b1 = useRef<HTMLElement>(null);
  const b2 = useRef<HTMLElement>(null);
  useEffect(() => {
    let raf = 0;
    const data = new Uint8Array(128);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const an = audio.getAnalyser();
      if (an) {
        an.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
        const bass = data.slice(1, 10).reduce((a, b) => a + b, 0) / 9 / 255;
        const mid = data.slice(30, 60).reduce((a, b) => a + b, 0) / 30 / 255;
        if (b1.current) b1.current.style.height = `${Math.min(100, bass * 160 + 6)}%`;
        if (b2.current) b2.current.style.height = `${Math.min(100, mid * 150 + 4)}%`;
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="meters" title="bus activity">
      <div className="meter-bar" style={{ height: '18px' }}><i ref={b1} /></div>
      <div className="meter-bar" style={{ height: '18px' }}><i ref={b2} /></div>
      <span className="meter-label" style={{ marginLeft: 4 }}>SIG</span>
    </div>
  );
}

export default function TopBar() {
  const realityIdx = useStore((s) => s.realityIdx);
  const shiftNonce = useStore((s) => s.shiftNonce);
  const started = useStore((s) => s.started);
  const micOn = useStore((s) => s.micOn);
  const toggleMic = useStore((s) => s.toggleMic);
  const clock = useMissionClock(started);
  const pal = REALITIES[realityIdx];

  return (
    <header className="topbar">
      <div className="tb-col">
        <div className="tb-title font-display">THE ORACLE ENGINE</div>
        <div className="tb-sub">psychedelic reality synthesizer · build 47.03</div>
      </div>

      <div className="tb-col tb-center" key={shiftNonce}>
        <div className="tr-name font-display flicker">{pal.name.toUpperCase()}</div>
        <div className="tr-epithet">{pal.epithet}</div>
        <div className="tr-meta">REALITY {pal.index} / IV · {pal.tagline}</div>
      </div>

      <div className="tb-col tb-right">
        <div className="tb-row">
          <Meters />
          <button className={`mic-btn ${micOn ? 'on' : ''}`} onClick={toggleMic} disabled={!started} style={{ opacity: started ? 1 : 0.45 }}>
            {micOn ? '◉ LYRIC ENGINE: LIVE' : '○ RAISE THE VOICE'}
          </button>
        </div>
        <div className="tb-row">
          <span className="rec-dot" />
          <span className="tb-clock">{clock}</span>
          <span className="micro">REC</span>
        </div>
      </div>
    </header>
  );
}
