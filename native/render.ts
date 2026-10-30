// The cozy room and Mote on starhermit:scene, as the browser build's
// src/render.js drew them with three.js r160: the curved plastered back wall
// with its wainscot band and cap rail, the varnished plank floor, the window
// (gradient sky with stars and moon on dark themes, soft glow, frame and
// sill), the rug and its ring, the theme props (lamp with a bright bulb and a
// point light, potted plant, book shelf, cushion, yarn ball), the placed
// decorations, the window's light pool and drifting dust motes, Mote itself
// (plush body tinted by mood, belly, ears that droop, blinking glossy eyes
// with catchlights, a mouth that follows the mood, cheeks, feet, tail) with a
// soft contact shadow, the highlight ring, the emote particles (hearts,
// bubbles, notes, crumbs, zzz, stars, sparkles) and the camera's authored
// sway. Presentation only: it reads the rules' mood and events and never
// touches the rules state. Deterministic decoration seed per session.
//
// From three.js r160 (physically based lights): colours as written, the
// punctual lights' intensities ÷ π (the engine takes three's legacy units).
// The old composer (RenderPass in half floats → GTAO → UnrealBloom 0.42 /
// 0.45 / 0.92 → the colour grade on the linear buffer → OutputPass with ACES
// → SMAA / FXAA) is the runtime's renderer.ao / bloom / grade / antialias in
// the same order. The emote particles were one instanced billboard mesh with
// a GLSL shader over a sprite atlas: here they are pooled Sprites, one
// texture per emote. Physical sheen (the plush rim) is not drawn by the
// engine: the plush keeps its colour and clear-coat. The old canvas sat
// between the HUD rails: the camera spans the window with a view offset so
// the room is framed in that rectangle (screens.ts paints the page around it).
import {
  ACESFilmicToneMapping, OrthographicCamera, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Group, HemisphereLight, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, Points, PointsMaterial, Raycaster,
  RepeatWrapping, RingGeometry, RoomEnvironment, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, TorusGeometry, Vector2, Vector3,
  renderer, scene, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, Path2D, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, Rules, type Theme } from "./game.ts";
import { MOTE_MAX, spriteCap, type Look } from "./quality.ts";

export interface Rect { x: number; y: number; width: number; height: number }
type Ctx = OffscreenCanvasRenderingContext2D;
type Rng = { range(n: number): number; next(): number };
const rngOf = (seed: number): Rng => Rules.makeRng(seed >>> 0);

/* Camera framing constants (no magic offsets). */
const CAM = { fov: 34, pos: new Vector3(0, 2.6, 7.4), look: new Vector3(0, 1.05, 0), swayAmp: 0.045, swaySpeed: 0.00021 };
/* Environment-map strength: the room map is neutral white, so keep it a gentle fill. */
const ENV = { base: 0.14, glossy: 0.35, hemiWithEnv: 0.3, hemiWithout: 0.55 };
const MOOD_COLORS: Record<string, number> = {
  joyful: 0xffd98a, content: 0xf2c9a0, worried: 0xd9b8a6,
  sad: 0xb9a8b8, sleepy: 0xc9c4e0, proud: 0xffe9a8, miserable: 0x9a8fa8,
};
const SPRITE_KINDS = ["heart", "bubble", "note", "crumb", "zzz", "star", "sparkle"] as const;
type SpriteKind = (typeof SPRITE_KINDS)[number];

// ---------------------------------------------------------------- textures (render.js, unchanged drawing)
/** Procedural canvas textures are authored at a fixed size and drawn at the preset's texScale. */
let TEX_SCALE = 1;
function canvasTex(size: [number, number], draw: (ctx: Ctx, w: number, h: number) => void, opts: { srgb?: boolean; repeat?: [number, number] | null } = {}): CanvasTexture {
  const w = Math.max(8, Math.round(size[0] * TEX_SCALE)), h = Math.max(8, Math.round(size[1] * TEX_SCALE));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")! as Ctx;
  ctx.scale(w / size[0], h / size[1]);
  draw(ctx, size[0], size[1]);
  const tex = new CanvasTexture(c);
  if (opts.srgb !== false) tex.colorSpace = SRGBColorSpace;
  if (opts.repeat) { tex.wrapS = tex.wrapT = RepeatWrapping; tex.repeat.set(opts.repeat[0], opts.repeat[1]); }
  tex.anisotropy = 4;
  return tex;
}
const rgb = (col: Color, k = 1, a = 1): string =>
  `rgba(${Math.min(255, col.r * 255 * k) | 0},${Math.min(255, col.g * 255 * k) | 0},${Math.min(255, col.b * 255 * k) | 0},${a})`;

