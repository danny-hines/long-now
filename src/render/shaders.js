// GLSL for everything drawn in space. All colours are linear HDR; tone mapping
// and bloom happen in post.

const NOISE = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i), hash31(i + vec3(1,0,0)), u.x), mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), u.x), mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// Crater field: rims and bowls from a jittered cell grid.
float craters(vec3 p, float scale) {
  p *= scale;
  vec3 i = floor(p), f = fract(p);
  float h = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 c = g + vec3(hash31(i + g), hash31(i + g + 7.3), hash31(i + g + 13.7));
    float r = 0.12 + 0.3 * hash31(i + g + 3.1);
    float d = length(f - c) / r;
    h += (smoothstep(0.75, 1.0, d) * (1.0 - smoothstep(1.0, 1.25, d)) * 0.6 - (1.0 - smoothstep(0.0, 0.9, d)) * 0.45) * step(0.55, hash31(i + g + 5.5));
  }
  return h;
}
`;

const VERT_COMMON = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vView;
void main() {
  vObj = normalize(position);
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vView = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

// Shared lighting: a sun of finite angular size (so a bloated red giant wraps
// light around a nearby planet), with a soft terminator.
const LIGHT = /* glsl */ `
uniform vec3 uSunDir;     // world space, toward the Sun
uniform vec3 uSunColor;
uniform float uLight;     // exposure-compensated intensity
uniform float uSunAngle;  // sin of the Sun's angular radius seen from here
float daylight(vec3 n) {
  float c = dot(n, uSunDir);
  return smoothstep(-uSunAngle - 0.06, uSunAngle + 0.22, c) * mix(max(c, 0.0), 1.0, clamp(uSunAngle * 1.5, 0.0, 0.8)) + 0.0;
}
vec3 lava(float heat) {
  // Black-body-ish ramp for glowing rock.
  return vec3(1.0, 0.20, 0.025) * heat * 0.8 + vec3(1.0, 0.5, 0.1) * pow(heat, 3.0) * 0.3;
}
`;

export const planetVertex = VERT_COMMON;

// ---------------------------------------------------------------------------
// Earth
// ---------------------------------------------------------------------------
export const earthFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vView;
uniform sampler2D uLand;   // r,g: signed distance to the coast in two neighbouring epochs
uniform float uMix;
uniform float uOcean, uIceLat, uVeg, uRust, uHaze, uCloud, uVenusian, uAtmo, uSeaGreen, uMolten, uLights, uTime;
${NOISE}
${LIGHT}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObj);
  vec3 n = normalize(vWorldN);
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float lon = atan(-p.z, p.x);
  vec2 uv = vec2(lon / 6.28318530718 + 0.5, 0.5 - lat / 3.14159265359);
  vec2 sd = texture2D(uLand, uv).rg;
  float h = mix(sd.r, sd.g, uMix);
  float rough = fbm(p * 9.0) - 0.5;
  float fine = fbm(p * 34.0) - 0.5;
  h += rough * 0.035 + fine * 0.012;
  // Sea level falls as the oceans are lost; the last water sits far from land.
  float sea = 0.5 - (1.0 - uOcean) * 0.55;
  float land = smoothstep(sea - 0.004, sea + 0.004, h);
  float inland = clamp((h - 0.5) * 3.0, 0.0, 1.0);
  float alat = abs(lat) * 57.29578;

  // --- land ---
  float mtn = smoothstep(0.52, 0.75, fbm(p * 6.0 + 3.0)) * inland;
  vec3 rock = mix(vec3(0.19, 0.17, 0.16), vec3(0.36, 0.31, 0.26), fbm(p * 5.0));
  rock = mix(rock, mix(vec3(0.40, 0.21, 0.13), vec3(0.52, 0.36, 0.22), fbm(p * 7.0 + 9.0)), uRust * 0.85);
  // Climate belts: wet tropics, dry subtropics, temperate, boreal.
  float wet = fbm(p * 4.0 + 21.0);
  float arid = smoothstep(10.0, 24.0, alat) * (1.0 - smoothstep(30.0, 42.0, alat));
  arid = clamp(arid * (0.55 + inland * 0.9) + (0.42 - wet) * 1.3, 0.0, 1.0);
  vec3 forest = mix(vec3(0.035, 0.12, 0.03), vec3(0.09, 0.19, 0.05), wet);
  vec3 boreal = vec3(0.07, 0.11, 0.06);
  vec3 desert = mix(vec3(0.62, 0.50, 0.31), vec3(0.50, 0.33, 0.20), fbm(p * 11.0));
  vec3 green = mix(forest, boreal, smoothstep(45.0, 62.0, alat));
  vec3 biome = mix(green, desert, arid);
  vec3 landCol = mix(rock, biome, uVeg * (1.0 - mtn * 0.6));
  landCol = mix(landCol, vec3(0.42, 0.40, 0.38), mtn * 0.5);
  // Dried sea floor shows as pale salt and sediment.
  vec3 basin = mix(vec3(0.46, 0.40, 0.31), vec3(0.62, 0.58, 0.50), fbm(p * 8.0 + 4.0));
  landCol = mix(basin, landCol, smoothstep(0.38, 0.5, h));

  // --- sea ---
  float depth = clamp((sea - h) * 5.0, 0.0, 1.0);
  vec3 water = mix(vec3(0.03, 0.17, 0.30), vec3(0.008, 0.035, 0.13), depth);
  water = mix(water, mix(vec3(0.07, 0.20, 0.13), vec3(0.02, 0.08, 0.06), depth), uSeaGreen * 0.8);

  // --- ice ---
  float iceEdge = uIceLat + (fbm(p * 7.0 + 40.0) - 0.5) * 16.0;
  float seaIce = smoothstep(iceEdge + 4.0, iceEdge + 8.0, alat);
  float landIce = smoothstep(iceEdge - 6.0, iceEdge - 1.0, alat + mtn * 14.0);
  float iceAll = step(uIceLat, 1.0);
  seaIce = max(seaIce, iceAll); landIce = max(landIce, iceAll);
  vec3 ice = mix(vec3(0.80, 0.86, 0.92), vec3(0.93, 0.95, 0.97), fbm(p * 20.0));

  vec3 surf = mix(mix(water, ice * 0.93, seaIce), mix(landCol, ice, landIce), land);
  float waterMask = (1.0 - land) * (1.0 - seaIce);

  // --- light ---
  float day = daylight(n);
  vec3 lit = uSunColor * uLight;
  vec3 col = surf * lit * day;
  vec3 hv = normalize(uSunDir + vView);
  col += lit * pow(max(dot(n, hv), 0.0), 90.0) * 0.55 * waterMask * day;

  // --- magma ocean / glowing crust ---
  if (uMolten > 0.001) {
    float plates = fbm(p * 5.0 + vec3(0.0, uTime * 0.02, 0.0));
    float cracks = 1.0 - smoothstep(0.0, 0.12 + 0.25 * uMolten, abs(fbm(p * 11.0 + 5.0) - 0.5));
    float crust = smoothstep(uMolten * 1.15 - 0.25, uMolten * 1.15, plates);
    float heat = clamp((1.0 - crust) + cracks * uMolten * 1.2, 0.0, 1.0) * smoothstep(0.0, 0.25, uMolten);
    heat *= 0.15 + 1.1 * fbm(p * 7.0 + vec3(uTime * 0.03, 0.0, 0.0));
    heat = mix(heat, heat * (1.0 - 0.8 * smoothstep(0.55, 0.7, fbm(p * 3.0 + 31.0))), 0.8);
    vec3 dark = vec3(0.045, 0.035, 0.03) * (0.3 + day) * lit;
    col = mix(col, dark, smoothstep(0.0, 0.3, uMolten));
    col += lava(heat) * (0.5 + 0.5 * uMolten);
  }

  // --- city lights (for a few centuries around now) ---
  if (uLights > 0.0) {
    float pop = smoothstep(0.52, 0.8, fbm(p * 14.0 + 77.0)) * smoothstep(0.80, 0.93, vnoise(p * 260.0)) * (0.3 + uVeg);
    col += vec3(1.0, 0.72, 0.35) * pop * land * (1.0 - landIce) * (1.0 - smoothstep(0.0, 0.12, day)) * 1.4 * uLights;
  }

  // --- clouds ---
  vec3 q = p * 3.2 + vec3(uTime * 0.012, 0.0, uTime * 0.008);
  q += 0.55 * vec3(fbm3(p * 2.2 + 11.0), fbm3(p * 2.2 + 47.0), fbm3(p * 2.2 + 83.0));
  float cl = fbm(q) * 0.75 + fbm(q * 4.1) * 0.25;
  float bands = 0.06 * cos(lat * 6.0);
  float cover = smoothstep(0.88 - uCloud * 0.8 - bands, 1.04 - uCloud * 0.8 - bands, cl);
  cover = mix(cover, 1.0, smoothstep(0.85, 1.0, uCloud));
  vec3 cloudCol = mix(vec3(0.95), vec3(0.86, 0.80, 0.62), uVenusian);
  col = mix(col, cloudCol * lit * day * 0.9, cover * 0.88 * (1.0 - 0.8 * uMolten));
  // Venus-like deck: featureless yellow-white with faint streaks.
  float streak = fbm(vec3(p.x * 2.0, p.y * 9.0, p.z * 2.0) + uTime * 0.01);
  col = mix(col, mix(vec3(0.80, 0.72, 0.50), vec3(0.93, 0.88, 0.70), streak) * lit * day, uVenusian * 0.95);
  // Organic haze (Archean methane) / Hadean murk.
  col = mix(col, vec3(0.78, 0.50, 0.26) * lit * day, uHaze * 0.6 * (1.0 - 0.85 * uMolten));

  // --- atmosphere ---
  float rim = pow(1.0 - max(dot(n, vView), 0.0), 3.0);
  vec3 sky = mix(mix(vec3(0.25, 0.48, 1.0), vec3(0.9, 0.55, 0.3), uHaze), vec3(0.95, 0.85, 0.6), uVenusian);
  col += sky * rim * uAtmo * lit * smoothstep(-0.25, 0.35, dot(n, uSunDir)) * 0.9;
  col = mix(col, sky * lit * day, 0.09 * uAtmo);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Generic rocky world: Mercury, Venus, Mars, the Moon, Theia, Pluto
// ---------------------------------------------------------------------------
export const rockyFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vView;
uniform vec3 uColA, uColB, uColDark, uAtmoColor, uCloudColor;
uniform float uCraters, uMaria, uRust, uWater, uIceCap, uCloudDeck, uAtmo, uMolten, uTime, uSeed, uDetail;
${NOISE}
${LIGHT}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObj) + uSeed;
  vec3 n = normalize(vWorldN);
  float lat = asin(clamp(vObj.y, -1.0, 1.0)) * 57.29578;
  float big = fbm(p * 1.7);
  float mid = fbm(p * 6.0 + 2.0);
  float elev = big * 0.7 + mid * 0.3;
  vec3 col = mix(uColA, uColB, smoothstep(0.3, 0.7, mid * 0.6 + fbm(p * 14.0) * 0.4));
  // Dark lowland plains (lunar maria, Martian albedo features).
  float dark = smoothstep(0.50, 0.40, elev) * uMaria;
  col = mix(col, uColDark, dark);
  // Rust.
  col = mix(col, col * vec3(1.25, 0.72, 0.48) + vec3(0.08, 0.02, 0.0), uRust * (0.75 + 0.25 * mid));
  // Craters shade the surface.
  float cr = (craters(p, 5.0) + 0.6 * craters(p + 3.0, 14.0)) * uCraters * uDetail;
  cr += (fbm(p * 40.0) - 0.5) * 0.5 * uCraters * uDetail;
  col *= clamp(1.0 + cr * 0.55, 0.5, 1.35);
  // Standing water in the lowlands.
  float waterLine = 0.30 + uWater * 0.22;
  float wet = smoothstep(waterLine + 0.01, waterLine - 0.01, elev) * step(0.01, uWater);
  col = mix(col, mix(vec3(0.04, 0.16, 0.28), vec3(0.01, 0.05, 0.14), smoothstep(0.0, 0.15, waterLine - elev)), wet);
  // Polar caps.
  float capEdge = 90.0 - uIceCap * 22.0 + (fbm(p * 8.0) - 0.5) * 10.0;
  col = mix(col, vec3(0.92, 0.94, 0.96), smoothstep(capEdge, capEdge + 3.0, abs(lat)) * step(0.01, uIceCap));

  float day = daylight(n);
  vec3 lit = uSunColor * uLight;
  col = col * lit * day;
  vec3 hv = normalize(uSunDir + vView);
  col += lit * pow(max(dot(n, hv), 0.0), 80.0) * 0.5 * wet * day;

  if (uMolten > 0.001) {
    float plates = fbm(p * 4.0 + vec3(0.0, uTime * 0.02, 0.0));
    float cracks = 1.0 - smoothstep(0.0, 0.1 + 0.25 * uMolten, abs(fbm(p * 10.0 + 5.0) - 0.5));
    float crust = smoothstep(uMolten * 1.15 - 0.25, uMolten * 1.15, plates);
    float heat = clamp((1.0 - crust) + cracks * uMolten * 1.2, 0.0, 1.0) * smoothstep(0.0, 0.25, uMolten);
    heat *= 0.15 + 1.1 * fbm(p * 7.0 + vec3(uTime * 0.03, 0.0, 0.0));
    heat = mix(heat, heat * (1.0 - 0.8 * smoothstep(0.55, 0.7, fbm(p * 3.0 + 31.0))), 0.8);
    col = mix(col, vec3(0.04, 0.03, 0.03) * (0.3 + day) * lit, smoothstep(0.0, 0.3, uMolten));
    col += lava(heat) * (0.5 + 0.5 * uMolten);
  }

  // Cloud deck (Venus) — swept into a global Y/V pattern.
  if (uCloudDeck > 0.001) {
    vec3 q = vec3(p.x * 1.6, p.y * 5.0 + 0.6 * sin(atan(p.z, p.x) * 2.0 + uTime * 0.03), p.z * 1.6) + uTime * 0.006;
    float c = fbm(q);
    vec3 cc = mix(uCloudColor * 0.82, uCloudColor * 1.08, c);
    col = mix(col, cc * lit * day, uCloudDeck);
  }
  float rim = pow(1.0 - max(dot(n, vView), 0.0), 3.0);
  col += uAtmoColor * rim * uAtmo * lit * smoothstep(-0.25, 0.35, dot(n, uSunDir));
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Gas and ice giants
// ---------------------------------------------------------------------------
export const giantFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vView;
uniform vec3 uBandA, uBandB, uBandC, uPole;
uniform float uBands, uTurb, uSpot, uYoung, uHot, uTime, uRings, uSeed;
uniform vec3 uSunObj;   // Sun direction in the planet's own frame (for ring shadows)
${NOISE}
${LIGHT}
float ringDensity(float r) {
  // r in planet radii. C ring, B ring, Cassini division, A ring, Encke gap.
  float d = smoothstep(1.24, 1.30, r) * 0.25;
  d = mix(d, 0.95, smoothstep(1.50, 1.56, r));
  d *= 1.0 - smoothstep(1.94, 1.96, r) * (1.0 - smoothstep(2.01, 2.03, r)) * 0.9;
  d = mix(d, 0.6, smoothstep(2.02, 2.05, r));
  d *= 1.0 - smoothstep(2.26, 2.28, r);
  return d * (0.8 + 0.2 * sin(r * 140.0));
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObj);
  vec3 n = normalize(vWorldN);
  float lat = asin(clamp(p.y, -1.0, 1.0));
  // Zonal flow: shear the longitude by latitude, then perturb with turbulence.
  float lon = atan(p.z, p.x);
  float jet = sin(lat * uBands) * 0.6;
  vec3 q = vec3(cos(lon + jet * uTime * 0.02) * cos(lat), p.y, sin(lon + jet * uTime * 0.02) * cos(lat));
  float turb = (fbm(q * vec3(3.0, 14.0, 3.0) + uSeed) - 0.5) * uTurb;
  float swirl = (fbm(q * 9.0 + uSeed * 2.0) - 0.5) * uTurb * 0.5;
  float b = sin((lat + turb * 0.35) * uBands + swirl * 2.0);
  float b2 = sin((lat + turb * 0.2) * uBands * 2.3 + 1.7);
  vec3 col = mix(uBandA, uBandB, smoothstep(-0.5, 0.5, b));
  col = mix(col, uBandC, smoothstep(0.35, 0.95, b2) * 0.45);
  col = mix(col, uPole, smoothstep(0.95, 1.4, abs(lat)));
  // A long-lived anticyclone.
  if (uSpot > 0.0) {
    vec2 d = vec2((lon - 1.2 + jet * 0.0) * cos(lat), lat + 0.38);
    d.x = d.x - 6.28318 * floor(d.x / 6.28318 + 0.5);
    float s = length(d / vec2(0.21, 0.105));
    float sw = fbm(vec3(d * 14.0, uTime * 0.05)) * 0.3;
    col = mix(col, vec3(0.62, 0.22, 0.12), (1.0 - smoothstep(0.75 + sw, 1.0 + sw, s)) * uSpot);
  }
  float day = daylight(n);
  // Limb darkening of a deep atmosphere.
  float mu = max(dot(n, vView), 0.0);
  vec3 lit = uSunColor * uLight;
  col = col * lit * day * (0.55 + 0.45 * pow(mu, 0.5));
  // Shadow of the rings on the cloud tops.
  if (uRings > 0.01 && abs(uSunObj.y) > 1e-4) {
    float tt = -p.y / uSunObj.y;
    if (tt > 0.0) {
      vec3 hit = p + uSunObj * tt;
      col *= 1.0 - 0.8 * uRings * ringDensity(length(hit.xz));
    }
  }
  // Self-luminous when newly formed, or when roasted by the giant Sun.
  col += vec3(1.0, 0.28, 0.08) * uYoung * (0.25 + 0.5 * fbm(q * 5.0)) * 0.8;
  col = mix(col, col * vec3(0.5, 0.6, 1.2) + vec3(0.9, 0.35, 0.1) * 0.35 * (1.0 - day), uHot * 0.6);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const ringVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPos;     // planet frame, in planet radii
varying vec3 vWorld;
void main() {
  vPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;
export const ringFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vPos;
varying vec3 vWorld;
uniform vec3 uSunObj, uSunColor;
uniform float uLight, uRings;
float ringDensity(float r) {
  float d = smoothstep(1.24, 1.30, r) * 0.25;
  d = mix(d, 0.95, smoothstep(1.50, 1.56, r));
  d *= 1.0 - smoothstep(1.94, 1.96, r) * (1.0 - smoothstep(2.01, 2.03, r)) * 0.9;
  d = mix(d, 0.6, smoothstep(2.02, 2.05, r));
  d *= 1.0 - smoothstep(2.26, 2.28, r);
  return d * (0.8 + 0.2 * sin(r * 140.0));
}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vPos.xz);
  float d = ringDensity(r) * uRings;
  if (d < 0.004) discard;
  // Planet's shadow: does the ray toward the Sun pass through the unit sphere?
  float bq = dot(vPos, uSunObj);
  float cq = dot(vPos, vPos) - 1.0;
  float shadow = (bq > 0.0 && bq * bq - cq > 0.0) ? 0.06 : 1.0;
  vec3 ice = mix(vec3(0.62, 0.55, 0.45), vec3(0.93, 0.89, 0.80), smoothstep(1.3, 1.9, r));
  // Lit from either side; a little brighter in forward scattering.
  vec3 view = normalize(cameraPosition - vWorld);
  float phase = 0.75 + 0.25 * abs(uSunObj.y);
  gl_FragColor = vec4(ice * uSunColor * uLight * phase * shadow, d);
}
`;

