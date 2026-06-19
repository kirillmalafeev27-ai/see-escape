// enemy.js — hostile ships that spawn around the player, bob on the waves,
// close to firing range and lob cannonballs using a real ballistic firing
// solution (leading the target). One solid hit and an enemy sinks to the
// seabed. Visuals come from the .glb model when available (sized to the
// measured dimensions), with a primitive hull as fallback.
import * as THREE from "three";
import { solveLaunchVelocity } from "./ballistics.js?v=20260603-bonuses-island-v1";

const ENEMY_DEFAULTS = { length: 72, beam: 18, deckY: 9, keelY: -9 };
const MUZZLE_SPEED = 205;
const STANDOFF = 380;
const MAX_ALIVE = 2;
const FIRST_SPAWN_DELAY = 10;
const SPAWN_DELAY_MIN = 14;
const SPAWN_DELAY_MAX = 24;
const INITIAL_RELOAD_MIN = 10;
const INITIAL_RELOAD_MAX = 18;
const COMBAT_RELOAD_MIN = 14;
const COMBAT_RELOAD_MAX = 24;
const QUIZ_RELOAD_MIN = 20;
const QUIZ_RELOAD_MAX = 32;
const LEARNING_RELOAD_MIN = 22;
const LEARNING_RELOAD_MAX = 36;
const ENEMY_FIRE_INTERVAL_MULTIPLIER = 1.15;
const BUOYANCY_RESPONSE = 3.5;
const HULL_BULWARK = 5;
const SAIL_BASE_CLEARANCE = 4;

function mat(c, r = 0.85, m = 0) {
  return new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
}

function reloadDelay(min, max) {
  return (min + Math.random() * (max - min)) * ENEMY_FIRE_INTERVAL_MULTIPLIER;
}

function buildEnemyShip(d, factory) {
  const g = new THREE.Group();
  g.rotation.order = "YXZ";

  const visuals = [];
  const hullH = d.deckY - d.keelY;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(d.beam, hullH, d.length * 0.95), mat(0x2e2018, 0.9));
  hull.position.y = (d.deckY + d.keelY) / 2;
  g.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(d.beam * 0.9, 0.5, d.length * 0.9), mat(0x5a3f25, 0.85));
  deck.position.y = d.deckY;
  g.add(deck);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 46, 8), mat(0x4a3420, 0.9));
  mast.position.set(0, d.deckY + 22, 0);
  g.add(mast);
  g.traverse((o) => { if (o.isMesh) visuals.push(o); });

  if (factory) {
    try {
      g.add(factory());
      for (const v of visuals) v.visible = false;
    } catch (e) {
      console.warn("enemy model clone failed, using primitive", e);
    }
  }

  const muzzles = [];
  for (const z of [-d.length * 0.16, d.length * 0.16]) {
    for (const sx of [d.beam * 0.45, -d.beam * 0.45]) {
      muzzles.push(new THREE.Vector3(sx, d.deckY + 2, z));
    }
  }
  return { group: g, muzzles };
}

export class EnemyFleet {
  constructor(scene, sampleWaveHeight, projectiles, effects, getPlayerTarget, opts = {}) {
    this.scene = scene;
    this.sample = sampleWaveHeight;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getPlayerTarget = getPlayerTarget;
    this.dims = { ...ENEMY_DEFAULTS, ...(opts.dims || {}) };
    this.factory = opts.factory || null;
    this.onSunk = opts.onSunk || (() => {});
    this.onSpawn = opts.onSpawn || (() => {});
    this.onFire = opts.onFire || (() => {});
    this.list = [];
    this.maxAlive = Number(opts.maxAlive || MAX_ALIVE);
    this.spawnTimer = Number(opts.firstSpawnDelay || FIRST_SPAWN_DELAY);
    this.killCount = 0;
    this.quizMode = false;
    this.learningFireMode = false;
    this._tmp = new THREE.Vector3();
  }