/** Varnished planks: per-board tone, wavy grain, seams and staggered butt joints. */
function makeFloorTexture(baseColor: number, seed: number): CanvasTexture {
  const col = new Color(baseColor);
  const rng = rngOf(seed);
  return canvasTex([512, 512], (ctx, W, H) => {
    ctx.fillStyle = rgb(col); ctx.fillRect(0, 0, W, H);
    const rows = 12, rh = H / rows;
    for (let i = 0; i < rows; i++) {
      const y = i * rh;
      const shade = 0.86 + rng.range(28) / 100;
      ctx.fillStyle = rgb(col, shade); ctx.fillRect(0, y, W, rh);
      for (let k = 0; k < 9; k++) {
        const gy = y + 3 + rng.range(Math.max(1, (rh - 6) | 0));
        const amp = 0.6 + rng.range(20) / 10, ph = rng.range(628) / 100;
        ctx.strokeStyle = rgb(col, k % 3 ? 0.78 : 1.12, 0.35);
        ctx.lineWidth = 0.6 + rng.range(10) / 10;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 16) ctx.lineTo(x, gy + Math.sin(x / 55 + ph) * amp);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(20,10,5,0.35)"; ctx.fillRect(0, y, W, 1.5);
      const jx = rng.range(W);
      ctx.fillRect(jx, y, 1.5, rh);
    }
  }, { repeat: [3, 3] });
}
/** Near-white plaster with soft mottling and faint vertical wallpaper stripes (tinted by colour). */
function makePlasterTexture(seed: number, stripes: number): CanvasTexture {
  const rng = rngOf(seed ^ 0x9a57);
  return canvasTex([256, 256], (ctx, W, H) => {
    ctx.fillStyle = "#f4f4f4"; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) {
      const v = 225 + rng.range(30);
      ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
      const r = 1 + rng.range(6);
      ctx.beginPath(); ctx.arc(rng.range(W), rng.range(H), r, 0, 7); ctx.fill();
    }
    for (let i = 0; i < stripes * 2; i++) {
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.035)";
      ctx.fillRect((i * W) / (stripes * 2), 0, W / (stripes * 2), H);
    }
  }, { repeat: [10, 2] });
}
/** Wainscot: vertical panel grooves. */
function makePanelTexture(): CanvasTexture {
  return canvasTex([128, 64], (ctx, W, H) => {
    ctx.fillStyle = "#f2f2f2"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fillRect(0, 0, 3, H);
    ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fillRect(3, 0, 2, H);
    ctx.fillStyle = "rgba(0,0,0,0.08)"; ctx.fillRect(0, H - 6, W, 6);
  }, { repeat: [60, 1] });
}
/** Woven rug: concentric bands with a stitched texture (tinted by colour). */
function makeRugTexture(seed: number): CanvasTexture {
  const rng = rngOf(seed ^ 0x2067);
  return canvasTex([512, 512], (ctx, W, H) => {
    ctx.fillStyle = "#e8e8e8"; ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    for (let r = W / 2; r > 8; r -= 18) {
      const band = ((r / 18) | 0) % 3;
      ctx.strokeStyle = band === 0 ? "rgba(255,255,255,0.9)" : band === 1 ? "rgba(200,200,200,0.9)" : "rgba(235,235,235,0.9)";
      ctx.lineWidth = 16;
      ctx.beginPath(); ctx.arc(cx, cy, r - 9, 0, 7); ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.12)"; ctx.lineWidth = 1.2;
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
function makeYarnTexture(): CanvasTexture {
  return canvasTex([128, 64], (ctx, W, H) => {
    ctx.fillStyle = "#f0f0f0"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = 1.2;
    for (let i = -H; i < W; i += 5) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + H * 0.8, H); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    for (let i = 0; i < W + H; i += 9) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - H * 0.7, H); ctx.stroke(); }
  });
}
/** Window sky: vertical gradient; dark skies get a few stars and a moon. */
function makeSkyTexture(skyColor: number, seed: number): CanvasTexture {
  const col = new Color(skyColor);
  const dark = col.r * 0.3 + col.g * 0.59 + col.b * 0.11 < 0.35;
  const rng = rngOf(seed ^ 0x57a2);
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
      ctx.fillStyle = "rgba(255,248,225,0.95)";
      ctx.beginPath(); ctx.arc(W * 0.72, H * 0.28, 9, 0, 7); ctx.fill();
      ctx.fillStyle = rgb(col, 0.75);
      ctx.beginPath(); ctx.arc(W * 0.72 + 4, H * 0.28 - 3, 8, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      for (const [x, y, r] of [[30, 40, 10], [42, 36, 12], [56, 42, 9], [90, 70, 8], [100, 66, 10]] as const) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
    }
  });
}
let radial: CanvasTexture | null = null;
/** Shared soft radial falloff (alpha maps for motes, light pool, contact shadow). */
function radialTexture(): CanvasTexture {
  if (radial) return radial;
  const keep = TEX_SCALE;
  TEX_SCALE = 1;
  radial = canvasTex([64, 64], (ctx, W, H) => {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    // render.js drew this as a grey alpha map (#fff → #999 → #000); the engine's basic materials take no
    // alphaMap, so the same falloff is the alpha of a white map.
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.45, "rgba(255,255,255,0.6)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }, { srgb: false });
  TEX_SCALE = keep;
  return radial;
}
/** One emote sprite (64 px, render.js drawSprite). */
function spriteTexture(kind: SpriteKind): CanvasTexture {
  const c = new OffscreenCanvas(64, 64);
  const ctx = c.getContext("2d")! as Ctx;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const path = (d: string): void => { ctx.fill(new Path2D(d)); };
  switch (kind) {
    case "heart": ctx.fillStyle = "#ff7a9a"; path("M32 54 C6 34 8 12 26 12 C32 12 32 20 32 20 C32 20 32 12 38 12 C56 12 58 34 32 54Z"); break;
    case "bubble": ctx.strokeStyle = "#bfe8ff"; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(32, 32, 20, 0, 7); ctx.stroke(); break;
    case "note": ctx.fillStyle = "#8ab8ff"; ctx.font = "bold 44px serif"; ctx.fillText("♪", 32, 34); break;
    case "crumb": ctx.fillStyle = "#d9a441"; ctx.beginPath(); ctx.arc(32, 32, 12, 0, 7); ctx.fill(); break;
    case "zzz": ctx.fillStyle = "#c9c4ff"; ctx.font = "bold 38px serif"; ctx.fillText("z", 32, 34); break;
    case "star": ctx.fillStyle = "#ffd96a"; path("M32 8 L39 25 L57 25 L42 36 L47 54 L32 44 L17 54 L22 36 L7 25 L25 25 Z"); break;
    default: ctx.fillStyle = "#fff3b0"; path("M32 6 L38 26 L58 32 L38 38 L32 58 L26 38 L6 32 L26 26 Z"); break;
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}


/**
 * Merge a group's static, untextured, non-emissive meshes that share a shading signature into one mesh
 * each (colours baked into vertex colours), so props cost one draw call per signature (render.js mergeStatic).
 */
function mergeStatic(root: Group): void {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, Mesh[]>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!(mesh instanceof Mesh)) return;
    const m = mesh.material as MeshStandardMaterial;
    if (Array.isArray(m) || m.map || m.transparent || m instanceof MeshBasicMaterial || mesh.userData.keep) return;
    if (m.emissive && m.emissive.getHex() !== 0) return;
    const key = [m.constructor.name, m.roughness, m.metalness, m.side, m.envMapIntensity, mesh.castShadow, mesh.receiveShadow].join("|");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(mesh);
  });
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const parts = list.map((o) => {
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(new Matrix4().multiplyMatrices(inv, o.matrixWorld));
      return { g, color: (o.material as MeshStandardMaterial).color };
    });
    const n = parts.reduce((a, p) => a + p.g.attributes.position!.count, 0);
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let off = 0;
    for (const { g, color } of parts) {
      const c = g.attributes.position!.count;
      pos.set(g.attributes.position!.array as Float32Array, off * 3);
      nor.set(g.attributes.normal!.array as Float32Array, off * 3);
      for (let i = 0; i < c; i++) { col[(off + i) * 3] = color.r; col[(off + i) * 3 + 1] = color.g; col[(off + i) * 3 + 2] = color.b; }
      off += c;
      g.dispose();
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("normal", new BufferAttribute(nor, 3));
    geo.setAttribute("color", new BufferAttribute(col, 3));
    const mat = (list[0]!.material as MeshStandardMaterial).clone();
    mat.color.set(0xffffff);
    mat.vertexColors = true;
    const merged = new Mesh(geo, mat);
    merged.castShadow = list[0]!.castShadow;
    merged.receiveShadow = list[0]!.receiveShadow;
    root.add(merged);
    for (const o of list) { o.parent?.remove(o); o.geometry.dispose(); }
  }
}
function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

