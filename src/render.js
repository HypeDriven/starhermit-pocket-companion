/**
 * Pocket Companion — render module (Three.js).
 * A cozy customizable room centered on Mote, an expressive procedural
 * creature. Presentation only: consumes immutable snapshots + events,
 * never mutates rules state. Deterministic decoration seed per session.
 */
import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeRng } from './rules.js';
import { THEMES, DECOR_ITEMS } from './content.js';
import { detectPreset, resolve, describe, SHADOW_MAP, PARTICLE_BUDGET } from './gfx.js';

/* Camera framing constants (no magic offsets). */
const CAM = {
  fov: 34,
  pos: new THREE.Vector3(0, 2.6, 7.4),
  look: new THREE.Vector3(0, 1.05, 0),
  swayAmp: 0.045,
  swaySpeed: 0.00021,
};

/* Shadow box fitted to the room (floor radius 6.4, props within ~4.5 of Mote). */
const SHADOW_BOX = { half: 5.2, near: 3, far: 17 };
/* Environment-map strength: the room map is neutral white, so keep it a gentle fill. */
const ENV = { base: 0.14, glossy: 0.35, hemiWithEnv: 0.3, hemiWithout: 0.55 };

// Colour grade + vignette (display-space in/out): gentle S-curve, a touch of
// saturation, warm highlights / cool shadows. Never lowers piece contrast.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.07);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.15, 0.85, l));
      s = s * 0.975 + 0.02;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

const MOOD_COLORS = {
  joyful: 0xffd98a, content: 0xf2c9a0, worried: 0xd9b8a6,
  sad: 0xb9a8b8, sleepy: 0xc9c4e0, proud: 0xffe9a8, miserable: 0x9a8fa8,
};

export class Renderer3D {
  constructor(container, opts = {}) {
    this.container = container;
    this.ok = false;
    this.disposed = false;
    this.reducedMotion = false;
    this.palette = opts.palette || 'default';
    this.decorSeed = opts.decorSeed || 1;
    this.onCreatureTap = null;
    this._time = 0;
    this._shake = 0;
    this._reaction = 0;
    this._mood = 'content';
    this._moodBlend = 0;
    this._moodColor = new THREE.Color();
    this._blink = 0;
    this._blinkTimer = 2;
    this._hidden = false;
    this._anchors = {};
    this._particles = [];
    this._decorNodes = new Map();
    this._highlight = 0; // -1 invalid, 0 none, 1 valid
    // Graphics state (see gfx.js).
    this.q = resolve({}, 'balanced');
    this.gpu = '';
    this.detected = 'balanced';
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.postKey = null;
    this.composer = null;
    this.postFailed = false;
    this._detailMaps = [];
  }

  /** Create the WebGL context and scene; `savedGfx` is the persisted graphics settings object. */
  init(savedGfx = {}) {
    try {
      // The canvas never multisamples: MSAA, when chosen, uses a multisampled composer target.
      this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    } catch {
      return false;
    }
    this.gpu = readGpu(this.renderer.getContext());
    const mobile = (window.matchMedia?.('(pointer: coarse)').matches) || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this.detected = detectPreset(this.gpu, { mobile });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.classList.add('game-canvas');
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Background via scene.background (clear colours wash out through post targets).
    this.scene.background = new THREE.Color(0x241d2b);
    this.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.1, 60);
    this.camera.position.copy(CAM.pos);
    this.camera.lookAt(CAM.look);

    // Layers: 0 env+gameplay, 1 selection markers, 2 effects.
    this.camera.layers.enable(1);
    this.camera.layers.enable(2);
    // Ambient occlusion sees solid geometry only (no sprites, motes or markers).
    this.aoCamera = this.camera.clone();
    this.aoCamera.layers.set(0);

    this.raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    this._buildLights();
    this._buildRoom('hearthwood');
    this._buildCreature();
    this._buildParticles();
    this._buildMarkers();
    this.setGraphics(savedGfx);
    this.resize();

