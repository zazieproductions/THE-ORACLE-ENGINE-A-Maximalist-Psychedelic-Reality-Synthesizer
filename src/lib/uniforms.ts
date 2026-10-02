import * as THREE from 'three';

// Shared shader uniforms — one object per channel, referenced by every
// ShaderMaterial so a single write updates the whole world.
export const U = {
  time: { value: 0 },
  energy: { value: 0.15 },
  morph: { value: 0.2 },
  dissolve: { value: 0 },
  uPixelRatio: { value: 1 },
  colA: { value: new THREE.Color('#1a0f38') },
  colB: { value: new THREE.Color('#8a5cff') },
  colC: { value: new THREE.Color('#00e5ff') },
  partA: { value: new THREE.Color('#8a5cff') },
  partB: { value: new THREE.Color('#00e5ff') },
  gridA: { value: new THREE.Color('#5b3bd6') },
  gridB: { value: new THREE.Color('#00e5ff') },
  starA: { value: new THREE.Color('#bdb2ff') },
  starB: { value: new THREE.Color('#00e5ff') },
  fogU: { value: new THREE.Color('#05010d') },
};
