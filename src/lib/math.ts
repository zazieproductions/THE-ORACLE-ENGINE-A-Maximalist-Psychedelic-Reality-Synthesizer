import * as THREE from 'three';

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export const damp = (cur: number, target: number, lambda: number, dt: number) =>
  THREE.MathUtils.damp(cur, target, lambda, dt);

/** rotate q around axis to angle (degrees) — small helper */
export function setFromLookAt(obj: THREE.Object3D, target: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) {
  const m = new THREE.Matrix4().lookAt(obj.position, target, up);
  obj.quaternion.setFromRotationMatrix(m);
}

export function randomInSphere(r = 1) {
  const u = Math.random() * Math.PI * 2;
  const v = Math.acos(2 * Math.random() - 1);
  const rad = r * Math.cbrt(Math.random());
  return new THREE.Vector3(
    rad * Math.sin(v) * Math.cos(u),
    rad * Math.cos(v),
    rad * Math.sin(v) * Math.sin(u),
  );
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** fibonacci sphere distribution */
export function fibSphere(i: number, n: number, r: number) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (i / (n - 1)) * 2;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * i;
  return new THREE.Vector3(Math.cos(theta) * rad * r, y * r, Math.sin(theta) * rad * r);
}
