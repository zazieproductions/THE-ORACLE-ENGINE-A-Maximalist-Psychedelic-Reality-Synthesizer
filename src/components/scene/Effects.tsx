import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { U } from '../../lib/uniforms';
import * as SH from '../../lib/shaders';

/** Volumetric-feeling fog: 5 stacked translucent planes with fbm smoke shader. */
export default function FogCurtains() {
  const refs = useRef<THREE.Mesh[]>([]);

  const geo = useMemo(() => new THREE.PlaneGeometry(90, 26), []);

  const matFor = (i: number) =>
    new THREE.ShaderMaterial({
      vertexShader: SH.fogVert,
      fragmentShader: SH.fogFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: U.time,
        uCol: { value: new THREE.Color('#0d0a1a') },
        uAccent: U.colB,
        uOpacity: { value: 0.16 - i * 0.02 },
        uSeed: { value: i * 7.3 },
      },
    });

  const mats = useMemo(() => [0, 1, 2, 3, 4].map((i) => matFor(i)), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    refs.current.forEach((m, i) => {
      if (!m) return;
      m.rotation.y = t * (0.008 + i * 0.004) * (i % 2 ? -1 : 1);
      (m.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    });
  });

  return (
    <group>
      {mats.map((m, i) => (
        <mesh
          key={i}
          ref={(el) => { if (el) refs.current[i] = el; }}
          geometry={geo}
          material={m}
          position={[0, -4 + i * 2.2, -16 - i * 7]}
          renderOrder={-5 + i}
        />
      ))}
    </group>
  );
}
