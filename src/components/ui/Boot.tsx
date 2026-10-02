import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { audio } from  '../../lib/audioEngine';
import { useStore } from '../../store';
import { REALITIES } from  '../../lib/content';

const BOOT_LINES = [
  '> contacting relay ………………… OK',
  '> decompressing oracle core … OK',
  '> calibrating reality buffers … OK',
  '> WARNING: local physics may disagree',
];

export default function Boot() {
  const begin = useStore((s) => s.begin);
  const started = useStore((s) => s.started);
  const [lines, setLines] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setLines((l) => Math.min(l + 1, BOOT_LINES.length)), 620);
    return () => window.clearInterval(id);
  }, []);

  return (
    <AnimatePresence>
      {!started && (
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
            <button className="boot-btn" onClick={() => { audio.start(); begin(); }}>
              INITIALIZE DESCENT
            </button>
            <div className="boot-warn">headphones recommended · the machine will consume your attention</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
