// Draws the solar system at true scale with three.js.
//
// The scene is rebuilt around the camera's target every frame ("floating
// origin") and rescaled so the camera always sits one unit from that target.
// That keeps single-precision GPU maths accurate whether we are a planet's
// width from Earth or a light-year out watching the nebula expand.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as SH from './shaders.js';
import { Paleo } from './paleo.js';
import { BODIES, BODY, T_DISC_GONE, T_INSTABILITY } from '../sim/bodies.js';
import { G, TAU, DEG, T_START, RSUN_AU } from '../sim/constants.js';
import { blackbodyRGB, sunMass, SUN_T } from '../sim/sun.js';
import { elementsToState, stateToElements, orbitPoints } from '../sim/kepler.js';
import { bodyLook } from '../sim/surface.js';

const ORBIT_N = 360;
const FOV = 38; // vertical field of view on a landscape screen, degrees
const MAX_ANGLE_PER_FRAME = 0.11; // rad: cap on displayed orbital motion at high time rates
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const C = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

// Ecliptic (x, y, z-north) → scene (x, y-up, z).
const toScene = (x, y, z, out) => out.set(x, z, -y);

const ROCKY = {
  mercury: { a: C(0.42, 0.40, 0.38), b: C(0.29, 0.27, 0.26), dark: C(0.2, 0.19, 0.18), craters: 1, maria: 0.35, seed: 1.7 },
  venus: { a: C(0.55, 0.38, 0.22), b: C(0.40, 0.28, 0.18), dark: C(0.25, 0.17, 0.1), craters: 0.15, maria: 0.4, seed: 4.1, atmo: C(0.95, 0.85, 0.6), cloud: C(0.92, 0.84, 0.62) },
  mars: { a: C(0.44, 0.36, 0.30), b: C(0.34, 0.28, 0.24), dark: C(0.15, 0.12, 0.11), craters: 0.45, maria: 0.85, seed: 9.3, atmo: C(0.95, 0.62, 0.45) },
  moon: { a: C(0.50, 0.49, 0.47), b: C(0.37, 0.36, 0.35), dark: C(0.12, 0.12, 0.13), craters: 1, maria: 1, seed: 6.2 },
  theia: { a: C(0.40, 0.31, 0.26), b: C(0.28, 0.22, 0.2), dark: C(0.15, 0.12, 0.1), craters: 0.3, maria: 0.5, seed: 12.9 },
  pluto: { a: C(0.66, 0.56, 0.46), b: C(0.46, 0.36, 0.29), dark: C(0.2, 0.13, 0.1), craters: 0.4, maria: 0.75, seed: 15.4 },
};
const GIANT = {
  jupiter: { A: C(0.80, 0.70, 0.56), B: C(0.52, 0.36, 0.25), Cc: C(0.86, 0.81, 0.72), pole: C(0.42, 0.37, 0.35), bands: 15, turb: 1.0, spot: 1, seed: 2.2 },
  saturn: { A: C(0.82, 0.73, 0.52), B: C(0.69, 0.59, 0.41), Cc: C(0.88, 0.82, 0.65), pole: C(0.55, 0.52, 0.42), bands: 19, turb: 0.35, spot: 0, seed: 5.5 },
  uranus: { A: C(0.56, 0.80, 0.85), B: C(0.52, 0.77, 0.83), Cc: C(0.64, 0.85, 0.88), pole: C(0.60, 0.83, 0.86), bands: 6, turb: 0.12, spot: 0, seed: 7.7 },
  neptune: { A: C(0.17, 0.32, 0.80), B: C(0.13, 0.25, 0.68), Cc: C(0.32, 0.48, 0.92), pole: C(0.15, 0.27, 0.70), bands: 8, turb: 0.45, spot: 0, seed: 11.1 },
};
// Direction (ecliptic longitude, degrees) toward which each north pole leans.
const TILT_AZIMUTH = { earth: 90, mars: 352, jupiter: 268, saturn: 80, uranus: 258, neptune: 319, venus: 30, mercury: 0, moon: 200, pluto: 133, theia: 40 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = (this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Phones and tablets: lighter anti-aliasing, and the resolution steps down
    // by itself if the frame rate cannot be held (see _adapt).
    this.adaptive = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x000000, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1e-4, 1e12);
    this.shift = new THREE.Vector2(); // where the scene centre sits, CSS px from the canvas centre
    this.shiftTarget = new THREE.Vector2();

    // Camera rig: orbiting the focus at `dist` AU.
    this.focusId = 'sun';
    this.prevFocus = null; // {pos: Vector3 (heliocentric), id}
    this.focusBlend = 1;
    this.dist = 95;
    this.distTarget = 95;
    this.azimuth = -0.6;
    this.elevation = 0.62;
    this.origin = new THREE.Vector3(); // heliocentric position of the camera target (AU, doubles)
    this.scale = 1;
    this.viewport = new THREE.Vector2(1, 1);
    this.realTime = 0;
    this.spinPhase = 0;

    this.paleo = new Paleo();
    this.paleo.loaded = this.paleo.load('data/paleo.bin').catch((e) => console.error('paleo data failed to load', e));

    this.disp = {}; // per-body display state
    this.screen = []; // per-body screen positions for labels
    this.flashes = [];

    this._buildSky();
    this._buildSun();
    this._buildBodies();
    this._buildBelts();
    this._buildExtras();

    renderer.setSize(Math.max(2, canvas.clientWidth || window.innerWidth), Math.max(2, canvas.clientHeight || window.innerHeight), false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.adaptive ? 2 : 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.9, 0.55, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  // --- construction --------------------------------------------------------

  _mat(vertexShader, fragmentShader, uniforms, extra = {}) {
    return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, ...extra });
  }
  _additive(vertexShader, fragmentShader, uniforms, extra = {}) {
    return this._mat(vertexShader, fragmentShader, uniforms, { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, ...extra });
  }
  _lightUniforms() {
    return { uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) }, uLight: { value: 1 }, uSunAngle: { value: 0.005 } };
  }
  _glow(color, falloff, core) {
    const mat = this._additive(SH.glowVertex, SH.glowFragment, {
      uSize: { value: 1 }, uMinPixels: { value: 0 }, uViewport: { value: this.viewport }, uColor: { value: color.clone() },
      uStrength: { value: 1 }, uFalloff: { value: falloff }, uCore: { value: core },
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    m.frustumCulled = false;
    return m;
  }

  _buildSky() {
    const galNorth = toScene(-0.8677, -0.1981, 0.4559, new THREE.Vector3()).normalize(); // galactic pole in ecliptic coords
    const galCentre = toScene(-0.0546, -0.9938, -0.0966, new THREE.Vector3()).normalize();
    this.skyMat = this._mat(SH.skyVertex, SH.skyFragment, { uGalNorth: { value: galNorth }, uGalCentre: { value: galCentre }, uDim: { value: 1 } }, { depthWrite: false, side: THREE.BackSide });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.skyMat);
    sky.frustumCulled = false; sky.renderOrder = -1000;
    this.scene.add(sky);

    const N = 9000;
    const pos = new Float32Array(N * 3), mag = new Float32Array(N), col = new Float32Array(N * 3);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const rgb = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      // Concentrate a share of the stars toward the galactic plane.
      let v;
      for (;;) {
        const u = rnd() * 2 - 1, ph = rnd() * TAU, s = Math.sqrt(1 - u * u);
        v = new THREE.Vector3(s * Math.cos(ph), u, s * Math.sin(ph));
        const b = Math.asin(v.dot(galNorth));
        if (rnd() < 0.35 + 0.65 * Math.exp(-(b * b) / 0.08)) break;
      }
      pos.set([v.x, v.y, v.z], i * 3);
      mag[i] = Math.min(1, 0.06 + Math.pow(rnd(), 9) * 1.4 + Math.pow(rnd(), 3) * 0.12);
      blackbodyRGB(3000 + Math.pow(rnd(), 2.2) * 22000, rgb);
      const m = Math.max(rgb[0], rgb[1], rgb[2]);
      col.set([rgb[0] / m, rgb[1] / m, rgb[2] / m], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.starMat = this._additive(SH.starVertex, SH.starFragment, { uPixel: { value: 2 }, uDim: { value: 1 } });
    const stars = new THREE.Points(g, this.starMat);
    stars.frustumCulled = false; stars.renderOrder = -999;
    this.scene.add(stars);
    this.skyObjects = [sky, stars];
  }

  _buildSun() {
    this.sunMat = this._mat(SH.planetVertex, SH.sunFragment, {
      uColor: { value: new THREE.Color(1, 1, 1) }, uBright: { value: 4 }, uCell: { value: 60 }, uTime: { value: 0 }, uSpots: { value: 1 }, uContrast: { value: 0.3 },
    });
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.sunMat);
    this.scene.add(this.sun);
    this.corona = this._glow(new THREE.Color(1, 1, 1), 3.2, 0);
    this.glare = this._glow(new THREE.Color(1, 1, 1), 2.4, 1.0);
    this.scene.add(this.corona, this.glare);
    // Planetary nebula shells.
    this.shells = [0, 1, 2].map((k) => {
      const mat = this._additive(SH.planetVertex, SH.shellFragment, {
        uColorIn: { value: C(0.15, 0.95, 0.75) }, uColorOut: { value: C(1.0, 0.22, 0.18) }, uStrength: { value: 0 }, uSeed: { value: k * 7.3 },
      }, { side: THREE.DoubleSide });
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), mat);
      m.visible = false;
      this.scene.add(m);
      return m;
    });
  }

  _buildBodies() {
    const sphere = new THREE.SphereGeometry(1, 128, 80);
    this.bodies = {};
    for (const def of BODIES) {
      let mat;
      const light = this._lightUniforms();
      if (def.id === 'earth') {
        mat = this._mat(SH.planetVertex, SH.earthFragment, {
          ...light, uLand: { value: null }, uMix: { value: 0 }, uOcean: { value: 1 }, uIceLat: { value: 66 }, uVeg: { value: 1 }, uRust: { value: 1 },
          uHaze: { value: 0 }, uCloud: { value: 0.5 }, uVenusian: { value: 0 }, uAtmo: { value: 1 }, uSeaGreen: { value: 0 }, uMolten: { value: 0 }, uLights: { value: 0 }, uTime: { value: 0 },
        });
      } else if (GIANT[def.id]) {
        const g = GIANT[def.id];
        mat = this._mat(SH.planetVertex, SH.giantFragment, {
          ...light, uBandA: { value: g.A }, uBandB: { value: g.B }, uBandC: { value: g.Cc }, uPole: { value: g.pole }, uBands: { value: g.bands }, uTurb: { value: g.turb },
          uSpot: { value: g.spot }, uYoung: { value: 0 }, uHot: { value: 0 }, uTime: { value: 0 }, uRings: { value: 0 }, uSeed: { value: g.seed }, uSunObj: { value: new THREE.Vector3(1, 0, 0) },
        });
      } else {
        const r = ROCKY[def.id];
        mat = this._mat(SH.planetVertex, SH.rockyFragment, {
          ...light, uColA: { value: r.a }, uColB: { value: r.b }, uColDark: { value: r.dark }, uAtmoColor: { value: r.atmo ?? C(0, 0, 0) }, uCloudColor: { value: r.cloud ?? C(1, 1, 1) },
          uCraters: { value: r.craters }, uMaria: { value: r.maria }, uRust: { value: 0 }, uWater: { value: 0 }, uIceCap: { value: 0 }, uCloudDeck: { value: 0 }, uAtmo: { value: 0 },
          uMolten: { value: 0 }, uTime: { value: 0 }, uSeed: { value: r.seed }, uDetail: { value: 1 },
        });
      }
      const mesh = new THREE.Mesh(sphere, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      const entry = { def, mesh, mat };

      // Atmosphere halo.
      if (['earth', 'venus', 'mars'].includes(def.id) || GIANT[def.id]) {
        const col = def.id === 'earth' ? C(0.3, 0.55, 1.0) : def.id === 'venus' ? C(0.95, 0.85, 0.6) : def.id === 'mars' ? C(0.95, 0.6, 0.42) : GIANT[def.id].Cc;
        entry.atmoMat = this._additive(SH.planetVertex, SH.atmoFragment, {
          uColor: { value: col.clone() }, uSunDir: light.uSunDir, uSunColor: light.uSunColor, uLight: light.uLight, uStrength: { value: 1 },
        }, { side: THREE.BackSide });
        entry.atmo = new THREE.Mesh(sphere, entry.atmoMat);
        entry.atmo.scale.setScalar(def.id === 'mars' ? 1.02 : 1.035);
        mesh.add(entry.atmo);
      }
      if (def.id === 'saturn') {
        const ring = new THREE.RingGeometry(1.2, 2.32, 180, 1);
        ring.rotateX(-Math.PI / 2);
        entry.ringMat = this._mat(SH.ringVertex, SH.ringFragment, { uSunObj: mat.uniforms.uSunObj, uSunColor: light.uSunColor, uLight: light.uLight, uRings: { value: 1 } }, { transparent: true, side: THREE.DoubleSide, depthWrite: false });
        entry.ring = new THREE.Mesh(ring, entry.ringMat);
        mesh.add(entry.ring);
      }
      if (def.id === 'earth') {
        // Debris thrown into orbit by the giant impact.
        const N = 1400, p = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
          const r = 1.3 + Math.pow(Math.random(), 1.5) * 3.2, a = Math.random() * TAU;
          p.set([r * Math.cos(a), (Math.random() - 0.5) * 0.25 * r * 0.3, r * Math.sin(a)], i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p, 3));
        entry.debris = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff7a33, size: 2.2, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        entry.debris.visible = false;
        mesh.add(entry.debris);
      }

      // Orbit line.
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_N * 3), 3));
      og.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(ORBIT_N), 1));
      entry.orbitMat = this._mat(SH.lineVertex, SH.lineFragment, { uColor: { value: new THREE.Color(def.color) }, uOpacity: { value: 0.6 }, uDash: { value: 0 } }, { transparent: true, depthWrite: false });
      entry.orbit = new THREE.Line(og, entry.orbitMat);
      entry.orbit.frustumCulled = false;
      entry.orbit.visible = false;
      this.scene.add(entry.orbit);

      this.bodies[def.id] = entry;
      this.disp[def.id] = { M: 0, locked: false, spin: Math.random() * TAU, pos: new THREE.Vector3(), rel: new Float64Array(6), el: {}, exists: false, blur: 0 };
    }
    this.disp.sun = { pos: new THREE.Vector3(), exists: true };
  }

  _buildBelts() {
    // population: 0 gas-disc dust, 1 inner planetesimals, 2 asteroid belt, 3 primordial outer disc, 4 Kuiper belt
    const specs = [
      { pop: 0, n: 26000, a: [0.25, 42], pow: 0.55, e: 0.02, inc: 0.035 },
      { pop: 1, n: 5000, a: [0.35, 1.9], pow: 1.0, e: 0.12, inc: 0.07 },
      { pop: 2, n: 7000, a: [2.08, 3.35], pow: 1.0, e: 0.14, inc: 0.17 },
      { pop: 3, n: 9000, a: [17, 34], pow: 1.0, e: 0.05, inc: 0.05 },
      { pop: 4, n: 8000, a: [35, 49], pow: 1.0, e: 0.12, inc: 0.17 },
    ];
    const total = specs.reduce((s, x) => s + x.n, 0);
    const orbit = new Float32Array(total * 4), phase = new Float32Array(total * 3), seedArr = new Float32Array(total), pos = new Float32Array(total * 3);
    let k = 0;
    for (const s of specs) {
      for (let i = 0; i < s.n; i++, k++) {
        const a = s.a[0] + (s.a[1] - s.a[0]) * Math.pow(Math.random(), s.pow);
        // Rayleigh-distributed eccentricities and inclinations.
        const e = Math.min(0.6, s.e * Math.sqrt(-2 * Math.log(1 - Math.random() * 0.999)) * 0.8);
        const inc = s.inc * Math.sqrt(-2 * Math.log(1 - Math.random() * 0.999)) * 0.8;
        orbit.set([a, e, inc, Math.random() * TAU], k * 4);
        phase.set([Math.random() * TAU, Math.random() * TAU, s.pop], k * 3);
        seedArr[k] = Math.random();
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seedArr, 1));
    this.beltMat = this._additive(SH.beltVertex, SH.beltFragment, {
      uSpin: { value: 0 }, uExpand: { value: 1 }, uSunR: { value: 0 }, uPopAlpha: { value: [0, 0, 0, 0, 0] },
      uZones: { value: Array.from({ length: 10 }, () => new THREE.Vector2(0, 0)) }, uOrigin: { value: new THREE.Vector3() }, uPixel: { value: 2 }, uGain: { value: 0.5 }, uScale: { value: 1 },
    });
    this.belts = new THREE.Points(g, this.beltMat);
    this.belts.frustumCulled = false;
    this.scene.add(this.belts);

    const disc = new THREE.RingGeometry(0.05, 50, 200, 40);
    this.discMat = this._additive(SH.discVertex, SH.discFragment, {
      uAlpha: { value: 0 }, uInner: { value: 0.1 }, uSpin: { value: 0 }, uGaps: { value: Array.from({ length: 4 }, () => new THREE.Vector2(0, 0)) },
    }, { side: THREE.DoubleSide });
    this.disc = new THREE.Mesh(disc, this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.frustumCulled = false;
    this.scene.add(this.disc);
  }

  _buildExtras() {
    // Gravity wells.
    this.wellObjs = Array.from({ length: 4 }, () => {
      const glow = this._glow(C(0.45, 0.35, 1.0), 2.2, 0.6);
      const ringGeo = new THREE.BufferGeometry();
      const pts = new Float32Array(97 * 3);
      for (let i = 0; i <= 96; i++) pts.set([Math.cos((i / 96) * TAU), 0, Math.sin((i / 96) * TAU)], i * 3);
      ringGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const rings = [0, 1, 2].map(() => new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0x9a86ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending })));
      const group = new THREE.Group();
      group.add(glow, ...rings);
      group.visible = false;
      this.scene.add(group);
      return { group, glow, rings };
    });
    // Preview of an intervention being aimed.
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_N * 3), 3));
    pg.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(ORBIT_N), 1));
    this.previewOrbit = new THREE.Line(pg, this._mat(SH.lineVertex, SH.lineFragment, { uColor: { value: C(1.0, 0.72, 0.25) }, uOpacity: { value: 0.95 }, uDash: { value: 60 } }, { transparent: true, depthWrite: false }));
    this.previewOrbit.frustumCulled = false; this.previewOrbit.visible = false;
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.arrow = new THREE.Line(ag, new THREE.LineBasicMaterial({ color: 0xffc04d, transparent: true, depthTest: false }));
    this.arrow.frustumCulled = false; this.arrow.visible = false;
    this.arrowTip = this._glow(C(1.0, 0.7, 0.25), 2.0, 1.0);
    this.arrowTip.visible = false;
    this.arrowTip.material.depthTest = false;
    this.scene.add(this.previewOrbit, this.arrow, this.arrowTip);
    this.preview = null;
    // Impact flashes.
    this.flashObjs = Array.from({ length: 3 }, () => { const g = this._glow(C(1.0, 0.85, 0.6), 2.0, 1.0); g.visible = false; g.material.depthTest = false; this.scene.add(g); return g; });
  }

  /** Compiles every shader up front so nothing pops in late. */
  async warmUp() {
    const hidden = [];
    this.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try { await this.gl.compileAsync(this.scene, this.camera); } catch (e) { console.warn('shader warm-up failed', e); }
    for (const o of hidden) o.visible = false;
  }

  // --- camera --------------------------------------------------------------

  resize() {
    const w = Math.max(2, this.canvas.clientWidth || window.innerWidth), h = Math.max(2, this.canvas.clientHeight || window.innerHeight);
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // On an upright phone the fixed vertical angle would leave a sliver of
    // width, so open the lens up until the view is as wide as a 4:5 window's.
    const widen = Math.min(1.9, Math.max(1, 0.8 / this.camera.aspect));
    this.camera.fov = (2 * Math.atan(Math.tan((FOV * DEG) / 2) * widen)) / DEG;
    const px = this.gl.getPixelRatio();
    this.viewport.set(w * px, h * px);
    this.cssSize = { w, h };
    this.pixelRatio = px;
    this._applyView(0);
  }

  radiusOf(id) {
    if (id === 'sun') return this.lastState ? this.lastState.sun.radiusAU : RSUN_AU;
    const b = this.lastState?.bodies.find((x) => x.id === id);
    return b?.exists ? b.radius : BODY[id].radius;
  }

  /** Moves the camera target to a body. dist (AU) optional. */
  focus(id, dist) {
    if (id !== this.focusId) {
      this.prevFocus = { pos: this.origin.clone() };
      this.focusBlend = 0;
      // The camera's bearing is kept relative to the Sun's direction from the
      // body it follows, so the lighting holds still while the body orbits.
      this.azimuth += this._sunAzimuth(this.focusId) - this._sunAzimuth(id);
      this.focusId = id;
    }
    if (dist !== undefined) this.distTarget = dist;
  }
  frameBody(id) {
    this.focus(id, this.radiusOf(id) * (id === 'sun' ? 7 : 5.5));
    this.pendingApproach = id === 'sun' ? null : id;
  }
  _approach() {
    // Arrive over the sunlit side, a little off to one side so the terminator shows.
    const d = this.disp[this.pendingApproach];
    if (!d?.exists) return;
    this.pendingApproach = null;
    this.azimuth = 0.75; // relative to the direction of the Sun
    this.elevation = 0.22;
  }
  /** Azimuth (scene frame) of the direction from a body toward the Sun. */
  _sunAzimuth(id) {
    const d = this.disp[id];
    if (id === 'sun' || !d?.exists) return 0;
    const lead = d.pos.lengthSq() > 1e-12 ? d.pos : null;
    return lead ? Math.atan2(lead.y, -lead.x) : 0;
  }
  /** Puts the centre of the scene (dx, dy) CSS px from the centre of the canvas, to clear panels drawn over it. */
  setViewShift(dx, dy) { this.shiftTarget.set(dx, dy); }
  _applyView(ease) {
    this.shift.lerp(this.shiftTarget, ease);
    if (this.shift.distanceTo(this.shiftTarget) < 0.25) this.shift.copy(this.shiftTarget);
    const { w, h } = this.cssSize || { w: 2, h: 2 };
    if (this.shift.lengthSq() > 0.01 && this.cssSize) this.camera.setViewOffset(w, h, -this.shift.x, -this.shift.y, w, h);
    else if (this.camera.view) this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }
  setPixelRatio(pr) {
    this.gl.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.resize();
  }
  // Drops the rendering resolution a step when two measured stretches in a row
  // average under 40 frames a second. It never climbs back, so it cannot hunt.
  _adapt(frameDt) {
    if (!this.adaptive || this.realTime < 12 || this.pixelRatio <= 1) return;
    const p = this._perf || (this._perf = { n: 0, sum: 0, slow: 0, skip: 0 });
    if (p.skip > 0) { p.skip--; return; }
    p.n++; p.sum += frameDt;
    if (p.n < 90) return;
    p.slow = p.sum / p.n > 1 / 40 ? p.slow + 1 : 0;
    p.n = 0; p.sum = 0;
    if (p.slow >= 2) { p.slow = 0; p.skip = 45; this.setPixelRatio(Math.max(1, this.pixelRatio * 0.8)); }
  }
  frameSystem() {
    let far = 4;
    if (this.lastState) for (const b of this.lastState.bodies) if (b.exists && b.el.bound && b.parent === 'sun' && b.def.kind !== 'dwarf') far = Math.max(far, b.el.Q);
    // Far enough back that the outermost orbit fits across a narrow screen too.
    const tanH = Math.tan((this.camera.fov * DEG) / 2) * this.camera.aspect;
    this.focus('sun', Math.min(far, 400) * Math.max(3.1, 1.12 / tanH));
  }
  rotate(dx, dy) {
    this.azimuth -= dx * 0.006;
    this.elevation = Math.max(-1.55, Math.min(1.55, this.elevation + dy * 0.006));
  }
  zoom(factor) {
    this.distTarget = Math.max(this.radiusOf(this.focusId) * 1.25, Math.min(1.5e6, this.distTarget * factor));
  }

  // --- per-frame update ----------------------------------------------------

  /**
   * @param state    world state at the current time
   * @param simDt    simulated years advanced since the previous frame (signed)
   * @param frameDt  wall-clock seconds since the previous frame
   * @param world    for surface status lookups
   */
  update(state, simDt, frameDt, world) {
    this.lastState = state;
    this.realTime += frameDt;
    this._adapt(frameDt);
    const t = state.t;
    const sun = state.sun;
    const byId = {};
    for (const b of state.bodies) byId[b.id] = b;

    // 1. Displayed orbital positions (true when slow, rate-capped when time races).
    const tmp = this._tmp6 || (this._tmp6 = new Float64Array(6));
    for (const b of state.bodies) {
      const d = this.disp[b.id];
      if (!b.exists) { d.exists = false; d.locked = false; continue; }
      const el = b.el;
      if (!d.exists) { d.M = el.M; d.locked = true; d.blur = 0; } // just appeared: start at its true place
      d.exists = true;
      if (el.bound && el.e < 0.98) {
        const dM = el.n * simDt;
        const cap = MAX_ANGLE_PER_FRAME * Math.min(1, frameDt * 60) * Math.min(1.6, Math.max(0.25, Math.pow(el.n / TAU, 0.3)));
        let diff = el.M - d.M; diff -= TAU * Math.round(diff / TAU);
        if (Math.abs(dM) <= cap * 1.5) {
          if (d.locked || Math.abs(diff) < 0.03) { d.M = el.M; d.locked = true; }
          else d.M += diff * Math.min(1, frameDt * 7);
          d.blur += (0 - d.blur) * Math.min(1, frameDt * 5);
        } else {
          d.locked = false;
          d.M += Math.sign(dM) * cap;
          d.blur += (Math.min(1, Math.abs(dM) / 2.5) - d.blur) * Math.min(1, frameDt * 5);
        }
        d.el.a = el.a; d.el.e = el.e; d.el.i = el.i; d.el.Om = el.Om; d.el.w = el.w; d.el.M = d.M; d.el.bound = true;
        elementsToState(d.el, b.mu, d.rel, 0);
        stateToElements(d.rel, 0, b.mu, d.el);
      } else {
        d.locked = false; d.blur = 0;
        d.rel.set(b.rel);
        Object.assign(d.el, el);
      }
    }
    const resolvePos = (id, depth = 0) => {
      const b = byId[id], d = this.disp[id];
      if (!b.exists) return;
      const p = b.parent !== 'sun' && byId[b.parent]?.exists && depth < 4 ? resolvePos(b.parent, depth + 1) || this.disp[b.parent].pos : null;
      d.pos.set(d.rel[0] + (p ? p.x : 0), d.rel[1] + (p ? p.y : 0), d.rel[2] + (p ? p.z : 0));
      return d.pos;
    };
    for (const b of state.bodies) resolvePos(b.id);

    // 2. Camera target.
    if (this.pendingApproach) this._approach();
    const fd = this.disp[this.focusId];
    if (this.focusId !== 'sun' && !fd.exists) { this.prevFocus = { pos: this.origin.clone() }; this.focusBlend = 0; this.azimuth += this._lastSunAz || 0; this.focusId = 'sun'; }
    const target = this.focusId === 'sun' ? new THREE.Vector3(0, 0, 0) : this.disp[this.focusId].pos;
    if (this.focusBlend < 1) {
      this.focusBlend = Math.min(1, this.focusBlend + frameDt / 1.1);
      const s = this.focusBlend * this.focusBlend * (3 - 2 * this.focusBlend);
      this.origin.lerpVectors(this.prevFocus.pos, target, s);
    } else this.origin.copy(target);
    const minDist = this.radiusOf(this.focusId) * 1.25;
    if (this.distTarget < minDist) this.distTarget = minDist;
    this.dist *= Math.pow(this.distTarget / this.dist, Math.min(1, frameDt * 6));
    if (this.dist < minDist) this.dist = minDist;
    const S = (this.scale = 1 / this.dist);
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const az = this.azimuth + (this._lastSunAz = this._sunAzimuth(this.focusId));
    this.camera.position.set(ce * Math.cos(az), se, ce * Math.sin(az));
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.min(0.2, Math.max(1e-5, (1 - this.radiusOf(this.focusId) * S) * 0.2));
    this.camera.far = 1e12;
    this._applyView(Math.min(1, frameDt * 9));
    this.camera.updateMatrixWorld();
    for (const o of this.skyObjects) o.position.copy(this.camera.position);

    const scenePos = (helio, out) => toScene((helio.x - this.origin.x) * S, (helio.y - this.origin.y) * S, (helio.z - this.origin.z) * S, out);
    const sunScene = scenePos(new THREE.Vector3(0, 0, 0), this._sunScene || (this._sunScene = new THREE.Vector3()));
    const camHelioDist = (scn) => scn.distanceTo(this.camera.position) / S; // AU from camera

    // 3. The Sun.
    const rgb = blackbodyRGB(sun.T, this._rgb || (this._rgb = [0, 0, 0]));
    const mx = Math.max(rgb[0], rgb[1], rgb[2]);
    const sunCol = this._sunCol || (this._sunCol = new THREE.Color());
    sunCol.setRGB(rgb[0] / mx, rgb[1] / mx, rgb[2] / mx, THREE.LinearSRGBColorSpace);
    this.sun.position.copy(sunScene);
    this.sun.scale.setScalar(sun.radiusAU * S);
    this.sun.rotation.y = this.realTime * 0.01;
    const giant = smooth(3, 60, sun.R);
    const su = this.sunMat.uniforms;
    su.uColor.value.copy(sunCol);
    su.uTime.value = this.realTime;
    su.uCell.value = 70 - 62 * giant; // a red giant has only a handful of huge convection cells
    su.uContrast.value = 0.4 + 0.35 * giant;
    su.uSpots.value = sun.phase === 'white-dwarf' || sun.phase === 'planetary-nebula' ? 0 : 1 - giant;
    su.uBright.value = sun.R < 0.1 ? 6 : 1.05;
    const dSun = camHelioDist(sunScene);
    const appBright = sun.L / (dSun * dSun);
    this.corona.position.copy(sunScene);
    this.corona.material.uniforms.uColor.value.copy(sunCol);
    this.corona.material.uniforms.uSize.value = sun.radiusAU * S * (3.4 - 1.2 * giant);
    this.corona.material.uniforms.uStrength.value = 0.3 - 0.12 * giant;
    this.glare.position.copy(sunScene);
    this.glare.material.uniforms.uColor.value.copy(sunCol);
    this.glare.material.uniforms.uSize.value = sun.radiusAU * S * 1.6;
    this.glare.material.uniforms.uMinPixels.value = Math.max(3, Math.min(46, 3 + 2.4 * Math.log10(1 + 4000 * appBright))) * this.pixelRatio;
    // Stars fade when the Sun fills the view; the point-like glare gives way to the disc.
    const sunPx = (sun.radiusAU * S) / Math.max(1e-9, sunScene.distanceTo(this.camera.position)) * this.viewport.y;
    this.glare.material.uniforms.uStrength.value = 1.3 * (1 - smooth(0.004, 0.05, sunPx / this.viewport.y));
    const dim = 1 - 0.75 * smooth(0.05, 0.6, sunPx / this.viewport.y);
    this.skyMat.uniforms.uDim.value = dim;
    this.starMat.uniforms.uDim.value = dim;
    this.starMat.uniforms.uPixel.value = 1.7 * this.pixelRatio;

    // Planetary nebula: shells ejected around the AGB tip, lit once the core is hot.
    const age = t - SUN_T.agbTip;
    const ion = smooth(1.5e4, 5e4, sun.T) * smooth(8, 200, sun.L);
    const shellDefs = [{ t0: -6e4, v: 1.6, k: 0.5 }, { t0: -4e3, v: 3.2, k: 0.9 }, { t0: 1500, v: 4.6, k: 1.0 }];
    this.shells.forEach((m, k) => {
      const a = age - shellDefs[k].t0;
      const str = a > 0 ? ion * shellDefs[k].k * Math.exp(-Math.max(0, age) / 2.2e4) : 0;
      m.visible = str > 0.002;
      if (!m.visible) return;
      m.position.copy(sunScene);
      m.scale.setScalar(Math.max(1e-6, a * shellDefs[k].v * S));
      m.material.uniforms.uStrength.value = str;
    });

    // 4. Bodies.
    this.paleo.update(t);
    const status = world.earthStatus(t);
    const zones = [];
    this.screen.length = 0;
    const v = this._v || (this._v = new THREE.Vector3());
    const sunDir = this._sd || (this._sd = new THREE.Vector3());
    const q1 = this._q1 || (this._q1 = new THREE.Quaternion()), q2 = this._q2 || (this._q2 = new THREE.Quaternion());
    const axis = this._axis || (this._axis = new THREE.Vector3());
    const up = this._up || (this._up = new THREE.Vector3(0, 1, 0));
    this.looks = this.looks || {};
    for (const b of state.bodies) {
      const e = this.bodies[b.id], d = this.disp[b.id];
      e.mesh.visible = b.exists;
      e.orbit.visible = false;
      if (!b.exists) continue;
      const p = scenePos(d.pos, e.mesh.position);
      const R = b.radius * S;
      e.mesh.scale.setScalar(R);
      const distCam = p.distanceTo(this.camera.position);
      const px = (R / distCam) * this.viewport.y / (2 * Math.tan((this.camera.fov * DEG) / 2)) / this.pixelRatio; // apparent radius, CSS px

      // Spin (rate-capped like the orbits) and axial tilt.
      const spinRate = (TAU * simDt * 8766) / b.def.dayHours;
      d.spin += Math.abs(spinRate) > 0.25 ? Math.sign(spinRate) * 0.25 * Math.min(1, frameDt * 60) : spinRate;
      const az = (TILT_AZIMUTH[b.id] ?? 0) * DEG;
      const tilt = b.def.tilt;
      axis.set(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), -Math.sin(tilt) * Math.sin(az)).normalize();
      q1.setFromUnitVectors(up, axis);
      q2.setFromAxisAngle(up, d.spin);
      e.mesh.quaternion.copy(q1).multiply(q2);

      // Light.
      sunDir.copy(sunScene).sub(p).normalize();
      const u = e.mat.uniforms;
      u.uSunDir.value.copy(sunDir);
      u.uSunColor.value.copy(sunCol);
      const rAU = Math.max(d.pos.length(), sun.radiusAU * 1.001);
      const flux = sun.L / (rAU * rAU);
      u.uLight.value = Math.max(0.3, Math.min(3.2, 1.15 * Math.pow(flux, 0.2)));
      u.uSunAngle.value = Math.min(0.95, sun.radiusAU / rAU);
      if (u.uTime) u.uTime.value = this.realTime;

      // Surface.
      const ctx = b.id === 'earth' ? status : { impacts: world.impactsOn(b.id) };
      const look = bodyLook(b.id, t, b.S, ctx);
      this.looks[b.id] = look;
      if (b.id === 'earth') {
        u.uLand.value = this.paleo.texture; u.uMix.value = this.paleo.mix;
        u.uOcean.value = look.ocean; u.uIceLat.value = look.iceLat; u.uVeg.value = look.vegetation; u.uRust.value = look.rust;
        u.uHaze.value = look.haze; u.uCloud.value = look.cloud; u.uVenusian.value = look.venusian; u.uAtmo.value = look.atmosphere;
        u.uSeaGreen.value = look.seaGreen; u.uMolten.value = look.molten; u.uLights.value = look.lights;
        e.atmoMat.uniforms.uStrength.value = look.atmosphere * (1 - 0.6 * look.molten);
        e.atmoMat.uniforms.uColor.value.setRGB(0.3 + 0.6 * Math.max(look.haze, look.venusian), 0.55 + 0.1 * look.venusian, 1.0 - 0.6 * Math.max(look.haze, look.venusian));
        e.debris.visible = look.debris > 0.01;
        if (e.debris.visible) { e.debris.material.opacity = look.debris; e.debris.rotation.y = this.realTime * 0.2; }
      } else if (GIANT[b.id]) {
        u.uYoung.value = look.young; u.uHot.value = look.hot;
        // Sun direction in the planet's frame, for ring shadows.
        u.uSunObj.value.copy(sunDir).applyQuaternion(q1.copy(e.mesh.quaternion).invert());
        const rings = b.id === 'saturn' ? look.rings : 0;
        u.uRings.value = rings;
        if (e.ring) { e.ring.visible = rings > 0.01; e.ringMat.uniforms.uRings.value = rings; }
        e.atmoMat.uniforms.uStrength.value = 0.5;
      } else {
        u.uMolten.value = look.molten;
        u.uDetail.value = 1 - 0.8 * look.molten;
        if (b.id === 'moon') { u.uMaria.value = look.maria; u.uCraters.value = 0.25 + 0.75 * look.craters; }
        if (b.id === 'mars') {
          u.uWater.value = look.water; u.uRust.value = look.rust; u.uIceCap.value = look.iceCap; u.uAtmo.value = look.atmosphere;
          e.atmoMat.uniforms.uStrength.value = look.atmosphere * 0.7;
        }
        if (b.id === 'venus') {
          u.uWater.value = look.water; u.uCloudDeck.value = look.cloudDeck; u.uAtmo.value = 0.8 * (look.cloudDeck > 0.1 ? 1 : 0.5);
          e.atmoMat.uniforms.uStrength.value = 0.8 * look.cloudDeck;
        }
        if (b.id === 'mercury' || b.id === 'pluto') u.uCraters.value = ROCKY[b.id].craters * (0.3 + 0.7 * (look.craters ?? 1));
        if (b.id === 'pluto') u.uIceCap.value = 1 - smooth(0.02, 0.3, b.S);
      }

      // Orbit line, starting at the body and fading behind it.
      const parentPos = b.parent !== 'sun' && byId[b.parent]?.exists ? this.disp[b.parent].pos : null;
      this._drawOrbit(e.orbit, d.el, parentPos, d.blur, S);
      const focusR = this.radiusOf(this.focusId);
      let op = b.parent === 'sun' ? 0.55 : 0.4;
      if (b.id === this.focusId) op *= smooth(6, 60, this.dist / focusR);
      if (b.parent !== 'sun') op *= smooth(0.4, 3, (d.el.bound ? d.el.a : 1) * S * 40) * (1 - smooth(60, 600, this.dist / (d.el.bound ? d.el.a : 1)));
      if (b.projected) op *= 0.55;
      e.orbitMat.uniforms.uOpacity.value = op;
      e.orbit.visible = op > 0.01;

      // Screen position for the label layer.
      v.copy(p).project(this.camera);
      this.screen.push({ id: b.id, x: (v.x * 0.5 + 0.5) * this.cssSize.w, y: (-v.y * 0.5 + 0.5) * this.cssSize.h, onScreen: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1, px, parent: b.parent, mass: b.mass, depth: distCam });

      if (b.parent === 'sun' && b.el.bound && b.mass > 1e-8) {
        const rh = b.el.a * Math.cbrt(b.mass / (3 * sun.M));
        zones.push([b.el.q - 3 * rh, b.el.Q + 3 * rh, b]);
      }
    }
    v.copy(sunScene).project(this.camera);
    this.screen.push({ id: 'sun', x: (v.x * 0.5 + 0.5) * this.cssSize.w, y: (-v.y * 0.5 + 0.5) * this.cssSize.h, onScreen: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1, px: (sun.radiusAU * S / sunScene.distanceTo(this.camera.position)) * this.viewport.y / (2 * Math.tan((this.camera.fov * DEG) / 2)) / this.pixelRatio, parent: null, mass: 1, depth: sunScene.distanceTo(this.camera.position) });

    // 5. Discs and belts.
    const tau = t - T_START;
    const natural = !state.intervention;
    const gas = (1 - smooth(2.5e6, 5.2e6, tau)) * smooth(0, 1.5e5, tau);
    const afterInst = smooth(0, 4e7, t - T_INSTABILITY);
    const bu = this.beltMat.uniforms;
    this.spinPhase += Math.sign(simDt) * Math.min(Math.abs(simDt) * TAU, 0.09 * Math.min(1, frameDt * 60));
    bu.uSpin.value = this.spinPhase;
    bu.uScale.value = S;
    bu.uOrigin.value.copy(sunScene);
    bu.uExpand.value = 1 / sunMass(Math.max(t, 0));
    bu.uSunR.value = sun.radiusAU * 1.3;
    bu.uPixel.value = 1.5 * this.pixelRatio;
    const pa = bu.uPopAlpha.value;
    pa[0] = gas;
    pa[1] = smooth(1e5, 1e6, tau) * (1 - smooth(1e7, 1.2e8, tau));
    pa[2] = smooth(2e5, 2e6, tau) * (1 - 0.45 * afterInst);
    pa[3] = smooth(5e5, 3e6, tau) * (1 - afterInst);
    pa[4] = smooth(5e5, 3e6, tau) * (0.25 + 0.75 * (1 - afterInst)) ;
    // Dim the belts when looking from close in, where they would smear the view.
    bu.uGain.value = 0.55 * smooth(0.02, 2.0, this.dist);
    zones.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < 10; k++) {
      const z = zones[k];
      // During formation every growing planet carves a lane; afterwards only real orbits count.
      bu.uZones.value[k].set(z ? z[0] : 0, z ? z[1] : 0);
    }
    this.disc.position.copy(sunScene);
    this.disc.scale.setScalar(S);
    this.disc.visible = gas > 0.003;
    this.discMat.uniforms.uAlpha.value = gas;
    this.discMat.uniforms.uSpin.value = this.spinPhase;
    this.discMat.uniforms.uInner.value = Math.max(0.06, sun.radiusAU * 3);
    const giants = zones.filter((z) => z[2].mass > 3e-5).slice(0, 4);
    for (let k = 0; k < 4; k++) {
      const z = giants[k];
      this.discMat.uniforms.uGaps.value[k].set(z ? z[2].el.a : 0, z ? Math.max(0.15, 2.2 * z[2].el.a * Math.cbrt(z[2].mass / 3)) : 0);
    }
    void natural;

    // 6. Wells, previews, flashes.
    this.wellObjs.forEach((w, k) => {
      const src = state.wells[k];
      w.group.visible = !!src;
      if (!src) return;
      scenePos(new THREE.Vector3(src.pos[0], src.pos[1], src.pos[2]), w.group.position);
      const reach = Math.max(0.05, Math.cbrt(src.mass) * 6); // rough sphere of influence
      w.glow.material.uniforms.uSize.value = Math.max(src.eps * 4, reach * 0.12) * S;
      w.glow.material.uniforms.uMinPixels.value = 9 * this.pixelRatio;
      w.glow.material.uniforms.uStrength.value = 1.6;
      w.rings.forEach((ring, j) => {
        const ph = (this.realTime * 0.35 + j / 3) % 1;
        ring.scale.setScalar(reach * (1 - ph) * S + 1e-9);
        ring.material.opacity = 0.55 * ph;
      });
    });
    this._updatePreview(state, byId, S, scenePos);
    this.flashes = this.flashes.filter((f) => this.realTime - f.t0 < 2.5);
    this.flashObjs.forEach((g, k) => {
      const f = this.flashes[k];
      g.visible = !!f;
      if (!f) return;
      const dpos = f.id === 'sun' ? new THREE.Vector3(0, 0, 0) : this.disp[f.id]?.exists ? this.disp[f.id].pos : f.pos;
      if (!dpos) { g.visible = false; return; }
      f.pos = dpos.clone();
      scenePos(dpos, g.position);
      const a = (this.realTime - f.t0) / 2.5;
      g.material.uniforms.uSize.value = this.radiusOf(f.id === 'sun' ? 'sun' : f.id) * S * (1.4 + 4 * a);
      g.material.uniforms.uMinPixels.value = (8 + 26 * a) * this.pixelRatio;
      g.material.uniforms.uStrength.value = 2.0 * Math.pow(1 - a, 2);
    });
  }

  _drawOrbit(line, el, parentPos, blur, S) {
    const pos = line.geometry.attributes.position, fade = line.geometry.attributes.aFade;
    const buf = this._orbitBuf || (this._orbitBuf = new Float64Array(ORBIT_N * 3));
    const rMax = Math.max(200, this.dist * 6);
    orbitPoints(el, ORBIT_N, buf, rMax);
    const ox = this.origin.x - (parentPos ? parentPos.x : 0), oy = this.origin.y - (parentPos ? parentPos.y : 0), oz = this.origin.z - (parentPos ? parentPos.z : 0);
    const arr = pos.array, fa = fade.array;
    const open = !(el.bound && el.e < 1);
    for (let k = 0; k < ORBIT_N; k++) {
      arr[3 * k] = (buf[3 * k] - ox) * S;
      arr[3 * k + 1] = (buf[3 * k + 2] - oz) * S;
      arr[3 * k + 2] = -(buf[3 * k + 1] - oy) * S;
      const u = k / (ORBIT_N - 1);
      const trail = open ? 0.7 : 0.14 + 0.86 * Math.pow(1 - u, 2.2);
      fa[k] = trail + (0.5 - trail) * blur;
    }
    pos.needsUpdate = true; fade.needsUpdate = true;
  }

  /** Shows what an intervention would do before it is applied. */
  setPreview(p) { this.preview = p; }

  _updatePreview(state, byId, S, scenePos) {
    const p = this.preview;
    this.previewOrbit.visible = false; this.arrow.visible = false; this.arrowTip.visible = false;
    if (!p) return;
    if (p.type === 'nudge') {
      const b = byId[p.bodyId];
      if (!b?.exists) return;
      const st = Float64Array.from(b.rel);
      st[3] += p.dv[0]; st[4] += p.dv[1]; st[5] += p.dv[2];
      const el = stateToElements(st, 0, b.mu, {});
      const parentPos = b.parent !== 'sun' && byId[b.parent]?.exists ? this.disp[b.parent].pos : null;
      // The preview is drawn from the body's true position, not the rate-capped one.
      this._drawOrbit(this.previewOrbit, el, parentPos, 0, S);
      const fa = this.previewOrbit.geometry.attributes.aFade.array;
      for (let k = 0; k < ORBIT_N; k++) fa[k] = k / ORBIT_N;
      this.previewOrbit.visible = true;
      // Arrow from the body along the push.
      const dvLen = Math.hypot(p.dv[0], p.dv[1], p.dv[2]);
      if (dvLen > 0) {
        const from = scenePos(this.disp[p.bodyId].pos, new THREE.Vector3());
        const dir = toScene(p.dv[0] / dvLen, p.dv[1] / dvLen, p.dv[2] / dvLen, new THREE.Vector3());
        const len = Math.max(b.radius * S * 2.6, 0.09);
        const to = from.clone().addScaledVector(dir, len);
        const a = this.arrow.geometry.attributes.position.array;
        from.addScaledVector(dir, b.radius * S * 1.05);
        a.set([from.x, from.y, from.z, to.x, to.y, to.z]);
        this.arrow.geometry.attributes.position.needsUpdate = true;
        this.arrow.visible = true;
        this.arrowTip.visible = true;
        this.arrowTip.position.copy(to);
        this.arrowTip.material.uniforms.uSize.value = 0;
        this.arrowTip.material.uniforms.uMinPixels.value = 7 * this.pixelRatio;
        this.arrowTip.material.uniforms.uStrength.value = 2.5;
      }
    } else if (p.type === 'well' && p.pos) {
      const w = this.wellObjs[3];
      w.group.visible = true;
      scenePos(new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]), w.group.position);
      const reach = Math.max(0.05, Math.cbrt(p.mass) * 6);
      w.glow.material.uniforms.uSize.value = reach * 0.12 * S;
      w.glow.material.uniforms.uMinPixels.value = 9 * this.pixelRatio;
      w.glow.material.uniforms.uStrength.value = 0.9 + 0.3 * Math.sin(this.realTime * 4);
      w.rings.forEach((ring, j) => { ring.scale.setScalar(reach * ((j + 1) / 3) * S); ring.material.opacity = 0.35; });
    }
  }

  /** A burst of light at a body (collisions). */
  flash(id) { this.flashes.unshift({ id, t0: this.realTime }); this.flashes.length = Math.min(this.flashes.length, 3); }

  render() { this.composer.render(); }

  // --- picking -------------------------------------------------------------

  /** Body under a screen point (CSS px), or null. */
  pick(x, y, reach = 14) {
    let best = null, bestD = Infinity;
    for (const s of this.screen) {
      if (!s.onScreen) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < Math.max(s.px, reach) && d - s.px < bestD) { bestD = d - s.px; best = s.id; }
    }
    return best;
  }

  /** Heliocentric ecliptic-plane point under a screen position (CSS px), or null. */
  eclipticPoint(x, y) {
    const ndc = new THREE.Vector3((x / this.cssSize.w) * 2 - 1, -(y / this.cssSize.h) * 2 + 1, 0.5).unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    const planeY = this._sunScene ? this._sunScene.y : 0;
    if (Math.abs(dir.y) < 1e-6) return null;
    const k = (planeY - this.camera.position.y) / dir.y;
    if (k <= 0) return null;
    const hit = this.camera.position.clone().addScaledVector(dir, k);
    // scene → heliocentric ecliptic
    return [hit.x / this.scale + this.origin.x, -hit.z / this.scale + this.origin.y, 0];
  }
}

export { G };
