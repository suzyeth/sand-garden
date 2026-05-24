import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SAND_HALF } from '../sim/constants';

/**
 * Small ornamental clusters tucked into the corners of the sand
 * platform itself — bamboo, dwarf shrub, grass tufts. Lives ON the
 * sand, well clear of the robot's outermost rings (which top out
 * around radius 5 from any stone centre).
 *
 * Positioning is deliberately asymmetric — three of four corners get
 * something, one stays empty, per karesansui balance. Scale is
 * intentionally small: real karesansui ornament is humble, not
 * monumental, and these need to read as "rooted in the garden"
 * rather than "trees crashing the diorama".
 */

// Sit decorations just inside the wooden border (~6.5m from centre).
// Wall sits at SAND_HALF - WALL_THICKNESS/2 = 7.9; we leave ~1.4m
// breathing room.
const CORNER_DIST = SAND_HALF - 1.4;
// Bamboo cluster centre moved further inward — its 1.5m clump radius
// was pushing canes out to ±8.1m and clipping into the wooden border.
// At 5.4m + 1.5m the outermost cane sits at 6.9m, comfortably inside
// the 7.8m inner wall face.
const BAMBOO_CENTER = SAND_HALF - 2.6;

function hash(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// ---- bamboo cluster (NE corner) ----

type Cane = {
  pos: [number, number];
  height: number;
  radius: number;
  tilt: number;
  greenLerp: number;
};

function buildBambooCluster(
  centreX: number,
  centreZ: number,
  count: number,
  clumpRadius: number,
): Cane[] {
  const out: Cane[] = [];
  for (let i = 0; i < count; i++) {
    const a = hash(i * 1.91 + centreX * 0.13);
    const b = hash(i * 3.17 + centreZ * 0.27);
    const r = Math.pow(a, 0.6) * clumpRadius;
    const theta = b * Math.PI * 2;
    out.push({
      pos: [centreX + Math.cos(theta) * r, centreZ + Math.sin(theta) * r],
      height: 2.2 + hash(i * 7.13 + centreX) * 1.6,
      radius: 0.032 + hash(i * 4.31 + centreZ) * 0.018,
      tilt: (hash(i * 11.7) - 0.5) * 0.16,
      greenLerp: hash(i * 5.27),
    });
  }
  return out;
}

// Three bamboo clusters — main NE grove, plus two satellites along
// the right and back of the sand. All positions verified to clear
// every main stone's outermost spiral path (SPIRAL_OUTER = 1.85 +
// stone.radius) and the home stone's moss disc.
const BAMBOO_CLUSTERS: Array<{
  center: [number, number];
  count: number;
  clumpRadius: number;
}> = [
  // Main NE cluster — biggest grove (kept where it was).
  { center: [5.4, 5.4], count: 24, clumpRadius: 1.3 },
  // SE wall-hugging satellites — one pressed against the back wall
  // (negative Z edge), one against the right engawa (positive X
  // edge). The home stone sits in between them.
  { center: [3.0, -6.8], count: 10, clumpRadius: 0.7 },
  { center: [6.8, -3.5], count: 8, clumpRadius: 0.65 },
];

const BAMBOO_LIGHT = new THREE.Color('#a5b97c');
const BAMBOO_DARK = new THREE.Color('#5a7038');

// ---- bamboo leaves ----

type Leaf = {
  x: number;
  y: number;
  z: number;
  yaw: number; // around Y axis — radial direction the leaf points
  droop: number; // negative = leaf tip falls below cluster
  roll: number; // around leaf's long axis (small variation)
  length: number; // m
  width: number; // m
  colour: THREE.Color;
};

type Branchlet = {
  baseX: number;
  baseY: number;
  baseZ: number;
  yaw: number; // outward direction in xz plane
  length: number; // total length along its own axis
  upTilt: number; // angle (radians) above horizontal at attachment
  caneColour: THREE.Color;
};

// Per-cane gentle curve — the shader bends the cane's top, so we mirror
// that bend here in TS so branchlets / leaves still meet the cane
// surface. Seed is the cane's world XZ, matching the shader expression.
const CANE_CURVE_AMP = 0.12; // metres at very tip
function caneCurveOffset(
  canePosX: number,
  canePosZ: number,
  yFrac: number,
): [number, number] {
  const seed = canePosX * 1.31 + canePosZ * 2.07;
  const cdx = Math.sin(seed);
  const cdz = Math.cos(seed);
  const amp = Math.pow(Math.max(0, yFrac), 1.6) * CANE_CURVE_AMP;
  return [cdx * amp, cdz * amp];
}

function buildBranchletsForCane(cane: Cane, baseIndex: number): Branchlet[] {
  const branchlets: Branchlet[] = [];
  // 3-6 branchlets distributed in upper 40-95% of cane. Real bamboo
  // branchlets cluster at the upper nodes — match by biasing toward
  // higher y fractions.
  const count = 3 + Math.floor(hash(baseIndex * 17.3) * 4);
  // Cane is rendered with rotation=(tilt, 0, tilt*0.6) (three.js XYZ
  // Euler). The cane's centreline at local Y = h*(yFrac - 0.5) ends up
  // displaced in world space by these small angles. We replicate the
  // displacement so the branchlet base meets the actual cane surface,
  // not the un-rotated axis.
  const tiltX = cane.tilt;
  const tiltZ = cane.tilt * 0.6;
  const cosTx = Math.cos(tiltX);
  const sinTx = Math.sin(tiltX);
  const cosTz = Math.cos(tiltZ);
  const sinTz = Math.sin(tiltZ);
  for (let c = 0; c < count; c++) {
    const yFrac = 0.42 + Math.pow(hash(baseIndex * 23.1 + c * 5.7), 0.55) * 0.55;
    const localY = cane.height * (yFrac - 0.5);
    const dx = -sinTz * cosTx * localY;
    const dy = cosTz * cosTx * localY;
    const dz = sinTx * localY;
    // Anchor the branchlet just outside the cane surface (cane radius
    // is ~0.03-0.05m and tapered) so the joint looks attached, not
    // floating. We push 1.5cm out along the branchlet's yaw.
    const surfacePush = 0.014;
    const yaw = baseIndex * 0.31 + c * 2.4 + hash(baseIndex + c * 1.7) * 0.6;
    const length = 0.10 + hash(baseIndex * 31.7 + c) * 0.10;
    const upTilt = 0.18 + hash(baseIndex * 41.1 + c * 2.7) * 0.18;
    // Add the cane's curvature offset at this yFrac so the branchlet
    // hits the cane surface even after the shader bends the cane top.
    const [curveDX, curveDZ] = caneCurveOffset(cane.pos[0], cane.pos[1], yFrac);
    branchlets.push({
      baseX: cane.pos[0] + dx + Math.cos(yaw) * surfacePush + curveDX,
      baseY: cane.height / 2 + dy,
      baseZ: cane.pos[1] + dz + Math.sin(yaw) * surfacePush + curveDZ,
      yaw,
      length,
      upTilt,
      caneColour: new THREE.Color().lerpColors(
        BAMBOO_DARK,
        BAMBOO_LIGHT,
        cane.greenLerp,
      ),
    });
  }
  return branchlets;
}

function buildLeavesFromBranchlet(br: Branchlet, baseIndex: number): Leaf[] {
  const leaves: Leaf[] = [];
  // 5-8 leaves per branchlet, fanning ±0.5 rad around the branchlet
  // direction. All droop strongly — real bamboo leaves hang.
  const leafCount = 5 + Math.floor(hash(baseIndex * 7.13) * 4);
  // Endpoint of the branchlet (where leaves attach).
  const cosTilt = Math.cos(br.upTilt);
  const sinTilt = Math.sin(br.upTilt);
  const tipX = br.baseX + Math.cos(br.yaw) * br.length * cosTilt;
  const tipY = br.baseY + br.length * sinTilt;
  const tipZ = br.baseZ + Math.sin(br.yaw) * br.length * cosTilt;
  for (let l = 0; l < leafCount; l++) {
    const t = leafCount === 1 ? 0 : l / (leafCount - 1);
    // Fan spread: ±0.55 rad around branchlet yaw, biased outward.
    const fanT = (t - 0.5) * 1.1;
    const yaw = br.yaw + fanT;
    // Droop: -0.7..-1.25 rad. Real bamboo leaves nearly point at the
    // ground from drooped branchlets.
    const droop = -0.7 - hash(baseIndex * 13.7 + l * 4.1) * 0.55;
    const roll = (hash(baseIndex * 19.3 + l * 7.7) - 0.5) * 0.7;
    const length = 0.16 + hash(baseIndex * 29.1 + l * 1.3) * 0.13;
    const width = 0.018 + hash(baseIndex * 37.7 + l * 2.7) * 0.010;
    // Tiny scatter from the branchlet tip so leaves don't stack on a
    // single point.
    const scatter = 0.008;
    const sx = (hash(baseIndex * 47.1 + l) - 0.5) * scatter;
    const sz = (hash(baseIndex * 53.3 + l * 1.7) - 0.5) * scatter;
    const colour = new THREE.Color().lerpColors(
      BAMBOO_DARK,
      BAMBOO_LIGHT,
      0.3 + hash(baseIndex * 59.7 + l * 3.7) * 0.6,
    );
    leaves.push({
      x: tipX + sx,
      y: tipY,
      z: tipZ + sz,
      yaw,
      droop,
      roll,
      length,
      width,
      colour,
    });
  }
  return leaves;
}

function buildLeafTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  ctx.clearRect(0, 0, w, h);
  // Lance-shaped silhouette: narrow at base, widest ~30% up, pointed tip.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  const cx = w / 2;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Shape: pow asymmetry — fast widen, slow taper to tip.
    const profile = Math.pow(t, 0.55) * Math.pow(1 - t, 0.85);
    const halfW = (w * 0.46) * profile / 0.34;
    const y = t * h;
    if (i === 0) ctx.moveTo(cx + halfW, y);
    else ctx.lineTo(cx + halfW, y);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const profile = Math.pow(t, 0.55) * Math.pow(1 - t, 0.85);
    const halfW = (w * 0.46) * profile / 0.34;
    ctx.lineTo(cx - halfW, t * h);
  }
  ctx.closePath();
  ctx.fill();
  // Central vein.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx, 4);
  ctx.lineTo(cx, h - 4);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---- grass tufts (SW corner) ----

