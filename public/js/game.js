// game.js — wires the combat core together: ocean + player ship (bobbing on
// the waves), the player's aimable cannons, an AI enemy fleet trading
// realistic cannonball fire, wood-debris impacts, and the HUD/main loop.
import * as THREE from "three";
import { createWorld } from "./ocean.js?v=20260615-mac-perf-v1";
import { EffectsSystem } from "./effects.js?v=20260615-mac-perf-v1";
import { ProjectileSystem } from "./ballistics.js?v=20260603-bonuses-island-v1";
import { buildPlayerShip, SHIP_DEFAULTS } from "./ship.js?v=20260614-buoyancy-v2";
import { EnemyFleet } from "./enemy.js?v=20260615-slower-enemy-fire-v1";
import { PlayerController } from "./player.js?v=20260615-cursor-modes-v1";
import { DamageControlSystem } from "./damage-control.js?v=20260614-hold-water-v2";
import { loadAndAnalyzeShip } from "./models.js?v=20260607-assets-fire-v1";
import { applyCollisionProfile, loadAppliedCollisionProfile } from "./collision-profile.js?v=20260609-remove-hold-helpers-v1";
import { SailingSystem } from "./sailing.js?v=20260603-bonuses-island-v1";
import { TreasureSystem } from "./treasure.js?v=20260603-bonuses-island-v1";
import { IslandFortress } from "./island.js?v=20260615-lazy-island-v1";
import { BonusSystem } from "./bonuses.js?v=20260615-clickable-bonuses-v1";
import { IslandQuestSystem } from "./island-quest.js?v=20260611-audio-guide-v1";
import { applyCannonLayout, loadCannonLayout } from "./cannon-layout.js?v=20260609-default-profile-v2";
import { AudioGuide } from "./audio-guide.js?v=20260615-once-hints-v1";
import { ActionQuizGate } from "./action-quiz.js?v=20260615-clickable-quiz-v1";

