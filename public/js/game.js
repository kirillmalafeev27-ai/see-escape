// game.js — wires the combat core together: ocean + player ship (bobbing on
// the waves), the player's aimable cannons, an AI enemy fleet trading
// realistic cannonball fire, wood-debris impacts, and the HUD/main loop.
import * as THREE from "three";
import { createWorld } from "./ocean.js";
import { EffectsSystem } from "./effects.js?v=20260602-analytic-nav2";
import { ProjectileSystem } from "./ballistics.js";
import { buildPlayerShip, SHIP_DEFAULTS } from "./ship.js?v=20260602-analytic-nav2";
import { EnemyFleet } from "./enemy.js";
import { PlayerController } from "./player.js?v=20260602-analytic-nav2";
import { DamageControlSystem } from "./damage-control.js?v=20260602-analytic-nav2";
import { loadAndAnalyzeShip } from "./models.js?v=20260602-analytic-nav2";

export async function startGame(container, hud) {
  const world = createWorld(container);
  const { scene, camera, renderer, sampleWaveHeight, advanceTime } = world;

  // Load + measure the player ship model so all gameplay fits the real model.
  let playerDims = { ...SHIP_DEFAULTS };
  let playerPivot = null;
  let playerNavigationRoot = null;
  let playerWalkableMeshes = [];
  let playerSolidMeshes = [];
  let playerStairZones = [];
  let playerNavigationSurfaces = [];
  let playerNavigationBlockers = [];
  let playerCannonTemplate = null;
  try {
    const r = await loadAndAnalyzeShip("models/stylized_pirate_ship.glb", {
      targetLength: 96,
      flip: false,
    });
    playerDims = r.dims;
    playerPivot = r.pivot;
    playerNavigationRoot = r.navigationRoot;
    playerWalkableMeshes = r.walkableMeshes;
    playerSolidMeshes = r.solidMeshes;
    playerStairZones = r.stairZones;
    playerNavigationSurfaces = r.navigationSurfaces;
    playerNavigationBlockers = r.navigationBlockers;
    playerCannonTemplate = r.cannonTemplate;
  } catch (e) {
    console.warn("Player ship model failed, using primitives:", e);
  }

  const ship = buildPlayerShip(playerDims, { cannonTemplate: playerCannonTemplate });
  scene.add(ship.group);
  if (playerPivot) {
    ship.group.add(playerPivot);
    if (playerNavigationRoot) ship.group.add(playerNavigationRoot);
    ship.modelPivot = playerPivot;
    ship.walkableMeshes = playerWalkableMeshes;
    ship.stairZones = playerStairZones;
    ship.navigationSurfaces = playerNavigationSurfaces;
    ship.navigationBlockers = playerNavigationBlockers;
    ship.solidMeshes = [...playerSolidMeshes, ...ship.cannonSolidMeshes];
    ship.snapCannonsToDeck(playerWalkableMeshes);
    ship.hidePrimitives();
  }

  const effects = new EffectsSystem(scene, sampleWaveHeight);
  const projectiles = new ProjectileSystem(scene);
  const damageControl = new DamageControlSystem({
    scene,
    ship,
    effects,
    onMessage: (m) => m && setMessage(m),
  });

  // Slowly drifting wind that nudges every cannonball (player reads it off the
  // HUD; the aim preview already bakes it in).
  const wind = new THREE.Vector3(3, 0, 1);
  const windTarget = new THREE.Vector3(3, 0, 1);
  let windTimer = 0;

  const getEnv = () => ({ wind, sampleWaveHeight });
  const state = { score: 0, over: false };
  const getPlayerTarget = () => ({ pos: ship.group.position.clone(), vel: new THREE.Vector3() });

  // Load + measure the enemy ship model (cheap clones per spawn).
  let enemyDims = { length: 72, beam: 18, deckY: 9, keelY: -9 };
  let enemyFactory = null;
  try {
    const r = await loadAndAnalyzeShip("models/low-poly_pirate_ship.glb", {
      targetLength: 72,
      flip: false,
    });
    enemyDims = r.dims;
    enemyFactory = () => r.pivot.clone(true);
  } catch (e) {
    console.warn("Enemy ship model failed, using primitives:", e);
  }

  const fleet = new EnemyFleet(scene, sampleWaveHeight, projectiles, effects, getPlayerTarget, {
    dims: enemyDims,
    factory: enemyFactory,
  });

  const player = new PlayerController({
    scene,
    camera,
    ship,
    domElement: renderer.domElement,
    projectiles,
    effects,
    getEnv,
    fireButton: hud.fireButton,
    jumpButton: hud.jumpButton,
    damageControl,
    onMessage: (m) => m && setMessage(m),
  });

  // ---- collisions / hit resolution ----
  const projEnv = {
    wind,
    sampleWaveHeight,
    hitTest: (proj) => (proj.team === "player" ? fleet.hitTest(proj) : ship.hullTest(proj.pos)),
    onHit: (proj, hit) => {
      if (proj.team === "player") {
        if (hit.kind === "sail") {
          effects.woodImpact(hit.point, hit.normal, 0.9);
          setMessage("Попадание по парусам: корпус врага не повреждён.");
          return;
        }
        effects.woodImpact(hit.point, hit.normal, 2.7);
        fleet.sink(hit.enemy);
        state.score++;
        setMessage("Прямое попадание! Враг идёт ко дну ⚓");
      } else {
        effects.woodImpact(hit.point, hit.normal, 1.2);
        registerPlayerHit(hit);
      }
    },
    onWater: (proj, point) => effects.waterSplash(point, proj.team === "enemy" ? 0.9 : 0.7),
  };

  function registerPlayerHit(hit) {
    flash();
    if (damageControl.addBreach(hit)) {
      setMessage("Пробоина в корпусе! Спускайся в трюм: возьми доску и заколоти течь.");
    } else {
      setMessage("Ядро ударило в корпус, но новой течи не появилось.");
    }
  }

  function loseToFlooding() {
    if (state.over) return;
    state.over = true;
    hud.gameover.style.display = "flex";
    document.exitPointerLock?.();
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

      windTimer -= dt;
      if (windTimer <= 0) {
        windTarget.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10);
        windTimer = 5 + Math.random() * 5;
      }
      wind.lerp(windTarget, 1 - Math.exp(-0.4 * dt));

      ship.applyBuoyancy(sampleWaveHeight, dt);
      ship.group.updateMatrixWorld(true);

      player.update(dt);
      fleet.update(dt, () => {});
      projectiles.update(dt, projEnv);
      damageControl.update(dt);
      if (damageControl.waterLevel >= 100) loseToFlooding();
      effects.update(dt);

      updateHud(dt);
    }
    renderer.render(scene, camera);
  }

  function updateHud(dt) {
    const ps = player.getState();
    const dc = damageControl.getState();
    hud.prompt.textContent = ps.prompt || "";
    hud.crosshair.style.display = "block";
    hud.reloadWrap.style.display = ps.nearCannon ? "block" : "none";
    hud.reloadBar.style.width = `${Math.round(ps.reload * 100)}%`;
    hud.fireButton.style.display = ps.nearCannon ? "block" : "none";
    hud.fireButton.disabled = !ps.canFire;
    hud.fireButton.textContent = ps.fireLabel;
    hud.jumpButton.disabled = !ps.canJump;

    hud.score.textContent = `Потоплено: ${state.score}`;
    hud.integrityBar.style.width = `${dc.waterLevel}%`;
    hud.integrityBar.style.background =
      dc.waterLevel < 35 ? "#4aa9d9" : dc.waterLevel < 70 ? "#e8c25a" : "#e85a5a";
    hud.floodLabel.textContent = `Вода в трюме: ${Math.round(dc.waterLevel)}% · пробоин: ${dc.activeBreaches}`;
    hud.enemies.textContent = `Врагов на воде: ${fleet.list.filter((e) => !e.sinking).length}`;

    const mag = Math.hypot(wind.x, wind.z);
    const ang = Math.atan2(wind.x, -wind.z);
    hud.windArrow.style.transform = `rotate(${ang}rad)`;
    hud.windText.textContent = `${mag.toFixed(1)} м/с`;

    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) hud.msg.style.opacity = "0";
    }
    if (hud.flash.style.opacity && parseFloat(hud.flash.style.opacity) > 0) {
      hud.flash.style.opacity = String(Math.max(0, parseFloat(hud.flash.style.opacity) - dt * 1.2));
    }
  }

  setMessage("Подойди к пушке и нажми E. При пробоине открой двери трюма, возьми доску или вычерпывай воду.");
  frame();
  return world;
}