// ---------------------------------------------------------------- the scene
const camera = new PerspectiveCamera(CAM.fov, 1, 0.1, 60);
camera.position.copy(CAM.pos);
camera.lookAt(CAM.look);
/** The old canvas's camera (the playfield's aspect, no view offset): projection and picking. */
const probe = new PerspectiveCamera(CAM.fov, 1, 0.1, 60);

const hemi = new HemisphereLight(0xfff2dd, 0x6b5a4a, ENV.hemiWithout);
const key = new DirectionalLight(0xffe0b3, 1.6);
key.position.set(3.5, 6, 4);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
{ // the page's fixed shadow box around the room
  const sc = key.shadow.camera as OrthographicCamera;
  sc.left = -5.2; sc.right = 5.2; sc.top = 5.2; sc.bottom = -5.2; sc.near = 3; sc.far = 17;
  sc.updateProjectionMatrix();
}
const lamp = new PointLight(0xffc978, 12, 9, 1.8);
lamp.position.set(-2.6, 2.4, -1.6);
scene.add(hemi, key, key.target, lamp);

let look: Look | null = null;
const tier = (): "lambert" | "standard" | "physical" => look?.budget.material ?? "standard";
const detailed = (): boolean => !!look?.detailed;
let envTex: Texture | null = null;
/** Every material that takes the room environment, with its old envMapIntensity. */
const envMats = new Set<MeshStandardMaterial>();

function mat(color: number | Color, rough = 0.9, metal = 0): Material {
  if (tier() === "lambert") return new MeshLambertMaterial({ color });
  const m = new MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: metal > 0.3 ? ENV.glossy : ENV.base });
  envMats.add(m);
  return m;
}
interface SurfParams { color?: number | Color; map?: Texture | null; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number; envMapIntensity?: number; emissive?: number }
/** Clear-coat surface for the preset's budget: Physical on High/Ultra, Standard on Balanced, Lambert on Low (sheen is not drawn). */
function surf(p: SurfParams): MeshLambertMaterial | MeshStandardMaterial {
  const t = tier();
  if (t === "lambert") {
    const m = new MeshLambertMaterial({ color: p.color ?? 0xffffff });
    if (p.map) m.map = p.map;
    return m;
  }
  const base = { color: p.color ?? 0xffffff, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0, envMapIntensity: p.envMapIntensity ?? 1 };
  const m = t === "physical"
    ? new MeshPhysicalMaterial({ ...base, clearcoat: p.clearcoat ?? 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 })
    : new MeshStandardMaterial(base);
  if (p.map) m.map = p.map;
  if (p.emissive !== undefined) m.emissive.set(p.emissive);
  envMats.add(m);
  return m;
}
/** Procedural surface maps only the "detailed" look shows. */
const detailMaps: { mat: MeshStandardMaterial | MeshLambertMaterial; map: Texture }[] = [];
function detailMap(m: Material, map: Texture): void {
  const mm = m as MeshStandardMaterial;
  detailMaps.push({ mat: mm, map });
  mm.map = detailed() ? map : null;
}

// ---------------------------------------------------------------- room
let theme: Theme = Content.THEMES[0]!;
let decorSeed = 1;
let roomGroup: Group | null = null;
let ambientGroup: Group | null = null;
let propGroup: Group | null = null;
let decorGroup: Group | null = null;
let windowGlow: Mesh | null = null;
let windowAnchor: Group | null = null;
let motes: Points | null = null;
let motesMat: PointsMaterial | null = null;
let moteSeeds = new Float32Array(MOTE_MAX * 4);
let placedDecor: string[] = [];
let builtRoom = "";

function buildRoom(): void {
  if (roomGroup) { scene.remove(roomGroup); disposeTree(roomGroup); }
  if (ambientGroup) { scene.remove(ambientGroup); disposeTree(ambientGroup); }
  for (const d of detailMaps) d.map.dispose();
  detailMaps.length = 0;
  for (const m of envMats) if (!creatureMats.has(m)) envMats.delete(m);
  const p = theme.palette;
  const g = new Group();
  const seed = decorSeed;
  TEX_SCALE = look?.budget.texScale ?? 1;
  // Floor: varnished planks with per-board tone, grain and seams.
  const floorMat = surf({ map: makeFloorTexture(p.floor, seed), roughness: 0.72, clearcoat: 0.25, clearcoatRoughness: 0.45, envMapIntensity: ENV.base });
  const floor = new Mesh(new CylinderGeometry(6.4, 6.4, 0.2, 64), floorMat);
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  g.add(floor);
  // Curved back wall; the opening faces the camera (theta 0 = +Z).
  const wallMat = mat(p.wall, 0.95);
  detailMap(wallMat, makePlasterTexture(seed, 3));
  const wallArc = Math.PI * 1.5, wallStart = Math.PI * 0.25;
  wallMat.side = BackSide;
  const wall = new Mesh(new CylinderGeometry(6.2, 6.2, 4.4, 64, 1, true, wallStart, wallArc), wallMat);
  wall.position.y = 2.1;
  wall.receiveShadow = true;
  g.add(wall);
  // Wainscot band with a small cap rail.
  const bandMat = mat(p.wallAccent, 0.8);
  detailMap(bandMat, makePanelTexture());
  bandMat.side = BackSide;
  const band = new Mesh(new CylinderGeometry(6.15, 6.15, 0.5, 64, 1, true, wallStart, wallArc), bandMat);
  band.position.y = 0.25;
  band.receiveShadow = true;
  g.add(band);
  const rail = new Mesh(new TorusGeometry(6.1, 0.035, 6, 96, wallArc), mat(p.wallAccent, 0.55));
  rail.rotation.x = Math.PI / 2;
  rail.rotation.z = -(wallStart + wallArc) + Math.PI / 2;
  rail.position.y = 0.5;
  g.add(rail);
  // Window: gradient sky (stars on dark themes), soft glow, open frame + sill.
  const win = new Group();
  const skyMat = new MeshBasicMaterial({ map: makeSkyTexture(p.sky, seed) });
  skyMat.color.setRGB(1.15, 1.15, 1.15); // a touch over white so the window reads as a light source
  const sky = new Mesh(new PlaneGeometry(1.7, 1.5), skyMat);
  const glow = new Mesh(new PlaneGeometry(1.7, 1.5), new MeshBasicMaterial({ color: p.glow, transparent: true, opacity: 0.1 }));
  glow.position.z = 0.01;
  windowGlow = glow;
  win.add(sky, glow);
  const frameMat = mat(p.wallAccent, 0.7);
  for (const [w, h, d, x, y] of [[1.9, 0.1, 0.1, 0, 0.8], [1.9, 0.1, 0.1, 0, -0.8], [0.1, 1.7, 0.1, -0.9, 0], [0.1, 1.7, 0.1, 0.9, 0], [0.06, 1.6, 0.1, 0, 0], [1.8, 0.06, 0.1, 0, 0]] as const) {
    const bar = new Mesh(new BoxGeometry(w, h, d), frameMat);
    bar.position.set(x, y, 0.02);
    win.add(bar);
  }
  const sill = new Mesh(new BoxGeometry(2.1, 0.07, 0.26), frameMat);
  sill.position.set(0, -0.88, 0.1);
  win.add(sill);
  mergeStatic(win);
  win.position.set(0, 2.5, -5.9);
  g.add(win);
  windowAnchor = win;
  // Rug (contact grounding under Mote): woven rings when detailed.
  const rugMat = mat(p.rug, 0.98);
  detailMap(rugMat, makeRugTexture(seed));
  const rug = new Mesh(new CircleGeometry(1.9, 64), rugMat);
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.011;
  rug.receiveShadow = true;
  g.add(rug);
  const rugRing = new Mesh(new RingGeometry(1.9, 2.06, 64), mat(p.wallAccent, 0.95));
  rugRing.rotation.x = -Math.PI / 2;
  rugRing.position.y = 0.012;
  rugRing.receiveShadow = true;
  g.add(rugRing);
  // Static props per theme (low-poly authored shapes).
  propGroup = new Group();
  addProps(propGroup);
  mergeStatic(propGroup);
  g.add(propGroup);
  decorGroup = new Group();
  g.add(decorGroup);
  roomGroup = g;
  scene.add(g);
  buildAmbient();
  setDecor(placedDecor);
  key.color.set(p.key);
  lamp.color.set(p.glow);
  builtRoom = roomKey();
  applyScene();
}
const roomKey = (): string => `${theme.id}|${decorSeed}|${tier()}|${look?.budget.texScale ?? 1}`;

