// game.js — wires the combat core together: ocean + player ship (bobbing on
// the waves), the player's aimable cannons, an AI enemy fleet trading
// realistic cannonball fire, wood-debris impacts, and the HUD/main loop.
import * as THREE from "three";
import { createWorld } from "./ocean.js";
import { EffectsSystem } from "./effects.js";
import { ProjectileSystem } from "./ballistics.js";
import { buildPlayerShip } from "./ship.js";
import { EnemyFleet } from "./enemy.js";
import { PlayerController } from "./player.js";

export function startGame(container, hud) {
  const world = createWorld(container);
  const { scene, camera, renderer, sampleWaveHeight, advanceTime } = world;

  // Player ship at the origin; it stays on station and bobs on the swell.
  const ship = buildPlayerShip();
  scene.add(ship.group);

  const effects = new EffectsSystem(scene, sampleWaveHeight);
  const projectiles = new ProjectileSystem(scene);

  // Slowly drifting wind that nudges every cannonball (player can read it off
  // the HUD and the aim preview already bakes it in).
  const wind = new THREE.Vector3(3, 0, 1);
  const windTarget = new THREE.Vector3(3, 0, 1);
  let windTimer = 0;

  const getEnv = () => ({ wind, sampleWaveHeight });

  const state = { score: 0, integrity: 100, over: false };

  const getPlayerTarget = () => ({ pos: ship.group.position.clone(), vel: new THREE.Vector3() });

  const fleet = new EnemyFleet(scene, sampleWaveHeight, projectiles, effects, getPlayerTarget);

  const player = new PlayerController({
    scene,
    camera,
    ship,
    domElement: renderer.domElement,
    projectiles,
    effects,
    getEnv,
    onMessage: (m) => m && setMessage(m),
  });

  // ---- collisions / hit resolution ----
  const projEnv = {
    wind,
    sampleWaveHeight,
    hitTest: (proj) => {
      if (proj.team === "player") return fleet.hitTest(proj);
      return ship.hullTest(proj.pos);
    },
    onHit: (proj, hit) => {
      if (proj.team === "player") {
        effects.woodImpact(hit.point, hit.normal, 1.4);
        fleet.sink(hit.enemy);
        state.score++;
        setMessage("Прямое попадание! Враг идёт ко дну ⚓");
      } else {
        effects.woodImpact(hit.point, hit.normal, 1.2);
        registerPlayerHit();
      }
    },
    onWater: (proj, point) => {
      effects.waterSplash(point, proj.team === "enemy" ? 0.9 : 0.7);
    },
  };

  function registerPlayerHit() {
    state.integrity -= 18;
    flash();
    if (state.integrity <= 0 && !state.over) {
      state.integrity = 0;
      state.over = true;
      hud.gameover.style.display = "flex";
      document.exitPointerLock?.();
    } else {
      setMessage("Пробоина в корпусе! (откачка появится в след. обновлении)");
    }
  }

  // ---- HUD helpers ----
  let msgTimer = 0;
  function setMessage(text) {
    hud.msg.textContent = text;
    hud.msg.style.opacity = "1";
    msgTimer = 3;
  }
  function flash() {
    hud.flash.style.opacity = "0.55";
  }

  addEventListener("keydown", (e) => {
    if (e.code === "KeyR" && state.over) location.reload();
  });

  // ---- main loop ----
  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!state.over) {
      advanceTime(dt);

      // wind drift
      windTimer -= dt;
      if (windTimer <= 0) {
        windTarget.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10);
        windTimer = 5 + Math.random() * 5;
      }
      wind.lerp(windTarget, 1 - Math.exp(-0.4 * dt));

      // player ship buoyancy, then make sure world matrices are fresh for
      // muzzle/aim transforms read this frame
      ship.applyBuoyancy(sampleWaveHeight);
      ship.group.updateMatrixWorld(true);

      player.update(dt);
      fleet.update(dt, () => {});
      projectiles.update(dt, projEnv);
      effects.update(dt);

      updateHud(dt);
    }
    renderer.render(scene, camera);
  }

  function updateHud(dt) {
    const ps = player.getState();
    hud.prompt.textContent = ps.prompt || "";
    hud.crosshair.style.display = ps.mode === "cannon" ? "block" : "none";
    hud.reloadWrap.style.display = ps.mode === "cannon" ? "block" : "none";
    hud.reloadBar.style.width = `${Math.round(ps.reload * 100)}%`;

    hud.score.textContent = `Потоплено: ${state.score}`;
    hud.integrityBar.style.width = `${state.integrity}%`;
    hud.integrityBar.style.background =
      state.integrity > 50 ? "#4fd07a" : state.integrity > 25 ? "#e8c25a" : "#e85a5a";
    hud.enemies.textContent = `Врагов на воде: ${fleet.list.filter((e) => !e.sinking).length}`;

    const mag = Math.hypot(wind.x, wind.z);
    const ang = Math.atan2(wind.x, -wind.z); // 0 = north(-z)
    hud.windArrow.style.transform = `rotate(${ang}rad)`;
    hud.windText.textContent = `${mag.toFixed(1)} м/с`;

    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) hud.msg.style.opacity = "0";
    }
    if (hud.flash.style.opacity && parseFloat(hud.flash.style.opacity) > 0) {
      const v = Math.max(0, parseFloat(hud.flash.style.opacity) - dt * 1.2);
      hud.flash.style.opacity = String(v);
    }
  }

  setMessage("Подойди к пушке (E), целься мышью, стреляй (ЛКМ/Space). Учитывай ветер и дугу!");
  frame();
  return world;
}