    this.renderer.domElement.addEventListener('pointerdown', (e) => this._tap(e));
    this.ok = true;
    return true;
  }

  /* ---------------- lighting ---------------- */
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xfff2dd, 0x6b5a4a, ENV.hemiWithout);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffe0b3, 1.6);
    this.key.position.set(3.5, 6, 4);
    const sc = this.key.shadow.camera;
    sc.left = -SHADOW_BOX.half; sc.right = SHADOW_BOX.half;
    sc.top = SHADOW_BOX.half; sc.bottom = -SHADOW_BOX.half;
    sc.near = SHADOW_BOX.near; sc.far = SHADOW_BOX.far;
    sc.updateProjectionMatrix();
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 3;
    this.scene.add(this.key);
    this.lamp = new THREE.PointLight(0xffc978, 12, 9, 1.8);
    this.lamp.position.set(-2.6, 2.4, -1.6);
    this.scene.add(this.lamp);
  }

  /** Room environment map (image-based lighting), built once on first use. */
  _envMap() {
    if (!this._envTex) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this._envTex = pm.fromScene(room, 0.04).texture;
      room.dispose?.();
      pm.dispose();
    }
    return this._envTex;
  }

  /* ---------------- room ---------------- */
  _mat(color, rough = 0.9, metal = 0) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: metal > 0.3 ? ENV.glossy : ENV.base });
  }

  /** Register a procedural surface map that only the "detailed" tier shows. */
  _detailMap(mat, map) {
    this._detailMaps.push({ mat, map });
    mat.map = this.q.detail === 'detailed' ? map : null;
  }

  _buildRoom(themeId) {
    if (this.roomGroup) { this.scene.remove(this.roomGroup); disposeTree(this.roomGroup); }
    if (this._ambientGroup) { this.scene.remove(this._ambientGroup); disposeTree(this._ambientGroup); }
    for (const d of this._detailMaps) d.map.dispose();
    this._detailMaps = [];
    const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    this.theme = theme;
    const p = theme.palette;
    const g = new THREE.Group();
    g.name = 'room';
    const seed = this.decorSeed;

    // Floor: varnished planks with per-board tone, grain and seams.
    const floorMat = new THREE.MeshPhysicalMaterial({
      map: makeFloorTexture(p.floor, seed), roughness: 0.72, clearcoat: 0.25, clearcoatRoughness: 0.45, envMapIntensity: ENV.base,
    });
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 6.4, 0.2, 64), floorMat);
    floor.position.y = -0.1;
    floor.receiveShadow = true;
    g.add(floor);

    // Curved back wall; the opening faces the camera (theta 0 = +Z).
    const wallMat = this._mat(p.wall, 0.95);
    this._detailMap(wallMat, makePlasterTexture(seed, 3));
    const wallArc = Math.PI * 1.5, wallStart = Math.PI * 0.25;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 4.4, 64, 1, true, wallStart, wallArc), wallMat);
    wall.position.y = 2.1;
    wall.material.side = THREE.BackSide;
    wall.receiveShadow = true;
    g.add(wall);

    // Wainscot band with a small cap rail.
    const bandMat = this._mat(p.wallAccent, 0.8);
    this._detailMap(bandMat, makePanelTexture(seed));
    const band = new THREE.Mesh(new THREE.CylinderGeometry(6.15, 6.15, 0.5, 64, 1, true, wallStart, wallArc), bandMat);
    band.position.y = 0.25;
    band.material.side = THREE.BackSide;
    band.receiveShadow = true;
    g.add(band);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(6.1, 0.035, 6, 96, wallArc), this._mat(p.wallAccent, 0.55));
    rail.rotation.x = Math.PI / 2;
    rail.rotation.z = -(wallStart + wallArc) + Math.PI / 2;
    rail.position.y = 0.5;
    g.add(rail);

    // Window: gradient sky (stars on dark themes), soft glow, open frame + sill.
    const win = new THREE.Group();
    const skyMat = new THREE.MeshBasicMaterial({ map: makeSkyTexture(p.sky, seed) });
    skyMat.color.setScalar(1.15); // a touch over white so the window reads as a light source
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), skyMat);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), new THREE.MeshBasicMaterial({ color: p.glow, transparent: true, opacity: 0.1 }));
    glow.position.z = 0.01;
    this._windowGlow = glow;
    win.add(sky, glow);
    const frameMat = this._mat(p.wallAccent, 0.7);
    const bars = [
      [1.9, 0.1, 0.1, 0, 0.8], [1.9, 0.1, 0.1, 0, -0.8],
      [0.1, 1.7, 0.1, -0.9, 0], [0.1, 1.7, 0.1, 0.9, 0],
      [0.06, 1.6, 0.1, 0, 0], [1.8, 0.06, 0.1, 0, 0],
    ];
    for (const [w, h, d, x, y] of bars) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
      bar.position.set(x, y, 0.02);
      win.add(bar);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.07, 0.26), frameMat);
    sill.position.set(0, -0.88, 0.1);
    win.add(sill);
    win.position.set(0, 2.5, -5.9);
    g.add(win);
    this._anchors.window = win;

    // Rug (contact grounding under Mote): woven rings when detailed.
    const rugMat = this._mat(p.rug, 0.98);
    this._detailMap(rugMat, makeRugTexture(seed));
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.9, 64), rugMat);
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.011;
    rug.receiveShadow = true;
    g.add(rug);
    const rugRing = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.06, 64), this._mat(p.wallAccent, 0.95));
    rugRing.rotation.x = -Math.PI / 2;
    rugRing.position.y = 0.012;
    rugRing.receiveShadow = true;
    g.add(rugRing);

    // Static props per theme (low-poly authored shapes).
    this._propGroup = new THREE.Group();
    this._addProps(this._propGroup, theme);
    g.add(this._propGroup);

    // Decor item anchors (filled by setDecor).
    this._decorGroup = new THREE.Group();
    g.add(this._decorGroup);

    this.roomGroup = g;
    this.scene.add(g);
    this._buildAmbient(p);
    if (this._placedDecor) this.setDecor(this._placedDecor);
    this.key.color.set(p.key);
    this.lamp.color.set(p.glow);
    // Rebuilding the room must honour the current graphics tiers.
    if (this.renderer && this.saved) this._applyScene();
  }

  /* ---------------- window light pool + dust motes (effects layer) ---------------- */
  _buildAmbient(p) {
    const grp = new THREE.Group();
    grp.name = 'ambient';
    const beam = new THREE.Color(p.sky).lerp(new THREE.Color(p.glow), 0.35).lerp(new THREE.Color(0xffffff), 0.45);
    // Pool of window light on the floor in front of the window.
    const pool = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({
      color: beam, alphaMap: makeRadialTexture(), transparent: true, opacity: 0.1,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    pool.rotation.x = -Math.PI / 2;
    pool.scale.set(1.5, 0.9, 1);
    pool.position.set(0, 0.02, -3.1);
    pool.layers.set(2);
    grp.add(pool);
    // Dust motes drifting in the window light.
    const n = 70;
    const rng = makeRng(this.decorSeed ^ 0xd057);
    const pos = new Float32Array(n * 3);
    this._moteSeeds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const t = rng.range(1000) / 1000;
      const x = (rng.range(1000) / 1000 - 0.5) * (1.6 + (1 - t) * 0.6);
      this._moteSeeds.set([x, 0.3 + t * 2.7, -2.8 - t * 2.9, rng.range(628) / 100], i * 4);
      pos.set([x, 0.3 + t * 2.7, -2.8 - t * 2.9], i * 3);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const motes = new THREE.Points(mg, new THREE.PointsMaterial({
      color: beam, map: makeRadialTexture(), size: 0.028, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    motes.layers.set(2);
    grp.add(motes);
    this._motes = motes;
    this._ambientGroup = grp;
    this.scene.add(grp);
  }

  _addProps(group, theme) {
    const p = theme.palette;
    const rng = makeRng(this.decorSeed ^ 0x5eed);
    const put = (mesh, x, z, ry = 0) => {
      mesh.position.x = x; mesh.position.z = z; mesh.rotation.y = ry;
      mesh.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      group.add(mesh);
    };
    // Lamp.
    const lampG = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2.2, 10), this._mat(0x6b5240, 0.7));
    pole.position.y = 1.1;
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 24, 1, true), new THREE.MeshStandardMaterial({ color: p.glow, roughness: 0.6, emissive: p.glow, emissiveIntensity: 0.55, side: THREE.DoubleSide }));
    shade.position.y = 2.25;
    // Warm bulb under the shade: the brightest thing in the room, so bloom picks it out.
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.glow).multiplyScalar(3) }));
    bulb.position.y = 2.08;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.06, 20), this._mat(0x5a4332, 0.5, 0.2));
    base.position.y = 0.03;
    lampG.add(pole, shade, bulb, base);
    this._lampShade = shade;
    put(lampG, -2.6, -1.6);
    // Plant.
    const plantG = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.3, 16), new THREE.MeshPhysicalMaterial({ color: 0xa3603f, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.3, envMapIntensity: ENV.base }));
    pot.position.y = 0.15;
    plantG.add(pot);
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55 + rng.range(30) / 100, 6), this._mat(0x5a8f4f, 0.9));
      leaf.position.y = 0.55;
      leaf.rotation.z = (i / 5 - 0.5) * 1.2;
      leaf.rotation.y = i * 1.3;
      plantG.add(leaf);
    }
    put(plantG, 2.7, -2.0);
    // Shelf with books.
    const shelfG = new THREE.Group();
    const plank = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.34), this._mat(0x7a5a3c, 0.8));
    shelfG.add(plank);
    for (let i = 0; i < 6; i++) {
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34 + rng.range(12) / 100, 0.24),
        this._mat([0xa34a3a, 0x3f7f8f, 0xd9a441, 0x6a8f5a, 0x8f5a8f, 0x4a6aa3][i], 0.85));
      book.position.set(-0.6 + i * 0.22, 0.24, 0);
      book.rotation.z = (rng.range(10) - 5) / 100;
      shelfG.add(book);
    }
    shelfG.position.set(-2.9, 2.5, -3.4);
    shelfG.rotation.y = 0.5;
    group.add(shelfG);
    // Cushion.
    const cushion = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), new THREE.MeshPhysicalMaterial({ color: p.rug, roughness: 0.9, sheen: 1, sheenRoughness: 0.6, sheenColor: 0xffe8d8, envMapIntensity: ENV.base }));
    cushion.receiveShadow = true;
    cushion.scale.set(1, 0.45, 1);
    cushion.position.set(1.9, 0.2, 0.8);
    cushion.castShadow = true;
    group.add(cushion);
    // Toy yarn ball.
    const yarnMat = this._mat(0xd96a8a, 0.95);
    this._detailMap(yarnMat, makeYarnTexture());
    const yarn = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), yarnMat);
    yarn.position.set(-1.3, 0.16, 1.4);
    yarn.castShadow = true;
    group.add(yarn);
  }

  /* ---------------- creature ---------------- */
  _buildCreature() {
    if (this.creature) { this.scene.remove(this.creature); disposeTree(this.creature); }
    const c = new THREE.Group();
    c.name = 'mote';

    // Plush body: sheen gives the soft velvet rim; the mood colour stays the base.
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: MOOD_COLORS.content, roughness: 0.78, emissive: 0x000000,
      sheen: 0.7, sheenRoughness: 0.5, sheenColor: 0xffe6c8, envMapIntensity: ENV.base,
    });
    this.bodyMat.userData.sheen = this.bodyMat.sheen;
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 40, 30), this.bodyMat);
    body.scale.set(1, 0.92, 0.95);
    body.position.y = 0.62;
    body.castShadow = true;
    c.add(body);
    this._body = body;

    this._bellyMat = new THREE.MeshPhysicalMaterial({ color: 0xfff3e0, roughness: 0.9, sheen: 0.6, sheenRoughness: 0.6, sheenColor: 0xfff4e6, envMapIntensity: ENV.base });
    this._bellyMat.userData.sheen = this._bellyMat.sheen;
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.4, 28, 18), this._bellyMat);
    belly.scale.set(0.85, 0.72, 0.5);
    belly.position.set(0, 0.5, 0.36);
    c.add(belly);

    // Ears.
    this._ears = [];
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 10), this.bodyMat);
      ear.position.set(side * 0.34, 1.18, 0);
      ear.rotation.z = -side * 0.35;
      ear.castShadow = true;
      c.add(ear);
      this._ears.push(ear);
    }

    // Eyes (white + pupil); blink by scaling.
    this._eyes = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      // Glossy eyes (clearcoat) with a catchlight so Mote reads as alive in every tier.
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), new THREE.MeshPhysicalMaterial({ color: 0xe9e4de, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: ENV.glossy }));
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshPhysicalMaterial({ color: 0x2a2430, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: ENV.glossy }));
      pupil.position.z = 0.075;
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      glint.position.set(-0.022, 0.026, 0.118);
      eye.add(white, pupil, glint);
      eye.position.set(side * 0.23, 0.78, 0.5);
      c.add(eye);
      this._eyes.push(eye);
    }

    // Mouth: torus arc; curvature adjusted by mood.
    this._mouth = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 8, 16, Math.PI), this._mat(0x7a4a3a, 0.6));
    this._mouth.position.set(0, 0.6, 0.56);
    this._mouth.rotation.z = Math.PI; // smile by default
    c.add(this._mouth);

    // Cheeks.
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf0908a, roughness: 1, transparent: true, opacity: 0.65 }));
      cheek.position.set(side * 0.38, 0.62, 0.46);
      cheek.scale.z = 0.4;
      c.add(cheek);
    }

    // Feet.
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), this.bodyMat);
      foot.scale.set(1, 0.5, 1.2);
      foot.position.set(side * 0.28, 0.07, 0.25);
      c.add(foot);
    }

    // Tail puff.
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this._mat(0xfff3e0, 0.95));
    tail.position.set(0, 0.42, -0.55);
    c.add(tail);

    this.scene.add(c);
    this.creature = c;

    // Soft contact shadow (cheap grounding in every tier, even with shadow maps off).
    if (this._blob) { this.scene.remove(this._blob); disposeTree(this._blob); }
    this._blob = new THREE.Mesh(new THREE.CircleGeometry(0.78, 32), new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: makeRadialTexture(), transparent: true, opacity: 0.4, depthWrite: false,
    }));
    this._blob.rotation.x = -Math.PI / 2;
    this._blob.position.set(0, 0.016, 0.05);
    this._blob.layers.set(2);
    this.scene.add(this._blob);
  }

  /* ---------------- selection markers ---------------- */
  _buildMarkers() {
    this._ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this._ring.rotation.x = -Math.PI / 2;
    this._ring.position.y = 0.02;
    this._ring.layers.set(1);
    this.scene.add(this._ring);
  }

  /* ---------------- pooled particles ---------------- */
  _buildParticles() {
    this._particleGroup = new THREE.Group();
    this._particleGroup.layers.set(2);
    this.scene.add(this._particleGroup);
    this._sprites = {
      heart: makeSpriteTexture('heart'), bubble: makeSpriteTexture('bubble'),
      note: makeSpriteTexture('note'), crumb: makeSpriteTexture('crumb'),
      zzz: makeSpriteTexture('zzz'), star: makeSpriteTexture('star'),
      sparkle: makeSpriteTexture('sparkle'),
    };
    this._pool = [];
  }

  burst(kind, count = 8) {
    if (this.reducedMotion) count = Math.min(2, count);
    const budget = PARTICLE_BUDGET[this.q.particles] - this._particles.length;
    const n = Math.max(0, Math.min(count, budget));
    for (let i = 0; i < n; i++) {
      let s = this._pool.pop();
      if (!s) {
        s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
        s.layers.set(2);
        this._particleGroup.add(s);
      }
      s.material.map = this._sprites[kind] || this._sprites.sparkle;
      s.material.opacity = 1;
      s.material.rotation = Math.random() * 0.6 - 0.3;
      const scale = 0.18 + Math.random() * 0.14;
      s.scale.set(scale, scale, 1);
      s.position.set((Math.random() - 0.5) * 0.8, 0.9 + Math.random() * 0.5, 0.5 + Math.random() * 0.2);
      s.visible = true;
      this._particles.push({
        sprite: s, life: 0,
        maxLife: this.reducedMotion ? 0.5 : 1.1 + Math.random() * 0.5,
        vx: (Math.random() - 0.5) * 0.5, vy: 0.8 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.2,
      });
    }
  }

  /* ---------------- public API ---------------- */
  setTheme(themeId) { this._buildRoom(themeId); }

  setDecor(placedItems) {
    this._placedDecor = [...placedItems];
    if (!this._decorGroup) return;
    disposeChildren(this._decorGroup);
    const rng = makeRng(this.decorSeed ^ 0xdec0);
    placedItems.forEach((itemId, i) => {
      const node = buildDecorMesh(itemId, this._mat.bind(this));
      if (!node) return;
      const angle = (i / Math.max(1, placedItems.length)) * Math.PI * 1.2 - Math.PI * 0.6;
      const r = 2.6 + rng.range(8) / 10;
      if (!node.userData.anchored) node.position.set(Math.sin(angle) * r, 0, Math.cos(angle) * -r * 0.7 - 0.6);
      node.rotation.y = rng.range(60) / 100 - 0.3;
      this._decorGroup.add(node);
      this._decorNodes.set(itemId, node);
    });
  }

  setMood(mood) { if (MOOD_COLORS[mood]) this._mood = mood; }

  /** Presentation reaction for a rules event (event hierarchy enforced). */
  react(actionId, kind, opts = {}) {
    const tierMap = { ack: 0, care: 1, bond: 1, room: 1, pass: 0, discovery: 2, goal: 2, round: 3 };
    const tier = opts.discovery ? 2 : (tierMap[kind] ?? 1);
    this._reaction = Math.max(this._reaction, tier === 0 ? 0.25 : tier === 1 ? 0.7 : 1.0);
    const bursts = {
      feed: ['crumb', 8], wash: ['bubble', 10], play: ['star', 8], rest: ['zzz', 6],
      pet: ['heart', 6], sing: ['note', 7], toss: ['star', 10], snack: ['crumb', 5],
      decorate: ['sparkle', 8], wait: [],
    };
    const b = bursts[actionId];
    if (b) this.burst(b[0], b[1]);
    if (opts.discovery) this.burst('sparkle', 14);
    if (opts.cravingMet) this.burst('heart', 12);
    if (tier >= 3 && !this.reducedMotion) this._shake = 0.35;
  }

  highlight(valid) { this._highlight = valid === null ? 0 : valid ? 1 : -1; }

  invalidWobble() { this._reaction = Math.max(this._reaction, 0.3); this._wobble = 0.4; }

  /** Project a named anchor to CSS pixels for DOM label alignment. */
  anchorToScreen(name) {
    const obj = name === 'creature' ? this.creature : this._anchors[name];
    if (!obj) return null;
    const v = new THREE.Vector3();
    obj.getWorldPosition(v);
    if (name === 'creature') v.y += 1.7;
    v.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top, behind: v.z > 1 };
  }

  _tap(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this._pointer, this.camera);
    this.raycaster.layers.set(0);
    const hits = this.raycaster.intersectObject(this.creature, true);
    if (hits.length && this.onCreatureTap) this.onCreatureTap();
  }

  /* ---------------- graphics settings ---------------- */
  /** Apply saved graphics settings live (see gfx.js for the model). */
  setGraphics(saved) {
    this.saved = saved || {};
    const prev = this.q;
    this.q = resolve(this.saved, this.detected);
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._applyScene(prev);
    this._fpsVisible(this.q.showFps);
    document.body.dataset.gfxPreset = this.q.preset;
    this.renderer.domElement.dataset.gfxPreset = this.q.preset;
  }

  /** Push the resolved tiers into lights, materials and effect groups. */
  _applyScene(prev) {
    const g = this.q;
    const size = SHADOW_MAP[g.shadows];
    const shadowChanged = !prev || (SHADOW_MAP[prev.shadows] > 0) !== (size > 0);
    this.renderer.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    const env = g.reflections === 'on';
    this.scene.environment = env ? this._envMap() : null;
    this.hemi.intensity = env ? ENV.hemiWithEnv : ENV.hemiWithout;
    const detailed = g.detail === 'detailed';
    if (this._propGroup) this._propGroup.visible = detailed;
    for (const d of this._detailMaps) {
      const want = detailed ? d.map : null;
      if (d.mat.map !== want) { d.mat.map = want; d.mat.needsUpdate = true; }
    }
    for (const m of [this.bodyMat, this._bellyMat]) if (m) m.sheen = detailed ? m.userData.sheen : 0;
    if (this._ambientGroup) this._ambientGroup.visible = g.ambient === 'on';
    if (this._blob) this._blob.material.opacity = size > 0 ? 0.28 : 0.42;
    // Materials pick up shadow-map changes on recompile.
    if (shadowChanged) {
      this.scene.traverse((o) => {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
      });
    }
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo(words) {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu,
      detected: this.detected,
      resolved: this.q,
      pixels: px,
      summary: describe(this.q, px[0] > 1 ? px : null, words),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = this._fpsEl;
    if (on && !el) {
      el = this._fpsEl = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      this.container.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.renderTarget1?.dispose();
    this.composer?.renderTarget2?.dispose();
    this.composer?.passes?.forEach((p) => p.dispose?.());
    this.composer = null;
    if (!g.post || this.postFailed) return;
    const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.aoCamera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.85;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only the lamp bulb, window, eye glints and sparkles bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.45, 0.92));
      }
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly (the panel says so).
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length % 30 === 0 && this._fpsEl && !this._fpsEl.hidden) {
      const recent = f.slice(-30).reduce((a, b) => a + b, 0) / 30;
      this._fpsEl.textContent = `${Math.round(1000 / recent)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    }
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  _renderFrame(dtMs) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < 2 || h < 2) return; // game screen hidden: nothing to draw
    this._adapt(dtMs);
    const ratio = Math.min(3, Math.max(0.25, Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale));
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h);
      this._fitCamera(w, h);
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      this.aoCamera.copy(this.camera);
      this.aoCamera.layers.set(0);
      this.composer.render(dtMs / 1000);
    } else this.renderer.render(this.scene, this.camera);
  }

  setReducedMotion(v) { this.reducedMotion = !!v; }

  setHidden(hidden) {
    this._hidden = hidden;
    if (!hidden && this.ok) this._loop();
  }

  resize() {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.size = [w, h];
    this.renderer.setSize(w, h);
    this._fitCamera(w, h);
  }

  _fitCamera(w, h) {
    this.camera.aspect = w / h;
    // Portrait-fit: pull the camera back so the room stays framed.
    const fit = Math.min(1, this.camera.aspect / 1.15);
    this.camera.position.set(CAM.pos.x, CAM.pos.y + (1 - fit) * 1.4, CAM.pos.z + (1 - fit) * 2.6);
    this.camera.lookAt(CAM.look);
    this.camera.updateProjectionMatrix();
  }

  start() { this._loop(); }

  _loop() {
    if (this.disposed || this._hidden || !this.ok) return;
    let last = performance.now();
    const step = (now) => {
      if (this.disposed || this._hidden) return;
      const rawMs = Math.min(250, now - last);
      const dt = Math.min(0.05, rawMs / 1000);
      last = now;
      this._time += dt;
      this._update(dt, now);
      this._renderFrame(rawMs || 16);
      this._raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(step);
  }

  _update(dt, now) {
    const rm = this.reducedMotion;
    // Idle breathing + authored camera sway (never cumulative lerp on transforms).
    if (this.creature) {
      const breathe = rm ? 0 : Math.sin(this._time * 2.1) * 0.015;
      const reactLift = this._reaction > 0 ? Math.sin(Math.min(1, this._reaction) * Math.PI) * 0.22 : 0;
      this._body.position.y = 0.62 + breathe + reactLift;
      this._reaction = Math.max(0, this._reaction - dt * 1.6);
      // Mood blending.
      this._moodColor.set(MOOD_COLORS[this._mood] || MOOD_COLORS.content);
      this.bodyMat.color.lerp(this._moodColor, Math.min(1, dt * 3));
      // Contact shadow tightens and fades as Mote hops.
      const lift = this._body.position.y - 0.62;
      this._blob.scale.setScalar(1 - Math.max(0, lift) * 0.9);
      // Ear droop / mouth by mood.
      const droop = { joyful: 0, proud: 0, content: 0.1, worried: 0.4, sad: 0.7, sleepy: 0.55, miserable: 0.9 }[this._mood] ?? 0.1;
      this._ears.forEach((ear, i) => {
        const side = i === 0 ? -1 : 1;
        ear.rotation.z += ((-side * (0.35 + droop * 0.5)) - ear.rotation.z) * Math.min(1, dt * 5);
      });
      const mouthTargets = {
        joyful: { rot: Math.PI, scale: 1.25 }, proud: { rot: Math.PI, scale: 1.3 },
        content: { rot: Math.PI, scale: 1 }, worried: { rot: Math.PI * 0.75, scale: 0.7 },
        sad: { rot: 0, scale: 0.7 }, sleepy: { rot: Math.PI, scale: 0.4 }, miserable: { rot: 0, scale: 0.55 },
      };
      const mt = mouthTargets[this._mood] || mouthTargets.content;
      this._mouth.rotation.z += (mt.rot - this._mouth.rotation.z) * Math.min(1, dt * 4);
      this._mouth.scale.setScalar(this._mouth.scale.x + (mt.scale - this._mouth.scale.x) * Math.min(1, dt * 4));
      // Blink.
      this._blinkTimer -= dt;
      if (this._blinkTimer <= 0) { this._blink = 0.12; this._blinkTimer = 2 + Math.random() * 3; }
      if (this._blink > 0 || this._mood === 'sleepy') {
        this._blink = Math.max(0, this._blink - dt);
        const s = this._mood === 'sleepy' ? 0.15 : 0.1;
        this._eyes.forEach((e) => e.scale.setY(e.scale.y + (s - e.scale.y) * Math.min(1, dt * 18)));
      } else {
        this._eyes.forEach((e) => e.scale.setY(e.scale.y + (1 - e.scale.y) * Math.min(1, dt * 18)));
      }
      // Invalid wobble.
      if (this._wobble > 0) {
        this._wobble = Math.max(0, this._wobble - dt);
        this.creature.rotation.z = rm ? 0 : Math.sin(this._wobble * 30) * this._wobble * 0.12;
      } else this.creature.rotation.z = 0;
    }
    // Highlight ring.
    const ringTarget = this._highlight === 0 ? 0 : 0.85;
    const mat = this._ring.material;
    mat.opacity += (ringTarget - mat.opacity) * Math.min(1, dt * 8);
    if (this._highlight === 1) mat.color.set(0x8fe08a);
    else if (this._highlight === -1) mat.color.set(0xe08a8a);
    this.bodyMat.emissive.set(this._highlight === 1 ? 0x224422 : this._highlight === -1 ? 0x442222 : 0x000000);
    // Camera: authored sway + event-tiered shake; never changes raycast truth
    // because raycasting uses pointer NDC against the same camera.
    const sway = rm ? 0 : Math.sin(now * CAM.swaySpeed) * CAM.swayAmp;
    let shakeX = 0, shakeY = 0;
    if (this._shake > 0 && !rm) {
      this._shake = Math.max(0, this._shake - dt);
      shakeX = (Math.random() - 0.5) * this._shake * 0.08;
      shakeY = (Math.random() - 0.5) * this._shake * 0.08;
    }
    const baseX = CAM.pos.x + sway, baseY = this.camera.position.y;
    this.camera.position.x += ((baseX + shakeX) - this.camera.position.x) * Math.min(1, dt * 4);
    this.camera.position.z += (CAM.pos.z + shakeY * 4 - this.camera.position.z) * Math.min(1, dt * 4);
    void baseY;
    this.camera.lookAt(CAM.look);
    this._updateAmbient(dt);
    // Particles.
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.sprite.visible = false;
        this._particles.splice(i, 1);
        this._pool.push(p.sprite);
        continue;
      }
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      p.sprite.material.opacity = 1 - p.life / p.maxLife;
    }
  }

  /** Window glow shimmer, lamp flicker and drifting motes; still under reduced motion. */
  _updateAmbient(dt) {
    const on = this.q.ambient === 'on';
    this._rmQuery ??= window.matchMedia?.('(prefers-reduced-motion: reduce)') || { matches: false };
    const still = this.reducedMotion || !on || this._rmQuery.matches;
    const t = this._time;
    this.lamp.intensity = still ? 12 : 12 * (1 + 0.035 * Math.sin(t * 6.3) + 0.02 * Math.sin(t * 13.7 + 1.3));
    if (this._windowGlow) this._windowGlow.material.opacity = still ? 0.1 : 0.1 + 0.03 * Math.sin(t * 0.7);
    if (!on || still || !this._motes) return;
    const pos = this._motes.geometry.attributes.position;
    const seeds = this._moteSeeds;
    for (let i = 0; i < pos.count; i++) {
      const x0 = seeds[i * 4], y0 = seeds[i * 4 + 1], z0 = seeds[i * 4 + 2], ph = seeds[i * 4 + 3];
      pos.setXYZ(i,
        x0 + Math.sin(t * 0.23 + ph) * 0.18,
        y0 + Math.sin(t * 0.17 + ph * 1.7) * 0.22,
        z0 + Math.cos(t * 0.19 + ph) * 0.12);
    }
    pos.needsUpdate = true;
    void dt;
  }

  dispose() {
    this.disposed = true;
    this.composer?.renderTarget1?.dispose();
    this.composer?.renderTarget2?.dispose();
    this._envTex?.dispose();
    cancelAnimationFrame(this._raf);
    if (this.renderer) {
      disposeTree(this.scene);
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.ok = false;
  }
}

/* ---------------- helpers ---------------- */
function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        for (const t of [m.map, m.alphaMap]) if (t && !t.userData?.shared) t.dispose();
        m.dispose();
      });
    }
  });
}
function disposeChildren(group) {
  for (const child of [...group.children]) { group.remove(child); disposeTree(child); }
}

function canvasTex(size, draw, { srgb = true, repeat = null } = {}) {
  const c = document.createElement('canvas');
  c.width = size[0]; c.height = size[1];
  draw(c.getContext('2d'), c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); }
  tex.anisotropy = 4;
  return tex;
}
const rgb = (col, k = 1, a = 1) => `rgba(${Math.min(255, col.r * 255 * k) | 0},${Math.min(255, col.g * 255 * k) | 0},${Math.min(255, col.b * 255 * k) | 0},${a})`;

/** Varnished planks: per-board tone, wavy grain, seams and staggered butt joints. */
function makeFloorTexture(baseColor, seed) {
  const col = new THREE.Color(baseColor);
  const rng = makeRng(seed);
  return canvasTex([512, 512], (ctx, W, H) => {
    ctx.fillStyle = rgb(col); ctx.fillRect(0, 0, W, H);
    const rows = 12, rh = H / rows;
    for (let i = 0; i < rows; i++) {
      const y = i * rh;
      const shade = 0.86 + rng.range(28) / 100;
      ctx.fillStyle = rgb(col, shade); ctx.fillRect(0, y, W, rh);
      // Grain: thin wavy darker/lighter lines along the board.
      for (let k = 0; k < 9; k++) {
        const gy = y + 3 + rng.range(Math.max(1, (rh - 6) | 0));
        const amp = 0.6 + rng.range(20) / 10, ph = rng.range(628) / 100;
        ctx.strokeStyle = rgb(col, k % 3 ? 0.78 : 1.12, 0.35);
        ctx.lineWidth = 0.6 + rng.range(10) / 10;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 16) ctx.lineTo(x, gy + Math.sin(x / 55 + ph) * amp);
        ctx.stroke();
      }
      // Seams + a staggered butt joint per row.
      ctx.fillStyle = 'rgba(20,10,5,0.35)'; ctx.fillRect(0, y, W, 1.5);
      const jx = rng.range(W);
      ctx.fillRect(jx, y, 1.5, rh);
    }
  }, { repeat: [3, 3] });
}

/** Near-white plaster with soft mottling and faint vertical wallpaper stripes (tinted by colour). */
function makePlasterTexture(seed, stripes) {
  const rng = makeRng(seed ^ 0x9a57);
  return canvasTex([256, 256], (ctx, W, H) => {
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) {
      const v = 225 + rng.range(30);
      ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
      const r = 1 + rng.range(6);
      ctx.beginPath(); ctx.arc(rng.range(W), rng.range(H), r, 0, 7); ctx.fill();
    }
    for (let i = 0; i < stripes * 2; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.035)';
      ctx.fillRect((i * W) / (stripes * 2), 0, W / (stripes * 2), H);
    }
  }, { repeat: [10, 2] });
}

/** Wainscot: vertical panel grooves. */
function makePanelTexture(seed) {
  void seed;
  return canvasTex([128, 64], (ctx, W, H) => {
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(0, 0, 3, H);
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(3, 0, 2, H);
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.fillRect(0, H - 6, W, 6);
  }, { repeat: [60, 1] });
}

/** Woven rug: concentric bands with a stitched texture (tinted by colour). */
function makeRugTexture(seed) {
  const rng = makeRng(seed ^ 0x2067);
  return canvasTex([512, 512], (ctx, W, H) => {
    ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    for (let r = W / 2; r > 8; r -= 18) {
      const band = ((r / 18) | 0) % 3;
      ctx.strokeStyle = band === 0 ? 'rgba(255,255,255,0.9)' : band === 1 ? 'rgba(200,200,200,0.9)' : 'rgba(235,235,235,0.9)';
      ctx.lineWidth = 16;
      ctx.beginPath(); ctx.arc(cx, cy, r - 9, 0, 7); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.03 + rng.range(5) / 100})`;
      ctx.fillRect(rng.range(W), rng.range(H), 2, 1);
    }
  });
}