/** Window light pool + dust motes (effects layer). */
function buildAmbient(): void {
  const p = theme.palette;
  const grp = new Group();
  const beam = new Color(p.sky).lerp(new Color(p.glow), 0.35).lerp(new Color(0xffffff), 0.45);
  const pool = new Mesh(new CircleGeometry(1, 32), new MeshBasicMaterial({
    color: beam, map: radialTexture(), transparent: true, opacity: 0.1, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  pool.rotation.x = -Math.PI / 2;
  pool.scale.set(1.5, 0.9, 1);
  pool.position.set(0, 0.02, -3.1);
  grp.add(pool);
  const n = MOTE_MAX; // built at the largest budget; the look draws budget.motes of them
  const rng = rngOf(decorSeed ^ 0xd057);
  const pos = new Float32Array(n * 3);
  moteSeeds = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = rng.range(1000) / 1000;
    const x = (rng.range(1000) / 1000 - 0.5) * (1.6 + (1 - t) * 0.6);
    moteSeeds.set([x, 0.3 + t * 2.7, -2.8 - t * 2.9, rng.range(628) / 100], i * 4);
    pos.set([x, 0.3 + t * 2.7, -2.8 - t * 2.9], i * 3);
  }
  const mg = new BufferGeometry();
  mg.setAttribute("position", new BufferAttribute(pos, 3));
  mg.setDrawRange(0, Math.min(n, look?.budget.motes ?? 50));
  motesMat = new PointsMaterial({
    color: beam.clone(), map: radialTexture(), size: 0.028, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  motes = new Points(mg, motesMat);
  motes.frustumCulled = false;
  grp.add(motes);
  ambientGroup = grp;
  scene.add(grp);
}

let lampShade: MeshStandardMaterial | null = null;
function addProps(group: Group): void {
  const p = theme.palette;
  const rng = rngOf(decorSeed ^ 0x5eed);
  const put = (mesh: Object3D, x: number, z: number): void => {
    mesh.position.x = x; mesh.position.z = z;
    mesh.traverse((m) => { if (m instanceof Mesh) { m.castShadow = true; m.receiveShadow = true; } });
    group.add(mesh);
  };
  // Lamp.
  const lampG = new Group();
  const pole = new Mesh(new CylinderGeometry(0.05, 0.08, 2.2, 10), mat(0x6b5240, 0.7));
  pole.position.y = 1.1;
  lampShade = new MeshStandardMaterial({ color: p.glow, roughness: 0.6, emissive: p.glow, emissiveIntensity: 0.55, side: DoubleSide });
  envMats.add(lampShade);
  const shade = new Mesh(new ConeGeometry(0.42, 0.5, 24, 1, true), lampShade);
  shade.position.y = 2.25;
  // Warm bulb under the shade: the brightest thing in the room, so bloom picks it out.
  const bulb = new Mesh(new SphereGeometry(0.09, 12, 8), new MeshBasicMaterial({ color: new Color(p.glow).multiplyScalar(3) }));
  bulb.position.y = 2.08;
  const base = new Mesh(new CylinderGeometry(0.26, 0.3, 0.06, 20), mat(0x5a4332, 0.5, 0.2));
  base.position.y = 0.03;
  lampG.add(pole, shade, bulb, base);
  put(lampG, -2.6, -1.6);
  // Plant.
  const plantG = new Group();
  const pot = new Mesh(new CylinderGeometry(0.22, 0.16, 0.3, 16), surf({ color: 0xa3603f, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.3, envMapIntensity: ENV.base }));
  pot.position.y = 0.15;
  plantG.add(pot);
  for (let i = 0; i < 5; i++) {
    const leaf = new Mesh(new ConeGeometry(0.09, 0.55 + rng.range(30) / 100, 6), mat(0x5a8f4f, 0.9));
    leaf.position.y = 0.55;
    leaf.rotation.z = (i / 5 - 0.5) * 1.2;
    leaf.rotation.y = i * 1.3;
    plantG.add(leaf);
  }
  put(plantG, 2.7, -2.0);
  // Shelf with books.
  const shelfG = new Group();
  shelfG.add(new Mesh(new BoxGeometry(1.6, 0.08, 0.34), mat(0x7a5a3c, 0.8)));
  const bookColors = [0xa34a3a, 0x3f7f8f, 0xd9a441, 0x6a8f5a, 0x8f5a8f, 0x4a6aa3];
  for (let i = 0; i < 6; i++) {
    const book = new Mesh(new BoxGeometry(0.12, 0.34 + rng.range(12) / 100, 0.24), mat(bookColors[i]!, 0.85));
    book.position.set(-0.6 + i * 0.22, 0.24, 0);
    book.rotation.z = (rng.range(10) - 5) / 100;
    shelfG.add(book);
  }
  shelfG.position.set(-2.9, 2.5, -3.4);
  shelfG.rotation.y = 0.5;
  group.add(shelfG);
  // Cushion.
  const cushion = new Mesh(new SphereGeometry(0.42, 24, 16), surf({ color: p.rug, roughness: 0.9, envMapIntensity: ENV.base }));
  cushion.receiveShadow = true;
  cushion.scale.set(1, 0.45, 1);
  cushion.position.set(1.9, 0.2, 0.8);
  cushion.castShadow = true;
  group.add(cushion);
  // Toy yarn ball.
  const yarnMat = mat(0xd96a8a, 0.95);
  detailMap(yarnMat, makeYarnTexture());
  const yarn = new Mesh(new SphereGeometry(0.16, 20, 14), yarnMat);
  yarn.position.set(-1.3, 0.16, 1.4);
  yarn.castShadow = true;
  group.add(yarn);
}

/** Authored low-poly decor meshes keyed by item id (render.js buildDecorMesh). */
function buildDecorMesh(itemId: string): Group | null {
  const g = new Group();
  const add = (geo: BufferGeometry, m: Material, x = 0, y = 0, z = 0): Mesh => {
    const mesh = new Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial => { const m = new MeshStandardMaterial(o); envMats.add(m); return m; };
  switch (itemId) {
    case "rug-round": { const m = add(new CircleGeometry(0.8, 24), mat(0xc9856a, 1)); m.rotation.x = -Math.PI / 2; m.position.set(0, 0.015, 2.2); g.userData.anchored = true; break; }
    case "plant-fern": add(new CylinderGeometry(0.16, 0.12, 0.24, 8), mat(0xa3603f, 0.9), 0, 0.12); add(new ConeGeometry(0.22, 0.5, 7), mat(0x4f8f5a, 0.9), 0, 0.5); break;
    case "lamp-paper": add(new CylinderGeometry(0.04, 0.06, 1.4, 8), mat(0x6b5240, 0.7), 0, 0.7); add(new SphereGeometry(0.22, 10, 8), std({ color: 0xfff0c9, emissive: 0xffdf9a, emissiveIntensity: 0.8 }), 0, 1.5); break;
    case "shelf-oak": add(new BoxGeometry(1.1, 0.06, 0.3), mat(0x7a5a3c, 0.8), 0, 1.6, -3.2); g.userData.anchored = true; break;
    case "cushion-moon": { const m = add(new SphereGeometry(0.34, 12, 9), mat(0x8a9ad9, 1)); m.scale.set(1, 0.4, 1); m.position.y = 0.15; break; }
    case "poster-comet": { const m = add(new PlaneGeometry(0.6, 0.8), std({ color: 0x30406a, emissive: 0x1a2440, emissiveIntensity: 0.4 }), 3.2, 2.2, -3.2); m.rotation.y = -0.5; g.userData.anchored = true; break; }
    case "toy-blocks": for (let i = 0; i < 3; i++) add(new BoxGeometry(0.16, 0.16, 0.16), mat([0xd96a5a, 0x5a8fd9, 0xd9c95a][i]!, 0.85), i * 0.2 - 0.2, 0.08 + (i === 1 ? 0.16 : 0), i * 0.05); break;
    case "bowl-gilded": add(new SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(0xd9b45a, 0.4, 0.8), 0, 0.2); break;
    case "curtains-star": { const m = mat(0x5a6aa3, 1); (m as MeshStandardMaterial).side = DoubleSide; add(new PlaneGeometry(2.2, 1.9), m, 0, 2.5, -5.8); g.userData.anchored = true; break; }
    case "clock-drift": { const m = add(new CylinderGeometry(0.3, 0.3, 0.06, 16), mat(0x9a7a5a, 0.8), 3.4, 2.6, -2.6); m.rotation.x = Math.PI / 2; m.rotation.y = -0.6; g.userData.anchored = true; break; }
    case "terrarium": add(new SphereGeometry(0.22, 12, 10), std({ color: 0xbfe8d9, transparent: true, opacity: 0.4, roughness: 0.2 }), 0, 0.24); add(new ConeGeometry(0.1, 0.2, 6), mat(0x4f8f5a, 0.9), 0, 0.18); break;
    case "banner-felt": { const m = mat(0xd97b6a, 1); (m as MeshStandardMaterial).side = DoubleSide; const b = add(new PlaneGeometry(1.2, 0.4), m, -3.4, 2.8, -2.6); b.rotation.y = 0.6; g.userData.anchored = true; break; }
    default: return null;
  }
  return g;
}

// ---------------------------------------------------------------- creature
const creature = new Group();
scene.add(creature);
const creatureMats = new Set<MeshStandardMaterial>();
let bodyMat: MeshLambertMaterial | MeshStandardMaterial | null = null;
let body: Mesh | null = null;
let ears: Mesh[] = [];
let eyes: Group[] = [];
let mouth: Mesh | null = null;
let bodySegs = "";
const blob = new Mesh(new CircleGeometry(0.78, 32), new MeshBasicMaterial({ color: 0x000000, map: radialTexture(), transparent: true, opacity: 0.4, depthWrite: false }));
blob.rotation.x = -Math.PI / 2;
blob.position.set(0, 0.016, 0.05);
scene.add(blob);
let builtCreature = "";

function buildCreature(): void {
  for (const c of [...creature.children]) { creature.remove(c); disposeTree(c); }
  for (const m of creatureMats) envMats.delete(m);
  creatureMats.clear();
  const cs = (m: MeshLambertMaterial | MeshStandardMaterial): typeof m => { if (m instanceof MeshStandardMaterial) creatureMats.add(m); return m; };
  bodyMat = cs(surf({ color: MOOD_COLORS.content!, roughness: 0.78, emissive: 0x000000, envMapIntensity: ENV.base }));
  const segs = look?.budget.body ?? [32, 24];
  bodySegs = segs.join("x");
  body = new Mesh(new SphereGeometry(0.62, segs[0], segs[1]), bodyMat);
  body.scale.set(1, 0.92, 0.95);
  body.position.y = 0.62;
  body.castShadow = true;
  creature.add(body);
  const belly = new Mesh(new SphereGeometry(0.4, 28, 18), cs(surf({ color: 0xfff3e0, roughness: 0.9, envMapIntensity: ENV.base })));
  belly.scale.set(0.85, 0.72, 0.5);
  belly.position.set(0, 0.5, 0.36);
  creature.add(belly);
  ears = [];
  for (const side of [-1, 1]) {
    const ear = new Mesh(new ConeGeometry(0.16, 0.42, 10), bodyMat);
    ear.position.set(side * 0.34, 1.18, 0);
    ear.rotation.z = -side * 0.35;
    ear.castShadow = true;
    creature.add(ear);
    ears.push(ear);
  }
  eyes = [];
  for (const side of [-1, 1]) {
    const eye = new Group();
    // Glossy eyes (clearcoat) with a catchlight so Mote reads as alive in every tier.
    const white = new Mesh(new SphereGeometry(0.115, 20, 16), cs(surf({ color: 0xe9e4de, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: ENV.glossy })));
    const pupil = new Mesh(new SphereGeometry(0.055, 16, 12), cs(surf({ color: 0x2a2430, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: ENV.glossy })));
    pupil.position.z = 0.075;
    const glint = new Mesh(new SphereGeometry(0.018, 8, 6), new MeshBasicMaterial({ color: 0xffffff }));
    glint.position.set(-0.022, 0.026, 0.118);
    eye.add(white, pupil, glint);
    eye.position.set(side * 0.23, 0.78, 0.5);
    creature.add(eye);
    eyes.push(eye);
  }
  const mouthMat = mat(0x7a4a3a, 0.6);
  if (mouthMat instanceof MeshStandardMaterial) creatureMats.add(mouthMat);
  mouth = new Mesh(new TorusGeometry(0.11, 0.022, 8, 16, Math.PI), mouthMat);
  mouth.position.set(0, 0.6, 0.56);
  mouth.rotation.z = Math.PI; // smile by default
  creature.add(mouth);
  for (const side of [-1, 1]) {
    const cheekMat = new MeshStandardMaterial({ color: 0xf0908a, roughness: 1, transparent: true, opacity: 0.65 });
    creatureMats.add(cheekMat);
    const cheek = new Mesh(new SphereGeometry(0.07, 10, 8), cheekMat);
    cheek.position.set(side * 0.38, 0.62, 0.46);
    cheek.scale.z = 0.4;
    creature.add(cheek);
  }
  for (const side of [-1, 1]) {
    const foot = new Mesh(new SphereGeometry(0.14, 10, 8), bodyMat);
    foot.scale.set(1, 0.5, 1.2);
    foot.position.set(side * 0.28, 0.07, 0.25);
    creature.add(foot);
  }
  const tailMat = mat(0xfff3e0, 0.95);
  if (tailMat instanceof MeshStandardMaterial) creatureMats.add(tailMat);
  const tail = new Mesh(new SphereGeometry(0.16, 10, 8), tailMat);
  tail.position.set(0, 0.42, -0.55);
  creature.add(tail);
  for (const m of creatureMats) envMats.add(m);
  builtCreature = tier();
  applyScene();
}

// ---------------------------------------------------------------- highlight ring and particles
const ringMat = new MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, side: DoubleSide });
const ring = new Mesh(new RingGeometry(0.85, 1.0, 40), ringMat);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.02;
scene.add(ring);

const spriteTex = new Map<SpriteKind, CanvasTexture>();
interface Particle { x: number; y: number; z: number; rot: number; scale: number; kind: SpriteKind; life: number; maxLife: number; vx: number; vy: number; vz: number }
const particles: Particle[] = [];
const spritePool: Sprite[] = [];
const fxRng = rngOf(0xe307);
const rand = (): number => fxRng.next() / 4294967296;
function burst(kind: SpriteKind, count = 8): void {
  if (reducedMotion) count = Math.min(2, count);
  const budget = (look ? spriteCap(look) : 160) - particles.length;
  const n = Math.max(0, Math.min(count, budget));
  for (let i = 0; i < n; i++) {
    particles.push({
      x: (rand() - 0.5) * 0.8, y: 0.9 + rand() * 0.5, z: 0.5 + rand() * 0.2,
      rot: rand() * 0.6 - 0.3, scale: 0.18 + rand() * 0.14, kind, life: 0,
      maxLife: reducedMotion ? 0.5 : 1.1 + rand() * 0.5,
      vx: (rand() - 0.5) * 0.5, vy: 0.8 + rand() * 0.6, vz: (rand() - 0.5) * 0.2,
    });
  }
}
function stepParticles(dt: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life += dt;
    if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
  }
  particles.forEach((p, i) => {
    let s = spritePool[i];
    if (!s) {
      s = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false }));
      spritePool.push(s);
      scene.add(s);
    }
    let tex = spriteTex.get(p.kind);
    if (!tex) { tex = spriteTexture(p.kind); spriteTex.set(p.kind, tex); }
    if (s.material.map !== tex) s.material.map = tex;
    s.material.rotation = p.rot;
    s.material.opacity = 1 - p.life / p.maxLife;
    s.position.set(p.x, p.y, p.z);
    s.scale.set(p.scale, p.scale, 1);
    s.visible = true;
  });
  for (let i = particles.length; i < spritePool.length; i++) spritePool[i]!.visible = false;
}

