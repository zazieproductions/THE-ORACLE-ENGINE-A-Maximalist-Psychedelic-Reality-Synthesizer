import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import { useStore } from './store';
import { REALITIES } from './lib/content';
import { U } from './lib/uniforms';
import { bus } from './lib/engineBus';
import { damp } from './lib/math';
import Oracle from './components/scene/Oracle';
import Particles from './components/scene/Particles';
import Environment from './components/scene/Environment';
import FogCurtains from './components/scene/Effects';
import CameraRig from './components/scene/CameraRig';
import Boot from './components/ui/Boot';
import TopBar from './components/ui/TopBar';
import RealityPanel from './components/ui/RealityPanel';
import ChorusPanel from './components/ui/ChorusPanel';
import CodexPanel from './components/ui/CodexPanel';

function WorldUniformsSync() {
  const realityIdx = useStore((s) => s.realityIdx);
  useEffect(() => {
    const pal = REALITIES[realityIdx];
    const c = (hex: string) => new THREE.Color(hex);
    U.colA.value.lerp(c(pal.colA), 0.12);
    U.colB.value.lerp(c(pal.colB), 0.12);
    U.colC.value.lerp(c(pal.colC), 0.12);
    U.partA.value.lerp(c(pal.particleA), 0.12);
    U.partB.value.lerp(c(pal.particleB), 0.12);
    U.gridA.value.lerp(c(pal.gridA), 0.12);
    U.gridB.value.lerp(c(pal.gridB), 0.12);
    U.starA.value.lerp(c(pal.starA), 0.12);
    U.starB.value.lerp(c(pal.starB), 0.12);
    U.fogU.value.lerp(c(pal.fog), 0.12);
    U.morph.value = realityIdx === 2 ? 0.85 : realityIdx === 3 ? 0.5 : 0.15;
  }, [realityIdx]);
  return null;
}

function UniformTicker() {
  useFrameSync();
  return null;
}

import { useFrame } from '@react-three/fiber';
function useFrameSync() {
  useFrame((state, dt) => {
    U.time.value = state.clock.elapsedTime;
    U.uPixelRatio.value = Math.min(2, state.gl.getPixelRatio());
    U.energy.value = Math.max(0.05, U.energy.value);
    // morph lerp toward target set above
  });
}

function InteractionLayer() {
  const setReality = useStore((s) => s.setReality);
  const pushLog = useStore((s) => s.pushLog);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      bus.mouseClient.x = e.clientX;
      bus.mouseClient.y = e.clientY;
      bus.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      bus.mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    const onClick = (e: MouseEvent) => {
      // clicking deep space (canvas, not UI) fires the oracle
      const el = e.target as HTMLElement;
      if (el.tagName === 'CANVAS') {
        bus.pulse = Math.min(1.4, bus.pulse + 0.7);
        bus.shake = Math.min(0.4, bus.shake + 0.22);
        pushLog('ORACLE', 'the gaze acknowledges yours.');
        // keyboard-free reality cycle on long-press? keep: double click cycles
      }
    };
    const onDbl = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'CANVAS') {
        const cur = useStore.getState().realityIdx;
        setReality((cur + 1) % 4);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') setReality(0);
      if (e.key === '2') setReality(1);
      if (e.key === '3') setReality(2);
      if (e.key === '4') setReality(3);
      if (e.key.toLowerCase() === 'd') useStore.getState().discharge();
      if (e.key === ' ') { e.preventDefault(); bus.pulse = Math.min(1.4, bus.pulse + 0.9); bus.shake = Math.min(0.4, bus.shake + 0.3); }
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
  }, [setReality, pushLog]);
  return null;
}

function ValenciaShake() {
  // drives a quick camera shake + VHS overlay via store nonces
  const shiftNonce = useStore((s) => s.shiftNonce);
  const dischargeNonce = useStore((s) => s.dischargeNonce);
  const [shiftFx, setShiftFx] = useState(0);
  const [disFx, setDisFx] = useState(0);
  useEffect(() => {
    if (shiftNonce === 0) return;
    setShiftFx(shiftNonce);
    bus.shake = 0.38;
    bus.dischargeT = 0.001;
    const id = window.setTimeout(() => setShiftFx(0), 520);
    return () => window.clearTimeout(id);
  }, [shiftNonce]);
  useEffect(() => {
    if (dischargeNonce === 0) return;
    setDisFx(dischargeNonce);
    bus.shake = 0.5;
    const id = window.setTimeout(() => setDisFx(0), 700);
    return () => window.clearTimeout(id);
  }, [dischargeNonce]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (bus.dischargeT > 0 && bus.dischargeT < 1) bus.dischargeT += 0.03;
      else bus.dischargeT = 0;
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <>
      {shiftFx > 0 && (
        <>
          <div key={'g' + shiftFx} className="vhs-glitch" />
          <div key={'b' + shiftFx} className="vhs-bars" />
        </>
      )}
      {disFx > 0 && <div key={'f' + disFx} className="flash-white" />}
    </>
  );
}

export default function App() {
  const started = useStore((s) => s.started);
  const realityIdx = useStore((s) => s.realityIdx);
  const [glError, setGlError] = useState(false);

  return (
    <div className="app-root">
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 2.4, 10.4], fov: 55, near: 0.1, far: 600 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(REALITIES[0].fog), 1);
        }}
        onError={() => setGlError(true)}
      >
        <Suspense fallback={null}>
          <UniformTicker />
          <WorldUniformsSync />
          <CameraRig />
          <fog attach="fog" args={[REALITIES[0].fog, 18, 140]} />
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

      {/* systemic overlays */}
      <div className="vignette-css" />
      <div className="scanlines" />
      <div className="scanband" />
      <div className="trackline" />
      <div className="grain" />

      {/* chrome frame */}
      <div className="corner c-tl" /><div className="corner c-tr" />
      <div className="corner c-bl" /><div className="corner c-br" />
      <div className="side-text left">ATLAS DEEP · SECTOR 7G · ANOMALY WATCH</div>
      <div className="side-text right">SIGIL ARCHIVE · NEVER ROTATE THE THIRD DIAGRAM</div>

      <TopBar />
      <RealityPanel />
      <ChorusPanel />
      <CodexPanel />
      <ValenciaShake />
      <InteractionLayer />
      <Boot />

      {glError && (
        <div className="webgl-fail">
          <div>
            <div style={{ fontSize: 22, letterSpacing: '0.3em', marginBottom: 12 }}>SIGNAL LOST</div>
            <div>THIS ENGINE REQUIRES WEBGL.</div>
            <div style={{ marginTop: 10, color: 'var(--dim)' }}>the oracle does not dream in fallback renderers.<br/>try chrome, edge, or another recent browser.</div>
          </div>
        </div>
      )}
      {!started && null}
      <div style={{ display: 'none' }}>{realityIdx}</div>
    </div>
  );
}
