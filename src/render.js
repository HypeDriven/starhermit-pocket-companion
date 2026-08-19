/**
 * Pocket Companion — render module (Three.js).
 * A cozy customizable room centered on Mote, an expressive procedural
 * creature. Presentation only: consumes immutable snapshots + events,
 * never mutates rules state. Deterministic decoration seed per session.
 */
import * as THREE from '../vendor/three.module.js';
import { makeRng } from './rules.js';
import { THEMES, DECOR_ITEMS } from './content.js';

/* Camera framing constants (no magic offsets). */
const CAM = {
  fov: 34,
  pos: new THREE.Vector3(0, 2.6, 7.4),
  look: new THREE.Vector3(0, 1.05, 0),
  swayAmp: 0.045,
  swaySpeed: 0.00021,
};

const QUALITY = {
  low: { dpr: 1, shadows: false, particles: 60, envDetail: 0.4, antialias: false },
  medium: { dpr: 1.5, shadows: true, particles: 160, envDetail: 0.75, antialias: true },
  high: { dpr: 2, shadows: true, particles: 400, envDetail: 1, antialias: true },
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
    this.tier = 'medium';
    this.reducedMotion = false;
    this.palette = opts.palette || 'default';
    this.decorSeed = opts.decorSeed || 1;
    this.onCreatureTap = null;
    this._time = 0;
    this._shake = 0;
    this._reaction = 0;
    this._mood = 'content';
    this._moodBlend = 0;
    this._blink = 0;
    this._blinkTimer = 2;
    this._hidden = false;
    this._anchors = {};
    this._particles = [];
    this._decorNodes = new Map();
    this._highlight = 0; // -1 invalid, 0 none, 1 valid
  }

  init(tier) {
    this.tier = QUALITY[tier] ? tier : 'medium';
    const q = QUALITY[this.tier];
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance' });
    } catch {
      return false;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.classList.add('game-canvas');
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.1, 60);
    this.camera.position.copy(CAM.pos);
    this.camera.lookAt(CAM.look);

    // Layers: 0 env+gameplay, 1 selection markers, 2 effects.
    this.camera.layers.enable(1);
    this.camera.layers.enable(2);

    this.raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    this._buildLights();
    this._buildRoom('hearthwood');
    this._buildCreature();
    this._buildParticles();
    this._buildMarkers();
    this.resize();

    this.renderer.domElement.addEventListener('pointerdown', (e) => this._tap(e));
    this.ok = true;
    return true;
  }

  /* ---------------- lighting ---------------- */
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xfff2dd, 0x6b5a4a, 0.55);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffe0b3, 1.6);
    this.key.position.set(3.5, 6, 4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.camera.left = -6; this.key.shadow.camera.right = 6;
    this.key.shadow.camera.top = 6; this.key.shadow.camera.bottom = -6;
    this.scene.add(this.key);
    this.lamp = new THREE.PointLight(0xffc978, 12, 9, 1.8);
    this.lamp.position.set(-2.6, 2.4, -1.6);
    this.scene.add(this.lamp);
  }

  /* ---------------- room ---------------- */
  _mat(color, rough = 0.9, metal = 0) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  }

  _buildRoom(themeId) {
    if (this.roomGroup) { this.scene.remove(this.roomGroup); disposeTree(this.roomGroup); }
    const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    this.theme = theme;
    const p = theme.palette;
    const g = new THREE.Group();
    g.name = 'room';

    // Floor with procedural wood-grain canvas texture.
    const floorTex = makeFloorTexture(p.floor, this.decorSeed);
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 6.4, 0.2, 48),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 })
    );
    floor.position.y = -0.1;
    floor.receiveShadow = true;
    g.add(floor);

    // Curved back wall; the opening faces the camera (theta 0 = +Z).
    const wallMat = this._mat(p.wall, 0.95);
    const wallArc = Math.PI * 1.5, wallStart = Math.PI * 0.25;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 4.4, 48, 1, true, wallStart, wallArc), wallMat);
    wall.position.y = 2.1;
    wall.material.side = THREE.BackSide;
    g.add(wall);

    // Wainscot band.
    const band = new THREE.Mesh(new THREE.CylinderGeometry(6.15, 6.15, 0.5, 48, 1, true, wallStart, wallArc), this._mat(p.wallAccent, 0.9));
    band.position.y = 0.25;
    band.material.side = THREE.BackSide;
    g.add(band);

    // Window with glowing sky + open frame (bars, not a panel).
    const win = new THREE.Group();
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), new THREE.MeshBasicMaterial({ color: p.sky }));
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), new THREE.MeshBasicMaterial({ color: p.glow, transparent: true, opacity: 0.22 }));
    glow.position.z = 0.01;
    win.add(sky, glow);
    const frameMat = this._mat(p.wallAccent, 0.8);
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
    win.position.set(0, 2.5, -5.9);
    g.add(win);
    this._anchors.window = win;

    // Rug (contact grounding under Mote).
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.9, 40), this._mat(p.rug, 0.98));
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.011;
    rug.receiveShadow = true;
    g.add(rug);
    const rugRing = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.06, 40), this._mat(p.wallAccent, 0.95));
    rugRing.rotation.x = -Math.PI / 2;
    rugRing.position.y = 0.012;
    g.add(rugRing);

    // Static props per theme (instanced-ish, low-poly authored shapes).
    this._propGroup = new THREE.Group();
    this._addProps(this._propGroup, theme);
    g.add(this._propGroup);

    // Decor item anchors (filled by setDecor).
    this._decorGroup = new THREE.Group();
    g.add(this._decorGroup);

    this.roomGroup = g;
    this.scene.add(g);
    if (this._placedDecor) this.setDecor(this._placedDecor);
    this.key.color.set(p.key);
    this.lamp.color.set(p.glow);
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
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 12, 1, true), new THREE.MeshStandardMaterial({ color: p.glow, roughness: 0.6, emissive: p.glow, emissiveIntensity: 0.5, side: THREE.DoubleSide }));
    shade.position.y = 2.25;
    lampG.add(pole, shade);
    put(lampG, -2.6, -1.6);
    // Plant.
    const plantG = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.3, 10), this._mat(0xa3603f, 0.9));
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
    const cushion = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), this._mat(p.rug, 0.98));
    cushion.scale.set(1, 0.45, 1);
    cushion.position.set(1.9, 0.2, 0.8);
    cushion.castShadow = true;
    group.add(cushion);
    // Toy yarn ball.
    const yarn = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), this._mat(0xd96a8a, 0.9));
    yarn.position.set(-1.3, 0.16, 1.4);
    yarn.castShadow = true;
    group.add(yarn);
  }

  /* ---------------- creature ---------------- */
  _buildCreature() {
    if (this.creature) { this.scene.remove(this.creature); disposeTree(this.creature); }
    const c = new THREE.Group();
    c.name = 'mote';

    this.bodyMat = new THREE.MeshStandardMaterial({ color: MOOD_COLORS.content, roughness: 0.75, emissive: 0x000000 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 28, 22), this.bodyMat);
    body.scale.set(1, 0.92, 0.95);
    body.position.y = 0.62;
    body.castShadow = true;
    c.add(body);
    this._body = body;

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.4, 20, 14), this._mat(0xfff3e0, 0.9));
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
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12), this._mat(0xffffff, 0.4));
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), this._mat(0x2a2430, 0.3));
      pupil.position.z = 0.075;
      eye.add(white, pupil);
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
    const q = QUALITY[this.tier];
    if (this.reducedMotion) count = Math.min(2, count);
    const budget = q.particles - this._particles.length;
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

  setQuality(tier) {
    if (!QUALITY[tier]) return;
    this.tier = tier;
    const q = QUALITY[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.renderer.shadowMap.enabled = q.shadows;
    if (this._propGroup) this._propGroup.visible = q.envDetail > 0.5;
    this.resize();
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
    this.renderer.setSize(w, h);
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
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this._time += dt;
      this._update(dt, now);
      this.renderer.render(this.scene, this.camera);
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
      const target = new THREE.Color(MOOD_COLORS[this._mood] || MOOD_COLORS.content);
      this.bodyMat.color.lerp(target, Math.min(1, dt * 3));
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

  dispose() {
    this.disposed = true;
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
      mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
}
function disposeChildren(group) {
  for (const child of [...group.children]) { group.remove(child); disposeTree(child); }
}

function makeFloorTexture(baseColor, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(baseColor);
  ctx.fillStyle = `rgb(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0})`;
  ctx.fillRect(0, 0, 256, 256);
  const rng = makeRng(seed);
  for (let i = 0; i < 12; i++) {
    const shade = 0.85 + rng.range(30) / 100;
    ctx.fillStyle = `rgba(${col.r * 255 * shade | 0},${col.g * 255 * shade | 0},${col.b * 255 * shade | 0},0.8)`;
    ctx.fillRect(0, i * 22, 256, 20);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.moveTo(0, i * 22); ctx.lineTo(256, i * 22); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
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

export const QUALITY_TIERS = Object.keys(QUALITY);
