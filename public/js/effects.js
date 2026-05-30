// effects.js — impact particles (splinters/dust/splash/smoke), wood debris
// chunks and muzzle flashes. Implements the "particle layer" + a lightweight
// version of the debris approach from the wood-debris-explosion skill (no
// physics engine: ballistic shards that settle on the water and fade).
import * as THREE from "three";

// GPU points with per-particle life-driven alpha (round soft sprites).
class ParticlePool {
  constructor(scene, max, { size = 1.5, blending = THREE.NormalBlending, gravity = -30, drag = 1.2 } = {}) {
    this.max = max;
    this.gravity = gravity;
    this.drag = drag;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.alpha = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: size } },
      transparent: true,
      depthWrite: false,
      blending,
      vertexShader: `
        uniform float uSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSize * (300.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float soft = smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(vColor, vAlpha * soft);
        }`,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.geo = geo;
  }

  emit(point, count, opts) {
    const {
      baseDir = new THREE.Vector3(0, 1, 0),
      spread = 1.0,
      speedMin = 4,
      speedMax = 12,
      lifeMin = 0.4,
      lifeMax = 0.9,
      color = [0.42, 0.29, 0.17],
      colorJitter = 0.15,
      up = 0,
    } = opts || {};
    const liftUp = up;
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      this.pos[i3] = point.x;
      this.pos[i3 + 1] = point.y;
      this.pos[i3 + 2] = point.z;
      const dx = baseDir.x + (Math.random() - 0.5) * spread;
      const dy = baseDir.y + (Math.random() - 0.5) * spread;
      const dz = baseDir.z + (Math.random() - 0.5) * spread;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const sp = speedMin + Math.random() * (speedMax - speedMin);
      this.vel[i3] = (dx / dl) * sp;
      this.vel[i3 + 1] = (dy / dl) * sp + liftUp;
      this.vel[i3 + 2] = (dz / dl) * sp;
      const j = (Math.random() - 0.5) * colorJitter;
      this.col[i3] = Math.min(1, Math.max(0, color[0] + j));
      this.col[i3 + 1] = Math.min(1, Math.max(0, color[1] + j));
      this.col[i3 + 2] = Math.min(1, Math.max(0, color[2] + j));
      this.maxLife[i] = this.life[i] = lifeMin + Math.random() * (lifeMax - lifeMin);
      this.alpha[i] = 1;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3 + 1] += this.gravity * dt;
      const d = 1 - Math.min(1, this.drag * dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] *= d;
      this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.alpha[i] = Math.max(0, this.life[i] / this.maxLife[i]);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

export class EffectsSystem {
  constructor(scene, sampleWaveHeight) {
    this.scene = scene;
    this.sampleWaveHeight = sampleWaveHeight;
    this.splinters = new ParticlePool(scene, 1200, { size: 1.4, gravity: -28, drag: 1.6 });
    this.dust = new ParticlePool(scene, 800, { size: 6.0, gravity: -2, drag: 2.2 });
    this.splash = new ParticlePool(scene, 1000, { size: 3.0, gravity: -34, drag: 1.0 });
    this.glow = new ParticlePool(scene, 600, { size: 5.0, gravity: -4, drag: 2.0, blending: THREE.AdditiveBlending });

    // Wood debris chunks (splinter-shaped boxes) with simple ballistics.
    this.debris = [];
    this.debrisPool = [];
    this.plankGeo = new THREE.BoxGeometry(1, 0.25, 0.4);
    this.plankMat = new THREE.MeshStandardMaterial({
      color: 0x6b4a2b,
      roughness: 0.9,
      metalness: 0.0,
    });
    this.maxDebris = 90;
  }

  _getPlank() {
    let m = this.debrisPool.pop();
    if (!m) {
      m = new THREE.Mesh(this.plankGeo, this.plankMat.clone());
      this.scene.add(m);
    }
    m.visible = true;
    return m;
  }

