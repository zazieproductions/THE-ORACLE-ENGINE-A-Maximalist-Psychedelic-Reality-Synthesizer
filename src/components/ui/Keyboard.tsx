import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';

/**
 * Playable keyboard.
 *
 * ADR-035: note state lives in a ref (a Map of note -> voiceId), never in
 * React state. A keypress must produce a note within one frame; routing it
 * through `setState` would add a render to the critical path and, worse,
 * make rapid retriggers of the same note coalesce. The ref is also what
 * makes `noteOff` unambiguous — the voiceId is remembered per note.
 */

const BLACK = [1, 3, 6, 8, 10];
const KEYMAP: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14,
};

const OCTAVES = 3;
const BASE_NOTE = 48; // C3

export default function Keyboard() {
  const noteOn = useStore((s) => s.noteOn);
  const noteOff = useStore((s) => s.noteOff);
  const running = useStore((s) => s.status) === 'running';
  const active = useRef(new Map<number, number>());
  const [octave, setOctave] = useState(0);
  // the key layout is a pure function of the constants above, so it is derived
  // rather than staged through state (ADR-047)
  const visible = useMemo(() => {
    const notes: number[] = [];
    for (let o = 0; o < OCTAVES; o++) {
      for (let i = 0; i < 12; i++) notes.push(BASE_NOTE + o * 12 + i);
    }
    return notes;
  }, []);

  const press = (note: number) => {
    if (!running || active.current.has(note)) return;
    const id = noteOn(note, 0.85);
    active.current.set(note, id);
  };

  const release = (note: number) => {
    const id = active.current.get(note);
    if (id === undefined) return;
    active.current.delete(note);
    // noteOff takes the VOICE id, not the note: a retriggered pitch must not
    // silence the newer voice
    noteOff(id);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { setOctave((o) => Math.max(-2, o - 1)); return; }
      if (k === 'x') { setOctave((o) => Math.min(2, o + 1)); return; }
      const semi = KEYMAP[k];
      if (semi === undefined) return;
      e.preventDefault();
      press(BASE_NOTE + semi + octave * 12);
    };
    const up = (e: KeyboardEvent) => {
      const semi = KEYMAP[e.key.toLowerCase()];
      if (semi === undefined) return;
      release(BASE_NOTE + semi + octave * 12);
    };
    const blur = () => { for (const n of [...active.current.keys()]) release(n); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      blur();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, octave, noteOn, noteOff]);

  const isBlack = (n: number) => BLACK.includes(n % 12);
  const label = (n: number) => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
  };

  return (
    <div className="keyboard" aria-label="instrument keyboard">
      <div className="kb-head">
        <span className="micro">INSTRUMENT · A MINOR PENTATONIC FIELD</span>
        <span className="micro dim">Z / X OCTAVE · A-K PLAY · SPACE STRIKE · D DISCHARGE · 1-4 REALITY</span>
      </div>
      <div className="kb-keys">
        {visible.map((n) => (
          <button
            key={n}
            className={`kb-key ${isBlack(n) ? 'black' : 'white'}`}
            onPointerDown={(e) => { e.preventDefault(); press(n); }}
            onPointerUp={() => release(n)}
            onPointerLeave={() => release(n)}
            disabled={!running}
            aria-label={label(n)}
          >
            <span>{label(n)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
