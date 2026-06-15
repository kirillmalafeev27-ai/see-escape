// ocean.js — renderer, scene, camera, sky/sun and the Gerstner-wave water.
// Exposes sampleWaveHeight() so ships/debris/projectiles can ride the surface.
import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
import { Sky } from "three/addons/objects/Sky.js";

// Single source of truth for the wave set — drives both the GPU vertex
// displacement and the CPU height sampling, so they can never diverge.
export const WAVES = [
  { dir: [1.0, 0.6], steep: 0.32, len: 900, speed: 1.0 },
  { dir: [-0.7, 1.0], steep: 0.28, len: 560, speed: 1.12 },
  { dir: [0.4, -1.0], steep: 0.26, len: 320, speed: 1.28 },
  { dir: [-1.0, -0.5], steep: 0.22, len: 180, speed: 1.45 },
];

export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.5,
    20000
  );

  const sun = new THREE.Vector3();

  // ---- Water with real 3D Gerstner waves --------------------------------
  const waterGeometry = new THREE.PlaneGeometry(10000, 10000, 240, 240);
  const water = new Water(waterGeometry, {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: new THREE.TextureLoader().load(
      "textures/waternormals.jpg",
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
      },
      undefined,
      (err) => console.error("Failed to load water normals:", err)
    ),
    sunDirection: new THREE.Vector3(),
    sunColor: 0xffffff,
    waterColor: 0x10303f,
    distortionScale: 3.4,
    fog: false,
  });
  water.material.side = THREE.FrontSide;
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  // Sea state — moderate seas so the deck is walkable but alive.
  const waveUniforms = {
    uWaveHeight: { value: 0.42 },
    uWaveChop: { value: 0.7 },
    uWaveScale: { value: 1.25 },
    uQuietZoneCenter: { value: new THREE.Vector2(1e8, 1e8) },
    uQuietZoneForward: { value: new THREE.Vector2(0, -1) },
    uQuietZoneHalfSize: { value: new THREE.Vector2(1, 1) },
    uQuietZoneEdge: { value: 1 },
    uQuietZoneWaveDamping: { value: 1 },
    uHullMaskEnabled: { value: 0 },
    uHullMaskCenter: { value: new THREE.Vector2(1e8, 1e8) },
    uHullMaskForward: { value: new THREE.Vector2(0, -1) },
    uHullMaskHalfSize: { value: new THREE.Vector2(1, 1) },
    uHullMaskEdge: { value: 0.75 },
  };
  Object.assign(water.material.uniforms, waveUniforms);

  const glf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
  const waveCalls = WAVES.map(
    (w) =>
      `disp += gerstner(vec2(${glf(w.dir[0])}, ${glf(w.dir[1])}), ${glf(
        w.steep
      )} * uWaveChop, ${glf(w.len)} * uWaveScale, ${glf(
        w.speed
      )}, p, t, tangent, binormal);`
  ).join("\n                ");

  water.material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "void main() {",
        /* glsl */ `
        uniform float uWaveHeight;
        uniform float uWaveChop;
        uniform float uWaveScale;
        uniform vec2 uQuietZoneCenter;
        uniform vec2 uQuietZoneForward;
        uniform vec2 uQuietZoneHalfSize;
        uniform float uQuietZoneEdge;
        uniform float uQuietZoneWaveDamping;

        float quietZoneMask(vec2 p) {
          vec2 forward = normalize(uQuietZoneForward);
          vec2 side = vec2(forward.y, -forward.x);
          vec2 local = vec2(
            dot(p - uQuietZoneCenter, side),
            dot(p - uQuietZoneCenter, forward)
          );
          vec2 edge = max(vec2(0.001), vec2(uQuietZoneEdge));
          vec2 fade = 1.0 - smoothstep(uQuietZoneHalfSize, uQuietZoneHalfSize + edge, abs(local));
          return clamp(fade.x * fade.y, 0.0, 1.0);
        }

        vec3 gerstner(vec2 dir, float steepness, float wavelength,
                      float speed, vec2 p, float t,
                      inout vec3 tangent, inout vec3 binormal) {
          float k = 6.2831853 / wavelength;
          float c = sqrt(9.8 / k) * speed;
          vec2 d = normalize(dir);
          float f = k * (dot(d, p) - c * t);
          float a = steepness / k;
          tangent += vec3(
            -d.x * d.x * (steepness * sin(f)),
            -d.x * d.y * (steepness * sin(f)),
             d.x * (steepness * cos(f)));
          binormal += vec3(
            -d.x * d.y * (steepness * sin(f)),
            -d.y * d.y * (steepness * sin(f)),
             d.y * (steepness * cos(f)));
          return vec3(d.x * a * cos(f), d.y * a * cos(f), a * sin(f));
        }

        void main() {
          vec2 p = position.xy;
          float t = time;
          vec3 tangent = vec3(1.0, 0.0, 0.0);
          vec3 binormal = vec3(0.0, 1.0, 0.0);
          vec3 disp = vec3(0.0);

          ${waveCalls}

          float quietMask = quietZoneMask(p);
          float quietFactor = mix(1.0, uQuietZoneWaveDamping, quietMask);
          vec3 quietDisp = disp * quietFactor;
          vec3 gPos = position;
          gPos.xy += quietDisp.xy;
          gPos.z  += quietDisp.z * uWaveHeight;
          vec3 gNorm = normalize(mix(vec3(0.0, 0.0, 1.0), normalize(cross(binormal, tangent)), quietFactor));
        `
      )
      .replace(/vec4\(\s*position,\s*1\.0\s*\)/g, "vec4( gPos, 1.0 )")
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\n objectNormal = normalize(gNorm);"
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      /* glsl */ `
      uniform float uHullMaskEnabled;
      uniform vec2 uHullMaskCenter;
      uniform vec2 uHullMaskForward;
      uniform vec2 uHullMaskHalfSize;
      uniform float uHullMaskEdge;

      float hullWaterMask(vec2 p) {
        vec2 forward = normalize(uHullMaskForward);
        vec2 side = vec2(forward.y, -forward.x);
        vec2 local = vec2(
          dot(p - uHullMaskCenter, side),
          dot(p - uHullMaskCenter, forward)
        );
        vec2 overflow = abs(local) - uHullMaskHalfSize;
        float outside = max(overflow.x, overflow.y);
        return 1.0 - smoothstep(0.0, max(0.001, uHullMaskEdge), outside);
      }

      void main() {
        if (uHullMaskEnabled > 0.5 && hullWaterMask(vec2(worldPosition.x, -worldPosition.z)) > 0.02) discard;
      `
    );
  };

  // ---- Sky --------------------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);
  const skyU = sky.material.uniforms;
  skyU["turbidity"].value = 8;
  skyU["rayleigh"].value = 1.6;
  skyU["mieCoefficient"].value = 0.005;
  skyU["mieDirectionalG"].value = 0.8;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const sceneEnv = new THREE.Scene();
  let renderTarget;
  const seaParams = { elevation: 16, azimuth: 150 };

  function updateSun() {
    const phi = THREE.MathUtils.degToRad(90 - seaParams.elevation);
    const theta = THREE.MathUtils.degToRad(seaParams.azimuth);
    sun.setFromSphericalCoords(1, phi, theta);
    sky.material.uniforms["sunPosition"].value.copy(sun);
    water.material.uniforms["sunDirection"].value.copy(sun).normalize();
    if (renderTarget !== undefined) renderTarget.dispose();
    sceneEnv.add(sky);
    renderTarget = pmrem.fromScene(sceneEnv);
    scene.add(sky);
    scene.environment = renderTarget.texture;
  }
  updateSun();

  // Ambient + sun light for the ships (Water/Sky are unlit by these).
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x16323f, 1.1));
  const dir = new THREE.DirectionalLight(0xfff2d6, 1.6);
  dir.position.copy(sun).multiplyScalar(800);
  scene.add(dir);

  const quietZone = {
    enabled: false,
    center: new THREE.Vector2(1e8, 1e8),
    forward: new THREE.Vector2(0, -1),
    halfSize: new THREE.Vector2(1, 1),
    edge: 1,
    damping: 1,
  };

  function smoothstep(edge0, edge1, x) {
    const span = edge1 - edge0;
    if (span <= 1e-6) return x < edge0 ? 0 : 1;
    const t = THREE.MathUtils.clamp((x - edge0) / span, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function quietZoneFactor(wx, wz) {
    if (!quietZone.enabled) return 1;
    const px = wx;
    const py = -wz;
    const dx = px - quietZone.center.x;
    const dy = py - quietZone.center.y;
    const fx = quietZone.forward.x;
    const fy = quietZone.forward.y;
    const sx = fy;
    const sy = -fx;
    const side = Math.abs(dx * sx + dy * sy);
    const along = Math.abs(dx * fx + dy * fy);
    const edge = Math.max(0.001, quietZone.edge);
    const sideFade = 1 - smoothstep(quietZone.halfSize.x, quietZone.halfSize.x + edge, side);
    const alongFade = 1 - smoothstep(quietZone.halfSize.y, quietZone.halfSize.y + edge, along);
    const mask = THREE.MathUtils.clamp(sideFade * alongFade, 0, 1);
    return THREE.MathUtils.lerp(1, quietZone.damping, mask);
  }

  // ---- CPU mirror of the GPU Gerstner sum -> world surface height -------
  const waveHeightScratch = {};
  function sampleWaveField(wx, wz, out = {}) {
    const u = water.material.uniforms;
    const t = u.time.value;
    const chop = u.uWaveChop.value;
    const scale = u.uWaveScale.value;
    const height = u.uWaveHeight.value;
    const px = wx;
    const py = -wz;
    let h = 0;
    let dhdx = 0;
    let dhdy = 0;
    let flowX = 0;
    let flowZ = 0;
    for (const w of WAVES) {
      const k = (2 * Math.PI) / (w.len * scale);
      const c = Math.sqrt(9.8 / k) * w.speed;
      const dl = Math.hypot(w.dir[0], w.dir[1]);
      const dx = w.dir[0] / dl;
      const dy = w.dir[1] / dl;
      const f = k * (dx * px + dy * py - c * t);
      const a = (w.steep * chop) / k;
      const sin = Math.sin(f);
      const cos = Math.cos(f);
      h += a * sin;
      dhdx += a * cos * k * dx;
      dhdy += a * cos * k * dy;

      // Phase velocity travels along the Gerstner direction. In world space
      // shader p.y maps to -z, so dy becomes -z here.
      const motion = Math.abs(w.steep * c * cos) * height;
      flowX += dx * motion;
      flowZ += -dy * motion;
    }
    const quiet = quietZoneFactor(wx, wz);
    out.height = h * height * quiet;
    out.dhdx = dhdx * height * quiet;
    out.dhdz = -dhdy * height * quiet;
    out.flowX = flowX * quiet;
    out.flowZ = flowZ * quiet;
    return out;
  }

  function sampleWaveHeight(wx, wz) {
    return sampleWaveField(wx, wz, waveHeightScratch).height;
  }

  function sampleWaveFrame(wx, wz) {
    const field = sampleWaveField(wx, wz);
    const normal = new THREE.Vector3(-field.dhdx, 1, -field.dhdz).normalize();
    return {
      height: field.height,
      normal,
      flowX: field.flowX,
      flowZ: field.flowZ,
    };
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function advanceTime(dt) {
    water.material.uniforms["time"].value += dt;
  }

  function setWaveHeightMultiplier(value) {
    water.material.uniforms.uWaveHeight.value = THREE.MathUtils.clamp(value, 0.08, 1.25) * 0.42;
  }

  function getWaveHeightMultiplier() {
    return water.material.uniforms.uWaveHeight.value / 0.42;
  }

  function setQuietZone({ center, yaw = 0, halfWidth = 1, halfLength = 1, edge = 1, damping = 1 } = {}) {
    const uniforms = water.material.uniforms;
    if (!center) {
      quietZone.enabled = false;
      quietZone.center.set(1e8, 1e8);
      quietZone.forward.set(0, -1);
      quietZone.halfSize.set(1, 1);
      quietZone.edge = 1;
      quietZone.damping = 1;
    } else {
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      quietZone.enabled = true;
      quietZone.center.set(center.x, -center.z);
      quietZone.forward.set(forwardX, -forwardZ).normalize();
      quietZone.halfSize.set(Math.max(0.1, halfWidth), Math.max(0.1, halfLength));
      quietZone.edge = Math.max(0.001, edge);
      quietZone.damping = THREE.MathUtils.clamp(damping, 0.02, 1);
    }
    uniforms.uQuietZoneCenter.value.copy(quietZone.center);
    uniforms.uQuietZoneForward.value.copy(quietZone.forward);
    uniforms.uQuietZoneHalfSize.value.copy(quietZone.halfSize);
    uniforms.uQuietZoneEdge.value = quietZone.edge;
    uniforms.uQuietZoneWaveDamping.value = quietZone.damping;
  }

  function setHullWaterMask({ center, yaw = 0, halfWidth = 1, halfLength = 1, edge = 0.75 } = {}) {
    const uniforms = water.material.uniforms;
    if (!center) {
      uniforms.uHullMaskEnabled.value = 0;
      uniforms.uHullMaskCenter.value.set(1e8, 1e8);
      uniforms.uHullMaskForward.value.set(0, -1);
      uniforms.uHullMaskHalfSize.value.set(1, 1);
      uniforms.uHullMaskEdge.value = 0.75;
      return;
    }
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    uniforms.uHullMaskEnabled.value = 1;
    uniforms.uHullMaskCenter.value.set(center.x, -center.z);
    uniforms.uHullMaskForward.value.set(forwardX, -forwardZ).normalize();
    uniforms.uHullMaskHalfSize.value.set(Math.max(0.1, halfWidth), Math.max(0.1, halfLength));
    uniforms.uHullMaskEdge.value = Math.max(0.001, edge);
  }

  return {
    THREE,
    renderer,
    scene,
    camera,
    water,
    sky,
    sun,
    sunLight: dir,
    seaParams,
    updateSun,
    sampleWaveHeight,
    sampleWaveFrame,
    advanceTime,
    setWaveHeightMultiplier,
    getWaveHeightMultiplier,
    setQuietZone,
    setHullWaterMask,
  };
}
