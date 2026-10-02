// ------------------------------------------------------------------
// GLSL chunks & full shaders — keep in one place for the aesthetic.
// All colors flow through uniforms (uColA, uColB, uColC, uFog...) so a
// reality state is just a palette + behavior switch.
// ------------------------------------------------------------------

export const NOISE_GLSL = /* glsl */ `
  float hash11(float p){ p = fract(p*443.8975); p += dot(vec2(p,p), vec2(p,p)+19.19); return fract(p*p); }
  float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*443.8975); p3 += dot(p3, p3.yzx+19.19); return fract((p3.x+p3.y)*p3.z); }
  float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.yzx+33.33); return fract((p.x+p.y)*p.z); }
  float vnoise(vec3 p){
    vec3 i = floor(p); vec3 f = fract(p);
    f = f*f*(3.0-2.0*f);
    float n000 = hash13(i+vec3(0.,0.,0.)); float n100 = hash13(i+vec3(1.,0.,0.));
    float n010 = hash13(i+vec3(0.,1.,0.)); float n110 = hash13(i+vec3(1.,1.,0.));
    float n001 = hash13(i+vec3(0.,0.,1.)); float n101 = hash13(i+vec3(1.,0.,1.));
    float n011 = hash13(i+vec3(0.,1.,1.)); float n111 = hash13(i+vec3(1.,1.,1.));
    return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),
               mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
  }
  float fbm(vec3 p){
    float v = 0.0; float a = 0.5;
    for(int i=0;i<4;i++){ v += a*vnoise(p); p = p*2.03 + vec3(1.7); a *= 0.5; }
    return v;
  }
`;

// ================================================================
// ORGANISM — central oracle shell. Dissipating advanced noise shell,
// fresnel glow, vertex displacement driven by energy & reality morph.
// ================================================================
export const organismVert = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uMorph;      // 0..1 reality blend
  uniform float uDissolve;   // 0..1 breakdown
  uniform float uRadius;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vNoise;

  ${NOISE_GLSL}

  void main() {
    vPos = position;
    vec3 p = position;
    float n = fbm(p * 1.6 + vec3(0.0, uTime * 0.22, uTime * 0.13));
    float n2 = vnoise(p * 4.2 - vec3(uTime * 0.3));
    vNoise = n;

    // tendrils pulse from the "poles" more strongly as energy rises
    float polar = pow(abs(normalize(position).y), 2.0);
    float disp = (n - 0.5) * (0.34 + uEnergy * 0.5 + polar * uEnergy * 0.4)
               + (n2 - 0.5) * 0.06;

    // morph: pull vertices along a hex-ish lattice when uMorph ~ 1
    float hex = sin(position.x * 7.0) * sin(position.y * 6.0 + 1.3) * sin(position.z * 6.5 + 2.1);
    disp += hex * 0.11 * uMorph;

    // dissolve: carve holes with noise threshold
    vNoise = n + hex * 0.16 * uMorph;
    vec3 dir = normalize(p);
    p = dir * (uRadius * (1.0 + disp));

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const organismFrag = /* glsl */ `
  uniform vec3 uColA;      // deep body
  uniform vec3 uColB;      // fresnel rim
  uniform vec3 uColC;      // inner core veins
  uniform float uTime;
  uniform float uEnergy;
  uniform float uMorph;
  uniform float uDissolve;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vNoise;

  ${NOISE_GLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);

    // inner glow: dark center, hot surface bands
    float bands = sin(vPos.y * 9.0 + uTime * 1.4 + vNoise * 12.0) * 0.5 + 0.5;
    bands = pow(bands, 3.0);

    float veins = smoothstep(0.62, 0.78, fbm(vPos * 3.2 + vec3(uTime * 0.4)));

    // hex lattice warning when morphed
    float hex = sin(vPos.x * 7.0) * sin(vPos.y * 6.0 + 1.3) * sin(vPos.z * 6.5 + 2.1);
    float hexLine = smoothstep(0.55, 0.95, abs(hex));

    vec3 col = uColA * (0.25 + 0.75 * bands);
    col += uColC * veins * 1.6;
    col += uColB * fres * (1.6 + uEnergy * 2.2);
    col = mix(col, uColB * hexLine * 1.8, uMorph * 0.8);

    // dissolve carve
    if (uDissolve > 0.001) {
      float cut = smoothstep(uDissolve * 0.9, uDissolve * 0.9 + 0.12, vNoise + hash11(floor(vPos.y * 24.0)) * 0.12);
      if (cut <= 0.001) discard;
      col = mix(vec3(1.0, 0.75, 0.25), col, cut) * (0.4 + cut);
    }

    // flicker like a failing tube
    float fl = 0.9 + 0.1 * step(0.5, fract(sin(floor(uTime * 24.0)) * 43758.5));
    gl_FragColor = vec4(col * fl, 1.0);
  }
`;

// ================================================================
// PARTICLES — soft additive points with size by energy & distance.
// ================================================================
export const particleVert = /* glsl */ `
  attribute float aSeed;
  attribute vec3 aVel;
  attribute float aSize;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uPixelRatio;
  varying float vSeed;
  varying float vFade;
  void main() {
    vSeed = aSeed;
    vec3 p = position;
    // slow swirl + rising current
    float ang = uTime * (0.05 + aSeed * 0.08);
    float c = cos(ang); float s = sin(ang);
    p = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
    p += aVel * uTime * (0.35 + uEnergy);
    p.y += sin(uTime * 0.4 + aSeed * 40.0) * 0.35;
    // wrap
    p.y = mod(p.y + 30.0, 60.0) - 30.0;
    p.x = mod(p.x + 45.0, 90.0) - 45.0;
    p.z = mod(p.z + 45.0, 90.0) - 45.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (1.0 + uEnergy * 1.4) * (140.0 / -mv.z);
    vFade = smoothstep(-220.0, -20.0, mv.z);
  }
`;

export const particleFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying float vSeed;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float core = smoothstep(0.5, 0.0, d);
    float glow = exp(-d * 5.5);
    vec3 col = mix(uColA, uColB, fract(vSeed * 7.31));
    col = col * (core * 1.4 + glow * 1.2);
    gl_FragColor = vec4(col, (core + glow) * vFade * 0.75);
  }
