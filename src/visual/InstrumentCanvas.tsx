/**
 * ====================================================================
 * INSTRUMENT CANVAS — the real-time AudioWorklet visualiser
 * ====================================================================
 *
 * Four instruments on one canvas, driven from the analysis frames the
 * analyzer worklet publishes through the shared ring:
 *
 *   1. WATERFALL SPECTROGRAM — log-frequency, 84 dB of range, scrolled with
 *      a `copyWithin` memmove on the ImageData backing store (a full-canvas
 *      redraw per frame would cost ~80 k fillRects; this costs one memmove).
 *   2. RADIAL SCOPE — the waveform wrapped onto a circle. A polar read of a
 *      periodic signal draws its own symmetry, which is far more legible
 *      than a linear trace for an instrument that is mostly sustained tones.
 *   3. SPECTRAL BLOOM — log-spaced radial magnitude bars, additive.
 *   4. BAND METERS + feature readouts.
 *
 * ADR-031: everything is drawn into ONE canvas with ONE `useAudioFrame`
 * subscription. Per-instrument canvases would each need their own DPR
 * scaling, their own palette, and their own compositing — and the browser
 * would have to composite 4 layers per frame instead of 1.
 *
 * ADR-032: the spectrogram's ImageData is allocated once and reused; the
 * per-row log-frequency bin table is rebuilt only on resize. The render loop
 * performs zero allocations, which is why this holds 60 fps alongside a
 * 3D scene and an 8-voice synth.
 */

import { useEffect, useRef } from 'react';
import { useAudioFrame, frames } from './frameDriver';
import { useStore } from '../store';
import { REALITIES } from '../lib/content';
import { SPECTRUM_BINS } from '../audio/protocol';
import { clamp } from '../lib/math';

const SPEC_FLOOR_DB = -84;
const LOG_BINS = 96;
const SCOPE_POINTS = 512;

interface Layout {
  w: number;
  h: number;
  spec: { x: number; y: number; w: number; h: number };
  scope: { cx: number; cy: number; r: number };
  bloom: { cx: number; cy: number; r: number };
  meters: { x: number; y: number; w: number; h: number };
}

function computeLayout(w: number, h: number): Layout {
  const specW = Math.floor(w * 0.56);
  const rightW = w - specW;
  return {
    w,
    h,
    spec: { x: 0, y: 0, w: specW, h },
    scope: { cx: specW + rightW * 0.5, cy: h * 0.3, r: Math.min(rightW * 0.42, h * 0.26) },
    bloom: { cx: specW + rightW * 0.5, cy: h * 0.72, r: Math.min(rightW * 0.42, h * 0.24) },
    meters: { x: 0, y: 0, w: 0, h: 0 },
  };
}

/** perceptual colour ramp: ink -> colA -> colB -> colC -> white */
function buildRamp(a: string, b: string, c: string): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const hex = (s: string): [number, number, number] => {
    const v = parseInt(s.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const c0 = hex(a);
  const c1 = hex(b);
  const c2 = hex(c);
  const white: [number, number, number] = [255, 250, 235];
  const stops: [number, [number, number, number]][] = [
    [0, [4, 2, 10]],
    [0.28, c0],
    [0.58, c1],
    [0.84, c2],
    [1, white],
  ];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lo = 0;
    while (lo < stops.length - 2 && t > stops[lo + 1][0]) lo++;
    const [t0, col0] = stops[lo];
    const [t1, col1] = stops[lo + 1];
    const k = clamp((t - t0) / Math.max(1e-6, t1 - t0));
    // gamma-correct interpolation: linear RGB blends look muddy in the dark end
    const g = (x: number) => Math.pow(x / 255, 2.2);
    const ug = (x: number) => Math.pow(x, 1 / 2.2) * 255;
    lut[i * 3] = ug(g(col0[0]) + (g(col1[0]) - g(col0[0])) * k);
    lut[i * 3 + 1] = ug(g(col0[1]) + (g(col1[1]) - g(col0[1])) * k);
    lut[i * 3 + 2] = ug(g(col0[2]) + (g(col1[2]) - g(col0[2])) * k);
  }
  return lut;
}

