import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import { useStore } from './store';
import { REALITIES } from './lib/content';
import { bus } from './lib/engineBus';
import { frames } from './visual/frameDriver';
import Oracle from './components/scene/Oracle';
import Particles from './components/scene/Particles';
import Environment from './components/scene/Environment';
import FogCurtains from './components/scene/Effects';
import CameraRig from './components/scene/CameraRig';
import SceneAudioSync from './components/scene/SceneAudioSync';
import InstrumentCanvas from './visual/InstrumentCanvas';
import Boot from './components/ui/Boot';
import TopBar from './components/ui/TopBar';
import RealityPanel from './components/ui/RealityPanel';
import MixPanel from './components/ui/MixPanel';
import PatchPanel from './components/ui/PatchPanel';
import MacroRack from './components/ui/MacroRack';
import Keyboard from './components/ui/Keyboard';
import CodexPanel from './components/ui/CodexPanel';

/**
 * Global pointer / keyboard interaction.
 *
 * ADR-034: listeners are attached to `window` with `{ passive: true }` where
 * possible and are removed on unmount. The original implementation attached
 * a `click` listener without ever checking whether the canvas had focus,
 * which meant a click on any UI element also fired the oracle. The target
 * check is explicit and centralised here so no other component has to
 * remember it.
 */
function InteractionLayer() {
  const setReality = useStore((s) => s.setReality);
  const pushLog = useStore((s) => s.pushLog);
  const discharge = useStore((s) => s.discharge);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      bus.mouseClient.x = e.clientX;
      bus.mouseClient.y = e.clientY;
      bus.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      bus.mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    const isCanvas = (e: Event) => (e.target as HTMLElement | null)?.tagName === 'CANVAS';
    const onClick = (e: MouseEvent) => {
      if (!isCanvas(e)) return;
      bus.pulse = Math.min(1.4, bus.pulse + 0.7);
      bus.shake = Math.min(0.4, bus.shake + 0.22);
      pushLog('ORACLE', 'the gaze acknowledges yours.');
    };
    const onDbl = (e: MouseEvent) => {
      if (!isCanvas(e)) return;
      const cur = useStore.getState().realityIdx;
      setReality((cur + 1) % REALITIES.length);
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === '1') setReality(0);
      else if (e.key === '2') setReality(1);
      else if (e.key === '3') setReality(2);
      else if (e.key === '4') setReality(3);
      else if (e.key.toLowerCase() === 'd') discharge();
      else if (e.key === ' ') {
        e.preventDefault();
        bus.pulse = Math.min(1.4, bus.pulse + 0.9);
        bus.shake = Math.min(0.4, bus.shake + 0.3);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('click', onClick);
    window.addEventListener('dblclick', onDbl);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('click', onClick);
      window.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKey);
    };
  }, [setReality, pushLog, discharge]);
  return null;
}

/**
 * VHS tear / discharge flash driven by the store's `shiftNonce`.
 *
 * ADR-045: the previous version mirrored the nonce into component state and
 * then cleared it with a timer, which is the "derived state in an effect"
 * anti-pattern the react-hooks rules correctly flag — it renders twice and
 * leaves a timer running after unmount. Instead the nonce *is* the key: a
 * change remounts the overlay divs, their CSS animation runs exactly once,
 * and the only effect left is the one that writes to the imperative `bus`.
 */
function ValenciaShake() {
  const shiftNonce = useStore((s) => s.shiftNonce);
  useEffect(() => {
    if (shiftNonce === 0) return;
    bus.shake = 0.38;
    bus.dischargeT = 0.001;
  }, [shiftNonce]);
  if (shiftNonce === 0) return null;
  return (
    <>
      <div key={'g' + shiftNonce} className="vhs-glitch" />
      <div key={'b' + shiftNonce} className="vhs-bars" />
    </>
  );
}

