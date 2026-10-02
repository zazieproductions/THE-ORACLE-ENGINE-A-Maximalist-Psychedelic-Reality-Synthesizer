import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { IcosahedronGeometry, OctahedronGeometry, EdgesGeometry, LineSegments, MeshStandardMaterial, Group, Mesh } from 'three';
import { organismVert, organismFrag } from '../../lib/shaders';
import { U } from '../../lib/uniforms';
import { bus } from '../../lib/engineBus';
import { damp } from '../../lib/math';

/**
 * THE ORACLE — central impossible organism.
 * Layer 1: fresnel membrane shell (shader).  Layer 2: wireframe
 * topology cage counter-rotating.  Layer 3: chrome fragments orbiting
 * the equator.  Pointer proximity magnetizes the shell + drives
 * interaction: click = oracle's "gaze" pulse.
 */
export default function Oracle() {
  const shellRef = useRef<Mesh>(null!);
  const shellMat = useRef<THREE.ShaderMaterial>(null!);
  const cageRef = useRef<LineSegments>(null!);
  const glowRef = useRef<Group>(null!);

  const geo = useMemo(() => new IcosahedronGeometry(2.1, 5), []);
  const cageGeo = useMemo(() => new EdgesGeometry(new OctahedronGeometry(3.05, 1)), []);
  const cage2Geo = useMemo(() => new EdgesGeometry(new OctahedronGeometry(3.6, 0)), []);
  const fragGeo = useMemo(() => new THREE.TetrahedronGeometry(0.16, 0), []);
  const coreGeo = useMemo(() => new THREE.IcosahedronGeometry(0.9, 3), []);

  const fragments = useMemo(() => {
    const arr: { theta: number; phi: number; speed: number; scale: number; tumble: number }[] = [];
    for (let i = 0; i < 14; i++) {
      arr.push({
        theta: (i / 14) * Math.PI * 2 + Math.random() * 0.4,
        phi: Math.PI * 0.5 + (Math.random() - 0.5) * 0.9,
        speed: 0.12 + Math.random() * 0.18,
        scale: 0.5 + Math.random() * 1.1,
        tumble: 0.4 + Math.random() * 0.8,
      });
    }
    return arr;
  }, []);

  const fragMat = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#c8c2b8',
        metalness: 0.92,
        roughness: 0.18,
        emissive: new THREE.Color('#8a5cff'),
        emissiveIntensity: 0.12,
      }),
    [],
  );

  const cageMat = useMemo(
    () => new THREE.LineBasicMaterial({ color: '#8a5cff', transparent: true, opacity: 0.35 }),
    [],
  );

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    // hover proximity → energy surge
    const mx = bus.mouse.x, my = bus.mouse.y;
    const dist2 = mx * mx + my * my;
    bus.hoverBoost = damp(bus.hoverBoost, Math.max(0, 1 - dist2 * 0.7), 4, dt);
    bus.pulse = Math.max(0, bus.pulse - dt * 0.7);

    const targetEnergy = 0.18 + bus.hoverBoost * 0.35 + bus.pulse * 0.9;
    U.energy.value = damp(U.energy.value, targetEnergy, 3, dt);
    U.dissolve.value = damp(U.dissolve.value, bus.pulse > 0.55 ? (bus.pulse - 0.55) * 0.8 : 0, 8, dt);

    // shell: slow rotation + wobble, reacts to mouse
    shellRef.current.rotation.y = t * 0.11;
    shellRef.current.rotation.z = Math.sin(t * 0.16) * 0.1 + mx * 0.06;
    shellRef.current.rotation.x = Math.cos(t * 0.13) * 0.08 + my * 0.06;

    cageRef.current.rotation.y = -t * 0.06;
    cageRef.current.rotation.x = t * 0.03;
    (cageRef.current.material as THREE.LineBasicMaterial).opacity = 0.22 + U.energy.value * 0.3;

    glowRef.current.rotation.y = t * 0.05;
    const scl = 1 + bus.pulse * 0.05;
    glowRef.current.scale.setScalar(scl);
  });

  return (
    <group>
      {/* glow bloom core */}
      <group ref={glowRef}>
        <mesh geometry={coreGeo}>
          <meshBasicMaterial color="#8a5cff" transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh scale={1.6}>
          <icosahedronGeometry args={[0.9, 3]} />
          <meshBasicMaterial color="#4c2f9e" transparent opacity={0.18} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.BackSide} />
        </mesh>
      </group>

      {/* membrane shell */}
      <mesh ref={shellRef} geometry={geo}>
        <shaderMaterial
          ref={shellMat}
          vertexShader={organismVert}
          fragmentShader={organismFrag}
          uniforms={{
            uTime: U.time,
            uEnergy: U.energy,
            uMorph: U.morph,
            uDissolve: U.dissolve,
            uRadius: { value: 2.1 },
            uColA: U.colA,
            uColB: U.colB,
            uColC: U.colC,
          }}
        />
      </mesh>

      {/* topology cages */}
      <lineSegments ref={cageRef} geometry={cageGeo} material={cageMat} />
      <lineSegments geometry={cage2Geo}>
        <lineBasicMaterial color="#00e5ff" transparent opacity={0.14} />
      </lineSegments>

      {/* chrome fragments */}
      {fragments.map((f, i) => (
        <Fragment key={i} f={f} geo={fragGeo} mat={fragMat} />
      ))}
    </group>
  );
}

function Fragment({ f, geo, mat }: { f: { theta: number; phi: number; speed: number; scale: number; tumble: number }; geo: THREE.BufferGeometry; mat: THREE.Material }) {
  const ref = useRef<Mesh>(null!);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const a = f.theta + t * f.speed;
    const wob = Math.sin(t * 0.5 + f.theta * 3) * 0.15;
    const r = 3.35 + wob;
    ref.current.position.set(
      r * Math.sin(f.phi) * Math.cos(a),
      r * Math.cos(f.phi) * 0.9,
      r * Math.sin(f.phi) * Math.sin(a),
    );
    ref.current.rotation.x = t * f.tumble;
    ref.current.rotation.y = t * f.tumble * 0.7;
  });
  return <mesh ref={ref} geometry={geo} material={mat} scale={f.scale} />;
}