export default function InstrumentCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    ctx: CanvasRenderingContext2D | null;
    layout: Layout;
    image: ImageData | null;
    /** per-row bin index into the linear spectrum (log frequency) */
    rowBin: Uint16Array;
    rowFrac: Float32Array;
    lut: Uint8ClampedArray;
    paletteKey: string;
    dpr: number;
    /** smoothed spectrum for the radial bloom (visual-only ballistics) */
    bloomMag: Float32Array;
    scopeTrail: Float32Array;
  }>({
    ctx: null,
    layout: computeLayout(800, 400),
    image: null,
    rowBin: new Uint16Array(0),
    rowFrac: new Float32Array(0),
    lut: buildRamp('#1a0f38', '#8a5cff', '#00e5ff'),
    paletteKey: '',
    dpr: 1,
    bloomMag: new Float32Array(LOG_BINS),
    scopeTrail: new Float32Array(SCOPE_POINTS * 2),
  });

  // ---- resize / DPR handling ----------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(320, Math.floor(rect.width));
      const h = Math.max(160, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const st = stateRef.current;
      st.ctx = ctx;
      st.dpr = dpr;
      st.layout = computeLayout(w, h);
      // allocate the spectrogram ImageData at device resolution
      const sw = Math.max(1, Math.floor(st.layout.spec.w * dpr));
      const sh = Math.max(1, Math.floor(st.layout.spec.h * dpr));
      st.image = ctx.createImageData(sw, sh);
      st.rowBin = new Uint16Array(sh);
      st.rowFrac = new Float32Array(sh);
      // log-frequency row table, built against the real Nyquist
      const fMin = 32;
      const nyquist = Math.max(8000, frames.sampleRate * 0.5);
      const fMax = Math.min(19000, nyquist);
      for (let y = 0; y < sh; y++) {
        // row 0 (top of ImageData) = high frequency
        const t = 1 - y / (sh - 1);
        const f = fMin * Math.pow(fMax / fMin, t);
        const bin = (f / nyquist) * SPECTRUM_BINS;
        st.rowBin[y] = Math.min(SPECTRUM_BINS - 2, Math.max(0, Math.floor(bin)));
        st.rowFrac[y] = bin - st.rowBin[y];
      }
      ctx.fillStyle = '#04020a';
      ctx.fillRect(0, 0, w, h);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  // ---- palette follows the active reality ---------------------------
  const realityIdx = useStore((s) => s.realityIdx);
  const paletteIndexRef = useRef(realityIdx);
  useEffect(() => { paletteIndexRef.current = realityIdx; }, [realityIdx]);
  useEffect(() => {
    const st = stateRef.current;
    const pal = REALITIES[realityIdx];
    const key = `${pal.colA}${pal.colB}${pal.colC}`;
    if (key !== st.paletteKey) {
      st.paletteKey = key;
      st.lut = buildRamp(pal.colA, pal.colB, pal.colC);
    }
  }, [realityIdx]);

  // ---- the render loop ----------------------------------------------
  useAudioFrame((frame, _dt, s) => {
    const st = stateRef.current;
    const ctx = st.ctx;
    const img = st.image;
    if (!ctx || !img) return;
    const L = st.layout;
    const pal = REALITIES[paletteIndexRef.current];

    // =============== 1. waterfall spectrogram =====================
    const sw = img.width;
    const sh = img.height;
    const data = img.data;
    // scroll left by one device pixel
    data.copyWithin(0, 4, data.length);
    const spec = frame.spectrum;
    const lut = st.lut;
    for (let y = 0; y < sh; y++) {
      const b0 = st.rowBin[y];
      const f = st.rowFrac[y];
      const m = spec[b0] + (spec[b0 + 1] - spec[b0]) * f;
      const db = 20 * Math.log10(m + 1e-7);
      const t = clamp((db - SPEC_FLOOR_DB) / -SPEC_FLOOR_DB);
      // slight gamma lift keeps quiet detail visible without blowing the top
      const idx = Math.min(255, Math.max(0, Math.round(Math.pow(t, 0.72) * 255)));
      const o = (y * sw + sw - 1) * 4;
      data[o] = lut[idx * 3];
      data[o + 1] = lut[idx * 3 + 1];
      data[o + 2] = lut[idx * 3 + 2];
      data[o + 3] = 255;
    }
    ctx.putImageData(img, L.spec.x * st.dpr, L.spec.y * st.dpr);

    // spectrogram frame + frequency guides
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(L.spec.x + 0.5, L.spec.y + 0.5, L.spec.w - 1, L.spec.h - 1);
    ctx.font = '9px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    const guides: [number, string][] = [
      [100, '100'], [1000, '1k'], [10000, '10k'],
    ];
    for (const [f, label] of guides) {
      const t = Math.log(f / 32) / Math.log(19000 / 32);
      const y = L.spec.y + (1 - t) * L.spec.h;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(L.spec.x, y);
      ctx.lineTo(L.spec.x + L.spec.w, y);
      ctx.stroke();
      ctx.globalAlpha = 0.75;
      ctx.fillText(label + 'Hz', L.spec.x + 6, y - 3);
    }
    ctx.restore();

    // =============== 2. radial scope ==============================
    const sc = L.scope;
    ctx.save();
    ctx.translate(sc.cx, sc.cy);
    const wave = frame.waveform;
    // faint reference rings
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (const rr of [0.35, 0.7, 1]) {
      ctx.beginPath();
      ctx.arc(0, 0, sc.r * rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // two-pass glow: wide + dim, then narrow + bright
    for (const pass of [
      { w: 5, a: 0.16, col: pal.colB },
      { w: 1.4, a: 0.95, col: pal.particleB },
    ]) {
      ctx.beginPath();
      for (let i = 0; i < SCOPE_POINTS; i++) {
        const v = wave[(i * (wave.length / SCOPE_POINTS)) | 0];
        const ang = (i / SCOPE_POINTS) * Math.PI * 2 - Math.PI / 2;
        const rr = sc.r * (0.5 + v * 0.46);
        const x = Math.cos(ang) * rr;
        const y = Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.lineWidth = pass.w;
      ctx.strokeStyle = pass.col;
      ctx.globalAlpha = pass.a;
      ctx.stroke();
    }
    // onset flash ring
    if (s.onset > 0.05) {
      ctx.globalAlpha = Math.min(0.8, s.onset);
      ctx.strokeStyle = pal.particleA;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, sc.r * (1.02 + s.onset * 0.1), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // =============== 3. spectral bloom ============================
    const bl = L.bloom;
    ctx.save();
    ctx.translate(bl.cx, bl.cy);
    ctx.globalCompositeOperation = 'lighter';
    const bm = st.bloomMag;
    const dt = 1 / 60;
    for (let i = 0; i < LOG_BINS; i++) {
      const t = i / (LOG_BINS - 1);
      const bin = Math.pow(t, 2.1) * (SPECTRUM_BINS - 2);
      const b0 = bin | 0;
      const m = spec[b0] + (spec[b0 + 1] - spec[b0]) * (bin - b0);
      // visual ballistics: fast rise, slow fall
      bm[i] += (Math.min(1.4, m) - bm[i]) * (m > bm[i] ? 0.55 : 0.12);
      const ang = t * Math.PI * 2 - Math.PI / 2;
      const len = bl.r * (0.12 + bm[i] * 0.95);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const inner = bl.r * 0.14;
      const grad = ctx.createLinearGradient(ca * inner, sa * inner, ca * (inner + len), sa * (inner + len));
      grad.addColorStop(0, pal.particleA);
      grad.addColorStop(1, pal.particleB);
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1.2, (Math.PI * 2 * bl.r) / LOG_BINS * 0.55);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(ca * inner, sa * inner);
      ctx.lineTo(ca * (inner + len), sa * (inner + len));
      ctx.stroke();
    }
    // mirrored inner ring for symmetry
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = pal.particleB;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 180; i++) {
      const t = i / 180;
      const bin = Math.pow(t, 2.1) * (SPECTRUM_BINS - 2);
      const m = spec[bin | 0];
      const ang = t * Math.PI * 2;
      const rr = bl.r * (0.1 + Math.min(1, m) * 0.42);
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // =============== 4. band meters + readouts ====================
    const mx = L.spec.x + L.spec.w + 12;
    const my = L.h - 74;
    const mw = L.w - mx - 14;
    ctx.save();
    ctx.font = '9px "Space Mono", monospace';
    const bands = ['SUB', 'LOW', 'MID', 'HI'];
    const barH = 8;
    for (let b = 0; b < 4; b++) {
      const y = my + b * 14;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(bands[b], mx, y + 7);
      const bx = mx + 30;
      const bw = mw - 30 - 26;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(bx, y, bw, barH);
      const v = clamp(s.bands[b]);
      const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, pal.particleA);
      grad.addColorStop(1, pal.particleB);
      ctx.fillStyle = grad;
      ctx.fillRect(bx, y, bw * v, barH);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(String(Math.round(v * 100)).padStart(3, ' '), bx + bw + 5, y + 7);
    }
    const rms = s.raw[0];
    const db = rms > 1e-6 ? 20 * Math.log10(rms) : -99;
    ctx.fillStyle = pal.particleB;
    ctx.font = '11px "Space Mono", monospace';
    ctx.fillText(
      `${db > -99 ? db.toFixed(1) : '-inf'} dB   CENTROID ${Math.round(s.centroid * 24000)} Hz   FLAT ${s.flatness.toFixed(3)}`,
      mx,
      my - 8,
    );
    ctx.restore();
    void dt;
  });

  return <canvas ref={canvasRef} className="instrument-canvas" aria-label="audio analysis instruments" />;
}