`;

// ================================================================
// TRAILS — radial streaks ring around the oracle (the "halo array")
// ================================================================
export const haloVert = /* glsl */ `
  attribute float aSlot;      // 0..1 around the circle
  attribute float aJit;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uSpeed;
  uniform float uRadius;
  varying float vSlot;
  varying float vJit;
  void main() {
    vSlot = aSlot; vJit = aJit;
    float ang = aSlot * 6.2831853 + uTime * uSpeed * (0.4 + aJit * 0.9);
    float r = uRadius * (1.0 + sin(uTime * (0.6 + aJit) + aSlot * 20.0) * 0.05);
    vec3 p = vec3(cos(ang) * r, sin(aSlot * 6.2831853) * uRadius * 0.22, sin(ang) * r);
    // elongate into streaks visually done in frag via uv-less angle; here just position
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const haloFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying float vSlot;
  varying float vJit;
  void main() {
    // streak mask: dashes along the track
    float dash = step(0.32, fract(vSlot * 48.0));
    float glint = pow(fract(vSlot * 7.0), 3.0);
    float a = dash * (0.25 + glint);
    vec3 col = mix(uColA, uColB, glint);
    gl_FragColor = vec4(col * 1.4, a * 0.8);
  }
`;

// ================================================================
// ORBIT SHELL — many small artifacts (obelisks/etchings) on rings
// ================================================================
export const orbitFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uTime;
  varying vec2 vUv;
  varying float vFace;
  ${NOISE_GLSL}
  void main() {
    float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x)
                * smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
    float glyphs = smoothstep(0.72, 0.8, vnoise(vec3(vUv * vec2(18.0, 9.0), 1.0) + vec3(0.0, vUv.x * 4.0, 0.0)));
    vec3 col = mix(uColA * 0.7, uColB, glyphs);
    col += uColB * glyphs * 1.2;
    float a = edge * (0.5 + glyphs * 0.5);
    gl_FragColor = vec4(col, a);
  }
`;

// ================================================================
// BACKDROP STARFIELD FIBER — points on far sphere, subtle drift
// ================================================================
export const backdropVert = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vSeed;
  void main() {
    vSeed = aSeed;
    vec3 p = position;
    float ang = uTime * 0.004 * (0.5 + aSeed);
    float c = cos(ang); float s = sin(ang);
    p = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (1.0 + aSeed * 2.2) * uPixelRatio;
  }
`;

export const backdropFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying float vSeed;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float a = smoothstep(0.5, 0.0, d);
    float twinkle = 0.6 + 0.4 * sin(vSeed * 90.0 + vSeed * 12.0);
    vec3 col = mix(uColA, uColB, step(0.85, vSeed));
    gl_FragColor = vec4(col, a * twinkle * 0.85);
  }
`;

// ================================================================
// GROUND GRID — retro-occult perspective grid plane with radial runes
// ================================================================
export const gridVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const gridFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uFog;
  uniform float uTime;
  uniform float uEnergy;
  varying vec2 vUv;
  varying vec3 vWorld;
  ${NOISE_GLSL}
  void main() {
    vec2 g = abs(fract(vWorld.xz * 0.5) - 0.5);
    float line = smoothstep(0.5, 0.46, max(g.x, g.y));
    float dist = length(vWorld.xz);
    float fade = exp(-dist * 0.055);
    // concentric rings (ritual circles)
    float ring = smoothstep(0.03, 0.0, abs(fract(dist * 0.12) - 0.5) / 12.0 - 0.02);
    float rings = smoothstep(0.0, 0.015, abs(sin(dist * 1.1)));
    rings = 1.0 - rings;
    // radial runes
    float ang = atan(vWorld.z, vWorld.x);
    float runes = step(0.985, sin(ang * 24.0)) * smoothstep(26.0, 30.0, dist) * smoothstep(52.0, 48.0, dist);
    vec3 col = uColA * line * 0.5 + uColB * (ring * 0.6 + rings * 0.35) * (0.5 + uEnergy)
             + uColB * runes;
    col *= fade * (0.55 + uEnergy * 0.6);
    float fogMix = smoothstep(18.0, 95.0, dist);
    col = mix(col, uFog, fogMix);
    gl_FragColor = vec4(col, clamp((line * 0.8 + ring + rings * 0.6 + runes) * fade, 0.0, 1.0));
  }
`;

// ================================================================
// NEURAL WEB — lines connecting sacred-geometry vertices
// ================================================================
export const webFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform float uTime;
  varying vec2 vUv;
  varying float vP;
  void main() {
    float a = (1.0 - abs(vUv.y - 0.5) * 2.0);
    vec3 col = uColA * (0.35 + vP * 0.65);
    gl_FragColor = vec4(col, a * (0.3 + vP * 0.5));
  }
`;

// ================================================================
// KEY FRAGMENTS — UI discs, sigil stamps (billboards / planes)
// ================================================================
export const discVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const discFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uTime;
  uniform float uSpin;
  uniform float uGlyphSeed;
  varying vec2 vUv;
  ${NOISE_GLSL}
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x) + uTime * uSpin;
    // concentric etched rings
    float rings = smoothstep(0.02, 0.0, abs(fract(r * 5.0) - 0.5) / 5.0 - 0.035);
    // glyphs around ring
    float ga = fract((ang / 6.2831853) * (6.0 + floor(uGlyphSeed * 4.0)));
    float glyph = step(0.55, hash11(floor(ga * 18.0) + floor(uGlyphSeed * 99.0) + floor(r * 3.0)));
    float ringMask = smoothstep(0.78, 0.82, r) * smoothstep(0.99, 0.94, r);
    float spokes = smoothstep(0.015, 0.0, abs(fract((ang / 6.2831853) * 9.0) - 0.5) / 9.0 - 0.016) * step(r, 0.78) * step(0.12, r);
    float disc = smoothstep(1.0, 0.97, r);
    float bg = smoothstep(0.65, 0.0, r) * 0.22;
    vec3 col = uColA * (bg + rings * 0.5 + spokes * 0.4) + uColB * (glyph * ringMask * 1.5 + smoothstep(1.0, 0.9, r) * 0.25);
    float a = disc * (0.34 + rings * 0.4 + glyph * ringMask + spokes * 0.35);
    col += uColB * pow(1.0 - r, 3.0) * 0.5;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`;

// ================================================================
// FOG CURTAINS — large translucent smoke planes (volumetric feel)
// ================================================================
export const fogVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const fogFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCol;
  uniform vec3 uAccent;
  uniform float uOpacity;
  uniform float uSeed;
  varying vec2 vUv;
  ${NOISE_GLSL}
  void main() {
    vec3 p = vec3(vUv * vec2(3.0, 1.2), uSeed + uTime * 0.02);
    float w = fbm(p + fbm(p * 1.7) * 1.4);
    float density = smoothstep(0.35, 0.85, w);
    float vert = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
    float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
    float a = density * vert * edge * uOpacity;
    vec3 col = mix(uCol, uAccent, density * 0.22);
    gl_FragColor = vec4(col, a);
  }
`;

