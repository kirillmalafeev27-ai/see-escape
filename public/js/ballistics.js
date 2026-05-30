// ballistics.js — cannonballs flying on real parabolas under gravity, wind and
// a little air drag, plus a ballistic firing-solution solver (enemy AI aim)
// and a trajectory predictor (player aim preview).
import * as THREE from "three";

export const GRAVITY = 32; // tuned for the scene scale (units/s^2)
export const DRAG = 0.02; // gentle air drag coefficient

export class ProjectileSystem {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.geo = new THREE.SphereGeometry(1.1, 12, 12);
    this.matIron = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.5, metalness: 0.7 });
    this.pool = [];
  }

  _getMesh() {
    let m = this.pool.pop();
    if (!m) {
      m = new THREE.Mesh(this.geo, this.matIron);
      this.scene.add(m);
    }
    m.visible = true;
    return m;
  }

  spawn(origin, velocity, { team = "player", radius = 1.4, ttl = 8 } = {}) {
    const mesh = this._getMesh();
    mesh.position.copy(origin);
    const p = {
      mesh,
      pos: origin.clone(),
      vel: velocity.clone(),
      team,
      radius,
      ttl,
    };
    this.list.push(p);
    return p;
  }

  _retire(p, i) {
    p.mesh.visible = false;
    this.pool.push(p.mesh);
    this.list.splice(i, 1);
  }

  // env: { wind:Vector3, sampleWaveHeight(x,z), hitTest(proj)->hit|null,
  //        onHit(proj,hit), onWater(proj,point) }
  update(dt, env) {
    const wind = env.wind || new THREE.Vector3();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      // integrate: gravity + wind, minus drag proportional to velocity
      p.vel.y -= GRAVITY * dt;
      p.vel.addScaledVector(wind, dt);
      p.vel.addScaledVector(p.vel, -DRAG * dt);
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.ttl -= dt;

      const surf = env.sampleWaveHeight(p.pos.x, p.pos.z);
      if (p.pos.y <= surf) {
        if (env.onWater) env.onWater(p, new THREE.Vector3(p.pos.x, surf, p.pos.z));
        this._retire(p, i);
        continue;
      }
      const hit = env.hitTest ? env.hitTest(p) : null;
      if (hit) {
        if (env.onHit) env.onHit(p, hit);
        this._retire(p, i);
        continue;
      }
      if (p.ttl <= 0) this._retire(p, i);
    }
  }
}

// Solve a launch velocity that lands a shot at `target`, leading a moving
// target. Accounts for gravity, distance, height difference and target
// velocity (the "lots of factors" the AI reasons about). Returns null if the
// target is out of range for the given muzzle speed.
const _up = new THREE.Vector3(0, 1, 0);
export function solveLaunchVelocity(origin, target, speed, targetVel = null, iterations = 4) {
  const v2 = speed * speed;
  let aim = target.clone();
  let angle = 0;
  let toT = new THREE.Vector3();
  for (let it = 0; it < iterations; it++) {
    toT.copy(aim).sub(origin);
    const dh = Math.hypot(toT.x, toT.z);
    const y = toT.y;
    const disc = v2 * v2 - GRAVITY * (GRAVITY * dh * dh + 2 * y * v2);
    if (disc < 0) return null; // unreachable
    angle = Math.atan2(v2 - Math.sqrt(disc), GRAVITY * dh); // low (direct) arc
    if (targetVel) {
      const tof = dh / Math.max(1e-3, speed * Math.cos(angle));
      aim.copy(target).addScaledVector(targetVel, tof);
    } else {
      break;
    }
  }
  const horiz = new THREE.Vector3(toT.x, 0, toT.z);
  if (horiz.lengthSq() < 1e-6) return null;
  horiz.normalize();
  const vel = horiz.multiplyScalar(speed * Math.cos(angle));
  vel.addScaledVector(_up, speed * Math.sin(angle));
  return vel;
}

// Step the same integration the projectiles use, returning a polyline so the
// player can see exactly where their shot will go before firing.
export function predictTrajectory(origin, velocity, env, { steps = 90, dt = 0.06 } = {}) {
  const pts = [origin.clone()];
  const pos = origin.clone();
  const vel = velocity.clone();
  const wind = env.wind || new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    vel.y -= GRAVITY * dt;
    vel.addScaledVector(wind, dt);
    vel.addScaledVector(vel, -DRAG * dt);
    pos.addScaledVector(vel, dt);
    pts.push(pos.clone());
    if (pos.y <= env.sampleWaveHeight(pos.x, pos.z)) break;
  }
  return pts;
}
