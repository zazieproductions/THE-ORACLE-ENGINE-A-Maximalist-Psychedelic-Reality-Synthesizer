import * as THREE from 'three';

/** Generate a soft radial-glow canvas texture for sprites. */
export function makeGlowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(160,220,255,0.35)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.25, inner);
  g.addColorStop(0.55, mid);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Etched disc texture (sigil / diagram) rendered at runtime — occult-geometry. */
export function makeDiscTexture(hue: string, glyphColor: string, variant: number): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  ctx.strokeStyle = hue;
  ctx.fillStyle = glyphColor;
  ctx.lineWidth = 1.2;

  // outer ring + inner rings
  const rings = [120, 108, 86, 80, 44, 40];
  for (const r of rings) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.globalAlpha = r % 2 === 0 ? 0.85 : 0.4;
    ctx.stroke();
  }

  // radial ticks
  const ticks = 48 + variant * 8;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const r1 = 109, r2 = i % 4 === 0 ? 98 : 104;
    ctx.globalAlpha = i % 4 === 0 ? 0.9 : 0.4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.stroke();
  }

  // glyphs — pseudo-runic marks on the outer band
  const glyphs = 16 + variant * 4;
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < glyphs; i++) {
    ctx.save();
    ctx.rotate((i / glyphs) * Math.PI * 2);
    ctx.translate(0, -96);
    const s = 5 + ((i * 7919 + variant * 104729) % 4);
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(-s / 2, 0); ctx.lineTo(s / 2, 0);
    ctx.moveTo(0, -s / 2); ctx.lineTo(0, s / 2);
    if (i % 3 === 0) { ctx.moveTo(-s / 2, -s / 2); ctx.lineTo(s / 2, s / 2); }
    if (i % 4 === 1) { ctx.moveTo(s / 2, -s / 2); ctx.lineTo(-s / 2, s / 2); }
    if (i % 5 === 2) { ctx.rect(-s / 3, -s / 3, (s / 3) * 2, (s / 3) * 2); }
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // sacred geometry core — overlapping polygons
  ctx.globalAlpha = 0.8;
  const sides = 3 + (variant % 4);
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2 + k * (Math.PI / sides) + variant;
      const x = cx + Math.cos(a) * 38;
      const y = cy + Math.sin(a) * 38;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // inner circle diagram
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.stroke();

  // speckle
  for (let i = 0; i < 700; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 122;
    ctx.globalAlpha = Math.random() * 0.5;
    ctx.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1, 1);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** VHS-style horizontal chromatic stripe texture (subtle use on panels / title) */
export function makeVhsTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 3) {
    const a = Math.random();
    ctx.fillStyle = `rgba(${a > 0.5 ? '255,60,80' : '0,255,255'},${0.06 + Math.random() * 0.12})`;
    ctx.fillRect(0, y, 256, 1);
  }
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.16})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 30, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
