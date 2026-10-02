import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { U } from '../../lib/uniforms';
import { frames } from '../../visual/frameDriver';
import { bus } from '../../lib/engineBus';
import { REALITIES } from '../../lib/content';
import { useStore } from '../../store';

/**
 * Bridges the analysis frame stream into the shader uniforms.
 *
 * ADR-030: this component is the ONLY place the 3D world learns about audio,
 * and it runs inside the renderer's own frame loop (via `useFrame`) rather
 * than a separate rAF. That matters for two reasons:
 *   1. the uniforms are updated exactly once per rendered frame, so no uniform
 *      can be written twice with conflicting values;
 *   2. no extra callback is scheduled on the main thread's event loop.
 *
 * The mapping is deliberately perceptual rather than literal:
 *   energy   -> membrane displacement and bloom strength
 *   onset    -> dissolve (the organism tears open on note attacks)
 *   centroid -> colour temperature (a bright sound is a hot rim)
 *   flatness -> how noise-like the source is, drives the hex-lattice morph
 */
export default function SceneAudioSync() {
  const realityIdx = useStore((s) => s.realityIdx);
  const pal = REALITIES[realityIdx];

  const energySm = useRef(0.06);
  const dissolveSm = useRef(0);
  const centroidSm = useRef(0.15);
  const flatSm = useRef(0);
  const rimTarget = useRef<THREE.Color>(new THREE.Color(pal.colB));
  const rimCurrent = useRef<THREE.Color>(new THREE.Color(pal.colB));

  useFrame((_state, dt) => {
    const s = frames.smoothed;

    // visual ballistics — frame rate, not sample rate
    energySm.current += (s.energy - energySm.current) * Math.min(1, dt * 8);
    const dissolveTarget = Math.min(1, s.onset * 0.9 + bus.pulse * 0.35);
    dissolveSm.current += (dissolveTarget - dissolveSm.current) * Math.min(1, dt * 12);
    centroidSm.current += (s.centroid - centroidSm.current) * Math.min(1, dt * 3);
    flatSm.current += (s.flatness - flatSm.current) * Math.min(1, dt * 2);

    U.time.value += dt;
    U.energy.value = 0.06 + energySm.current * 2.6;
    U.dissolve.value = dissolveSm.current;
    U.morph.value = 0.1 + flatSm.current * 0.7 + centroidSm.current * 0.2;

    // rim colour tracks spectral brightness: dark sound -> deep body colour,
    // bright sound -> the palette's accent
    rimTarget.current.set(pal.colB).lerp(TMP.set(pal.colC), centroidSm.current);
    rimCurrent.current.lerp(rimTarget.current, Math.min(1, dt * 2));
    U.colB.value.copy(rimCurrent.current);
  });

  return null;
}

const TMP = new THREE.Color();