  // Cannonball-into-wood hit. point/normal in world space; strength scales it.
  woodImpact(point, normal, strength = 1) {
    const n = normal.clone().normalize();
    this.splinters.emit(point, Math.round(40 * strength), {
      baseDir: n,
      spread: 1.3,
      speedMin: 10,
      speedMax: 34,
      lifeMin: 0.4,
      lifeMax: 0.9,
      color: [0.45, 0.3, 0.17],
      up: 6,
    });
    this.dust.emit(point, Math.round(22 * strength), {
      baseDir: n,
      spread: 1.6,
      speedMin: 2,
      speedMax: 9,
      lifeMin: 0.7,
      lifeMax: 1.4,
      color: [0.66, 0.58, 0.46],
      up: 3,
    });

    const chunks = Math.min(Math.round(10 * strength), this.maxDebris - this.debris.length);
    for (let i = 0; i < chunks; i++) {
      const m = this._getPlank();
      const len = 1.5 + Math.random() * 3.5;
      m.scale.set(len, 0.6 + Math.random(), 0.6 + Math.random());
      m.position.copy(point);
      m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      const dir = n.clone();
      dir.x += (Math.random() - 0.5) * 1.2;
      dir.y += (Math.random() - 0.5) * 1.0 + 0.5;
      dir.z += (Math.random() - 0.5) * 1.2;
      dir.normalize();
      const sp = (14 + Math.random() * 26) * strength;
      this.debris.push({
        mesh: m,
        vel: dir.multiplyScalar(sp),
        ang: new THREE.Vector3(
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10
        ),
        ttl: 3.5 + Math.random() * 2,
        settled: false,
      });
    }
  }

  waterSplash(point, strength = 1) {
    this.splash.emit(point, Math.round(46 * strength), {
      baseDir: new THREE.Vector3(0, 1, 0),
      spread: 0.9,
      speedMin: 12,
      speedMax: 30 * strength,
      lifeMin: 0.4,
      lifeMax: 1.0,
      color: [0.82, 0.9, 0.95],
      up: 8,
    });
    this.dust.emit(point, 14, {
      baseDir: new THREE.Vector3(0, 1, 0),
      spread: 1.4,
      speedMin: 2,
      speedMax: 8,
      lifeMin: 0.6,
      lifeMax: 1.2,
      color: [0.85, 0.92, 0.96],
      up: 4,
    });
  }

  muzzleFlash(point, dir) {
    const d = dir.clone().normalize();
    this.glow.emit(point, 26, {
      baseDir: d,
      spread: 0.6,
      speedMin: 18,
      speedMax: 48,
      lifeMin: 0.12,
      lifeMax: 0.3,
      color: [1.0, 0.8, 0.4],
    });
    this.dust.emit(point, 18, {
      baseDir: d,
      spread: 0.9,
      speedMin: 6,
      speedMax: 18,
      lifeMin: 0.6,
      lifeMax: 1.3,
      color: [0.5, 0.5, 0.5],
      up: 3,
    });
  }

  update(dt) {
    this.splinters.update(dt);
    this.dust.update(dt);
    this.splash.update(dt);
    this.glow.update(dt);

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.ttl -= dt;
      if (!d.settled) {
        d.vel.y += -30 * dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.ang.x * dt;
        d.mesh.rotation.y += d.ang.y * dt;
        d.mesh.rotation.z += d.ang.z * dt;
        const surf = this.sampleWaveHeight(d.mesh.position.x, d.mesh.position.z);
        if (d.mesh.position.y <= surf) {
          d.mesh.position.y = surf;
          d.settled = true;
          this.waterSplash(d.mesh.position.clone(), 0.25);
        }
      } else {
        // float on the surface and bob with it
        d.mesh.position.y = this.sampleWaveHeight(d.mesh.position.x, d.mesh.position.z);
        d.ang.multiplyScalar(0.96);
        d.mesh.rotation.x += d.ang.x * dt * 0.2;
      }
      if (d.ttl <= 0) {
        const fade = Math.max(0, 1 + d.ttl); // ttl goes negative; fade last 1s
        if (d.ttl < -1) {
          d.mesh.visible = false;
          this.debrisPool.push(d.mesh);
          this.debris.splice(i, 1);
          continue;
        }
        d.mesh.scale.multiplyScalar(0.97);
        void fade;
      }
    }
  }
}
