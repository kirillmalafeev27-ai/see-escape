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
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  const waterGeometry = new THREE.PlaneGeometry(10000, 10000, 360, 360);
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
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  // Sea state — moderate seas so the deck is walkable but alive.
  const waveUniforms = {
    uWaveHeight: { value: 0.42 },
    uWaveChop: { value: 0.7 },
    uWaveScale: { value: 1.25 },
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

          vec3 gPos = position;
          gPos.xy += disp.xy;
          gPos.z  += disp.z * uWaveHeight;
          vec3 gNorm = normalize(cross(binormal, tangent));
        `
      )
      .replace(/vec4\(\s*position,\s*1\.0\s*\)/g, "vec4( gPos, 1.0 )")
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\n objectNormal = normalize(gNorm);"
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

  // ---- CPU mirror of the GPU Gerstner sum -> world surface height -------
  function sampleWaveHeight(wx, wz) {
    const u = water.material.uniforms;
    const t = u.time.value;
    const chop = u.uWaveChop.value;
    const scale = u.uWaveScale.value;
    const height = u.uWaveHeight.value;
    const px = wx;
    const py = -wz;
    let h = 0;
    for (const w of WAVES) {
      const k = (2 * Math.PI) / (w.len * scale);
      const c = Math.sqrt(9.8 / k) * w.speed;
      const dl = Math.hypot(w.dir[0], w.dir[1]);
      const dx = w.dir[0] / dl;
      const dy = w.dir[1] / dl;
      const f = k * (dx * px + dy * py - c * t);
      const a = (w.steep * chop) / k;
      h += a * Math.sin(f);
    }
    return h * height;
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function advanceTime(dt) {
    water.material.uniforms["time"].value += dt;
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
    advanceTime,
  };
}
