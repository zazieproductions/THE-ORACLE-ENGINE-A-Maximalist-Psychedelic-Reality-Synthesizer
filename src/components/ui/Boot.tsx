import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../store';

const BOOT_LINES = [
  '> contacting relay ………………… OK',
  '> decompressing oracle core … OK',
  '> loading audioworklet dsp …',
  '> allocating shared analysis ring …',
  '> WARNING: local physics may disagree',
];

export default function Boot() {
  const begin = useStore((s) => s.begin);
  const status = useStore((s) => s.status);
  const [lines, setLines] = useState(0);

  useEffect(() => {
    if (status !== 'idle') return;
    const id = window.setInterval(() => setLines((l) => Math.min(l + 1, BOOT_LINES.length)), 620);
    return () => window.clearInterval(id);
  }, [status]);

  const done = status === 'running' || status === 'failed';

  return (
    <AnimatePresence>
      {!done && (
        <motion.div
          className="boot"
          exit={{ opacity: 0, transition: { duration: 0.7, ease: 'easeInOut' } }}
        >
          <div className="boot-inner">
            <div className="boot-ring" />
            <div className="boot-kicker">UNREGISTERED INSTRUMENT · INST. ATLAS DEEP</div>
            <h1 className="boot-title font-display">THE ORACLE<br />ENGINE</h1>
            <div className="boot-sub">a maximalist psychedelic reality synthesizer</div>
            <div className="boot-lines" aria-hidden>
              {BOOT_LINES.slice(0, lines).map((l, i) => (
                <div key={i} className="boot-line">{l}</div>
              ))}
            </div>
            <button
              className="boot-btn"
              disabled={status === 'booting'}
              onClick={() => { void begin(); }}
            >
              {status === 'booting' ? 'INITIALIZING…' : 'INITIALIZE DESCENT'}
            </button>
            <div className="boot-warn">
              headphones recommended · custom audioworklet dsp · the machine will consume your attention
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
