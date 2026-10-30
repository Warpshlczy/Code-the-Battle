import * as THREE from 'three';
import type { LogEvent, PublicBattleState, PublicCard } from '../engine/battle';
import { ART } from '../ui/art';
import type { VisualCue } from '../ui/visual';
import type { Lang } from '../i18n';
import {
  CARD_H,
  CARD_THICK,
  CARD_W,
  PILE_ANCHOR,
  PILE_KEYS,
  pileKey,
  pileSide,
  pileType,
  TABLE_RADIUS,
  cameraPreset,
  enemyHandSlot,
  handSlot,
  idleMotion,
  pileSlot,
  spreadSlot,
  stageSlot,
  type PileKey,
  type Slot,
  type ViewName,
} from './layout';
import { cueDirection } from './timeline';
import { cardKeys, diffHand, handTargets } from './transition';
import { cardBackTexture, cardFaceTexture, numberTexture, pileLabelTexture, rasterizedTexture, tableTexture } from './textures';

export interface TableCallbacks {
  lang?: Lang;
  onHoverCard?: (card: PublicCard | null, client: { x: number; y: number } | null) => void;
  onHandHover?: (active: boolean) => void;
  onPileClick?: (pile: PileKey) => void;
  onViewChange?: (view: ViewName) => void;
  onSpreadChange?: (pile: PileKey | null) => void;
}

interface CardMesh {
  group: THREE.Group;
  card: PublicCard;
  back: boolean;
  key?: string;
}

interface Tween {
  id: number;
  object: THREE.Object3D;
  from: { position: THREE.Vector3; scale: THREE.Vector3; quaternion: THREE.Quaternion };
  to: { position: THREE.Vector3; scale: THREE.Vector3; quaternion: THREE.Quaternion };
  start: number;
  duration: number;
  ease: (t: number) => number;
  onUpdate?: (t: number) => void;
  onDone?: () => void;
}

