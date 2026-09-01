import * as THREE from "three";

const HELM_RANGE = 8;
const TURN_RATE = 0.34;
const THROTTLE_RESPONSE = 0.28;
const SPEED_RESPONSE = 0.75;

function localBounds(group, object) {
  group.updateMatrixWorld(true);
  object.updateWorldMatrix(true, true);
  const worldBox = new THREE.Box3().setFromObject(object);
  const localBox = new THREE.Box3();
  for (const x of [worldBox.min.x, worldBox.max.x]) {
    for (const y of [worldBox.min.y, worldBox.max.y]) {
      for (const z of [worldBox.min.z, worldBox.max.z]) {
        localBox.expandByPoint(group.worldToLocal(new THREE.Vector3(x, y, z)));
      }
    }
  }
  return localBox;
}

export class SailingSystem {
  constructor({ ship, wind, onMessage }) {
    this.ship = ship;
    this.wind = wind;
    this.onMessage = onMessage || (() => {});
    this.controlling = false;
    this.throttle = 0.36;
    this.rudder = 0;
    this.speed = 0;
    this.speedMultiplier = 1;
    this.anchored = false;
    this.windAlignment = 0;
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.helmPosition = this._findHelm();
  }

  _findHelm() {
    let helm = null;
    this.ship.modelPivot?.traverse((object) => {
      if (helm || !/^StylShip_Wheel(?:_|$)/i.test(object.name || "")) return;
      const bounds = localBounds(this.ship.group, object);
      if (!bounds.isEmpty()) helm = bounds.getCenter(new THREE.Vector3());
    });
    return helm || new THREE.Vector3(0, this.ship.dims.deckY + 2.4, -this.ship.dims.length * 0.28);
  }

  _nearHelm(position) {
    return position.distanceTo(this.helmPosition) <= HELM_RANGE;
  }

  // Public probes for the HUD: the on-screen helm button mirrors the E key,
  // so it needs the same "am I close enough" answer the prompt uses.
  nearHelm(rig) {
    const position = rig?.position || rig;
    return Boolean(position) && this._nearHelm(position);
  }

  canTakeHelm(rig) {
    return !this.anchored && !this.controlling && this.nearHelm(rig);
  }

  getPrompt(rig) {
    if (this.controlling) return "Штурвал: W/S - паруса · A/D - курс · E или кнопка - отойти";
    return this._nearHelm(rig.position) ? "E или кнопка - встать к штурвалу" : "";
  }

  interact(rig) {
    if (this.controlling) {
      this.controlling = false;
      this.rudder = 0;
      this.onMessage("Ты отошёл от штурвала. Корабль сохраняет курс.");
      return true;
    }
    if (this.anchored || !this._nearHelm(rig.position)) return false;
    this.controlling = true;
    this.onMessage("Штурвал твой: вперёд-назад - паруса, вбок - курс.");
    return true;
  }

  addSpeedMultiplier(amount = 0.2) {
    this.speedMultiplier *= 1 + amount;
  }

  setAnchored(value) {
    this.anchored = Boolean(value);
    if (this.anchored) {
      this.controlling = false;
      this.rudder = 0;
    }
  }

  update(dt, keys) {
    if (this.anchored) {
      this.speed = THREE.MathUtils.lerp(this.speed, 0, 1 - Math.exp(-2.4 * dt));
      this.velocity.copy(this.forward).multiplyScalar(this.speed);
      return;
    }
    if (this.controlling) {
      const throttleInput = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      this.throttle = THREE.MathUtils.clamp(this.throttle + throttleInput * THROTTLE_RESPONSE * dt, 0, 1);
      const rudderTarget = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      this.rudder = THREE.MathUtils.lerp(this.rudder, rudderTarget, 1 - Math.exp(-4.2 * dt));
    } else {
      this.rudder = THREE.MathUtils.lerp(this.rudder, 0, 1 - Math.exp(-3.2 * dt));
    }

    this.forward.set(Math.sin(this.ship.group.rotation.y), 0, Math.cos(this.ship.group.rotation.y));
    const windSpeed = Math.hypot(this.wind.x, this.wind.z);
    const windDirection = windSpeed > 1e-5
      ? new THREE.Vector3(this.wind.x / windSpeed, 0, this.wind.z / windSpeed)
      : new THREE.Vector3(0, 0, 1);
    this.windAlignment = this.forward.dot(windDirection);
    const windFactor = THREE.MathUtils.lerp(0.24, 1, (this.windAlignment + 1) / 2);
    const targetSpeed = this.throttle * (7 + windSpeed * 3.4) * windFactor * this.speedMultiplier;
    this.speed = THREE.MathUtils.lerp(this.speed, targetSpeed, 1 - Math.exp(-SPEED_RESPONSE * dt));

    const steeringAuthority = 0.18 + Math.min(1, this.speed / 13) * 0.82;
    this.ship.group.rotation.y += this.rudder * TURN_RATE * steeringAuthority * dt;
    this.forward.set(Math.sin(this.ship.group.rotation.y), 0, Math.cos(this.ship.group.rotation.y));
    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.ship.group.position.addScaledVector(this.velocity, dt);
  }

  getState() {
    return {
      controlling: this.controlling,
      throttle: this.throttle,
      speed: this.speed,
      speedMultiplier: this.speedMultiplier,
      anchored: this.anchored,
      windAlignment: this.windAlignment,
      velocity: this.velocity,
    };
  }
}