// ---------------------------------------------------------------- state
let reducedMotion = false;
let mood = "content";
const moodColor = new Color();
let reaction = 0;
let wobble = 0;
let blink = 0;
let blinkTimer = 2;
let highlight = 0; // -1 invalid, 0 none, 1 valid
let shake = 0;
let elapsed = 0;
let active = false;

// ---------------------------------------------------------------- the look (setGraphics)
/** Push the look's tiers into lights, materials and effect groups (render.js _applyScene). */
function applyScene(): void {
  if (!look) return;
  const size = look.shadows;
  renderer.shadowMap.enabled = size > 0;
  key.castShadow = size > 0;
  if (size > 0) key.shadow.mapSize = size;
  const env = look.reflections;
  if (env && !envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  // r160 scaled scene.environment by each material's envMapIntensity; at engine minor 20 (three r185) the
  // scene environment ignores it, so every lit material carries the environment as its own envMap.
  for (const m of envMats) { const want = env ? envTex : null; if (m.envMap !== want) m.envMap = want; }
  hemi.intensity = (env ? ENV.hemiWithEnv : ENV.hemiWithout);
  const det = look.detailed;
  if (propGroup) propGroup.visible = det;
  for (const d of detailMaps) { const want = det ? d.map : null; if (d.mat.map !== want) d.mat.map = want; }
  if (ambientGroup) ambientGroup.visible = look.ambient;
  if (motes) motes.geometry.setDrawRange(0, Math.min(MOTE_MAX, look.budget.motes));
  (blob.material as MeshBasicMaterial).opacity = size > 0 ? 0.28 : 0.42;
}
/** The runtime's quality tier applied live (no reload): asset variants, effects and the post chain. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // UnrealBloomPass(0.42, 0.45, 0.92): only the lamp bulb, window, eye glints and sparkles bloom.
  // three r160 page: UnrealBloomPass 0.42 squared (0.1764) for the engine's r185 bloom (engine.minor 29).
  renderer.bloom = next.bloom ? { strength: 0.1764, radius: 0.45, threshold: 0.92, resolution: b.bloomRes } : null;
  // GTAOPass: radius 0.45, distance exponent 1.4, thickness 1; 16 / 8 samples and the denoise per tier; blend 0.85.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.85, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1,
    samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader on the linear buffer before OutputPass: a 0.22 S-curve, saturation 1.07, cool shadows / warm
  // highlights by a smoothstep of luma from 0.15 to 0.85, a 0.24 vignette from 0.38 to 0.9 (x scaled 1.1).
  // Its final small lift (× 0.975 + 0.02) is levels; the page clamped, so no overRange "keep".
  renderer.grade = next.grade ? {
    space: "linear", contrast: 0.22, saturation: 1.07, levels: [0.975, 0.02], split: [0.15, 0.85], shadows: [0.97, 0.98, 1.04], highlights: [1.04, 1.0, 0.95],
    vignette: { amount: 0.24, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  // Background via scene.background; the post chain tone-maps it as the old composer did (engine.minor 29).
  scene.background = new Color(0x241d2b);
  if (particles.length > spriteCap(next)) particles.splice(0, particles.length - spriteCap(next));
  if (builtCreature !== tier()) buildCreature();
  else if (body && bodySegs !== b.body.join("x")) {
    bodySegs = b.body.join("x");
    body.geometry.dispose();
    body.geometry = new SphereGeometry(0.62, b.body[0], b.body[1]);
  }
  if (builtRoom && builtRoom !== roomKey()) buildRoom();
  applyScene();
}

/** The session's theme and decoration seed (render.js setTheme with decorSeed). */
export function setTheme(themeId: string, seed: number): void {
  theme = Content.THEMES.find((t) => t.id === themeId) ?? Content.THEMES[0]!;
  decorSeed = seed >>> 0 || 1;
  if (!body) buildCreature();
  if (builtRoom !== roomKey()) buildRoom();
}
export function setDecor(items: string[]): void {
  placedDecor = [...items];
  if (!decorGroup) return;
  for (const c of [...decorGroup.children]) { decorGroup.remove(c); disposeTree(c); }
  const rng = rngOf(decorSeed ^ 0xdec0);
  items.forEach((itemId, i) => {
    const node = buildDecorMesh(itemId);
    if (!node) return;
    const angle = (i / Math.max(1, items.length)) * Math.PI * 1.2 - Math.PI * 0.6;
    const r = 2.6 + rng.range(8) / 10;
    if (!node.userData.anchored) node.position.set(Math.sin(angle) * r, 0, Math.cos(angle) * -r * 0.7 - 0.6);
    node.rotation.y = rng.range(60) / 100 - 0.3;
    decorGroup!.add(node);
  });
  const env = look?.reflections ? envTex : null;
  for (const m of envMats) if (m.envMap !== env) m.envMap = env;
}
export function setMood(m: string): void { if (MOOD_COLORS[m]) mood = m; }

/** Presentation reaction for a rules event (event hierarchy enforced). */
export function react(actionId: string, kind: string, opts: { discovery?: boolean; cravingMet?: boolean } = {}): void {
  const tierMap: Record<string, number> = { ack: 0, care: 1, bond: 1, room: 1, pass: 0, discovery: 2, goal: 2, round: 3 };
  const t = opts.discovery ? 2 : (tierMap[kind] ?? 1);
  reaction = Math.max(reaction, t === 0 ? 0.25 : t === 1 ? 0.7 : 1.0);
  const bursts: Record<string, [SpriteKind, number]> = {
    feed: ["crumb", 8], wash: ["bubble", 10], play: ["star", 8], rest: ["zzz", 6],
    pet: ["heart", 6], sing: ["note", 7], toss: ["star", 10], snack: ["crumb", 5], decorate: ["sparkle", 8],
  };
  const b = bursts[actionId];
  if (b) burst(b[0], b[1]);
  if (opts.discovery) burst("sparkle", 14);
  if (opts.cravingMet) burst("heart", 12);
  if (t >= 3 && !reducedMotion) shake = 0.35;
}
/** Hovering or focusing a tray action: a green (legal) or red (unavailable) ring and tint. */
export function setHighlight(valid: boolean | null): void { highlight = valid === null ? 0 : valid ? 1 : -1; }
export function invalidWobble(): void { reaction = Math.max(reaction, 0.3); wobble = 0.4; }
export function setReducedMotion(v: boolean): void { reducedMotion = v; }
/** Whether the room draws (full-page screens cover the window). */
export function setActive(on: boolean): void {
  active = on;
  renderer.camera = on ? camera : null;
  // the old render loop kept stepping emotes while the room was hidden: none are left for the next session
  if (!on) { particles.length = 0; for (const sp of spritePool) sp.visible = false; }
}

// ---------------------------------------------------------------- framing, projection, picking
let frameKey = "";
let win = { w: 1, h: 1 };
let view: Rect = { x: 0, y: 0, width: 1, height: 1 };
/** render.js _fitCamera: portrait-fit pulls the camera up (and its z, which the sway then eases back). */
function fitCamera(): void {
  const aspect = view.width / Math.max(1, view.height);
  for (const c of [camera, probe]) c.aspect = aspect;
  const fit = Math.min(1, aspect / 1.15);
  camera.position.set(CAM.pos.x, CAM.pos.y + (1 - fit) * 1.4, CAM.pos.z + (1 - fit) * 2.6);
  camera.lookAt(CAM.look);
  // The old canvas filled the playfield: the window shows it through a view offset.
  camera.setViewOffset(view.width, view.height, -view.x, -view.y, win.w, win.h);
  camera.updateProjectionMatrix();
  probe.updateProjectionMatrix();
}
const tmp = new Vector3();
/** A world point in window pixels (through the playfield's camera), or null behind the camera. */
function toWindow(v: Vector3): { x: number; y: number } | null {
  probe.position.copy(camera.position);
  probe.quaternion.copy(camera.quaternion);
  probe.updateMatrixWorld(true);
  tmp.copy(v).project(probe);
  if (tmp.z > 1) return null;
  return { x: view.x + (tmp.x * 0.5 + 0.5) * view.width, y: view.y + (-tmp.y * 0.5 + 0.5) * view.height };
}
/** render.js anchorToScreen('creature'): the point above Mote's head (window px). */
export function creatureAnchor(): { x: number; y: number } | null {
  creature.getWorldPosition(tmp);
  return toWindow(new Vector3(tmp.x, tmp.y + 1.7, tmp.z));
}
/** Mote's on-screen box (window px) for its named target. */
export function creatureRect(): Rect | null {
  const a = toWindow(new Vector3(-0.7, 1.45, 0.3)), b = toWindow(new Vector3(0.7, 0, 0.3));
  if (!a || !b) return null;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
const raycaster = new Raycaster();
/** render.js _tap: whether a window point hits Mote. */
export function hitsCreature(x: number, y: number): boolean {
  if (!active || view.width < 2) return false;
  probe.position.copy(camera.position);
  probe.quaternion.copy(camera.quaternion);
  probe.updateMatrixWorld(true);
  const ndc = new Vector2(((x - view.x) / view.width) * 2 - 1, -((y - view.y) / view.height) * 2 + 1);
  raycaster.setFromCamera(ndc, probe);
  return raycaster.intersectObject(creature, true).length > 0;
}

// ---------------------------------------------------------------- each frame
const droops: Record<string, number> = { joyful: 0, proud: 0, content: 0.1, worried: 0.4, sad: 0.7, sleepy: 0.55, miserable: 0.9 };
const mouthTargets: Record<string, { rot: number; scale: number }> = {
  joyful: { rot: Math.PI, scale: 1.25 }, proud: { rot: Math.PI, scale: 1.3 },
  content: { rot: Math.PI, scale: 1 }, worried: { rot: Math.PI * 0.75, scale: 0.7 },
  sad: { rot: 0, scale: 0.7 }, sleepy: { rot: Math.PI, scale: 0.4 }, miserable: { rot: 0, scale: 0.55 },
};
export function update(dtIn: number, w: number, h: number, rect: Rect): void {
  if (!active) return;
  const dt = Math.min(0.05, dtIn);
  elapsed += dt;
  const fk = `${w}x${h}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  if (w > 0 && h > 0 && rect.width > 1 && rect.height > 1 && fk !== frameKey) {
    frameKey = fk;
    win = { w, h };
    view = { ...rect };
    fitCamera();
  }
  // attenuated points size by the window height, the old canvas by its own: scale to the playfield's share
  if (motesMat) motesMat.size = 0.028 * view.height / Math.max(1, win.h);
  const rm = reducedMotion;
  if (body && bodyMat) {
    const breathe = rm ? 0 : Math.sin(elapsed * 2.1) * 0.015;
    const reactLift = reaction > 0 ? Math.sin(Math.min(1, reaction) * Math.PI) * 0.22 : 0;
    body.position.y = 0.62 + breathe + reactLift;
    reaction = Math.max(0, reaction - dt * 1.6);
    moodColor.set(MOOD_COLORS[mood] ?? MOOD_COLORS.content!);
    bodyMat.color.lerp(moodColor, Math.min(1, dt * 3));
    const lift = body.position.y - 0.62;
    blob.scale.setScalar(1 - Math.max(0, lift) * 0.9);
    const droop = droops[mood] ?? 0.1;
    ears.forEach((ear, i) => {
      const side = i === 0 ? -1 : 1;
      ear.rotation.z += ((-side * (0.35 + droop * 0.5)) - ear.rotation.z) * Math.min(1, dt * 5);
    });
    const mt = mouthTargets[mood] ?? mouthTargets.content!;
    if (mouth) {
      mouth.rotation.z += (mt.rot - mouth.rotation.z) * Math.min(1, dt * 4);
      mouth.scale.setScalar(mouth.scale.x + (mt.scale - mouth.scale.x) * Math.min(1, dt * 4));
    }
    blinkTimer -= dt;
    if (blinkTimer <= 0) { blink = 0.12; blinkTimer = 2 + rand() * 3; }
    if (blink > 0 || mood === "sleepy") {
      blink = Math.max(0, blink - dt);
      const s = mood === "sleepy" ? 0.15 : 0.1;
      eyes.forEach((e) => { e.scale.y += (s - e.scale.y) * Math.min(1, dt * 18); });
    } else eyes.forEach((e) => { e.scale.y += (1 - e.scale.y) * Math.min(1, dt * 18); });
    if (wobble > 0) {
      wobble = Math.max(0, wobble - dt);
      creature.rotation.z = rm ? 0 : Math.sin(wobble * 30) * wobble * 0.12;
    } else creature.rotation.z = 0;
    if ("emissive" in bodyMat) bodyMat.emissive.set(highlight === 1 ? 0x224422 : highlight === -1 ? 0x442222 : 0x000000);
  }
  // Highlight ring.
  const ringTarget = highlight === 0 ? 0 : 0.85;
  ringMat.opacity += (ringTarget - ringMat.opacity) * Math.min(1, dt * 8);
  if (highlight === 1) ringMat.color.set(0x8fe08a);
  else if (highlight === -1) ringMat.color.set(0xe08a8a);
  // Camera: authored sway + event-tiered shake; picking uses the same camera without the shake.
  const sway = rm ? 0 : Math.sin(elapsed * 1000 * CAM.swaySpeed) * CAM.swayAmp;
  let shakeX = 0, shakeY = 0;
  if (shake > 0 && !rm) {
    shake = Math.max(0, shake - dt);
    shakeX = (rand() - 0.5) * shake * 0.08;
    shakeY = (rand() - 0.5) * shake * 0.08;
  }
  camera.position.x += ((CAM.pos.x + sway + shakeX) - camera.position.x) * Math.min(1, dt * 4);
  camera.position.z += (CAM.pos.z + shakeY * 4 - camera.position.z) * Math.min(1, dt * 4);
  camera.lookAt(CAM.look);
  // Window glow shimmer, lamp flicker and drifting motes; still under reduced motion.
  const on = !!look?.ambient;
  const still = rm || !on;
  lamp.intensity = (still ? 12 : 12 * (1 + 0.035 * Math.sin(elapsed * 6.3) + 0.02 * Math.sin(elapsed * 13.7 + 1.3)));
  if (windowGlow) (windowGlow.material as MeshBasicMaterial).opacity = still ? 0.1 : 0.1 + 0.03 * Math.sin(elapsed * 0.7);
  if (on && !still && motes) {
    const pos = motes.geometry.attributes.position!;
    const arr = pos.array as Float32Array;
    const n = Math.min(MOTE_MAX, look!.budget.motes);
    for (let i = 0; i < n; i++) {
      const x0 = moteSeeds[i * 4]!, y0 = moteSeeds[i * 4 + 1]!, z0 = moteSeeds[i * 4 + 2]!, ph = moteSeeds[i * 4 + 3]!;
      arr[i * 3] = x0 + Math.sin(elapsed * 0.23 + ph) * 0.18;
      arr[i * 3 + 1] = y0 + Math.sin(elapsed * 0.17 + ph * 1.7) * 0.22;
      arr[i * 3 + 2] = z0 + Math.cos(elapsed * 0.19 + ph) * 0.12;
    }
    pos.needsUpdate = true;
  }
  stepParticles(dt);
  void lampShade; void windowAnchor;
}