// ---------------------------------------------------------------------------
// Atmosphere shell (drawn slightly larger than the planet, back faces, additive)
// ---------------------------------------------------------------------------
export const atmoFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vWorldN;
varying vec3 vView;
uniform vec3 uColor, uSunDir, uSunColor;
uniform float uLight, uStrength;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vWorldN);
  float edge = max(dot(-n, vView), 0.0);          // back face: 0 at the limb
  float glow = pow(smoothstep(0.0, 0.27, edge), 1.6);            // brightest hugging the planet, fading outward
  float lit = smoothstep(-0.35, 0.4, dot(-n, uSunDir) * -1.0);
  gl_FragColor = vec4(uColor * uSunColor * uLight * glow * lit * uStrength * 1.6, 1.0);
}
`;

// ---------------------------------------------------------------------------
// The Sun
// ---------------------------------------------------------------------------
export const sunFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vView;
uniform vec3 uColor;       // black-body colour
uniform float uBright, uCell, uTime, uSpots, uContrast;
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObj);
  float mu = max(dot(normalize(vWorldN), vView), 0.0);
  // Convection cells: fine granulation on a dwarf, a few giant cells on a red giant.
  vec3 q = p * uCell + vec3(0.0, uTime * 0.04, 0.0);
  float g = fbm(q) * 0.6 + fbm(q * 3.1 + uTime * 0.05) * 0.4;
  float cells = mix(1.0, 0.55 + 0.9 * g, uContrast);
  // Magnetic spots along the active latitudes.
  float lat = abs(asin(clamp(p.y, -1.0, 1.0)));
  float spot = smoothstep(0.70, 0.78, fbm(p * 7.0 + vec3(uTime * 0.01, 3.0, 0.0))) * smoothstep(0.05, 0.2, lat) * (1.0 - smoothstep(0.45, 0.65, lat)) * uSpots;
  // Limb darkening, redder toward the edge.
  float limb = 0.35 + 0.65 * pow(mu, 0.55);
  vec3 col = uColor * mix(vec3(1.0, 0.86, 0.72), vec3(1.0), pow(mu, 0.6));
  col *= limb * cells * (1.0 - 0.75 * spot) * uBright;
  gl_FragColor = vec4(col, 1.0);
}
`;

