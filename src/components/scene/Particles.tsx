import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { U } from '../../lib/uniforms';
import { bus } from '../../lib/engineBus';
import * as SH from '../../lib/shaders';

function ParticleSystem({
  count, spread, size, vertical = true,
}: { count: number; spread: number; size: number; vertical?: boolean }) {
  const points = useRef<THREE.Points>(null!);
  const { geo } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * spread;
      pos[i * 3 + 1] = (Math.random() - 0.5) * (vertical ? spread * 1.4 : spread);
      pos[i * 3 + 2] = (Math.random() - 0.5) * spread;
      vel[i * 3] = (Math.random() - 0.5) * 0.4;
      vel[i * 3 + 1] = (Math.random() - 0.5) * 0.4;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
      seed[i] = Math.random();
      sz[i] = size * (0.4 + Math.random() * 0.8);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    return { geo: g };
  }, [count, spread, size, vertical]);

  useFrame(() => {
    if (bus.dischargeT > 0 && bus.dischargeT < 1) {
      // radial burst: push particles outward via time uniforms is cheap — use scale pop
      points.current.scale.setScalar(1 + bus.dischargeT * 0.35);
    } else {
      points.current.scale.setScalar(1);
    }
  });

  return (
    <points ref={points} geometry={geo} frustumCulled={false}>
      <shaderMaterial
        vertexShader={SH.particleVert}
        fragmentShader={SH.particleFrag}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={{
          uTime: U.time, uEnergy: U.energy, uPixelRatio: U.uPixelRatio,
          uColA: U.partA, uColB: U.partB,
        }}
      />
    </points>
  );
}

export default function Particles() {
  return (
    <>
      <ParticleSystem count={1500} spread={44} size={0.32} />
      <ParticleSystem count={500} spread={14} size={0.6} vertical={false} />
    </>
  );
}
