import * as THREE from 'three';

// Ephemeral, non-reactive channels (read every frame — never through React state)
export const bus = {
  mouse: new THREE.Vector2(0, 0),          // ndc
  mouseClient: { x: 0, y: 0 },             // px
  hoverText: '',
  hoverBoost: 0,
  pulse: 0,                                 // decaying excitement
  shake: 0,                                 // camera jitter 0..~0.35
  dischargeT: -100,                         // clock time of last discharge
};