  _spawn(options = {}) {
    const built = buildEnemyShip(this.dims, this.factory);
    this.scene.add(built.group);
    if (options.position) {
      built.group.position.copy(options.position);
    } else {
      const player = this.getPlayerTarget();
      const ang = Math.random() * Math.PI * 2;
      const dist = 560 + Math.random() * 200;
      built.group.position.set(
        player.pos.x + Math.cos(ang) * dist,
        0,
        player.pos.z + Math.sin(ang) * dist
      );
    }
    const entry = {
      group: built.group,
      muzzles: built.muzzles,
      reload: Number.isFinite(options.reload) ? options.reload : reloadDelay(INITIAL_RELOAD_MIN, INITIAL_RELOAD_MAX),
      health: Number.isFinite(options.health) ? options.health : 100,
      sinking: Boolean(options.sinking),
      sinkVel: Number(options.sinkVel) || 0,
      list: Number(options.list) || 0,
      halfL: this.dims.length * 0.42,
      halfW: this.dims.beam * 0.42,
      buoyancyReady: false,
      accuracy: Number.isFinite(options.accuracy) ? options.accuracy : 0.04 + Math.random() * 0.05,
    };
    this.list.push(entry);
    if (!options.silent) this.onSpawn(built.group.position.clone());
    return entry;
  }