// Soft additive halo on a camera-facing quad (corona, glare, wells, flashes).
export const glowVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
uniform float uSize;       // world-space radius
uniform float uMinPixels;  // never smaller than this on screen
uniform vec2 uViewport;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float pixelWorld = -mv.z * 2.0 / (projectionMatrix[1][1] * uViewport.y); // world units per pixel at this depth
  float size = max(uSize, uMinPixels * pixelWorld);
  mv.xy += vUv * size;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;
export const glowFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uStrength, uFalloff, uCore;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = pow(1.0 - r, uFalloff);
  a += uCore * exp(-r * r * 90.0);
  gl_FragColor = vec4(uColor * a * uStrength, 1.0);
}
`;

// Expanding shell of ejected gas (planetary nebula).
export const shellFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vView;
uniform vec3 uColorIn, uColorOut;
uniform float uStrength, uSeed;
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  float mu = abs(dot(normalize(vWorldN), vView));
  // A thin shell looks brightest at its edge, where the sightline is longest.
  float path = 1.0 / max(mu, 0.12) - 1.0;
  float wisps = 0.45 + 0.9 * fbm(normalize(vObj) * 4.0 + uSeed);
  vec3 col = mix(uColorIn, uColorOut, smoothstep(0.2, 0.9, 1.0 - mu));
  gl_FragColor = vec4(col * path * wisps * uStrength * 0.16, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Discs and belts: one point per particle on its own Kepler orbit
// ---------------------------------------------------------------------------
export const beltVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aOrbit;   // a, e, inclination, node
attribute vec3 aPhase;   // mean anomaly at spin 0, argument of periapsis, population
attribute float aSeed;
uniform float uSpin;     // accumulated (capped) orbital phase for a = 1
uniform float uExpand;   // orbits widen as the Sun loses mass
uniform float uSunR;
uniform float uPopAlpha[5];
uniform vec2 uZones[10]; // cleared lanes: [inner, outer] in AU
uniform vec3 uOrigin;    // heliocentre in scene space
uniform float uPixel;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = aOrbit.x * uExpand, e = aOrbit.y;
  float M = aPhase.x + uSpin * pow(aOrbit.x, -1.5);
  float E = M + e * sin(M + e * sin(M));
  float xp = a * (cos(E) - e), yp = a * sqrt(1.0 - e * e) * sin(E);
  float cw = cos(aPhase.y), sw = sin(aPhase.y), cO = cos(aOrbit.w), sO = sin(aOrbit.w), ci = cos(aOrbit.z), si = sin(aOrbit.z);
  vec3 P = vec3(cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si);
  vec3 Q = vec3(-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si);
  vec3 ecl = P * xp + Q * yp;
  vec3 pos = vec3(ecl.x, ecl.z, -ecl.y) * uScale + uOrigin;
  int pop = int(aPhase.z + 0.5);
  float alpha = uPopAlpha[pop];
  // Sparse populations thin out by dropping particles, not by dimming them all.
  alpha = alpha >= 1.0 ? 1.0 : step(aSeed, alpha) * min(1.0, 0.35 + alpha);
  for (int k = 0; k < 10; k++) {
    alpha *= 1.0 - step(uZones[k].x, a) * step(a, uZones[k].y);
  }
  alpha *= step(uSunR, a * (1.0 - e));
  // A belt that is only a few pixels across would pile up into a white blob.
  alpha *= clamp(aOrbit.x * uScale * 4.0, 0.05, 1.0);
  vAlpha = alpha;
  vColor = pop == 0 ? mix(vec3(1.0, 0.62, 0.30), vec3(0.55, 0.60, 0.80), smoothstep(1.0, 20.0, aOrbit.x))
         : pop == 2 ? vec3(0.50, 0.45, 0.39)
         : pop == 1 ? vec3(0.80, 0.62, 0.45)
         : vec3(0.62, 0.72, 0.86);
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPixel * (pop == 0 ? 1.0 : 1.1) * (0.6 + 0.8 * aSeed);
  if (pop == 2 || pop == 4) vAlpha *= 0.55;
  if (pop == 0) vAlpha *= 0.45;
  if (alpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
}
`;
export const beltFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vAlpha;
varying vec3 vColor;
uniform float uGain;
void main() {
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(d));
  gl_FragColor = vec4(vColor * a * vAlpha * uGain, 1.0);
}
`;

// Glowing gas of the protoplanetary disc (flat annulus, additive).
export const discVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPos;
varying vec3 vWorld;
void main() {
  vPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;
export const discFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vPos;
varying vec3 vWorld;
uniform float uAlpha, uInner, uSpin;
uniform vec2 uGaps[4];   // [radius, half-width]
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vPos.xy);
  float ang = atan(vPos.y, vPos.x);
  float dens = smoothstep(uInner, uInner * 2.5, r) * exp(-r / 14.0) * (1.0 - smoothstep(38.0, 48.0, r));
  // Faint spiral structure sheared by Keplerian rotation.
  float sp = fbm(vec3(cos(ang - uSpin * pow(max(r, 0.2), -1.5) * 0.15) * r * 0.5, sin(ang - uSpin * pow(max(r, 0.2), -1.5) * 0.15) * r * 0.5, r * 0.6));
  dens *= 0.55 + 0.9 * sp;
  for (int k = 0; k < 4; k++) {
    dens *= 1.0 - 0.92 * (1.0 - smoothstep(uGaps[k].y * 0.6, uGaps[k].y * 1.6, abs(r - uGaps[k].x))) * step(0.001, uGaps[k].y);
  }
  vec3 hot = vec3(1.0, 0.55, 0.22), cold = vec3(0.45, 0.32, 0.30);
  vec3 col = mix(hot, cold, smoothstep(0.5, 12.0, r)) * (0.5 + 2.5 * exp(-r / 1.5));
  // Seen edge-on the disc is a thicker column of dust.
  vec3 view = normalize(cameraPosition - vWorld);
  float slant = 1.0 / max(abs(view.y), 0.18);
  gl_FragColor = vec4(col * dens * uAlpha * 0.42 * slant, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------
export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;
export const skyFragment = /* glsl */ `
varying vec3 vDir;
uniform vec3 uGalNorth, uGalCentre;
uniform float uDim;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float b = asin(clamp(dot(d, uGalNorth), -1.0, 1.0));       // galactic latitude
  vec3 inPlane = normalize(d - uGalNorth * dot(d, uGalNorth));
  float toCentre = dot(inPlane, uGalCentre) * 0.5 + 0.5;
  float width = 0.10 + 0.10 * toCentre;
  float band = exp(-b * b / (width * width));
  float cloud = fbm(d * 6.0) * 0.65 + fbm(d * 19.0) * 0.35;
  float dust = smoothstep(0.38, 0.62, fbm(d * 9.0 + 5.0)) * exp(-b * b / 0.004);
  vec3 col = mix(vec3(0.55, 0.62, 0.85), vec3(1.0, 0.86, 0.68), toCentre) * band * (0.35 + 0.9 * cloud) * (0.25 + 0.75 * toCentre);
  col *= 1.0 - 0.75 * dust;
  gl_FragColor = vec4(col * 0.05 * uDim, 1.0);
}
`;
export const starVertex = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
varying vec3 vColor;
uniform float uPixel, uDim;
void main() {
  vColor = aColor * aMag * uDim;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
  gl_PointSize = uPixel * (1.0 + 1.6 * aMag);
}
`;
export const starFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(d));
  gl_FragColor = vec4(vColor * a * a, 1.0);
}
`;

// Orbit lines: per-vertex alpha fading along the trail.
export const lineVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aFade;
varying float vFade;
void main() {
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
export const lineFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vFade;
uniform vec3 uColor;
uniform float uOpacity, uDash;
void main() {
  #include <logdepthbuf_fragment>
  if (uDash > 0.0 && fract(vFade * uDash) > 0.5) discard;
  gl_FragColor = vec4(uColor, uOpacity * (uDash > 0.0 ? 1.0 : vFade));
}
`;