/** Yarn ball: wound strands. */
function makeYarnTexture() {
  return canvasTex([128, 64], (ctx, W, H) => {
    ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1.2;
    for (let i = -H; i < W; i += 5) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + H * 0.8, H); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < W + H; i += 9) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - H * 0.7, H); ctx.stroke(); }
  });
}

/** Window sky: vertical gradient; dark skies get a few stars and a moon. */
function makeSkyTexture(skyColor, seed) {
  const col = new THREE.Color(skyColor);
  const dark = col.r * 0.3 + col.g * 0.59 + col.b * 0.11 < 0.35;
  const rng = makeRng(seed ^ 0x57a2);
  return canvasTex([128, 128], (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(col, dark ? 0.85 : 0.92));
    g.addColorStop(1, rgb(col, dark ? 1.45 : 1.12));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (dark) {
      for (let i = 0; i < 26; i++) {
        ctx.fillStyle = `rgba(255,250,235,${0.4 + rng.range(60) / 100})`;
        const r = 0.5 + rng.range(10) / 10;
        ctx.beginPath(); ctx.arc(rng.range(W), rng.range(H * 0.75), r, 0, 7); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,248,225,0.95)';
      ctx.beginPath(); ctx.arc(W * 0.72, H * 0.28, 9, 0, 7); ctx.fill();
      ctx.fillStyle = rgb(col, 0.75);
      ctx.beginPath(); ctx.arc(W * 0.72 + 4, H * 0.28 - 3, 8, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (const [x, y, r] of [[30, 40, 10], [42, 36, 12], [56, 42, 9], [90, 70, 8], [100, 66, 10]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
    }
  });
}

let _radial = null;
/** Shared soft radial falloff (alpha maps for motes, light pool, contact shadow). */
function makeRadialTexture() {
  if (_radial) return _radial;
  _radial = canvasTex([64, 64], (ctx, W, H) => {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    g.addColorStop(0, '#fff'); g.addColorStop(0.45, '#999'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }, { srgb: false });
  _radial.userData.shared = true;
  return _radial;
}

/** GPU name from the unmasked renderer string when the browser exposes it. */
function readGpu(gl) {
  try {
    if (/Firefox/.test(navigator.userAgent)) return String(gl.getParameter(gl.RENDERER) || '');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
  } catch { return ''; }
}

function makeSpriteTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const draw = {
    heart: () => { ctx.fillStyle = '#ff7a9a'; path(ctx, 'M32 54 C6 34 8 12 26 12 C32 12 32 20 32 20 C32 20 32 12 38 12 C56 12 58 34 32 54Z'); },
    bubble: () => { ctx.strokeStyle = '#bfe8ff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(32, 32, 20, 0, 7); ctx.stroke(); },
    note: () => { ctx.fillStyle = '#8ab8ff'; ctx.font = 'bold 44px serif'; ctx.fillText('♪', 32, 34); },
    crumb: () => { ctx.fillStyle = '#d9a441'; ctx.beginPath(); ctx.arc(32, 32, 12, 0, 7); ctx.fill(); },
    zzz: () => { ctx.fillStyle = '#c9c4ff'; ctx.font = 'bold 38px serif'; ctx.fillText('z', 32, 34); },
    star: () => { ctx.fillStyle = '#ffd96a'; path(ctx, 'M32 8 L39 25 L57 25 L42 36 L47 54 L32 44 L17 54 L22 36 L7 25 L25 25 Z'); },
    sparkle: () => { ctx.fillStyle = '#fff3b0'; path(ctx, 'M32 6 L38 26 L58 32 L38 38 L32 58 L26 38 L6 32 L26 26 Z'); },
  };
  (draw[kind] || draw.sparkle)();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function path(ctx, d) { ctx.fill(new Path2D(d)); }

/** Authored low-poly decor meshes keyed by item id. */
function buildDecorMesh(itemId, mat) {
  const g = new THREE.Group();
  g.name = 'decor:' + itemId;
  const add = (geo, m, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  switch (itemId) {
    case 'rug-round': { const m = add(new THREE.CircleGeometry(0.8, 24), mat(0xc9856a, 1)); m.rotation.x = -Math.PI / 2; m.position.set(0, 0.015, 2.2); g.userData.anchored = true; break; }
    case 'plant-fern': add(new THREE.CylinderGeometry(0.16, 0.12, 0.24, 8), mat(0xa3603f, 0.9), 0, 0.12); add(new THREE.ConeGeometry(0.22, 0.5, 7), mat(0x4f8f5a, 0.9), 0, 0.5); break;
    case 'lamp-paper': add(new THREE.CylinderGeometry(0.04, 0.06, 1.4, 8), mat(0x6b5240, 0.7), 0, 0.7); add(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfff0c9, emissive: 0xffdf9a, emissiveIntensity: 0.8 }), 0, 1.5); break;
    case 'shelf-oak': { const m = add(new THREE.BoxGeometry(1.1, 0.06, 0.3), mat(0x7a5a3c, 0.8), 0, 1.6, -3.2); g.userData.anchored = true; void m; break; }
    case 'cushion-moon': { const m = add(new THREE.SphereGeometry(0.34, 12, 9), mat(0x8a9ad9, 1)); m.scale.set(1, 0.4, 1); m.position.y = 0.15; break; }
    case 'poster-comet': { const m = add(new THREE.PlaneGeometry(0.6, 0.8), new THREE.MeshStandardMaterial({ color: 0x30406a, emissive: 0x1a2440, emissiveIntensity: 0.4 }), 3.2, 2.2, -3.2); m.rotation.y = -0.5; g.userData.anchored = true; break; }
    case 'toy-blocks': for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.16, 0.16, 0.16), mat([0xd96a5a, 0x5a8fd9, 0xd9c95a][i], 0.85), i * 0.2 - 0.2, 0.08 + (i === 1 ? 0.16 : 0), i * 0.05); break;
    case 'bowl-gilded': add(new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(0xd9b45a, 0.4, 0.8), 0, 0.2); break;
    case 'curtains-star': { const m = add(new THREE.PlaneGeometry(2.2, 1.9), mat(0x5a6aa3, 1), 0, 2.5, -5.8); g.userData.anchored = true; m.material.side = THREE.DoubleSide; break; }
    case 'clock-drift': { const m = add(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 16), mat(0x9a7a5a, 0.8), 3.4, 2.6, -2.6); m.rotation.x = Math.PI / 2; m.rotation.y = -0.6; g.userData.anchored = true; break; }
    case 'terrarium': add(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshStandardMaterial({ color: 0xbfe8d9, transparent: true, opacity: 0.4, roughness: 0.2 }), 0, 0.24); add(new THREE.ConeGeometry(0.1, 0.2, 6), mat(0x4f8f5a, 0.9), 0, 0.18); break;
    case 'banner-felt': { const m = add(new THREE.PlaneGeometry(1.2, 0.4), mat(0xd97b6a, 1), -3.4, 2.8, -2.6); m.rotation.y = 0.6; g.userData.anchored = true; m.material.side = THREE.DoubleSide; break; }
    default: return null;
  }
  return g;
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