/** Applies the initial reality palette before the first paint. */
function PaletteSeed() {
  const realityIdx = useStore((s) => s.realityIdx);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const pal = REALITIES[realityIdx];
    const r = document.documentElement;
    r.style.setProperty('--p', pal.p);
    r.style.setProperty('--s', pal.s);
    r.style.setProperty('--a', pal.a);
    r.style.setProperty('--h', pal.h);
    r.style.setProperty('--fog', pal.fog);
    document.body.style.backgroundColor = pal.fog;
    r.dataset.realityIdx = String(realityIdx);
  }, [realityIdx]);
  return null;
}

export default function App() {
  const status = useStore((s) => s.status);
  const realityIdx = useStore((s) => s.realityIdx);
  const error = useStore((s) => s.error);
  const [glError, setGlError] = useState(false);

  // ---- lifecycle: the engine must never outlive the page -------------
  useEffect(() => {
    const onUnload = () => { frames.dispose(); };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  // ---- suspend the context when the tab is hidden ---------------------
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) frames.dispose();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return (
    <div className="app-root">
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 2.4, 10.4], fov: 55, near: 0.1, far: 600 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => { gl.setClearColor(new THREE.Color(REALITIES[realityIdx].fog), 1); }}
        onError={() => setGlError(true)}
      >
        <Suspense fallback={null}>
          <CameraRig />
          <fog attach="fog" args={[REALITIES[realityIdx].fog, 18, 140]} />
          <SceneAudioSync />
          <Oracle />
          <Environment />
          <Particles />
          <FogCurtains />
          <EffectComposer multisampling={0}>
            <Bloom intensity={1.05} luminanceThreshold={0.12} luminanceSmoothing={0.28} mipmapBlur radius={0.72} />
            <ChromaticAberration offset={[0.0016, 0.0016]} blendFunction={BlendFunction.NORMAL} />
            <Vignette eskil={false} offset={0.24} darkness={0.72} />
          </EffectComposer>
        </Suspense>
      </Canvas>

      {/* systemic video-texture overlays */}
      <div className="vignette-css" />
      <div className="scanlines" />
      <div className="scanband" />
      <div className="trackline" />
      <div className="grain" />
      <div className="corner c-tl" /><div className="corner c-tr" />
      <div className="corner c-bl" /><div className="corner c-br" />
      <div className="side-text left">ATLAS DEEP · SECTOR 7G · ANOMALY WATCH</div>
      <div className="side-text right">SIGIL ARCHIVE · NEVER ROTATE THE THIRD DIAGRAM</div>

      <PaletteSeed />
      <TopBar />
      <div className="rack-left">
        <RealityPanel />
        <PatchPanel />
      </div>
      <div className="rack-right">
        <MixPanel />
        <MacroRack />
      </div>
      <div className="rack-bottom">
        <InstrumentCanvas />
        <Keyboard />
      </div>
      <CodexPanel />
      <ValenciaShake />
      <InteractionLayer />
      <Boot />

      {glError && (
        <div className="webgl-fail">
          <div>
            <div style={{ fontSize: 22, letterSpacing: '0.3em', marginBottom: 12 }}>SIGNAL LOST</div>
            <div>THIS ENGINE REQUIRES WEBGL.</div>
            <div style={{ marginTop: 10, color: 'var(--dim)' }}>
              the oracle does not dream in fallback renderers.<br />try chrome, edge, or another recent browser.
            </div>
          </div>
        </div>
      )}

      {status === 'failed' && (
        <div className="engine-fail">
          <div>
            <div style={{ fontSize: 18, letterSpacing: '0.25em', marginBottom: 10, color: 'var(--h)' }}>ENGINE FAULT</div>
            <div style={{ maxWidth: 560, lineHeight: 1.6 }}>{error}</div>
            <div style={{ marginTop: 12, color: 'var(--dim)', fontSize: 12 }}>
              the visual layer is still live — the oracle is merely mute.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
