// enemy.js — hostile ships that spawn around the player, bob on the waves,
// close to firing range, and lob cannonballs using a real ballistic firing
// solution (leading the target, accounting for gravity/distance/height). One
// solid hit from the player and an enemy starts sinking to the seabed.
import * as THREE from "three";
import { solveLaunchVelocity } from "./ballistics.js";

const ENEMY = { length: 72, beam: 20, deckY: 3, muzzleSpeed: 200, standoff: 360 };

function mat(c, r = 0.85, m = 0) {
  return new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
}

function buildEnemyShip() {
  const g = new THREE.Group();
  g.rotation.order = "YXZ";
  const { length: L, beam: W, deckY } = ENEMY;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(W, 12, L * 0.95), mat(0x2e2018, 0.9));
  hull.position.y = -3;
  g.add(hull);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(W * 0.5, L * 0.16, 4), mat(0x2e2018, 0.9));
  bow.rotation.set(Math.PI / 2, Math.PI / 4, 0);
  bow.scale.set(1, 1, 0.6);
  bow.position.set(0, -3, L * 0.5);
  g.add(bow);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.5, L * 0.9), mat(0x5a3f25, 0.85));
  deck.position.y = deckY;
  g.add(deck);
  // mast + dark-red sail to read as hostile
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 50, 8), mat(0x4a3420, 0.9));
  mast.position.set(0, deckY + 25, 2);
  g.add(mast);
  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 22),
    mat(0x7a1f1f, 1).clone()
  );
  sail.material.side = THREE.DoubleSide;
  sail.position.set(0, deckY + 26, 2);
  g.add(sail);
  // bulwarks
  for (const x of [W * 0.46, -W * 0.46]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 3, L * 0.9), mat(0x5a3f25, 0.85));
    b.position.set(x, deckY + 1.5, 0);
    g.add(b);
  }

  const muzzles = [];
  for (const z of [-12, 12]) {
    for (const sx of [W * 0.45, -W * 0.45]) {
      muzzles.push(new THREE.Vector3(sx, deckY + 2, z));
    }
  }
  return { group: g, muzzles };
}

export class EnemyFleet {
  constructor(scene, sampleWaveHeight, projectiles, effects, getPlayerTarget) {
    this.scene = scene;
    this.sample = sampleWaveHeight;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getPlayerTarget = getPlayerTarget;
    this.list = [];
    this.maxAlive = 3;
    this.spawnTimer = 2;
    this.killCount = 0;
    this._tmp = new THREE.Vector3();
  }

  _spawn() {
    const built = buildEnemyShip();
    this.scene.add(built.group);
    const player = this.getPlayerTarget();
    const ang = Math.random() * Math.PI * 2;
    const dist = 560 + Math.random() * 200;
    built.group.position.set(
      player.pos.x + Math.cos(ang) * dist,
      0,
      player.pos.z + Math.sin(ang) * dist
    );
    const e = {
      group: built.group,
      muzzles: built.muzzles,
      reload: 3 + Math.random() * 3,
      vel: new THREE.Vector3(),
      sinking: false,
      sinkVel: 0,
      list: 0,
      halfL: ENEMY.length * 0.42,
      halfW: ENEMY.beam * 0.42,
      accuracy: 0.04 + Math.random() * 0.05, // radians of aim jitter
    };
    this.list.push(e);
  }

  _buoyancy(e) {
    const g = e.group;
    const a = g.rotation.y;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const px = g.position.x;
    const pz = g.position.z;
    const h = (lx, lz) => this.sample(px + (lx * c + lz * s), pz + (-lx * s + lz * c));
    const bow = h(0, e.halfL);
    const stern = h(0, -e.halfL);
    const stbd = h(e.halfW, 0);
    const port = h(-e.halfW, 0);
    g.position.y = (bow + stern + stbd + port) / 4;
    g.rotation.x = Math.atan2(stern - bow, e.halfL * 2) * 0.8;
    g.rotation.z = (Math.atan2(stbd - port, e.halfW * 2) * 0.8) + e.list;
  }

  _fire(e) {
    const player = this.getPlayerTarget();
    // pick the muzzle on the side facing the player
    e.group.updateMatrixWorld(true);
    let best = null;
    let bestDot = -Infinity;
    const toPlayer = this._tmp.copy(player.pos).sub(e.group.position).normalize();
    for (const mLocal of e.muzzles) {
      const wp = mLocal.clone().applyMatrix4(e.group.matrixWorld);
      const dir = wp.clone().sub(e.group.position).setY(0).normalize();
      const dot = dir.dot(toPlayer);
      if (dot > bestDot) {
        bestDot = dot;
        best = wp;
      }
    }
    if (!best) return;
    // aim a touch above the deck waterline of the player
    const aim = player.pos.clone();
    aim.y += 4;
    const vel = solveLaunchVelocity(best, aim, ENEMY.muzzleSpeed, player.vel);
    if (!vel) return; // out of range — hold fire
    // apply aim jitter
    const jitter = e.accuracy;
    vel.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * jitter * 2);
    vel.applyAxisAngle(new THREE.Vector3(1, 0, 0), (Math.random() - 0.5) * jitter * 2);
    this.projectiles.spawn(best, vel, { team: "enemy" });
    this.effects.muzzleFlash(best, vel);
  }

  // Player projectile hit-test against live enemies.
  hitTest(proj) {
    for (const e of this.list) {
      if (e.sinking) continue;
      const r = ENEMY.length * 0.5;
      const d = e.group.position.distanceTo(proj.pos);
      if (d < r) {
        const normal = proj.pos.clone().sub(e.group.position).setY(0).normalize();
        return { enemy: e, point: proj.pos.clone(), normal };
      }
    }
    return null;
  }

  sink(e) {
    if (e.sinking) return;
    e.sinking = true;
    e.sinkVel = 2;
    e.list = (Math.random() - 0.5) * 0.5;
    this.killCount++;
  }

  update(dt, onKilled) {
    const player = this.getPlayerTarget();
    // spawn pacing
    if (this.list.filter((e) => !e.sinking).length < this.maxAlive) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this._spawn();
        this.spawnTimer = 6 + Math.random() * 6;
      }
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.sinking) {
        e.sinkVel += 6 * dt;
        e.group.position.y -= e.sinkVel * dt;
        e.list += dt * 0.15;
        e.group.rotation.z += dt * 0.15;
        if (e.group.position.y < -60) {
          this.scene.remove(e.group);
          this.list.splice(i, 1);
          if (onKilled) onKilled();
        }
        continue;
      }

      // steer toward standoff distance and face the player
      const toP = this._tmp.copy(player.pos).sub(e.group.position);
      toP.y = 0;
      const dist = toP.length();
      const desiredYaw = Math.atan2(toP.x, toP.z);
      // smoothly turn
      let dy = desiredYaw - e.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      e.group.rotation.y += THREE.MathUtils.clamp(dy, -0.4 * dt, 0.4 * dt);
      // move
      const fwd = new THREE.Vector3(Math.sin(e.group.rotation.y), 0, Math.cos(e.group.rotation.y));
      const speed = dist > ENEMY.standoff ? 26 : -4;
      e.group.position.addScaledVector(fwd, speed * dt);

      this._buoyancy(e);

      // fire control
      e.reload -= dt;
      if (e.reload <= 0 && dist < 760) {
        this._fire(e);
        e.reload = 4 + Math.random() * 4;
      }
    }
  }
}