const PLAYER_STANDEE = new THREE.Vector3(0, 0, 3.55);
const ENEMY_STANDEE = new THREE.Vector3(0, 0, -3.55);
const STANDEE_SCALE = 0.46;
const PLAYER_COLOR = '#4da3ff';
const ENEMY_COLOR = '#ff4d5e';

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export class TableScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private callbacks: TableCallbacks;
  private lang: Lang;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private time = 0;

  private tableGroup = new THREE.Group();
  private worldGroup = new THREE.Group();
  private standees = new Map<'player' | 'enemy', { group: THREE.Group; shader: THREE.ShaderMaterial; rings: THREE.Object3D[]; seed: number }>();
  private dust?: THREE.Points;
  private pileGroups = new Map<PileKey, THREE.Group>();
  private handGroup = new THREE.Group();
  private enemyHandGroup = new THREE.Group();
  private enemyHandLabel: THREE.Sprite | null = null;
  private stageGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  private shieldGroup = new THREE.Group();

  private handMeshes: CardMesh[] = [];
  private handKeys: string[] = [];
  private pileMeshes = new Map<PileKey, CardMesh[]>();
  private pileLabels = new Map<PileKey, THREE.Sprite>();
  private stageMeshes: CardMesh[] = [];
  private stagedCard: CardMesh | null = null;
  private activeSide: 'player' | 'enemy' | null = 'player';
  private focus: 'player' | 'enemy' | null = null;
  private blockValues: Record<'player' | 'enemy', number> = { player: 0, enemy: 0 };
  private blockAuras = new Map<'player' | 'enemy', THREE.Mesh>();
  private nextMarker = new THREE.Group();
  private nextLabel: THREE.Sprite | null = null;
  private nextGround: THREE.Mesh | null = null;
  private nextUniforms: { uTime: { value: number }; uColor: { value: THREE.Color } } | null = null;
  private energy = 5;
  private cardScale = 1;
  private handSpread = 1;
  private spread: PileKey | null = null;
  private spreadSaved: { group: THREE.Group; meshes: CardMesh[] } | null = null;
  private spreadBackdrop: THREE.Mesh | null = null;
  private spreadEmpty: THREE.Sprite | null = null;

  private view: ViewName = 'overview';
  private cameraTarget = new THREE.Vector3();
  private cameraShake = 0;
  private tweenId = 0;
  private tweens: Tween[] = [];
  private hovered: CardMesh | null = null;
  private handHovered = false;
  private stageHalo: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-10, -10);
  private pointerParallax = new THREE.Vector2();
  private stateKey = '';
  private speed = 1;
  private rng = seededRandom(1);
  private observer?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, callbacks: TableCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.lang = callbacks.lang ?? 'zh';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#04070a');
    this.scene.fog = new THREE.FogExp2('#04070a', 0.055);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);

    this.scene.add(this.worldGroup);
    this.buildLights();
    this.buildTable();
    this.buildEnvironment();
    this.buildStandees();
    this.buildPiles();
    this.buildBlockAuras();
    this.buildNextMarker();
    this.buildDust();
    this.buildHandLabel();
    this.worldGroup.add(...PILE_KEYS.map((k) => this.pileGroups.get(k)!), this.stageGroup, this.enemyHandGroup, this.handGroup, this.fxGroup, this.shieldGroup, this.nextMarker);

    this.applyView('overview', true);
    this.attachEvents();
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas.parentElement);
    }
    this.resize();
    this.loop();
  }

  // ---------------------------------------------------------------- build

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight('#244a58', '#06090d', 0.95);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight('#cfeaff', 1.15);
    key.position.set(-3, 9, 4);
    key.castShadow = false;
    this.scene.add(key);
    const cyan = new THREE.PointLight('#38f2cf', 22, 16, 2);
    cyan.position.set(-4.6, 3.4, 1.4);
    this.scene.add(cyan);
    const magenta = new THREE.PointLight('#ff2f7d', 20, 16, 2);
    magenta.position.set(4.6, 3.4, 1.4);
    this.scene.add(magenta);
    const spot = new THREE.SpotLight('#eaf6ff', 26, 18, Math.PI / 4.2, 0.55, 1.6);
    spot.position.set(0, 9.5, 1.5);
    spot.target.position.set(0, 0, 0);
    this.scene.add(spot, spot.target);
  }

  private buildTable(): void {
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS, 0.26, 72),
      new THREE.MeshStandardMaterial({ map: tableTexture(), color: '#9fb4b8', roughness: 0.72, metalness: 0.42 }),
    );
    top.position.y = -0.13;
    this.tableGroup.add(top);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(TABLE_RADIUS, 0.05, 12, 96),
      new THREE.MeshStandardMaterial({ color: '#38f2cf', emissive: '#38f2cf', emissiveIntensity: 1.4, roughness: 0.4 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.01;
    this.tableGroup.add(rim);

    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.2, 1.5, 36),
      new THREE.MeshStandardMaterial({ color: '#0a1116', roughness: 0.9, metalness: 0.3 }),
    );
    pedestal.position.y = -1.0;
    this.tableGroup.add(pedestal);

    const hazard = new THREE.Mesh(
      new THREE.RingGeometry(TABLE_RADIUS - 0.32, TABLE_RADIUS - 0.22, 96),
      new THREE.MeshBasicMaterial({ color: '#ffb454', transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    hazard.rotation.x = -Math.PI / 2;
    hazard.position.y = 0.012;
    this.tableGroup.add(hazard);

    this.worldGroup.add(this.tableGroup);
  }

  private buildEnvironment(): void {
    const rackMat = new THREE.MeshStandardMaterial({ color: '#0a151c', roughness: 0.85, metalness: 0.35 });
    const stripMat = new THREE.MeshBasicMaterial({ color: '#38f2cf' });
    const stripMagenta = new THREE.MeshBasicMaterial({ color: '#ff2f7d' });
    const rng = seededRandom(7);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + 0.2;
      const radius = 20 + rng() * 6;
      const height = 6 + rng() * 7;
      const rack = new THREE.Mesh(new THREE.BoxGeometry(1.5 + rng(), height, 1.2 + rng()), rackMat);
      rack.position.set(Math.cos(a) * radius, height / 2, Math.sin(a) * radius);
      rack.rotation.y = -a;
      this.scene.add(rack);
      const strips = 3 + Math.floor(rng() * 4);
      for (let s = 0; s < strips; s++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.035, 0.02), rng() > 0.75 ? stripMagenta : stripMat);
        strip.position.set(rack.position.x, 0.5 + s * 0.8, rack.position.z);
        strip.rotation.y = rack.rotation.y;
        strip.translateZ(0.62);
        this.scene.add(strip);
      }
    }

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(44, 64),
      new THREE.MeshStandardMaterial({ color: '#04070a', roughness: 0.95, metalness: 0.1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.75;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(88, 88, '#123039', '#0a1c22');
    grid.position.y = -1.74;
    this.scene.add(grid);

    for (const x of [-5.2, 5.2]) {
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(1.5, 6.4, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: x < 0 ? '#38f2cf' : '#ff2f7d', transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
      );
      beam.position.set(x, 4.4, 0.4);
      this.scene.add(beam);
    }
  }

  private hologramMaterial(url: string, tint: THREE.Color): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        map: { value: null as THREE.Texture | null },
        uTime: { value: 0 },
        uFlicker: { value: 1 },
        uHit: { value: 0 },
        uTint: { value: tint },
        uDim: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform float uTime;
        uniform float uFlicker;
        uniform float uHit;
        uniform vec3 uTint;
        uniform float uDim;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(map, vUv);
          float scan = 0.86 + 0.14 * sin((vUv.y + uTime * 0.09) * 260.0);
          float band = smoothstep(0.0, 0.08, fract(vUv.y * 1.15 - uTime * 0.11));
          vec3 col = tex.rgb * uTint * scan * uFlicker * 1.45;
          col += vec3(0.32, 0.92, 0.86) * band * 0.16;
          col += vec3(1.0, 0.22, 0.32) * uHit;
          col *= uDim;
          float alpha = tex.a * uFlicker;
          if (alpha < 0.03) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const texture = rasterizedTexture(url, 512, 700);
    material.uniforms.map.value = texture;
    return material;
  }

  private buildStandees(): void {
    const specs: Array<{ side: 'player' | 'enemy'; art: string; tint: string; pos: THREE.Vector3 }> = [
      { side: 'player', art: ART.player, tint: '#9fc9ff', pos: PLAYER_STANDEE },
      { side: 'enemy', art: ART.enemy, tint: '#ff9aa5', pos: ENEMY_STANDEE },
    ];
    for (const spec of specs) {
      const group = new THREE.Group();
      group.position.copy(spec.pos);
      const facing = spec.side === 'player' ? 0 : Math.PI;
      group.rotation.y = facing;
      group.scale.setScalar(STANDEE_SCALE);

      const material = this.hologramMaterial(spec.art, new THREE.Color(spec.tint));
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.8), material);
      plane.position.y = 1.45;
      group.add(plane);

      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 3.0),
        new THREE.MeshBasicMaterial({ color: spec.tint, transparent: true, opacity: 0.07, depthWrite: false }),
      );
      glow.position.set(0, 1.45, -0.04);
      group.add(glow);

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.05, 1.25, 0.16, 40),
        new THREE.MeshStandardMaterial({ color: '#0b1a20', roughness: 0.6, metalness: 0.5, emissive: spec.tint, emissiveIntensity: 0.18 }),
      );
      base.position.y = 0.08;
      group.add(base);

      const rings: THREE.Object3D[] = [];
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.85 + i * 0.22, 0.012, 8, 64),
          new THREE.MeshBasicMaterial({ color: spec.tint, transparent: true, opacity: 0.55, depthWrite: false }),
        );
        ring.position.y = 0.28 + i * 0.05;
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
        rings.push(ring);
      }

      const drones = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const drone = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.06),
          new THREE.MeshBasicMaterial({ color: spec.tint }),
        );
        drone.position.set(Math.cos(i * 2.1) * 1.25, 1.5 + i * 0.35, Math.sin(i * 2.1) * 1.25);
        drones.add(drone);
      }
      group.add(drones);

      this.worldGroup.add(group);
      this.standees.set(spec.side, { group, shader: material, rings, seed: spec.side === 'player' ? 3 : 91 });
      rings.push(drones);
    }
  }

  private tr(zh: string, en: string): string {
    return this.lang === 'zh' ? zh : en;
  }

  private pileLabelText(side: 'player' | 'enemy', kind: 'draw' | 'discard'): string {
    if (this.lang === 'zh') return `${side === 'player' ? '我方' : '敌方'}${kind === 'draw' ? '抽牌' : '弃牌'}`;
    return `${side === 'player' ? 'Your' : 'SENTINEL'} ${kind}`;
  }

  private buildPiles(): void {
    for (const pile of PILE_KEYS) {
      const group = new THREE.Group();
      const side = pileSide(pile);
      const kind = pileType(pile);
      const accent = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
      const anchor = PILE_ANCHOR[pile];
      group.userData.pile = pile;
      const tray = new THREE.Mesh(
        new THREE.CylinderGeometry(0.86, 0.92, 0.09, 48),
        new THREE.MeshStandardMaterial({ color: '#08141b', roughness: 0.65, metalness: 0.45, emissive: accent, emissiveIntensity: 0.12 }),
      );
      tray.position.set(anchor.x, 0.035, anchor.z);
      group.add(tray);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.84, 0.012, 8, 64),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: kind === 'draw' ? 0.75 : 0.5 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(anchor.x, 0.085, anchor.z);
      group.add(rim);
      group.userData.pad = tray;
      group.userData.rim = rim;
      this.pileGroups.set(pile, group);
      this.pileMeshes.set(pile, []);

      const text = this.pileLabelText(side, kind);
      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: pileLabelTexture(text, 0, accent), transparent: true, depthWrite: false }),
      );
      label.position.set(anchor.x, 0.72, anchor.z + (side === 'player' ? 0.38 : -0.38));
      label.scale.set(1.45, 0.45, 1);
      this.pileLabels.set(pile, label);
      group.add(label);
    }
  }

  private buildHandLabel(): void {
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: pileLabelTexture(this.tr('敌方手牌', 'SENTINEL hand'), 0, ENEMY_COLOR), transparent: true, depthWrite: false }),
    );
    label.position.set(0, 0.9, -2.25);
    label.scale.set(2.1, 0.62, 1);
    this.enemyHandLabel = label;
    this.worldGroup.add(label);
  }

  private buildBlockAuras(): void {
    for (const side of ['player', 'enemy'] as const) {
      const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
      const aura = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.28, 1),
        new THREE.MeshBasicMaterial({ color: side === 'player' ? '#6fb6ff' : '#ff7d88', wireframe: true, transparent: true, opacity: 0, depthWrite: false }),
      );
      aura.position.set(origin.x, 1.18, origin.z);
      this.shieldGroup.add(aura);
      this.blockAuras.set(side, aura);
    }
  }

  private buildNextMarker(): void {
    const uniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color('#58d7ff') },
    };
    this.nextUniforms = uniforms;
    const marker = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.34, CARD_H * 1.22),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        uniforms,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec2 vUv;
          uniform float uTime;
          uniform vec3 uColor;
          void main() {
            vec2 d = abs(vUv - 0.5) * 2.0;
            float edge = max(d.x, d.y);
            float frame = smoothstep(0.9, 0.925, edge) * (1.0 - smoothstep(0.97, 0.995, edge));
            float dash = step(0.32, fract((vUv.x + vUv.y) * 15.0 - uTime * 0.9));
            float corners = step(0.86, max(d.x, d.y)) * step(0.6, min(d.x, d.y));
            float scan = smoothstep(0.42, 0.5, vUv.y) * (1.0 - smoothstep(0.5, 0.58, vUv.y)) * 0.18;
            float alpha = frame * (0.45 + dash * 0.55) + corners * 0.25 + scan;
            gl_FragColor = vec4(uColor, alpha * 0.9);
          }
        `,
      }),
    );
    marker.renderOrder = 12;
    this.nextMarker.add(marker);

    const glow = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.62, 48),
      new THREE.MeshBasicMaterial({ color: '#58d7ff', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.012;
    this.nextGround = glow;
    this.worldGroup.add(glow);

    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: numberTexture('NEXT', '#58d7ff'), transparent: true, depthWrite: false, depthTest: false }),
    );
    label.scale.set(1.35, 0.42, 1);
    label.position.set(0, CARD_H * 0.52, 0.03);
    label.renderOrder = 13;
    this.nextLabel = label;
    this.nextMarker.add(label);
    this.nextMarker.visible = false;
    this.nextMarker.renderOrder = 12;

    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.9, CARD_H * 1.75),
      new THREE.MeshBasicMaterial({ color: '#58d7ff', transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    halo.position.y = 0.02;
    halo.renderOrder = 4;
    this.stageHalo = halo;
    this.stageGroup.add(halo);
  }

  private buildDust(): void {
    const count = 340;
    const positions = new Float32Array(count * 3);
    const rng = seededRandom(42);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rng() - 0.5) * 22;
      positions[i * 3 + 1] = rng() * 7 - 0.5;
      positions[i * 3 + 2] = rng() * 20 - 9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: '#9fe8ff', size: 0.035, transparent: true, opacity: 0.5, depthWrite: false });
    this.dust = new THREE.Points(geo, mat);
    this.scene.add(this.dust);
  }

  // ---------------------------------------------------------------- cards

  private makeCardMesh(card: PublicCard, back: boolean): CardMesh {
    const group = new THREE.Group();
    const painted = !back && !!card.art?.image;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H),
      new THREE.MeshStandardMaterial({
        map: back ? cardBackTexture() : cardFaceTexture(card, this.lang),
        emissive: new THREE.Color(0xffffff),
        emissiveMap: back ? cardBackTexture() : cardFaceTexture(card, this.lang),
        emissiveIntensity: painted ? 0.72 : 0.58,
        roughness: painted ? 0.66 : 0.58,
        metalness: painted ? 0.05 : 0.12,
        transparent: false,
      }),
    );
    face.position.z = CARD_THICK / 2 + 0.004;
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(CARD_W, CARD_H, CARD_THICK),
      new THREE.MeshStandardMaterial({ color: '#0b141a', roughness: 0.8, metalness: 0.3 }),
    );
    group.add(shell, face);
    group.userData.card = card;
    group.userData.interactive = true;
    return { group, card, back };
  }

  private applySlot(object: THREE.Object3D, slot: Slot): void {
    object.position.set(slot.x, slot.y, slot.z);
    object.rotation.set(slot.rx, slot.ry, slot.rz);
  }

  private disposeCardMesh(mesh: CardMesh): void {
    mesh.group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        const mat = child.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }

  private slotPosition(slot: Slot): THREE.Vector3 {
    return new THREE.Vector3(slot.x, slot.y, slot.z);
  }

  private slotQuaternion(slot: Slot): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(slot.rx, slot.ry, slot.rz));
  }

  private tweenToSlot(object: THREE.Object3D, slot: Slot, duration: number, delay = 0, onDone?: () => void): void {
    this.tween(
      object,
      { position: this.slotPosition(slot), quaternion: this.slotQuaternion(slot) },
      duration,
      easeInOut,
      onDone,
      delay,
    );
  }

  private makeHandMesh(card: PublicCard, key: string): CardMesh {
    const mesh = this.makeCardMesh(card, false);
    mesh.key = key;
    mesh.group.userData.key = key;
    return mesh;
  }

  private sendToDiscard(mesh: CardMesh, animate: boolean, delay: number): void {
    this.handGroup.remove(mesh.group);
    if (!animate) {
      this.disposeCardMesh(mesh);
      return;
    }
    this.fxGroup.add(mesh.group);
    const anchor = PILE_ANCHOR['player-discard'];
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    this.tween(
      mesh.group,
      {
        position: new THREE.Vector3(anchor.x, 0.14, anchor.z),
        quaternion: flat,
        scale: new THREE.Vector3(0.72, 0.72, 0.72),
      },
      0.46,
      easeInOut,
      () => {
        this.fxGroup.remove(mesh.group);
        this.disposeCardMesh(mesh);
      },
      delay,
    );
  }

  /**
   * Reconciles the hand by presentation key. This is what makes the leftmost card
   * leave, the rest slide left, and freshly drawn cards fly in from the draw pile.
   */
  private syncHand(state: PublicBattleState, animate: boolean): void {
    const next = state.player.hand;
    const nextKeys = cardKeys(next);
    const diff = diffHand(this.handKeys, nextKeys);
    const targets = handTargets(next.length).map((slot) => ({ ...slot, x: slot.x * this.handSpread }));
    const byKey = new Map<string, CardMesh>();
    for (const mesh of this.handMeshes) if (mesh.key) byKey.set(mesh.key, mesh);

    diff.removed.forEach(({ key }, i) => {
      const mesh = byKey.get(key);
      if (!mesh) return;
      byKey.delete(key);
      this.sendToDiscard(mesh, animate, 0.05 * i);
    });

    diff.added.forEach(({ key, index }, i) => {
      const card = next[index];
      if (!card) return;
      const mesh = this.makeHandMesh(card, key);
      const slot = targets[index];
      if (animate) {
        const anchor = PILE_ANCHOR['player-draw'];
        mesh.group.position.set(anchor.x, 0.94, anchor.z);
        mesh.group.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.35, 0.5, 0.12));
        mesh.group.scale.setScalar(0.58 * this.cardScale);
        this.handGroup.add(mesh.group);
        this.tween(
          mesh.group,
          {
            position: this.slotPosition(slot),
            quaternion: this.slotQuaternion(slot),
            scale: new THREE.Vector3(this.cardScale, this.cardScale, this.cardScale),
          },
          0.55,
          easeOut,
          undefined,
          0.08 * i,
        );
      } else {
        this.applySlot(mesh.group, slot);
        mesh.group.scale.setScalar(this.cardScale);
        this.handGroup.add(mesh.group);
      }
      byKey.set(key, mesh);
    });

    const ordered: CardMesh[] = [];
    nextKeys.forEach((key, index) => {
      const mesh = byKey.get(key);
      if (!mesh) return;
      ordered.push(mesh);
      const currentSlot = targets[index];
      if (!animate) {
        this.applySlot(mesh.group, currentSlot);
        return;
      }
      const distance = Math.abs(mesh.group.position.x - currentSlot.x);
      if (distance < 0.001) return;
      this.tweenToSlot(mesh.group, currentSlot, 0.34, index * 0.015);
    });
    this.handMeshes = ordered;
    this.handKeys = nextKeys;
  }

  /** Takes the leftmost card out of the fan and presents it on the stage. */
  private attachCardHalo(group: THREE.Group, side: 'player' | 'enemy'): void {
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.55, CARD_H * 1.42),
      new THREE.MeshBasicMaterial({
        color: side === 'player' ? PLAYER_COLOR : ENEMY_COLOR,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.position.z = -0.03;
    halo.renderOrder = 1;
    group.add(halo);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(CARD_W * 1.04, CARD_H * 1.04)),
      new THREE.LineBasicMaterial({ color: side === 'player' ? '#9fd8ff' : '#ff9aa5', transparent: true, opacity: 0.95, depthTest: false }),
    );
    edge.position.z = 0.012;
    edge.renderOrder = 12;
    group.add(edge);
  }

  private detachLeftmostToStage(): void {
    const hidden = this.handMeshes.shift();
    if (!hidden) return;
    this.handKeys.shift();
    this.handGroup.remove(hidden.group);
    const card = hidden.card;
    this.disposeCardMesh(hidden);
    const mesh = this.makeCardMesh(card, false);
    mesh.key = '';
    mesh.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat && 'emissiveIntensity' in mat) mat.emissiveIntensity = 0.85;
      }
    });
    this.stageGroup.add(mesh.group);
    this.attachCardHalo(mesh.group, 'player');
    this.stagedCard = mesh;
    if (this.stageHalo) {
      this.stageHalo.visible = true;
      (this.stageHalo.material as THREE.MeshBasicMaterial).color.set(PLAYER_COLOR);
    }
    const slot = stageSlot('player');
    mesh.group.scale.setScalar(0.92 * Math.max(1, this.cardScale));
    this.tween(
      mesh.group,
      {
        position: this.slotPosition(slot),
        quaternion: this.slotQuaternion(slot),
        scale: new THREE.Vector3(...Array(3).fill((this.camera.aspect < 1 ? 2.15 : 1.55) * Math.max(1, this.cardScale))),
      },
      0.42,
      easeOut,
    );
  }

  /** Moves the presented card into the discard pile and disposes it. */
  private retireStageCard(animate = true): void {
    const mesh = this.stagedCard;
    if (!mesh) return;
    this.stagedCard = null;
    if (this.stageHalo) {
      this.stageHalo.visible = false;
      (this.stageHalo.material as THREE.MeshBasicMaterial).opacity = 0;
    }
    if (!animate) {
      this.stageGroup.remove(mesh.group);
      this.disposeCardMesh(mesh);
      return;
    }
    const anchor = PILE_ANCHOR['player-discard'];
    this.tween(
      mesh.group,
      {
        position: new THREE.Vector3(anchor.x, 0.12, anchor.z),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
        scale: new THREE.Vector3(0.72, 0.72, 0.72),
      },
      0.44,
      easeInOut,
      () => {
        this.stageGroup.remove(mesh.group);
        this.disposeCardMesh(mesh);
      },
    );
  }

  private syncPiles(state: PublicBattleState, animate = false): void {
    for (const pile of PILE_KEYS) {
      const side = pileSide(pile);
      const kind = pileType(pile);
      const cards = side === 'player'
        ? (kind === 'draw' ? state.player.draw : state.player.discard)
        : (kind === 'discard' ? state.enemyDiscard : null);
      const count = side === 'player' ? (cards?.length ?? 0) : (kind === 'draw' ? state.enemy.drawCount : state.enemyDiscard.length);
      const group = this.pileGroups.get(pile)!;
      const existing = this.pileMeshes.get(pile)!;
      const visible = Math.min(count, 8);
      const nextKeys = Array.from({ length: visible }, (_, i) => (cards?.[i] ? `card:${cards[i].uid}` : `back#${i}`));
      const label = this.pileLabels.get(pile);
      if (label) {
        const accent = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
        const text = this.pileLabelText(side, kind);
        const nextMap = pileLabelTexture(text, count, accent);
        const material = label.material;
        if (material.map !== nextMap) {
          material.map = nextMap;
          material.needsUpdate = true;
        }
      }
      const rim = group.userData.rim as THREE.Mesh | undefined;
      if (rim && existing.length !== visible) {
        this.tween(rim, { scale: new THREE.Vector3(1.14, 1.14, 1.14) }, 0.2, easeOut, () => {
          this.tween(rim, { scale: new THREE.Vector3(1, 1, 1) }, 0.35, easeInOut);
        });
      }
      if (existing.length === visible && existing.every((m, i) => m.key === nextKeys[i])) continue;
      const faceUp = kind === 'discard';
      const nextSet = new Set(nextKeys);
      const byKey = new Map<string, CardMesh>();
      for (const mesh of existing) {
        if (mesh.key && nextSet.has(mesh.key)) byKey.set(mesh.key, mesh);
      }
      // Cards that left the visible stack drift up and fade out instead of vanishing.
      for (const mesh of existing) {
        if (mesh.key && nextSet.has(mesh.key)) continue;
        group.remove(mesh.group);
        if (!animate) {
          this.disposeCardMesh(mesh);
          continue;
        }
        this.fxGroup.add(mesh.group);
        const base = mesh.group.position.clone();
        this.tween(
          mesh.group,
          {
            position: new THREE.Vector3(base.x, base.y + 0.62, base.z),
            scale: new THREE.Vector3(0.18, 0.18, 0.18),
            quaternion: mesh.group.quaternion.clone(),
          },
          0.34,
          easeOut,
          () => {
            this.fxGroup.remove(mesh.group);
            this.disposeCardMesh(mesh);
          },
        );
      }
      const anchor = PILE_ANCHOR[pile];
      const next: CardMesh[] = [];
      for (let i = 0; i < visible; i++) {
        const card = cards?.[i];
        const publicCard: PublicCard = card ?? {
          uid: `hidden-${pile}-${i}`,
          name: this.tr('未知', 'Unknown'),
          description: '',
          cost: 0,
          type: 'skill',
          target: 'none',
          playable: false,
        };
        const key = nextKeys[i];
        const slot = pileSlot(pile, i, count);
        let mesh = byKey.get(key);
        if (!mesh) {
          mesh = this.makeCardMesh(publicCard, !faceUp);
          mesh.key = key;
          group.add(mesh.group);
          if (animate) {
            mesh.group.position.set(anchor.x, 0.98, anchor.z);
            mesh.group.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.5, 0.22, 0.12));
            mesh.group.scale.setScalar(0.52);
            this.tween(
              mesh.group,
              {
                position: this.slotPosition(slot),
                quaternion: this.slotQuaternion(slot),
                scale: new THREE.Vector3(1, 1, 1),
              },
              0.46,
              easeOut,
              undefined,
              0.02 * i,
            );
          } else {
            this.applySlot(mesh.group, slot);
          }
        } else if (animate) {
          const moved = mesh.group.position.distanceTo(this.slotPosition(slot)) > 0.002
            || !mesh.group.quaternion.equals(this.slotQuaternion(slot));
          if (moved) this.tweenToSlot(mesh.group, slot, 0.34, 0.012 * i);
        } else {
          this.applySlot(mesh.group, slot);
        }
        if (i === visible - 1 && animate && !mesh.group.userData.bounced) {
          mesh.group.userData.bounced = true;
          this.tween(mesh.group, { position: new THREE.Vector3(slot.x, slot.y + 0.2, slot.z) }, 0.16, easeOut, () => {
            this.tweenToSlot(mesh.group, slot, 0.28);
          });
        }
        next.push(mesh);
      }
      this.pileMeshes.set(pile, next);
    }
  }

  private syncEnemyHand(state: PublicBattleState, animate = false): void {
    const count = state.enemy.handCount;
    if (this.enemyHandLabel) {
      const material = this.enemyHandLabel.material as THREE.SpriteMaterial;
      const map = pileLabelTexture(this.tr('敌方手牌', 'SENTINEL hand'), count, ENEMY_COLOR);
      if (material.map !== map) {
        material.map = map;
        material.needsUpdate = true;
      }
    }
    const current = this.enemyHandGroup.children.length;
    if (current === Math.min(count, 8)) return;
    while (this.enemyHandGroup.children.length > 0) {
      const child = this.enemyHandGroup.children[0];
      this.enemyHandGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    for (let i = 0; i < Math.min(count, 8); i++) {
      const back = new THREE.Mesh(
        new THREE.PlaneGeometry(CARD_W * 0.8, CARD_H * 0.8),
        new THREE.MeshBasicMaterial({ map: cardBackTexture(), side: THREE.DoubleSide, transparent: true, opacity: 0.96 }),
      );
      const slot = enemyHandSlot(i, Math.min(count, 8));
      this.applySlot(back, slot);
      this.enemyHandGroup.add(back);
      if (animate) {
        back.scale.setScalar(0.55);
        this.tween(back, { scale: new THREE.Vector3(0.9, 0.9, 0.9) }, 0.34, easeOut, undefined, i * 0.03);
      } else {
        back.scale.setScalar(0.9);
      }
    }
  }

  /** Reconciles hand, piles and enemy hand with a (possibly interpolated) snapshot. */
  syncState(state: PublicBattleState, animate = true): void {
    this.energy = state.player.energy;
    this.blockValues = { player: state.player.block, enemy: state.enemy.block };
    this.activeSide = state.phase === 'enemy' ? 'enemy' : state.phase === 'over' ? null : 'player';
    this.syncHand(state, animate);
    if (!this.spread) this.syncPiles(state, animate);
    this.syncEnemyHand(state, animate);
  }

  setState(state: PublicBattleState): void {
    this.syncState(state, false);
  }

  /** Kept for callers that only need pile counts refreshed. */
  refreshPiles(state: PublicBattleState): void {
    if (!this.spread) this.syncPiles(state, true);
  }

  // ---------------------------------------------------------------- interaction

  private attachEvents(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    this.resize();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerParallax.set(this.pointer.x, this.pointer.y);
    if (this.spread) {
      this.callbacks.onHoverCard?.(null, null);
      this.hovered = null;
      if (this.handHovered) { this.handHovered = false; this.callbacks.onHandHover?.(false); }
      return;
    }
    const handActive = this.pointer.y < -0.42 || this.pick(this.handMeshes) !== null;
    if (handActive !== this.handHovered) {
      this.handHovered = handActive;
      this.callbacks.onHandHover?.(handActive);
    }
    const hit = this.pick(this.handMeshes);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.callbacks.onHoverCard?.(hit ? hit.card : null, hit ? { x: event.clientX, y: event.clientY } : null);
    }
  };

  private onPointerLeave = (): void => {
    this.pointer.set(-10, -10);
    this.pointerParallax.set(0, 0);
    this.hovered = null;
    this.callbacks.onHoverCard?.(null, null);
    if (this.handHovered) { this.handHovered = false; this.callbacks.onHandHover?.(false); }
  };

  private onPointerDown = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const nearHand = this.pointer.y < -0.42 || this.pick(this.handMeshes) !== null;
    if (nearHand && !this.handHovered) {
      this.handHovered = true;
      this.callbacks.onHandHover?.(true);
    }
    if (this.spread) {
      this.collapseSpread();
      return;
    }
    const piles = [...this.pileMeshes.values()].flat();
    const hit = this.pick(piles);
    if (hit) {
      const pile = (hit.group.parent?.userData.pile as PileKey | undefined) ?? null;
      if (pile) {
        this.callbacks.onPileClick?.(pile);
        return;
      }
    }
    const padPile = this.pickPilePad();
    if (padPile) {
      this.callbacks.onPileClick?.(padPile);
      return;
    }

  };

  private pickPilePad(): PileKey | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const pile of PILE_KEYS) {
      const pad = this.pileGroups.get(pile)?.userData.pad as THREE.Mesh | undefined;
      if (!pad) continue;
      if (this.raycaster.intersectObject(pad, false).length > 0) return pile;
    }
    return null;
  }

  private pick(meshes: CardMesh[]): CardMesh | null {
    if (meshes.length === 0) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects = meshes.map((m) => m.group);
    const intersects = this.raycaster.intersectObjects(objects, true);
    if (intersects.length === 0) return null;
    let node: THREE.Object3D | null = intersects[0].object;
    while (node && !meshes.some((m) => m.group === node)) node = node.parent;
    return meshes.find((m) => m.group === node) ?? null;
  }

  /** Spreads either discard pile into a readable row so both sides can be inspected. */
  spreadPile(pile: PileKey, state: PublicBattleState): void {
    if (pileType(pile) !== 'discard') return;
    const side = pileSide(pile);
    const cards = side === 'player' ? state.player.discard : state.enemyDiscard;
    if (this.spread === pile) {
      this.applyView(side === 'player' ? 'discard' : 'enemy-discard', false);
      return;
    }
    this.collapseSpread();
    const group = this.pileGroups.get(pile)!;
    const existing = this.pileMeshes.get(pile)!;
    for (const mesh of existing) group.remove(mesh.group);

    const accent = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const zBase = side === 'player' ? 1.95 : -1.95;
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(6.2, Math.max(2.2, cards.length * 0.7 + 0.8)), 2.2),
      new THREE.MeshBasicMaterial({ color: '#04090d', transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
    );
    backdrop.rotation.x = -Math.PI / 2 + 0.55;
    backdrop.position.set(0, 0.5, zBase);
    this.worldGroup.add(backdrop);
    this.spreadBackdrop = backdrop;

    if (cards.length === 0) {
      const empty = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: numberTexture('EMPTY', accent), transparent: true, depthWrite: false }),
      );
      empty.position.set(0, 0.95, zBase);
      empty.scale.set(1.5, 0.42, 1);
      this.worldGroup.add(empty);
      this.spreadEmpty = empty;
    }

    const row: CardMesh[] = cards.map((card, i) => {
      const mesh = this.makeCardMesh(card, false);
      const from = existing[Math.min(i, Math.max(0, existing.length - 1))]?.group.position.clone() ?? this.slotPosition(pileSlot(pile, i, cards.length));
      mesh.group.position.copy(from);
      mesh.group.rotation.copy(existing[0]?.group.rotation ?? new THREE.Euler(-Math.PI / 2, 0, 0));
      this.worldGroup.add(mesh.group);
      const slot = spreadSlot(pile, i, cards.length);
      this.tween(mesh.group, { position: this.slotPosition(slot), quaternion: this.slotQuaternion(slot) }, 0.55, easeOut);
      return mesh;
    });
    this.pileMeshes.set(pile, row);
    this.spreadSaved = { group, meshes: existing };
    this.spread = pile;
    this.handGroup.visible = false;
    this.enemyHandGroup.visible = false;
    if (this.enemyHandLabel) this.enemyHandLabel.visible = false;
    this.applyView(side === 'player' ? 'discard' : 'enemy-discard', false);
    this.callbacks.onSpreadChange?.(pile);
  }

  collapseSpread(): void {
    if (!this.spread || !this.spreadSaved) return;
    const pile = this.spread;
    this.spread = null;
    const { group, meshes } = this.spreadSaved;
    const current = this.pileMeshes.get(pile) ?? [];
    for (const mesh of current) {
      this.worldGroup.remove(mesh.group);
      group.remove(mesh.group);
      this.disposeCardMesh(mesh);
    }
    if (this.spreadEmpty) {
      this.worldGroup.remove(this.spreadEmpty);
      this.spreadEmpty.material.dispose();
      this.spreadEmpty = null;
    }
    if (this.spreadBackdrop) {
      this.worldGroup.remove(this.spreadBackdrop);
      this.spreadBackdrop.geometry.dispose();
      (this.spreadBackdrop.material as THREE.Material).dispose();
      this.spreadBackdrop = null;
    }
    this.pileMeshes.set(pile, meshes);
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].group.parent !== group) group.add(meshes[i].group);
      const slot = pileSlot(pile, i, meshes.length);
      meshes[i].group.position.set(slot.x, slot.y + 0.3, slot.z);
      this.tweenToSlot(meshes[i].group, slot, 0.4);
    }
    this.spreadSaved = null;
    this.handGroup.visible = true;
    this.enemyHandGroup.visible = true;
    if (this.enemyHandLabel) this.enemyHandLabel.visible = true;
    this.applyView('overview', false);
    this.callbacks.onSpreadChange?.(null);
  }

  isSpread(): boolean {
    return this.spread !== null;
  }

  // ---------------------------------------------------------------- camera

  applyView(view: ViewName, instant: boolean): void {
    this.view = view;
    const aspect = this.camera.aspect || 1.6;
    const preset = cameraPreset(view, aspect);
    const position = new THREE.Vector3(...preset.position);
    const target = new THREE.Vector3(...preset.target);
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (instant) {
      this.camera.position.copy(position);
      this.cameraTarget.copy(target);
      this.camera.lookAt(target);
    } else {
      this.tween(this.camera, { position, target }, 0.8, easeInOut);
    }
    this.callbacks.onViewChange?.(view);
  }

  // ---------------------------------------------------------------- cues

  setSpeed(speed: number): void {
    this.speed = Math.max(0.25, speed);
  }

  /** One visual event: reconcile cards, then play the effect cue. */
  applyEvent(event: LogEvent, state: PublicBattleState, cue: VisualCue | null): void {
    if (event.type === 'card_end' || event.type === 'card_halt') this.retireStageCard();
    if (event.type === 'battle_end') this.retireStageCard(false);
    if (cue) this.applyCue(cue, state);
    else this.syncState(state, true);
  }

  applyCue(cue: VisualCue, state: PublicBattleState): void {
    const dir = cueDirection(cue);
    this.cameraShake = Math.max(this.cameraShake, dir.shake);
    const targetSide = cue.target ?? (cue.side === 'enemy' ? 'player' : 'enemy');
    if (cue.kind === 'cast' && cue.side !== 'enemy') this.detachLeftmostToStage();
    this.syncState(state, true);
    switch (cue.kind) {
      case 'cast': {
        const side = cue.side ?? 'player';
        this.castPulse(side);
        if (cue.card && side === 'enemy') this.presentEnemyCard(cue.card);
        break;
      }
      case 'hit':
        this.launchProjectile(cue.side ?? 'player', targetSide, cue.amount ?? 0, cue.blocked ?? 0);
        break;
      case 'block':
        this.burstAt(cue.side ?? 'player', '#38f2cf', 22, 0.7);
        this.ringAt(cue.side ?? 'player', '#38f2cf');
        this.shieldPulse(cue.side ?? 'player');
        if (cue.amount) this.floatNumber(this.tr(`+${cue.amount} 格挡`, `+${cue.amount} block`), cue.side ?? 'player', '#7ef0c0');
        break;
      case 'heal':
        this.healEffect(cue.side ?? 'player', cue.amount ?? 0);
        break;
      case 'energy':
        this.energyEffect(cue.side ?? 'player', cue.delta ?? 0);
        break;
      case 'expire':
        this.burstAt(cue.side ?? 'player', '#7ef0c0', 16, 0.05);
        this.floatNumber(this.tr('格挡消散', 'Block expires'), cue.side ?? 'player', '#7ef0c0');
        break;
      case 'shuffle':
        this.jigglePile();
        break;
      case 'halt':
        this.hitStandee(cue.side ?? 'player', 0, '#ff4d5e');
        break;
      case 'end':
        this.focus = null;
        this.applyView('overview', false);
        break;
      case 'phase':
        this.applyPhaseCue(cue);
        break;
      default:
        break;
    }
  }

  /** A card is being played: flash a ring around the stage where it is presented. */
  private castPulse(side: 'player' | 'enemy'): void {
    const slot = stageSlot(side);
    const color = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.58, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    ring.position.set(slot.x, slot.y, slot.z);
    ring.lookAt(this.camera.position);
    this.fxGroup.add(ring);
    ring.scale.setScalar(0.55);
    this.tween(ring, { scale: new THREE.Vector3(2.4, 2.4, 2.4) }, 0.48, easeOut, () => {
      this.fxGroup.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    });
    this.burstAt(side, color, 10, 0.35);
  }

  /** Attacks always spawn a missile at the attacker and fly it into the target. */
  private launchProjectile(from: 'player' | 'enemy', to: 'player' | 'enemy', amount: number, blocked: number): void {
    if (from === to) {
      this.projectileImpact(to, amount, blocked, from === 'player' ? '#63d6ff' : '#ff5f7d');
      return;
    }
    const fromOrigin = from === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const toOrigin = to === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const start = new THREE.Vector3(fromOrigin.x, 1.55, fromOrigin.z);
    const end = new THREE.Vector3(toOrigin.x, 1.42, toOrigin.z);
    const color = from === 'player' ? '#63d6ff' : '#ff5f7d';
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 14, 10),
      new THREE.MeshBasicMaterial({ color: '#f3ffff' }),
    );
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(0.23, 14, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    const tail = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.7, 14, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    const dir = end.clone().sub(start).normalize();
    tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    tail.position.copy(dir.clone().multiplyScalar(-0.32));
    group.add(aura, tail, core);
    group.position.copy(start);
    this.fxGroup.add(group);
    this.ringAt(from, color);

    const proxy = new THREE.Object3D();
    proxy.position.copy(start);
    let lastTrail = -1;
    this.tween(
      proxy,
      { position: end },
      0.44,
      (t) => t,
      () => {
        this.fxGroup.remove(group);
        group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.projectileImpact(to, amount, blocked, color);
      },
      0,
      (t) => {
        const pos = proxy.position.clone();
        pos.y += Math.sin(Math.PI * t) * 0.55;
        group.position.copy(pos);
        if (t - lastTrail > 0.1) {
          lastTrail = t;
          this.spawnTrail(pos, color);
        }
      },
    );
  }

  private spawnTrail(position: THREE.Vector3, color: string): void {
    const spark = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.045),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    spark.position.copy(position);
    spark.position.x += (this.rng() - 0.5) * 0.12;
    spark.position.y += (this.rng() - 0.5) * 0.12;
    spark.position.z += (this.rng() - 0.5) * 0.12;
    this.fxGroup.add(spark);
    this.tween(spark, { scale: new THREE.Vector3(0.05, 0.05, 0.05) }, 0.28, easeOut, () => {
      this.fxGroup.remove(spark);
      spark.geometry.dispose();
      (spark.material as THREE.Material).dispose();
    });
  }

  private projectileImpact(target: 'player' | 'enemy', amount: number, blocked: number, color: string): void {
    this.ringAt(target, color);
    this.cameraShake = Math.max(this.cameraShake, amount >= 6 ? 0.055 : 0.028);
    if (blocked > 0) {
      this.shatterShield(target);
      this.floatNumber(this.tr(`格挡 -${blocked}`, `-${blocked} block`), target, '#9fd6ff');
    }
    this.hitStandee(target, amount, '#ff4d5e');
  }

  /** Healing rises from the unit: light column, expanding ring and floating motes. */
  private healEffect(side: 'player' | 'enemy', amount: number): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const color = '#58f2a8';
    this.ringAt(side, color);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.52, 0.92, 2.2, 24, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.set(origin.x, 1.25, origin.z);
    beam.scale.set(0.35, 0.25, 0.35);
    this.fxGroup.add(beam);
    this.tween(beam, { scale: new THREE.Vector3(1, 1, 1) }, 0.32, easeOut, () => {
      this.tween(beam, { scale: new THREE.Vector3(1.15, 1.3, 1.15) }, 0.5, easeInOut, () => {
        this.fxGroup.remove(beam);
        beam.geometry.dispose();
        (beam.material as THREE.Material).dispose();
      });
    });

    const rng = seededRandom(this.tweenId + 53);
    for (let i = 0; i < 18; i++) {
      const mote = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.028 + rng() * 0.03),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      const a = rng() * Math.PI * 2;
      const radius = 0.25 + rng() * 0.65;
      mote.position.set(origin.x + Math.cos(a) * radius, 0.35 + rng() * 0.5, origin.z + Math.sin(a) * radius);
      this.fxGroup.add(mote);
      this.tween(
        mote,
        {
          position: new THREE.Vector3(origin.x + Math.cos(a) * (radius * 0.6), 2.3 + rng() * 0.9, origin.z + Math.sin(a) * (radius * 0.6)),
          scale: new THREE.Vector3(0.2, 0.2, 0.2),
        },
        0.85 + rng() * 0.35,
        easeOut,
        () => {
          this.fxGroup.remove(mote);
          mote.geometry.dispose();
          (mote.material as THREE.Material).dispose();
        },
        0.03 * i,
      );
    }

    for (let i = 0; i < 5; i++) {
      const plus = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: numberTexture('+', '#b6ffd9'), transparent: true, depthWrite: false }),
      );
      plus.position.set(origin.x + (rng() - 0.5) * 1.1, 0.7 + rng() * 0.8, origin.z + (rng() - 0.5) * 0.6);
      plus.scale.set(0.22, 0.22, 1);
      this.fxGroup.add(plus);
      this.tween(plus, { position: plus.position.clone().add(new THREE.Vector3(0, 1.4 + rng() * 0.6, 0)) }, 0.9, easeOut, () => {
        this.fxGroup.remove(plus);
        plus.material.dispose();
      }, i * 0.06);
    }

    if (amount > 0) this.floatNumber(`+${amount}`, side, color);
  }

  /** Energy gain/loss orbits the unit then snaps into its HUD. */
  private energyEffect(side: 'player' | 'enemy', delta: number): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const gain = delta >= 0;
    const color = gain ? '#ffd37a' : '#8f9fb3';
    this.ringAt(side, color);
    const rng = seededRandom(this.tweenId + 71);
    for (let i = 0; i < 14; i++) {
      const orb = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.04 + rng() * 0.03),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      const a = (i / 14) * Math.PI * 2;
      orb.position.set(origin.x + Math.cos(a) * 0.72, 0.55 + rng() * 0.7, origin.z + Math.sin(a) * 0.62);
      this.fxGroup.add(orb);
      this.tween(
        orb,
        {
          position: new THREE.Vector3(origin.x + Math.cos(a + 1.6) * 0.22, 2.35 + rng() * 0.7, origin.z + Math.sin(a + 1.6) * 0.22),
          scale: new THREE.Vector3(0.15, 0.15, 0.15),
        },
        0.72 + rng() * 0.25,
        easeOut,
        () => {
          this.fxGroup.remove(orb);
          orb.geometry.dispose();
          (orb.material as THREE.Material).dispose();
        },
        0.02 * i,
      );
    }
    if (delta !== 0) this.floatNumber(this.tr(`${gain ? '+' : ''}${delta} 能量`, `${gain ? '+' : ''}${delta} energy`), side, color);
  }

  private ringAt(side: 'player' | 'enemy', color: string): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.44, 0.52, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(origin.x, 0.06, origin.z);
    this.fxGroup.add(ring);
    ring.scale.setScalar(0.6);
    this.tween(ring, { scale: new THREE.Vector3(2.7, 2.7, 2.7) }, 0.6, easeOut, () => {
      this.fxGroup.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    });
  }

  private applyPhaseCue(cue: VisualCue): void {
    const side = cue.phaseSide ?? null;
    this.focus = side && side !== 'over' ? side : null;
    this.activeSide = side && side !== 'over' ? side : null;
    if (side === 'enemy') {
      this.cameraShake = Math.max(this.cameraShake, 0.012);
    }
  }

  private presentEnemyCard(card: PublicCard): void {
    const mesh = this.makeCardMesh(card, false);
    this.attachCardHalo(mesh.group, 'enemy');
    mesh.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat && 'emissiveIntensity' in mat) mat.emissiveIntensity = 0.8;
      }
    });
    if (this.stageHalo) {
      this.stageHalo.visible = true;
      (this.stageHalo.material as THREE.MeshBasicMaterial).color.set(ENEMY_COLOR);
    }
    const slot = stageSlot('enemy');
    const from = ENEMY_STANDEE.clone().setY(1.7);
    mesh.group.position.copy(from);
    mesh.group.scale.setScalar(0.8);
    this.stageGroup.add(mesh.group);
    this.tween(mesh.group, { position: this.slotPosition(slot), quaternion: this.slotQuaternion(slot), scale: new THREE.Vector3(...Array(3).fill(this.camera.aspect < 1 ? 1.9 : 1.45)) }, 0.4, easeOut);
    window.setTimeout(() => {
      if (this.disposed) return;
      const anchor = PILE_ANCHOR['enemy-discard'];
      if (this.stageHalo) { this.stageHalo.visible = false; (this.stageHalo.material as THREE.MeshBasicMaterial).opacity = 0; }
      this.tween(mesh.group, { position: new THREE.Vector3(anchor.x, 0.12, anchor.z), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), scale: new THREE.Vector3(0.7, 0.7, 0.7) }, 0.42, easeInOut, () => {
        this.stageGroup.remove(mesh.group);
        this.disposeCardMesh(mesh);
      });
    }, 1250 / this.speed);
  }

  private jigglePile(): void {
    const meshes = this.pileMeshes.get('player-draw') ?? [];
    meshes.forEach((mesh, i) => {
      const base = mesh.group.position.clone();
      const lift = 0.25 + this.rng() * 0.35;
      this.tween(mesh.group, { position: new THREE.Vector3(base.x, base.y + lift, base.z) }, 0.22, easeOut, () => {
        this.tween(mesh.group, { position: base }, 0.32, easeInOut);
      }, i * 0.02);
    });
  }

  private burstAt(side: 'player' | 'enemy', color: string, count: number, dy: number): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const rng = seededRandom(this.tweenId + 17);
    for (let i = 0; i < count; i++) {
      const particle = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.035),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      particle.position.set(origin.x + (rng() - 0.5) * 0.9, 0.6 + rng() * 1.6, origin.z + (rng() - 0.5) * 0.5);
      this.fxGroup.add(particle);
      const drift = new THREE.Vector3((rng() - 0.5) * 0.5, dy + rng() * 0.4, (rng() - 0.5) * 0.4);
      const to = particle.position.clone().add(drift);
      this.tween(particle, { position: to, scale: new THREE.Vector3(0.2, 0.2, 0.2) }, 0.8, easeOut, () => {
        this.fxGroup.remove(particle);
        particle.geometry.dispose();
        (particle.material as THREE.Material).dispose();
      });
    }
  }

  private shatterShield(side: 'player' | 'enemy'): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const color = side === 'player' ? '#7fc4ff' : '#ff8894';
    const rng = seededRandom(this.tweenId + 31);
    for (let i = 0; i < 14; i++) {
      const shard = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.09 + rng() * 0.1),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      const a = (i / 14) * Math.PI * 2 + rng() * 0.5;
      shard.position.set(origin.x + Math.cos(a) * 0.9, 0.8 + rng() * 0.9, origin.z + Math.sin(a) * 0.7);
      this.shieldGroup.add(shard);
      const to = new THREE.Vector3(
        origin.x + Math.cos(a) * (1.6 + rng()),
        0.3 + rng() * 0.7,
        origin.z + Math.sin(a) * (1.3 + rng()),
      );
      this.tween(shard, { position: to, scale: new THREE.Vector3(0.15, 0.15, 0.15) }, 0.62, easeOut, () => {
        this.shieldGroup.remove(shard);
        shard.geometry.dispose();
        (shard.material as THREE.Material).dispose();
      });
    }
  }

  private shieldPulse(side: 'player' | 'enemy'): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const shield = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.15, 1),
      new THREE.MeshBasicMaterial({ color: '#38f2cf', wireframe: true, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    shield.position.set(origin.x, 1.1, origin.z);
    shield.scale.setScalar(0.5);
    this.shieldGroup.add(shield);
    this.tween(shield, { scale: new THREE.Vector3(1, 1, 1) }, 0.45, easeOut, () => {
      this.tween(shield, { scale: new THREE.Vector3(1.35, 1.35, 1.35) }, 0.45, easeInOut, () => {
        this.shieldGroup.remove(shield);
        shield.geometry.dispose();
        (shield.material as THREE.Material).dispose();
      });
    });
  }

  private hitStandee(side: 'player' | 'enemy', amount: number, color: string): void {
    const standee = this.standees.get(side);
    if (!standee) return;
    standee.shader.uniforms.uHit.value = 0.8;
    window.setTimeout(() => {
      if (!this.disposed) standee.shader.uniforms.uHit.value = 0;
    }, 420 / this.speed);
    this.burstAt(side, color, 24, 0.3);
    if (amount > 0) this.floatNumber(`-${amount}`, side, color);
  }

  private floatNumber(text: string, side: 'player' | 'enemy', color: string): void {
    const origin = side === 'player' ? PLAYER_STANDEE : ENEMY_STANDEE;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: numberTexture(text, color), transparent: true, depthWrite: false }));
    sprite.position.set(origin.x, 2.15, origin.z);
    sprite.scale.set(1.1, 0.55, 1);
    this.fxGroup.add(sprite);
    this.tween(sprite, { position: new THREE.Vector3(origin.x, 2.95, origin.z) }, 1.1, easeOut, () => {
      this.fxGroup.remove(sprite);
      sprite.material.dispose();
    });
  }

  // ---------------------------------------------------------------- tweens

  private tween(
    object: THREE.Object3D | THREE.Camera,
    to: { position?: THREE.Vector3; scale?: THREE.Vector3; quaternion?: THREE.Quaternion; target?: THREE.Vector3 },
    duration: number,
    ease: (t: number) => number = easeOut,
    onDone?: () => void,
    delay = 0,
    onUpdate?: (t: number) => void,
  ): void {
    // A newer motion for the same object replaces the old one, so card reordering stays crisp.
    this.tweens = this.tweens.filter((tw) => tw.object !== (object as THREE.Object3D));
    const tween: Tween = {
      id: ++this.tweenId,
      object: object as THREE.Object3D,
      from: {
        position: (object as THREE.Object3D).position.clone(),
        scale: (object as THREE.Object3D).scale.clone(),
        quaternion: (object as THREE.Object3D).quaternion.clone(),
      },
      to: {
        position: to.position?.clone() ?? (object as THREE.Object3D).position.clone(),
        scale: to.scale?.clone() ?? (object as THREE.Object3D).scale.clone(),
        quaternion: to.quaternion?.clone() ?? (object as THREE.Object3D).quaternion.clone(),
      },
      start: this.time + Math.max(0, delay) / this.speed,
      duration: Math.max(0.05, duration / this.speed),
      ease,
      onDone,
      onUpdate,
    };
    if (to.target) this.cameraTargetGoal.copy(to.target);
    this.tweens.push(tween);
  }

  private cameraTargetGoal = new THREE.Vector3();

  // ---------------------------------------------------------------- loop

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = window.requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.updateTweens();
    this.updateIdle(dt);
    this.updatePresentation(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateTweens(): void {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      if (this.time < tw.start) continue;
      const t = Math.min(1, (this.time - tw.start) / tw.duration);
      const k = tw.ease(t);
      tw.object.position.lerpVectors(tw.from.position, tw.to.position, k);
      tw.object.scale.lerpVectors(tw.from.scale, tw.to.scale, k);
      tw.object.quaternion.slerpQuaternions(tw.from.quaternion, tw.to.quaternion, k);
      tw.onUpdate?.(t);
      if (t >= 1) {
        this.tweens.splice(i, 1);
        tw.onDone?.();
      }
    }
  }

  private updateIdle(dt: number): void {
    for (const side of ['player', 'enemy'] as const) {
      const standee = this.standees.get(side);
      if (!standee) continue;
      const motion = idleMotion(this.time, side);
      standee.group.position.y = motion.y;
      standee.group.rotation.z = motion.sway;
      standee.group.scale.setScalar(motion.scale);
      standee.shader.uniforms.uTime.value = this.time;
      standee.shader.uniforms.uFlicker.value = motion.flicker;
      standee.shader.uniforms.uDim.value = this.activeSide && this.activeSide !== side ? 0.62 : 1;
      standee.rings.forEach((ring, i) => {
        if (i < 3) ring.rotation.z += dt * (side === 'player' ? 0.35 : -0.28) * (1 + i * 0.3);
        else ring.rotation.y += dt * 0.4;
      });
    }
    if (this.dust) {
      const positions = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i++) {
        let y = positions.getY(i) + dt * 0.08;
        if (y > 6.6) y = -0.4;
        positions.setY(i, y);
      }
      positions.needsUpdate = true;
    }
  }

  private updatePresentation(dt: number): void {
    const pulse = 0.86 + 0.14 * Math.sin(this.time * 2.6);
    for (const side of ['player', 'enemy'] as const) {
      const aura = this.blockAuras.get(side);
      if (!aura) continue;
      const block = this.blockValues[side];
      aura.visible = block > 0;
      if (block > 0) {
        const material = aura.material as THREE.MeshBasicMaterial;
        material.opacity = Math.min(0.36, 0.1 + block / 110) * pulse;
        aura.scale.setScalar(1 + Math.min(0.2, block / 160) + Math.sin(this.time * 1.8) * 0.008);
        aura.rotation.y += dt * 0.25;
      }
    }

    if (this.stageHalo) {
      const mat = this.stageHalo.material as THREE.MeshBasicMaterial;
      const active = !!this.stagedCard;
      mat.opacity = active ? 0.2 + 0.1 * Math.sin(this.time * 5.2) : 0;
      this.stageHalo.scale.setScalar(active ? 1 + Math.sin(this.time * 2.8) * 0.035 : 1);
    }

    const first = this.handMeshes[0];
    const show = !!first && this.activeSide === 'player' && !this.spread && !this.stagedCard;
    this.nextMarker.visible = show;
    if (this.nextGround) this.nextGround.visible = show;
    if (!show || !first) return;
    this.nextMarker.position.copy(first.group.position);
    this.nextMarker.quaternion.copy(first.group.quaternion);
    this.nextMarker.translateZ(CARD_THICK / 2 + 0.03);
    this.nextMarker.scale.setScalar(this.cardScale);
    const color = '#58d7ff';
    if (this.nextUniforms) {
      this.nextUniforms.uTime.value = this.time;
      this.nextUniforms.uColor.value.set('#58d7ff');
    }
    if (this.nextLabel) {
      const material = this.nextLabel.material as THREE.SpriteMaterial;
      const map = numberTexture('NEXT', color);
      if (material.map !== map) {
        material.map = map;
        material.needsUpdate = true;
      }
      this.nextLabel.position.set(0, CARD_H * 0.72, 0.04);
      this.nextLabel.scale.set(0.66, 0.21, 1);
    }
    if (this.nextGround) {
      this.nextGround.position.set(first.group.position.x, 0.018, first.group.position.z);
      this.nextGround.scale.setScalar(1 + Math.sin(this.time * 3.2) * 0.06);
      (this.nextGround.material as THREE.MeshBasicMaterial).color.set(color);
    }
  }

  private updateCamera(dt: number): void {
    const aspect = this.camera.aspect || 1.6;
    const preset = cameraPreset(this.view, aspect);
    const base = new THREE.Vector3(...preset.position);
    base.x += this.pointerParallax.x * (aspect < 1 ? 0.35 : 0.55);
    base.y += this.pointerParallax.y * 0.22;
    this.camera.position.lerp(base, Math.min(1, dt * 2.2));
    this.cameraTarget.lerp(this.cameraTargetGoal.lengthSq() > 0 ? this.cameraTargetGoal : new THREE.Vector3(...preset.target), Math.min(1, dt * 2.2));
    if (this.cameraShake > 0.0005) {
      const jitter = this.cameraShake;
      this.camera.position.x += Math.sin(this.time * 90) * jitter;
      this.camera.position.y += Math.cos(this.time * 74) * jitter * 0.6;
      this.cameraShake *= 0.9;
    }
    const look = this.cameraTarget.clone();
    const focusX = this.focus === 'player' ? -0.32 : this.focus === 'enemy' ? 0.32 : 0;
    look.x += focusX;
    this.camera.position.x += focusX * 0.15;
    this.camera.lookAt(look);
  }

  // ---------------------------------------------------------------- lifecycle

  resize(): void {
    const parent = this.canvas.parentElement;
    const width = Math.max(240, this.canvas.clientWidth || parent?.clientWidth || window.innerWidth);
    const height = Math.max(240, this.canvas.clientHeight || parent?.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissorTest(false);
    this.camera.aspect = width / height;
    const aspect = width / height;
    this.cardScale = aspect < 0.8 ? Math.max(0.92, aspect / 0.7) : 1;
    this.handSpread = aspect < 0.62 ? 0.82 : 1;
    for (const mesh of this.handMeshes) mesh.group.scale.setScalar(this.cardScale);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    window.cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('resize', this.onResize);
    this.observer?.disconnect();
    for (const mesh of [...this.handMeshes, ...[...this.pileMeshes.values()].flat(), ...this.stageMeshes]) this.disposeCardMesh(mesh);
    if (this.stagedCard) this.disposeCardMesh(this.stagedCard);
    this.handMeshes = [];
    this.stageMeshes = [];
    this.pileMeshes.clear();
    if (this.enemyHandLabel) {
      this.enemyHandLabel.material.dispose();
      this.enemyHandLabel = null;
    }
    this.nextMarker.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.nextGround?.geometry.dispose();
    if (this.nextGround) (this.nextGround.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}

const fallbackCard: PublicCard = {
  uid: 'fallback',
  name: 'Unknown',
  description: '',
  cost: 1,
  type: 'skill',
  target: 'none',
  playable: true,
};