  _buoyancy(e, dt) {
    const g = e.group;
    const a = g.rotation.y;
    const s = Math.sin(a), c = Math.cos(a);
    const px = g.position.x, pz = g.position.z;
    const h = (lx, lz) => this.sample(px + (lx * c + lz * s), pz + (-lx * s + lz * c));
    const bow = h(0, e.halfL), stern = h(0, -e.halfL);
    const stbd = h(e.halfW, 0), port = h(-e.halfW, 0);
    const targetY = (bow + stern + stbd + port) / 4;
    const targetPitch = Math.atan2(stern - bow, e.halfL * 2) * 0.8;
    const targetRoll = Math.atan2(stbd - port, e.halfW * 2) * 0.8 + e.list;
    if (!e.buoyancyReady) {
      g.position.y = targetY;
      g.rotation.x = targetPitch;
      g.rotation.z = targetRoll;
      e.buoyancyReady = true;
      return;
    }
    const alpha = 1 - Math.exp(-BUOYANCY_RESPONSE * Math.max(0, dt));
    g.position.y = THREE.MathUtils.lerp(g.position.y, targetY, alpha);
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, targetPitch, alpha);
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, targetRoll, alpha);
  }

  _fire(e, target = null) {
    const player = target || this.getPlayerTarget();
    if (player?.insideHold) return false;
    e.group.updateMatrixWorld(true);
    let best = null, bestDot = -Infinity;
    const toPlayer = this._tmp.copy(player.pos).sub(e.group.position).normalize();
    for (const mLocal of e.muzzles) {
      const wp = mLocal.clone().applyMatrix4(e.group.matrixWorld);
      const dir = wp.clone().sub(e.group.position).setY(0).normalize();
      const dot = dir.dot(toPlayer);
      if (dot > bestDot) { bestDot = dot; best = wp; }
    }
    if (!best) return false;
    const aim = player.pos.clone();
    aim.y += 4;
    const vel = solveLaunchVelocity(best, aim, MUZZLE_SPEED, player.vel);
    if (!vel) return false;
    const j = e.accuracy;
    vel.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * j * 2);
    vel.applyAxisAngle(new THREE.Vector3(1, 0, 0), (Math.random() - 0.5) * j * 2);
    this.projectiles.spawn(best, vel, { team: "enemy" });
    this.effects.muzzleFlash(best, vel);
    this.onFire(best.clone());
    return true;
  }

  hitTest(proj) {
    for (const e of this.list) {
      if (e.sinking) continue;
      const d = this.dims;
      if (e.group.position.distanceTo(proj.pos) > d.length * 1.4) continue;

      e.group.updateMatrixWorld(true);
      const local = e.group.worldToLocal(proj.pos.clone());
      const radius = proj.radius || 0;
      const inRigging =
        Math.abs(local.x) <= d.beam * 1.7 + radius &&
        Math.abs(local.z) <= d.length * 0.5 + radius &&
        local.y >= d.deckY + 0.35 - radius &&
        local.y <= d.deckY + d.length * 0.9 + radius;
      if (inRigging) {
        const normal = proj.vel.clone().normalize().multiplyScalar(-1);
        return { enemy: e, kind: "sail", point: proj.pos.clone(), normal };
      }

      const inHull =
        Math.abs(local.x) <= d.beam * 0.62 + radius &&
        Math.abs(local.z) <= d.length * 0.52 + radius &&
        local.y >= d.keelY - radius &&
        local.y <= d.deckY + 0.35 + radius;
      if (inHull) {
        const nx = local.x / Math.max(1, d.beam * 0.62);
        const nz = local.z / Math.max(1, d.length * 0.52);
        const normal = Math.abs(nx) > Math.abs(nz)
          ? new THREE.Vector3(Math.sign(nx) || 1, 0, 0)
          : new THREE.Vector3(0, 0, Math.sign(nz) || 1);
        normal.transformDirection(e.group.matrixWorld);
        return { enemy: e, kind: "hull", point: proj.pos.clone(), normal };
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
    this.onSunk(e.group.position.clone());
  }

  damage(e, amount) {
    if (!e || e.sinking) return false;
    e.health = Math.max(0, (e.health ?? 100) - amount);
    if (e.health <= 0) {
      this.sink(e);
      return true;
    }
    return false;
  }

  snapshot(limit = 12) {
    return this.list.slice(0, limit).map((e) => ({
      position: { x: e.group.position.x, y: e.group.position.y, z: e.group.position.z },
      rotation: { x: e.group.rotation.x, y: e.group.rotation.y, z: e.group.rotation.z },
      reload: e.reload,
      health: e.health,
      sinking: e.sinking,
      sinkVel: e.sinkVel,
      list: e.list,
      accuracy: e.accuracy,
      buoyancyReady: e.buoyancyReady,
    }));
  }

  syncFromSnapshot(items = []) {
    const safeItems = Array.isArray(items) ? items : [];
    while (this.list.length > safeItems.length) {
      const enemy = this.list.pop();
      if (enemy?.group) this.scene.remove(enemy.group);
    }
    while (this.list.length < safeItems.length) {
      this._spawn({ silent: true, position: new THREE.Vector3() });
    }
    for (let i = 0; i < safeItems.length; i++) {
      const item = safeItems[i] || {};
      const enemy = this.list[i];
      enemy.group.position.set(item.position?.x || 0, item.position?.y || 0, item.position?.z || 0);
      enemy.group.rotation.set(item.rotation?.x || 0, item.rotation?.y || 0, item.rotation?.z || 0);
      enemy.reload = Number.isFinite(item.reload) ? item.reload : enemy.reload;
      enemy.health = Number.isFinite(item.health) ? item.health : enemy.health;
      enemy.sinking = Boolean(item.sinking);
      enemy.sinkVel = Number(item.sinkVel) || 0;
      enemy.list = Number(item.list) || 0;
      enemy.accuracy = Number.isFinite(item.accuracy) ? item.accuracy : enemy.accuracy;
      enemy.buoyancyReady = Boolean(item.buoyancyReady);
      enemy.group.visible = true;
    }
  }

  reset() {
    for (const enemy of this.list) {
      if (enemy?.group) this.scene.remove(enemy.group);
    }
    this.list = [];
    this.spawnTimer = FIRST_SPAWN_DELAY;
    this.killCount = 0;
  }

  update(dt, onKilled) {
    const player = this.getPlayerTarget();
    if (this.list.filter((e) => !e.sinking).length < this.maxAlive) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this._spawn();
        this.spawnTimer = SPAWN_DELAY_MIN + Math.random() * (SPAWN_DELAY_MAX - SPAWN_DELAY_MIN);
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

      const toP = this._tmp.copy(player.pos).sub(e.group.position);
      toP.y = 0;
      const dist = toP.length();
      const desiredYaw = Math.atan2(toP.x, toP.z);
      let dy = desiredYaw - e.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      e.group.rotation.y += THREE.MathUtils.clamp(dy, -0.4 * dt, 0.4 * dt);
      const fwd = new THREE.Vector3(Math.sin(e.group.rotation.y), 0, Math.cos(e.group.rotation.y));
      const slowApproach = this.quizMode || this.learningFireMode;
      const speed = slowApproach ? (dist > STANDOFF ? 10 : 0) : dist > STANDOFF ? 26 : -4;
      e.group.position.addScaledVector(fwd, speed * dt);

      this._buoyancy(e, dt);

      e.reload -= dt;
      const fireRange = this.quizMode ? 900 : 760;
      if (e.reload <= 0 && dist < fireRange) {
        if (this.quizMode) {
          e.reload = reloadDelay(QUIZ_RELOAD_MIN, QUIZ_RELOAD_MAX);
        } else if (player?.insideHold) {
          e.reload = 0.75;
        } else if (this.learningFireMode) {
          this._fire(e, player);
          e.reload = reloadDelay(LEARNING_RELOAD_MIN, LEARNING_RELOAD_MAX);
        } else {
          this._fire(e, player);
          e.reload = reloadDelay(COMBAT_RELOAD_MIN, COMBAT_RELOAD_MAX);
        }
      }
    }
  }
}