// ================================================================
// CURTAIN — inverted mountain silhouettes at horizon (deep sea / void)
// ================================================================
export const curtainVert = /* glsl */ `
  varying vec2 vUv;
  varying float vY;
  void main() {
    vUv = uv;
    vec3 p = position;
    vY = p.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const curtainFrag = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uFog;
  uniform float uTime;
  uniform float uSeed;
  varying vec2 vUv;
  varying float vY;
  ${NOISE_GLSL}
  void main() {
    float ridge = fbm(vec3(vUv.x * 4.0 + uSeed, 0.0, uSeed));
    float ridge2 = fbm(vec3(vUv.x * 9.0 - uSeed, 4.0, uSeed));
    float edge = vUv.y - (ridge * 0.55 + ridge2 * 0.2) * 0.9;
    float body = smoothstep(0.0, 0.02, edge);
    float haze = exp(-abs(edge) * 9.0) * 0.6;
    vec3 col = uColA * body;
    col += uColA * haze * 0.6;
    // luminal rim where ridge meets sky
    col += vec3(0.5, 0.85, 1.0) * pow(haze, 3.0) * 0.35;
    float fogMix = smoothstep(0.55, 1.0, vUv.y);
    col = mix(col, uFog, fogMix * 0.85);
    gl_FragColor = vec4(col, body * 0.9 + haze * 0.3);
  }
`;
