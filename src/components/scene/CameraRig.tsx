import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { bus } from '../../lib/engineBus';

/**
 * Cinematic camera rig:
 * - slow autonomous drift (Lissajous) around the oracle
 * - mouse parallax offset
 * - pulse shake on big events
 * - gentle FOV breathing with energy
 */
export default function CameraRig() {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(0, 0.4, 0));
  const smooth = useRef({ x: 0, y: 0 });

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const px = bus.mouse.x, py = bus.mouse.y;
    smooth.current.x += (px - smooth.current.x) * Math.min(1, dt * 2.2);
    smooth.current.y += (py - smooth.current.y) * Math.min(1, dt * 2.2);

    // base orbit
    const baseR = 10.2;
    const baseAng = t * 0.055;
    const cx = Math.cos(baseAng) * baseR;
    const cz = Math.sin(baseAng) * baseR;
    const cy = 2.1 + Math.sin(t * 0.11) * 0.7;

    // parallax pull toward the look target
    const target = new THREE.Vector3(
      cx + smooth.current.x * -2.2,
      cy + smooth.current.y * -1.2,
      cz,
    );
    camera.position.lerp(target, Math.min(1, dt * 1.6));

    // shake
    bus.shake = Math.max(0, bus.shake - dt * 0.9);
    if (bus.shake > 0.001) {
      const s = bus.shake * bus.shake;
      camera.position.x += (Math.random() - 0.5) * s * 0.5;
      camera.position.y += (Math.random() - 0.5) * s * 0.5;
      camera.position.z += (Math.random() - 0.5) * s * 0.5;
    }

    look.current.x += ((smooth.current.x * 0.6) - look.current.x) * Math.min(1, dt * 2);
    look.current.y += ((0.4 + smooth.current.y * 0.4) - look.current.y) * Math.min(1, dt * 2);
    camera.lookAt(look.current);

    // fov breathing
    const pc = camera as THREE.PerspectiveCamera;
    const targetFov = 55 + Math.sin(t * 0.3) * 1.2;
    pc.fov += (targetFov - pc.fov) * Math.min(1, dt * 1.5);
    pc.updateProjectionMatrix();
  });

  return null;
}
