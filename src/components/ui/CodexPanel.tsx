import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../store';
import { CODEX } from '../../lib/content';

export default function CodexPanel() {
  const codex = useStore((s) => s.codex);
  const codexAct = useStore((s) => s.codexAct);
  const codexNext = useStore((s) => s.codexNext);
  const codexClose = useStore((s) => s.codexClose);

  return (
    <div className="center-stack">
      <AnimatePresence mode="wait">
        {codex ? (
          <motion.div
            key={codex.entryIndex + (codex.result ? '-r' : '')}
            className="codex"
            initial={{ opacity: 0, y: 24, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -14, filter: 'blur(6px)' }}
            transition={{ duration: 0.28 }}
          >
            {(() => {
              const e = CODEX[codex.entryIndex];
              return (
                <>
                  <div className="codex-head">
                    <span className="codex-kind">
                      ▚ {e.kind} · MEMO {String(codex.entryIndex + 1).padStart(2, '0')}/{String(CODEX.length).padStart(2, '0')}
                    </span>
                    <button className="codex-close" onClick={codexClose} aria-label="close">✕</button>
                  </div>
                  <div className="codex-title font-display">{e.title}</div>
                  <div className="codex-body">{e.body}</div>
                  <div className="codex-foot">
                    {codex.result ? (
                      <span className="codex-status" style={{ color: 'var(--s)' }}>{codex.result}</span>
                    ) : (
                      <button className="codex-action" onClick={codexAct}>{e.action}</button>
                    )}
                    <button
                      className="codex-action"
                      style={{ borderColor: 'color-mix(in srgb, var(--ink) 30%, transparent)', background: 'transparent' }}
                      onClick={codexNext}
                    >
                      NEXT MEMO →
                    </button>
                  </div>
                </>
              );
            })()}
          </motion.div>
        ) : (
          <CodexPrompt key="prompt" />
        )}
      </AnimatePresence>

      <EventLog />
    </div>
  );
}

function CodexPrompt() {
  const openCodex = useStore((s) => s.openCodex);
  const started = useStore((s) => s.status) === 'running';
  if (!started) return null;
  return (
    <motion.button
      className="codex"
      style={{ textAlign: 'left', cursor: 'pointer' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 10 }}
      onClick={() => openCodex()}
    >
      <span className="codex-kind">▚ THE ARCHIVE IS OPEN</span>
      <div style={{ fontSize: 15, letterSpacing: '0.1em', marginTop: 6, color: 'var(--ink)' }} className="font-display">
        Consult the oracle's memos
      </div>
      <div className="codex-status" style={{ marginTop: 4 }}>{CODEX.length} fragments decrypted · tap to read</div>
    </motion.button>
  );
}

function EventLog() {
  const log = useStore((s) => s.log);
  return (
    <div className="log-view" aria-live="polite">
      {log.map((l, i) => (
        <div key={l.id} className={`log-line ${i === log.length - 1 ? 'fresh' : ''}`}>
          <span className="tag">[{l.tag}]</span>
          {l.text}
        </div>
      ))}
    </div>
  );
}
