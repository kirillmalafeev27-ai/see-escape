// game.js — wires the combat core together: ocean + player ship (bobbing on
// the waves), the player's aimable cannons, an AI enemy fleet trading
// realistic cannonball fire, wood-debris impacts, and the HUD/main loop.
import * as THREE from "three";
import { createWorld } from "./ocean.js";
import { EffectsSystem } from "./effects.js?v=20260602-raycast-restored-v1";
import { ProjectileSystem } from "./ballistics.js?v=20260603-bonuses-island-v1";
import { buildPlayerShip, SHIP_DEFAULTS } from "./ship.js?v=20260603-cannon-line-v6";
import { EnemyFleet } from "./enemy.js?v=20260603-bonuses-island-v1";
import { PlayerController } from "./player.js?v=20260604-island-barrage-v5";
import { DamageControlSystem } from "./damage-control.js?v=20260603-action-buttons-v1";
import { loadAndAnalyzeShip } from "./models.js?v=20260602-raycast-restored-v1";
import { applyCollisionProfile, loadAppliedCollisionProfile } from "./collision-profile.js?v=20260602-default-profile-v2";
import { SailingSystem } from "./sailing.js?v=20260603-bonuses-island-v1";
import { TreasureSystem } from "./treasure.js?v=20260603-bonuses-island-v1";
import { IslandFortress } from "./island.js?v=20260603-bonuses-island-v1";
import { BonusSystem } from "./bonuses.js?v=20260603-bonuses-island-v1";
import { IslandQuestSystem } from "./island-quest.js?v=20260604-island-barrage-v5";

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
    waterMaterial: world.water.material,
    onMessage: (m) => m && setMessage(m),
  });
  const defaultStairZones = ship.stairZones.slice();
  applyCollisionProfile(ship, loadAppliedCollisionProfile(), { stairZones: defaultStairZones });

  // Slowly drifting wind that nudges every cannonball (player reads it off the
  // HUD; the aim preview already bakes it in).
  const wind = new THREE.Vector3(3, 0, 1);
  const windTarget = new THREE.Vector3(3, 0, 1);
  let windTimer = 0;

  const getEnv = () => ({ wind, sampleWaveHeight });
  const state = { score: 0, treasures: 0, over: false, bonuses: {} };
  const sailing = new SailingSystem({ ship, wind, onMessage: (m) => m && setMessage(m) });
  const getPlayerTarget = () => ({ pos: ship.group.position.clone(), vel: sailing.velocity.clone() });
  let bonusSystem = null;
  const treasures = new TreasureSystem(scene, sampleWaveHeight, () => {
    state.treasures++;
    bonusSystem?.showChoices();
    setMessage("Сундук с сокровищами поднят на борт.");
  });

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
    onSunk: (position) => treasures.spawn(position),
  });
  const island = new IslandFortress(scene, projectiles, effects, getPlayerTarget);
  const islandQuest = new IslandQuestSystem({
    scene,
    island,
    ship,
    sailing,
    hud,
    onMessage: (m) => m && setMessage(m),
    onComplete: () => {
      state.treasures += 3;
      winAtIsland();
    },
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
    dumpButton: hud.dumpButton,
    jumpButton: hud.jumpButton,
    takePlankButton: hud.takePlankButton,
    scoopWaterButton: hud.scoopWaterButton,
    patchBreachButton: hud.patchBreachButton,
    islandTeleportButton: hud.islandTeleportButton,
    damageControl,
    sailing,
    islandQuest,
    onMessage: (m) => m && setMessage(m),
  });
  islandQuest.setPlayer(player);
  bonusSystem = new BonusSystem({
    hud,
    state,
    systems: { sailing, player, damageControl },
    onMessage: (m) => m && setMessage(m),
  });

  // ---- collisions / hit resolution ----
  const projEnv = {
    wind,
    sampleWaveHeight,
    hitTest: (proj) => (proj.team === "player" ? island.hitTest(proj) || fleet.hitTest(proj) : ship.hullTest(proj.pos)),
    onHit: (proj, hit) => {
      if (proj.team === "player") {
        if (hit.kind === "islandCannon") {
          effects.woodImpact(hit.point, hit.normal, 2.2);
          island.destroyCannon(hit.cannon);
          const remaining = island.activeCannons().length;
          setMessage(remaining ? `Береговая пушка уничтожена. Осталось: ${remaining}.` : "Все береговые пушки уничтожены. Крепость обезоружена.");
          return;
        }
        if (hit.kind === "island") {
          effects.woodImpact(hit.point, hit.normal, 1.25);
          setMessage("Ядро ударило в камни крепости. Целься по береговым пушкам.");
          return;
        }
        if (hit.kind === "sail") {
          effects.woodImpact(hit.point, hit.normal, 0.9);
          setMessage("Попадание по парусам: корпус врага не повреждён.");
          return;
        }
        if (proj.kind === "grapeshot") {
          effects.woodImpact(hit.point, hit.normal, 1.35);
          const sunk = fleet.damage(hit.enemy, proj.damage || 50);
          if (sunk) {
            state.score++;
            setMessage("Картечь добила корпус. Враг идёт ко дну.");
          } else {
            setMessage("Картечь сорвала половину прочности корпуса.");
          }
          return;
        }
        if (proj.kind === "hand-cannon") {
          effects.woodImpact(hit.point, hit.normal, 2.2);
          const sunk = fleet.damage(hit.enemy, proj.damage || 100);
          if (sunk) {
            state.score++;
            setMessage("Ручная пушка пробила корпус. Враг идёт ко дну.");
          }
          return;
        }
        effects.woodImpact(hit.point, hit.normal, 2.7);
        fleet.sink(hit.enemy);
        state.score++;
        setMessage("Прямое попадание! Враг идёт ко дну ⚓");
      } else {
        if (islandQuest.active) {
          effects.waterSplash(hit.point || proj.pos, 0.8);
          return;
        }
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
    const title = hud.gameover.querySelector("h1");
    const text = hud.gameover.querySelector("p");
    if (title) {
      title.textContent = "Корабль потоплен";
      title.style.color = "#ff7070";
    }
    if (text) text.innerHTML = "Нажми <b>R</b>, чтобы начать заново.";
    hud.gameover.style.display = "flex";
    document.exitPointerLock?.();
  }

  function winAtIsland() {
    if (state.over) return;
    state.over = true;
    const title = hud.gameover.querySelector("h1");
    const text = hud.gameover.querySelector("p");
    if (title) {
      title.textContent = "Победа!";
      title.style.color = "#8dff9e";
    }
    if (text) {
      text.innerHTML = "Сокровище острова взято. Поздравляем!";
    }
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
      if (bonusSystem?.active) {
        updateHud(dt);
        renderer.render(scene, camera);
        return;
      }
      advanceTime(dt);

      windTimer -= dt;
      if (windTimer <= 0) {
        windTarget.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10);
        windTimer = 5 + Math.random() * 5;
      }
      wind.lerp(windTarget, 1 - Math.exp(-0.4 * dt));

      sailing.update(dt, player.keys);
      ship.applyBuoyancy(sampleWaveHeight, dt);
      ship.group.updateMatrixWorld(true);

      player.update(dt);
      fleet.quizMode = Boolean(islandQuest.active);
      fleet.update(dt, () => {});
      island.update(dt);
      islandQuest.update(dt);
      projectiles.update(dt, projEnv);
      if (!islandQuest.active) {
        damageControl.update(dt);
      }
      treasures.update(dt, ship.group.position, {
        harpoon: Boolean(state.bonuses.harpoon),
        pullTarget: ship.group.position,
      });
      if (!islandQuest.active && damageControl.waterLevel >= 100) loseToFlooding();
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
    if (hud.dumpButton) hud.dumpButton.style.display = ps.canDumpBucket ? "block" : "none";
    if (hud.takePlankButton) hud.takePlankButton.style.display = ps.canTakePlank ? "block" : "none";
    if (hud.scoopWaterButton) hud.scoopWaterButton.style.display = ps.canScoopWater ? "block" : "none";
    if (hud.patchBreachButton) hud.patchBreachButton.style.display = ps.canPatchBreach ? "block" : "none";
    hud.jumpButton.disabled = !ps.canJump;

    hud.score.textContent = `Потоплено: ${state.score}`;
    hud.treasures.textContent = `Сокровища: ${state.treasures}`;
    hud.integrityBar.style.width = `${dc.waterLevel}%`;
    hud.integrityBar.style.background =
      dc.waterLevel < 35 ? "#4aa9d9" : dc.waterLevel < 70 ? "#e8c25a" : "#e85a5a";
    hud.floodLabel.textContent = `Вода в трюме: ${Math.round(dc.waterLevel)}% · пробоин: ${dc.activeBreaches}`;
    hud.enemies.textContent = `Врагов на воде: ${fleet.list.filter((e) => !e.sinking).length}`;

    const mag = Math.hypot(wind.x, wind.z);
    setRelativeArrow(hud.windArrow, wind);
    hud.windText.textContent = `${mag.toFixed(1)} м/с · X ${wind.x.toFixed(1)} · Z ${wind.z.toFixed(1)}`;
    const navigation = sailing.getState();
    hud.speedText.textContent = `${navigation.speed.toFixed(1)} м/с · паруса ${Math.round(navigation.throttle * 100)}%`;
    const toIsland = island.position.clone().sub(ship.group.position);
    setRelativeArrow(hud.compassArrow, toIsland);
    hud.compassText.textContent = `Крепость: ${Math.round(toIsland.length())} м · пушек: ${island.activeCannons().length}`;

    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) hud.msg.style.opacity = "0";
    }
    if (hud.flash.style.opacity && parseFloat(hud.flash.style.opacity) > 0) {
      hud.flash.style.opacity = String(Math.max(0, parseFloat(hud.flash.style.opacity) - dt * 1.2));
    }
  }

  function setRelativeArrow(element, worldDirection) {
    camera.updateWorldMatrix(true, false);
    const view = camera.getWorldDirection(new THREE.Vector3());
    view.y = 0;
    const direction = worldDirection.clone();
    direction.y = 0;
    if (view.lengthSq() < 1e-5 || direction.lengthSq() < 1e-5) return;
    view.normalize();
    direction.normalize();
    const viewAngle = Math.atan2(view.x, view.z);
    const targetAngle = Math.atan2(direction.x, direction.z);
    const relativeAngle = Math.atan2(Math.sin(targetAngle - viewAngle), Math.cos(targetAngle - viewAngle));
    element.style.transform = `rotate(${relativeAngle}rad)`;
  }

  setMessage("ЛКМ стреляет из ближайшей пушки. У штурвала нажми E, чтобы управлять курсом и парусами.");
  frame();
  return world;
}