type Tuft = {
  pos: [number, number];
  rotY: number;
  scale: number;
};

function buildGrassTufts(
  centreX: number,
  centreZ: number,
  count: number,
): Tuft[] {
  const out: Tuft[] = [];
  for (let i = 0; i < count; i++) {
    const a = hash(i * 2.13 + centreX * 0.31);
    const b = hash(i * 4.41 + centreZ * 0.17);
    const r = Math.pow(a, 0.7) * 0.85;
    const theta = b * Math.PI * 2;
    out.push({
      pos: [centreX + Math.cos(theta) * r, centreZ + Math.sin(theta) * r],
      rotY: hash(i * 6.7) * Math.PI,
      scale: 0.14 + hash(i * 8.91) * 0.07, // 0.14-0.21m tall
    });
  }
  return out;
}

// ---- dwarf shrub (NW corner) — small low conifer-ish dome ----

const SHRUB_POSITIONS: Array<[number, number, [number, number, number]]> = [
  // [x, z, [scale_x, scale_y, scale_z]]
  [-CORNER_DIST + 0.0, CORNER_DIST + 0.0, [0.55, 0.32, 0.55]],
  [-CORNER_DIST + 0.45, CORNER_DIST - 0.15, [0.32, 0.2, 0.32]],
];

export function Periphery() {
  const bamboo = useMemo(() => {
    const all: Cane[] = [];
    for (const c of BAMBOO_CLUSTERS) {
      all.push(
        ...buildBambooCluster(c.center[0], c.center[1], c.count, c.clumpRadius),
      );
    }
    return all;
  }, []);

  const branchlets = useMemo(() => {
    const all: Branchlet[] = [];
    bamboo.forEach((cane, idx) => {
      all.push(...buildBranchletsForCane(cane, idx + 1));
    });
    return all;
  }, [bamboo]);

  const leaves = useMemo(() => {
    const all: Leaf[] = [];
    branchlets.forEach((br, idx) => {
      all.push(...buildLeavesFromBranchlet(br, idx + 101));
    });
    return all;
  }, [branchlets]);

  const leafTexture = useMemo(() => buildLeafTexture(), []);
  const leafGeom = useMemo(() => new THREE.PlaneGeometry(1, 1, 1, 1), []);
  const leafMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: leafTexture,
        color: '#8aa760',
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.45,
        roughness: 0.85,
        depthWrite: true,
      }),
    [leafTexture],
  );

  const branchletGeom = useMemo(() => {
    // Cylinder along Y; we'll orient via instance matrix.
    return new THREE.CylinderGeometry(0.004, 0.006, 1, 5, 1);
  }, []);
  const branchletMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#6e7d44',
        roughness: 0.95,
      }),
    [],
  );

  const branchletMeshRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = branchletMeshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const t = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const euler = new THREE.Euler();
    for (let i = 0; i < branchlets.length; i++) {
      const br = branchlets[i];
      // Branchlet rises from cane at upTilt, in direction yaw. Cylinder
      // default axis is +Y. Rotate so +Y maps to the branchlet's local
      // forward.
      euler.set(Math.PI / 2 - br.upTilt, br.yaw, 0, 'YXZ');
      q.setFromEuler(euler);
      // After this rotation, the cylinder's centre needs to sit half a
      // length along its (new) local +Y axis from the base attachment.
      const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      t.set(
        br.baseX + dir.x * br.length * 0.5,
        br.baseY + dir.y * br.length * 0.5,
        br.baseZ + dir.z * br.length * 0.5,
      );
      s.set(1, br.length, 1);
      m.compose(t, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, br.caneColour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [branchlets]);

  const leafMeshRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = leafMeshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const t = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const euler = new THREE.Euler();
    for (let i = 0; i < leaves.length; i++) {
      const lf = leaves[i];
      // Orientation: first yaw around Y so leaf's long axis (local +Y of
      // the plane) points radially outward; then droop tips it down;
      // small roll spins it on its own long axis for variation.
      euler.set(lf.droop, lf.yaw, lf.roll, 'YXZ');
      q.setFromEuler(euler);
      // Anchor leaf so its base is at (x,y,z) and tip extends outward
      // and down. Plane is centred — push it half its length along its
      // local +Y after rotation.
      const halfLen = lf.length * 0.5;
      const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      t.set(
        lf.x + dir.x * halfLen,
        lf.y + dir.y * halfLen,
        lf.z + dir.z * halfLen,
      );
      s.set(lf.width, lf.length, 1);
      m.compose(t, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, lf.colour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [leaves]);
  const tufts = useMemo(
    () => buildGrassTufts(-CORNER_DIST, -CORNER_DIST, 5),
    [],
  );

  // Tapered cane. Geometry handles the gentle linear taper (top 75%
  // of bottom radius); the vertex shader adds an exponential taper in
  // the top ~22% and a hint of node bulge so the silhouette reads as
  // real bamboo, not a cylinder. Radial segments bumped 8 → 12 for a
  // smoother circle; height segments 1 → 10 so the shader displacement
  // has enough rings to interpolate across.
  const caneGeom = useMemo(
    () => new THREE.CylinderGeometry(0.75, 1.0, 1, 12, 10),
    [],
  );

  // Material with node-band + per-vertex taper shader injection.
  // We use ONE shared material as a template; each mesh clones it and
  // overrides .color for per-cane tint.
  const caneBaseMat = useMemo(() => {
    // Roughness 0.55 + tiny metalness gives bamboo's faint waxy sheen
    // without going plasticky. Combined with the Y tint in the fragment
    // shader the tip catches a soft highlight.
    const m = new THREE.MeshStandardMaterial({
      color: '#7a8f55',
      roughness: 0.55,
      metalness: 0.05,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vCaneWorld;
varying float vCaneYFrac;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
// yFrac runs 0 (base) → 1 (tip) along the cane in local coords.
float yFrac = position.y + 0.5;
vCaneYFrac = yFrac;

// Exponential taper in the top ~22% of the cane. At yFrac = 0.78
// nothing happens; at yFrac = 1 the radius is pulled in by ~42%.
float topTaper = pow(max(0.0, yFrac - 0.78) * 4.55, 1.85) * 0.46;

// Subtle node bulge — a small radial swell at each ~33cm node ring
// so the cane has a knot silhouette, not just a colour band.
float nodePhase = fract(yFrac * 9.0);
float nodeBulge = 0.045 *
  smoothstep(0.42, 0.50, nodePhase) *
  smoothstep(0.58, 0.50, nodePhase);

float xzScale = max(0.0, 1.0 - topTaper) + nodeBulge;
transformed = vec3(position.x * xzScale, position.y, position.z * xzScale);

// Gentle bend in a per-cane direction — uses the cane's world XZ
// translation (modelMatrix column 3) as the seed so two adjacent
// canes don't all curve the same way. Amplitude grows as yFrac^1.6
// so the base stays anchored and only the top portion drifts. We
// divide by the local XZ scale so the world-space bend amplitude is
// independent of cane radius.
float caneBaseX = modelMatrix[3][0];
float caneBaseZ = modelMatrix[3][2];
float curveSeed = caneBaseX * 1.31 + caneBaseZ * 2.07;
vec2 curveDir = vec2(sin(curveSeed), cos(curveSeed));
float curveAmp = pow(max(0.0, yFrac), 1.6) * 0.12;
float scaleXZ = length(modelMatrix[0].xyz);
vec2 bendOffset = (scaleXZ > 0.0001) ? (curveDir * curveAmp / scaleXZ) : vec2(0.0);
transformed.x += bendOffset.x;
transformed.z += bendOffset.y;

vec4 _cw = modelMatrix * vec4(transformed, 1.0);
vCaneWorld = _cw.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vCaneWorld;
varying float vCaneYFrac;
float caneHash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );

// Periodic node bands — dark rings every ~33cm of world Y. Wider
// and darker than before so the joints actually read.
float bandPos = fract(vCaneWorld.y * 3.0);
float band =
  smoothstep(0.90, 0.99, bandPos) *
  smoothstep(1.08, 0.99, bandPos);
diffuseColor.rgb *= 1.0 - band * 0.58;

// Vertical streak noise — fine grain so the cane reads as natural.
float n = caneHash(vec2(vCaneWorld.x * 9.0, vCaneWorld.y * 1.4));
diffuseColor.rgb *= 1.0 + (n - 0.5) * 0.14;

// Long vertical fibre streaks — slightly different per cane based
// on world XZ, soft so they don't fight the node bands.
float fibre =
  0.5 + 0.5 * sin(vCaneWorld.y * 38.0 + vCaneWorld.x * 21.0 + vCaneWorld.z * 17.0);
diffuseColor.rgb *= 1.0 + (fibre - 0.5) * 0.08;

// Vertical tint gradient: shaded near the base, brighter / warmer
// toward the tip where the sun reaches first.
float tipTint = (vCaneYFrac - 0.45) * 0.42;
diffuseColor.rgb *= 1.0 + tipTint;`,
      );
    };
    return m;
  }, []);
  // Grass tuft: a stubby cone for a low blob look. Real grass would
  // be many thin blades — would cost more geometry than it's worth at
  // this scale.
  const tuftGeom = useMemo(
    () => new THREE.ConeGeometry(1, 1, 6, 1),
    [],
  );
  const shrubGeom = useMemo(
    () => new THREE.IcosahedronGeometry(1, 1),
    [],
  );

  const shrubMaterial = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#3a5430',
      roughness: 1.0,
      flatShading: true,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vShrubWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _sw = modelMatrix * vec4(transformed, 1.0);
vShrubWorld = _sw.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vShrubWorld;
float shHash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float n = shHash(vShrubWorld.xz * 9.0 + vShrubWorld.y * 4.0);
float n2 = shHash(vShrubWorld.xz * 22.0 + 11.0);
float shade = (n - 0.5) * 0.28 + (n2 - 0.5) * 0.16;
diffuseColor.rgb *= 1.0 + shade;`,
      );
    };
    return m;
  }, []);

  const tuftColour = useMemo(() => new THREE.Color('#6b8a3e'), []);

  return (
    <>
      {/* NE corner — bamboo cluster. Each cane clones the base
          material so colour varies per-cane while the node-band
          shader is compiled once. */}
      <group>
        {bamboo.map((c, i) => {
          const colour = new THREE.Color().lerpColors(
            BAMBOO_DARK,
            BAMBOO_LIGHT,
            c.greenLerp,
          );
          const mat = caneBaseMat.clone();
          mat.color = colour;
          return (
            <mesh
              key={`b-${i}`}
              position={[c.pos[0], c.height / 2, c.pos[1]]}
              rotation={[c.tilt, 0, c.tilt * 0.6]}
              scale={[c.radius, c.height, c.radius]}
              castShadow
              geometry={caneGeom}
            >
              <primitive object={mat} attach="material" />
            </mesh>
          );
        })}
      </group>

      {/* bamboo branchlets — thin twigs at upper nodes that the leaf
          clusters hang from */}
      <instancedMesh
        ref={branchletMeshRef}
        args={[branchletGeom, branchletMat, branchlets.length]}
        castShadow
      />

      {/* bamboo leaves — one instanced mesh covers all canes */}
      <instancedMesh
        ref={leafMeshRef}
        args={[leafGeom, leafMat, leaves.length]}
        castShadow
      />

      {/* SW corner — grass tufts */}
      <group>
        {tufts.map((t, i) => (
          <mesh
            key={`g-${i}`}
            position={[t.pos[0], t.scale * 0.5, t.pos[1]]}
            rotation={[0, t.rotY, 0]}
            scale={[t.scale * 0.55, t.scale, t.scale * 0.55]}
            castShadow
            geometry={tuftGeom}
          >
            <meshStandardMaterial
              color={tuftColour}
              roughness={1.0}
              flatShading
            />
          </mesh>
        ))}
      </group>

      {/* NW corner — dwarf shrub group */}
      <group>
        {SHRUB_POSITIONS.map((s, i) => (
          <mesh
            key={`s-${i}`}
            position={[s[0], s[2][1] * 0.4, s[1]]}
            scale={s[2]}
            castShadow
            geometry={shrubGeom}
          >
            <primitive object={shrubMaterial} attach="material" />
          </mesh>
        ))}
      </group>
      {/* SE corner intentionally left empty for karesansui asymmetry */}
    </>
  );
}