export async function startGame(container, hud) {
  const world = createWorld(container);
  const { scene, camera, renderer, sampleWaveHeight, advanceTime } = world;
  const audioGuide = new AudioGuide({ button: hud.audioGuideButton });
  let player = null;
  const actionQuiz = new ActionQuizGate({
    audioGuide,
    onActiveChange: (active) => {
      if (active) player?.enterCursorMode?.();
    },
  });
  audioGuide.introduce([
    "Ты капитан боевого корабля. Главная цель: выжить, топить врагов, идти по компасу к крепости и забрать островное сокровище.",
    "Ходи по палубе клавишами W A S D. Клик по экрану захватывает мышь для обзора и наведения.",
    "Подойди к пушке. Жёлтая дуга показывает, куда упадёт ядро. Перед выстрелом реши задание, затем стреляй сам.",
  ]);

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
    applyCannonLayout(ship, loadCannonLayout());
    ship.hidePrimitives();
  }

  const effects = new EffectsSystem(scene, sampleWaveHeight, {
    effectScale: world.performanceProfile?.effectScale ?? 1,
  });
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
  const audioState = {
    prompt: "",
    flags: new Map(),
    waterPhase: 0,
    activeBreaches: 0,
    enemyCount: 0,
    islandPhase: "far",
    windBucket: "",
    windTimer: 0,
    bonusActive: false,
    questActive: false,
  };
  const sailing = new SailingSystem({ ship, wind, onMessage: (m) => m && setMessage(m) });
  const getPlayerTarget = () => ({ pos: ship.group.position.clone(), vel: sailing.velocity.clone() });
  let bonusSystem = null;
  let playerShipSinking = false;
  let playerSinkTimer = 0;
  let sinkingOverlayShown = false;
  function updateShipQuietWaterZone(maskInteriorWater = false) {
    world.setQuietZone?.({ center: null });
    world.setHullWaterMask?.(
      maskInteriorWater
        ? {
            center: ship.group.position,
            yaw: ship.group.rotation.y,
            halfWidth: ship.dims.beam * 0.42,
            halfLength: ship.dims.length * 0.46,
            edge: 1.2,
          }
        : { center: null }
    );
  }
  const treasures = new TreasureSystem(scene, sampleWaveHeight, () => {
    state.treasures++;
    setMessage("Сундук с сокровищами поднят на борт.");
    bonusSystem?.showChoices();
  });

  // Enemy GLB loads in the background; primitive enemies are good enough until it arrives.
  let enemyDims = { length: 72, beam: 18, deckY: 9, keelY: -9 };
  let enemyFactory = null;

  const fleet = new EnemyFleet(scene, sampleWaveHeight, projectiles, effects, getPlayerTarget, {
    dims: enemyDims,
    factory: enemyFactory,
    onSunk: (position) => {
      treasures.spawn(position);
      audioGuide.event("С потопленного врага выпал сундук. Подведи корабль к светящемуся кольцу на воде, чтобы забрать трофей.", {
        id: "treasure-spawn",
        priority: 2,
        cooldown: 4000,
      });
    },
    onSpawn: (position) => {
      const distance = Math.round(position.distanceTo(ship.group.position));
      setMessage(`На горизонте новый вражеский корабль. Дистанция около ${distance} метров: ищи пушку и готовь залп.`, {
        id: "enemy-spawn",
        cooldown: 4500,
      });
    },
    onFire: (position) => {
      const distance = Math.round(position.distanceTo(ship.group.position));
      setMessage(`Враг стреляет с дистанции ${distance} метров. Следи за попаданием: пробоины чинятся в трюме доской.`, {
        id: "enemy-fire",
        cooldown: 5000,
      });
    },
  });
  const island = new IslandFortress(scene, projectiles, effects, getPlayerTarget);
  const islandQuest = new IslandQuestSystem({
    scene,
    island,
    ship,
    sailing,
    hud,
    sampleWaveHeight,
    raiderShipFactory: enemyFactory,
    onMessage: (m) => m && setMessage(m),
    onComplete: () => {
      state.treasures += 3;
      winAtIsland();
    },
  });

  loadAndAnalyzeShip("models/low-poly_pirate_ship.glb", {
    targetLength: 72,
    flip: false,
  })
    .then((r) => {
      enemyDims = r.dims;
      enemyFactory = () => r.pivot.clone(true);
      fleet.dims = enemyDims;
      fleet.factory = enemyFactory;
      islandQuest.raiderShipFactory = enemyFactory;
    })
    .catch((e) => {
      console.warn("Enemy ship model failed, using primitives:", e);
    });

  player = new PlayerController({
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
    requestActionQuiz: (action, context) => actionQuiz.request(action, context),
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
      setMessage("Пробоина в корпусе! Спускайся в трюм: возьми доску и заколоти течь.", {
        priority: 3,
        interrupt: true,
      });
    } else {
      setMessage("Ядро ударило в корпус, но новой течи не появилось.", { priority: 2 });
    }
  }

  function loseToFlooding() {
    if (state.over) return;
    state.over = true;
    playerShipSinking = true;
    playerSinkTimer = 0;
    sinkingOverlayShown = false;
    const title = hud.gameover.querySelector("h1");
    const text = hud.gameover.querySelector("p");
    if (title) {
      title.textContent = "Корабль потоплен";
      title.style.color = "#ff7070";
    }
    if (text) text.innerHTML = "Нажми <b>R</b>, чтобы начать заново.";
    hud.gameover.style.display = "none";
    setMessage("Корабль уходит ко дну: океан уже прорывается внутрь корпуса.", {
      priority: 3,
      interrupt: true,
    });
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
    audioGuide.event("Победа. Сокровище острова взято, цель выполнена.", {
      id: "victory",
      priority: 3,
      interrupt: true,
    });
    document.exitPointerLock?.();
  }

  // ---- HUD helpers ----
  let msgTimer = 0;
  function setMessage(text, options = {}) {
    hud.msg.textContent = text;
    hud.msg.style.opacity = "1";
    msgTimer = 3;
    if (!options.voice) return;
    audioGuide.event(text, {
      id: options.id || `message:${text}`,
      priority: options.priority ?? 2,
      cooldown: options.cooldown ?? 1200,
      interrupt: Boolean(options.interrupt),
    });
  }
  function flash() {
    hud.flash.style.opacity = "0.55";
  }

  function announceHudAudio({ toIsland, islandCannons }) {
    const islandDistance = toIsland.length();
    const nextIslandPhase = islandDistance <= 280 ? "landing" : islandDistance <= 560 ? "close" : islandDistance <= 950 ? "approach" : "far";
    if (nextIslandPhase !== audioState.islandPhase) {
      audioState.islandPhase = nextIslandPhase;
      if (nextIslandPhase === "approach") {
        audioGuide.status("island-approach", "Крепость впереди по компасу. Продолжай идти к жёлтой стрелке.");
      } else if (nextIslandPhase === "close") {
        audioGuide.status("island-close", `Крепость близко. На берегу активных пушек: ${islandCannons}. Их можно уничтожать корабельными пушками.`);
      } else if (nextIslandPhase === "landing") {
        audioGuide.event("Ты у острова. Нажми E, чтобы бросить якорь и начать испытание статуи.", {
          id: "island-landing",
          priority: 3,
        });
      }
    }

    audioState.bonusActive = Boolean(bonusSystem?.active);

    if (islandQuest.active && !audioState.questActive) {
      audioGuide.event("Началось испытание острова. Выбери направление, ответь на вопрос, сделай шаг к сокровищу и избегай клеток под обстрелом.", {
        id: "quest-start-coach",
        priority: 3,
      });
    }
    audioState.questActive = Boolean(islandQuest.active);
  }

  addEventListener("keydown", (e) => {
    if (e.code === "KeyR" && state.over) location.reload();
  });

  // ---- main loop ----
  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    world.tuneForFrameTime?.(dt);
    const playerInsideHold = damageControl.isInsideHold?.(player.rig.position) || false;
    damageControl.updateInteriorVisibility(player.rig.position);
    if (state.over) {
      if (playerShipSinking) {
        advanceTime(dt);
        playerSinkTimer += dt;
        damageControl.update(dt);
        ship.group.position.y -= (0.38 + Math.min(playerSinkTimer, 5.5) * 0.13) * dt;
        ship.group.position.x += Math.sin(playerSinkTimer * 0.7) * 0.22 * dt;
        ship.group.position.z += Math.cos(playerSinkTimer * 0.5) * 0.18 * dt;
        ship.group.rotation.z = THREE.MathUtils.lerp(ship.group.rotation.z, 0.18, 1 - Math.exp(-0.55 * dt));
        ship.group.rotation.x = THREE.MathUtils.lerp(ship.group.rotation.x, -0.1, 1 - Math.exp(-0.45 * dt));
        updateShipQuietWaterZone(playerInsideHold);
        ship.group.updateMatrixWorld(true);
        effects.update(dt);
        updateHud(dt);
        if (!sinkingOverlayShown && playerSinkTimer > 4.2) {
          sinkingOverlayShown = true;
          hud.gameover.style.display = "flex";
        }
      }
      renderer.render(scene, camera);
      return;
    }
    if (!state.over) {
      if (bonusSystem?.active) {
        updateHud(dt);
        renderer.render(scene, camera);
        return;
      }
      advanceTime(dt);
      const waveTarget = islandQuest.active ? 0.18 : 1;
      const currentWave = world.getWaveHeightMultiplier?.() ?? 1;
      world.setWaveHeightMultiplier?.(
        THREE.MathUtils.lerp(currentWave, waveTarget, 1 - Math.exp(-2.4 * dt))
      );

      windTimer -= dt;
      if (windTimer <= 0) {
        windTarget.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10);
        windTimer = 5 + Math.random() * 5;
      }
      wind.lerp(windTarget, 1 - Math.exp(-0.4 * dt));

      sailing.update(dt, player.keys);
      updateShipQuietWaterZone(playerInsideHold);
      ship.applyBuoyancy(sampleWaveHeight, dt, damageControl.getFloodSinkOffset?.() || 0, world.sampleWaveFrame);
      ship.group.updateMatrixWorld(true);

      player.update(dt);
      fleet.quizMode = Boolean(islandQuest.active);
      fleet.learningFireMode = Boolean(actionQuiz.active);
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
      if (!islandQuest.active && damageControl.isShipLost?.()) loseToFlooding();
      effects.update(dt);

      updateHud(dt);
    }
    renderer.render(scene, camera);
  }

  function updateHud(dt) {
    const ps = player.getState();
    const dc = damageControl.getState();
    const uiCursorActive = actionQuiz.active || Boolean(bonusSystem?.active) || islandQuest.active || player.questMode;
    hud.prompt.textContent = ps.prompt || "";
    hud.crosshair.style.display = uiCursorActive ? "none" : "block";
    hud.reloadWrap.style.display = ps.nearCannon ? "block" : "none";
    hud.reloadBar.style.width = `${Math.round(ps.reload * 100)}%`;
    hud.fireButton.style.display = ps.nearCannon ? "block" : "none";
    hud.fireButton.disabled = !ps.canFire;
    hud.fireButton.textContent = ps.fireLabel;
    if (hud.dumpButton) {
      hud.dumpButton.style.display = ps.canDumpBucket ? "block" : "none";
      hud.dumpButton.textContent = "Вылить воду [E]";
    }
    if (hud.takePlankButton) {
      hud.takePlankButton.style.display = ps.canTakePlank ? "block" : "none";
      hud.takePlankButton.textContent = "Взять доску [F]";
    }
    if (hud.scoopWaterButton) {
      hud.scoopWaterButton.style.display = ps.canScoopWater ? "block" : "none";
      hud.scoopWaterButton.textContent = "Зачерпнуть воду [E]";
    }
    if (hud.patchBreachButton) {
      hud.patchBreachButton.style.display = ps.canPatchBreach ? "block" : "none";
      hud.patchBreachButton.textContent = "Заколотить дыру [F]";
    }
    hud.jumpButton.disabled = !ps.canJump;

    const enemyCount = fleet.list.filter((e) => !e.sinking).length;
    hud.score.textContent = `Потоплено: ${state.score}`;
    hud.treasures.textContent = `Сокровища: ${state.treasures}`;
    hud.enemies.textContent = `Врагов на воде: ${enemyCount}`;

    const floodLevel = Math.round(dc.waterLevel);
    hud.integrityBar.style.width = `${floodLevel}%`;
    hud.integrityBar.style.background =
      floodLevel < 35 ? "#4aa9d9" : floodLevel < 70 ? "#e8c25a" : "#e85a5a";
    hud.floodLabel.textContent = `Вода в трюме: ${floodLevel}% · пробоин: ${dc.activeBreaches}`;

    const mag = Math.hypot(wind.x, wind.z);
    setRelativeArrow(hud.windArrow, wind);
    hud.windText.textContent = `${mag.toFixed(1)} м/с · X ${wind.x.toFixed(1)} · Z ${wind.z.toFixed(1)}`;
    const navigation = sailing.getState();
    hud.speedText.textContent = `${navigation.speed.toFixed(1)} м/с · паруса ${Math.round(navigation.throttle * 100)}%`;
    const toIsland = island.position.clone().sub(ship.group.position);
    const islandCannons = island.activeCannons().length;
    setRelativeArrow(hud.compassArrow, toIsland);
    hud.compassText.textContent = `Крепость: ${Math.round(toIsland.length())} м · пушек: ${islandCannons}`;

    announceHudAudio({
      ps,
      dc,
      navigation,
      enemyCount,
      toIsland,
      islandCannons,
      windSpeed: mag,
      dt,
    });

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
