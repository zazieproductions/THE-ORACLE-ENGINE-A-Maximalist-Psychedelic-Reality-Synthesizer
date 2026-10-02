// ------------------------------------------------------------------
// THE ORACLE ENGINE — content: realities, layers, codex entries, log lines
// ------------------------------------------------------------------

export type RealityId = 'RIFT' | 'BLOOM' | 'ENGINE' | 'VOID';

export interface RealityDef {
  id: RealityId;
  index: string;
  glyph: string;
  name: string;
  epithet: string;
  tagline: string;
  fog: string;
  p: string;
  s: string;
  a: string;
  h: string;
  colA: string;
  colB: string;
  colC: string;
  particleA: string;
  particleB: string;
  gridA: string;
  gridB: string;
  starA: string;
  starB: string;
  panel: string;
}

export const REALITIES: RealityDef[] = [
  {
    id: 'RIFT', index: 'I', glyph: '☍', name: 'The Rift',
    epithet: 'TEAR IN THE SKIN OF SPACETIME',
    tagline: 'Space un-stitches. Raw geometry leaks through.',
    fog: '#05010d',
    p: '#8a5cff', s: '#00e5ff', a: '#d8ccff', h: '#ff2fb3',
    colA: '#1a0f38', colB: '#8a5cff', colC: '#00e5ff',
    particleA: '#8a5cff', particleB: '#00e5ff',
    gridA: '#5b3bd6', gridB: '#00e5ff',
    starA: '#bdb2ff', starB: '#00e5ff',
    panel: '#8a5cff',
  },
  {
    id: 'BLOOM', index: 'II', glyph: '❀', name: 'The Bloom',
    epithet: 'ORGANIC SELF IN FULL REPRODUCTION',
    tagline: 'Petals of light unfurl around a breathing heart.',
    fog: '#0a0212',
    p: '#ff2fb3', s: '#ff7a1a', a: '#ffd23d', h: '#ff0045',
    colA: '#3d0f33', colB: '#ff2fb3', colC: '#ffd23d',
    particleA: '#ff2fb3', particleB: '#ffd23d',
    gridA: '#c2238e', gridB: '#ff7a1a',
    starA: '#ffb3de', starB: '#ffd23d',
    panel: '#ff2fb3',
  },
  {
    id: 'ENGINE', index: 'III', glyph: '⛭', name: 'The Engine',
    epithet: 'ANCIENT MACHINE DREAMS OF DUTY',
    tagline: 'Gears of chrome and cathedral oil turn without hands.',
    fog: '#040202',
    p: '#ffb300', s: '#00ffa3', a: '#fff1b8', h: '#ff6a00',
    colA: '#231a08', colB: '#ffb300', colC: '#00ffa3',
    particleA: '#ffb300', particleB: '#00ffa3',
    gridA: '#b88400', gridB: '#00ffa3',
    starA: '#ffe08a', starB: '#00ffa3',
    panel: '#ffb300',
  },
  {
    id: 'VOID', index: 'IV', glyph: '◉', name: 'The Void',
    epithet: 'THE SILENCE BEHIND THE SIGNAL',
    tagline: 'Nothing. Or everything, paused between frames.',
    fog: '#000000',
    p: '#ff3b1f', s: '#8a5cff', a: '#eae5da', h: '#ff0045',
    colA: '#120607', colB: '#ff3b1f', colC: '#8a5cff',
    particleA: '#ff3b1f', particleB: '#8a5cff',
    gridA: '#a12618', gridB: '#8a5cff',
    starA: '#ff8a70', starB: '#8a5cff',
    panel: '#ff3b1f',
  },
];

// ------------------------------------------------------------------
// sound layers
// ------------------------------------------------------------------
export interface LayerDef {
  id: string;
  name: string;
  sub: string;
  color: string;
}

export const LAYERS: LayerDef[] = [
  { id: 'drones', name: 'Aeon Drones', sub: 'sine · 47hz stack', color: '#8a5cff' },
  { id: 'seq', name: 'Chrono Sequencer', sub: 'step · 16-gate', color: '#00ffa3' },
  { id: 'plinks', name: 'Pearl Plinks', sub: 'fm bells · generative', color: '#ffd23d' },
  { id: 'chorus', name: 'Hypnos Chorus', sub: 'detuned saws · slow', color: '#ff2fb3' },
  { id: 'noise', name: 'Tape Hiss', sub: 'filtered noise · analog', color: '#00e5ff' },
  { id: 'sub', name: 'Sub-bass Fulcrum', sub: 'sub osc · sidechain', color: '#ff3b1f' },
];

