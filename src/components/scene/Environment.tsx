import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { U } from '../../lib/uniforms';
import { makeDiscTexture } from '../../lib/textures';

/**
 * The Sacred Ring — three tilted rings of etched discs (sigils) orbiting
 * the oracle at different inclinations, plus a persistent ground grid
 * with ritual runes, and a far star-fiber dome.
 */
export default function SacredRing() {
  const ring1 = useRef<THREE.Group>(null!);
  const ring2 = useRef<THREE.Group>(null!);
  const ring3 = useRef<THREE.Group>(null!);
  const gridRef = useRef<THREE.Mesh>(null!);

  const discTexA = useMemo(() => makeDiscTexture('#9b8cff', '#b7aaff', 1), []);
  const discTexB = useMemo(() => makeDiscTexture('#00e5ff', '#aef4ff', 3), []);
  const discTexC = useMemo(() => makeDiscTexture('#ff2fb3', '#ffb0dd', 5), []);

  const ringGeo = useMemo(() => new THREE.PlaneGeometry(1.05, 1.05), []);

  const makeRing = (n: number, r: number, scale: number) => {
    const items = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      items.push({ a, r, scale, key: i });
    }
    return items;
  };
  const r1 = useMemo(() => makeRing(8, 4.6, 0.72), []);
  const r2 = useMemo(() => makeRing(6, 6.1, 1.0), []);
  const r3 = useMemo(() => makeRing(10, 7.7, 0.55), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    ring1.current.rotation.y = t * 0.05;
    ring1.current.rotation.x = Math.sin(t * 0.07) * 0.08;
    ring2.current.rotation.y = -t * 0.03;
    ring2.current.rotation.z = Math.sin(t * 0.05) * 0.06;
    ring3.current.rotation.y = t * 0.018;

    // grid breathes with energy
    (gridRef.current.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    (gridRef.current.material as THREE.ShaderMaterial).uniforms.uEnergy.value = U.energy.value;
  });

  return (
    <>
      <group ref={ring1} rotation={[0.32, 0, 0.12]}>
        {r1.map((it) => (
          <mesh
            key={it.key}
            geometry={ringGeo}
            position={[Math.cos(it.a) * it.r, 0, Math.sin(it.a) * it.r]}
            scale={it.scale}
            onUpdate={(m) => m.lookAt(0, 0, 0)}
          >
            <meshBasicMaterial
              map={discTexA}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
              opacity={0.9}
              blending={THREE.AdditiveBlending}
              color="#8a5cff"
            />
          </mesh>
        ))}
      </group>

      <group ref={ring2} rotation={[-0.2, 0, 0.3]}>
        {r2.map((it) => (
          <mesh
            key={it.key}
            geometry={ringGeo}
            position={[Math.cos(it.a) * it.r, 0, Math.sin(it.a) * it.r]}
            scale={it.scale}
            onUpdate={(m) => m.lookAt(0, 0, 0)}
          >
            <meshBasicMaterial
              map={discTexB}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
              opacity={0.65}
              blending={THREE.AdditiveBlending}
              color="#00e5ff"
            />
          </mesh>
        ))}
      </group>

      <group ref={ring3} rotation={[0.1, 0, -0.2]}>
        {r3.map((it) => (
          <mesh
            key={it.key}
            geometry={ringGeo}
            position={[Math.cos(it.a) * it.r, 0, Math.sin(it.a) * it.r]}
            scale={it.scale}
            onUpdate={(m) => m.lookAt(0, 0, 0)}
          >
            <meshBasicMaterial
              map={discTexC}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
              opacity={0.5}
              blending={THREE.AdditiveBlending}
              color="#ff2fb3"
            />
          </mesh>
        ))}
      </group>

      {/* ground: ritual grid */}
      <mesh ref={gridRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.4, 0]}>
        <planeGeometry args={[220, 220, 1, 1]} />
        <shaderMaterial
          vertexShader={SH_GRID_VERT}
          fragmentShader={SH_GRID_FRAG}
          transparent
          depthWrite={false}
          uniforms={{
            uTime: { value: 0 },
            uEnergy: { value: 0.2 },
            uColA: U.gridA,
            uColB: U.gridB,
            uFog: U.fogU,
          }}
        />
      </mesh>

      <StarDome />
    </>
  );
}

function StarDome() {
  const ref = useRef<THREE.Points>(null!);
  const { geo } = useMemo(() => {
    const N = 900;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // fibonacci shell
      const y = 1 - (i / (N - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = Math.PI * (3 - Math.sqrt(5)) * i;
      const r = 120;
      pos[i * 3] = Math.cos(th) * rad * r;
      pos[i * 3 + 1] = Math.abs(y) * r * 0.7 - 8;
      pos[i * 3 + 2] = Math.sin(th) * rad * r;
      seed[i] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    return { geo: g };
  }, []);
  useFrame((s) => {
    ref.current.rotation.y = s.clock.elapsedTime * 0.004;
  });
  return (
    <points ref={ref} geometry={geo} frustumCulled={false}>
      <shaderMaterial
        vertexShader={SH_STAR_VERT}
        fragmentShader={SH_STAR_FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={{ uTime: U.time, uPixelRatio: U.uPixelRatio, uColA: U.starA, uColB: U.starB }}
      />
    </points>
  );
}

import { gridVert as SH_GRID_VERT, gridFrag as SH_GRID_FRAG, backdropVert as SH_STAR_VERT, backdropFrag as SH_STAR_FRAG } from '../../lib/shaders';