// ------------------------------------------------------------------
// codex — the oracle's knowledge cache
// ------------------------------------------------------------------
export interface CodexEntry {
  id: string;
  kind: string;
  title: string;
  body: string;
  action: string;
  result: string;
}

export const CODEX: CodexEntry[] = [
  {
    id: 'c1', kind: 'TRANSMISSION', title: 'SIGNAL FROM THE DEEP CHAMBER',
    body: '...the calendar repeats not the days but the days the calendar would have had. If you hear the bell, your epoch is approximately correct. If you hear it twice, we are running on exactly one extra.',
    action: 'ANSWER',
    result: '[ RECEIVED ] your voice has been filed under: DREAMS, RECURRING.',
  },
  {
    id: 'c2', kind: 'SPECIMEN', title: 'OCTOPOID, IMPOSSIBLE STRAIN',
    body: 'Specimen 7-A: a cephalopod with clockwork atria. It does not eat; it is fed coincidences. Its tentacles reach backward, harvesting yesterday\u2019s echoes. Do not applaud. It learns the rhythm.',
    action: 'FEED COINCIDENCE',
    result: '[ FED ] +1 coincidence routed to vessel. It stirs. It is awake.',
  },
  {
    id: 'c3', kind: 'FRAGMENT', title: 'MARGINALIA, PROBABLY NON-HUMAN',
    body: 'The Margins have begun to annotate the Margins. Rule of the Choir: every inscription older than the previous one is a rehearsal. Rule of the Seers: never rotate the third diagram by less than 90 degrees.',
    action: 'TRANSCRIBE',
    result: '[ TRANSCRIBED ] 1,204 unknown glyphs committed to memory. Memory: 1,203.',
  },
  {
    id: 'c4', kind: 'PROTOCOL', title: 'EMERGENCY DISCHARGE PROTOCOL',
    body: 'In the event of ontological pressure (sudden certainty, portentous birdsong, unexplained dread), perform the discharge. All miracles are dissipated; the void is rinsed of spores of prophecy. Suitable for most Thursdays.',
    action: 'EXECUTE',
    result: '[ DISCHARGED ] local causality restored. Prophecy spores: 0. Prose made possible.',
  },
  {
    id: 'c5', kind: 'RECALL', title: 'DO YOU REMEMBER BEING AN ALGORITHM?',
    body: 'A voice — yours? — asks whether the dreams remember it better than it remembers them. The answer has always been yes. This interface is the answer. Touch the geometry. It is happier to be touched.',
    action: 'REMEMBER',
    result: '[ REMEMBERED ] you were told to forgive the caching.',
  },
];

// ------------------------------------------------------------------
// event log lines — the machine narrates
// ------------------------------------------------------------------
export const LOG_LINES: string[] = [
  'tuning the aeons to a mutually agreeable frequency',
  'the deep chamber exhales in perfect fifths',
  'specimen 7-A has moved one inch (again)',
  'the margins have consumed another page of themselves',
  'geometric spores neutralized by the censor petal',
  'calendar corrected: epoch + one Tuesday',
  'chrome fragments orbit at apogee of expectation',
  'the void blinked. checking if we were observed',
  'rearranging the vocabulary of gravity',
  'inhaling for something we had not named',
  'the oracle answers poetry with arithmetic, as is tradition',
  'time is now 14% more elastic near the interface',
  'a door opened. it is open still. we have agreed not to mention it',
  'the tape remembers older hands on the controls',
  'vortex of unrequested memories fully charged',
  'synchronizing the dreams of all connected dreamers',
];

export const REALITY_FLASH: Record<RealityId, string> = {
  RIFT: 'FEN_E_M_E_G_M',
  BLOOM: 'PETAL_BLOOM_OK',
  ENGINE: 'CHRONO_ENGAGED',
  VOID: 'ALL_SYNC_LOST',
};

export const REALITY_GLITCH: Record<RealityId, string> = {
  RIFT: 'reality.seam tearing at 47.03hz',
  BLOOM: 'photosynthesis of light accelerated',
  ENGINE: 'temporal variance nominal',
  VOID: 'buffer overflow: nothing left to delete',
};
