import * as THREE from "three";

const ANCHOR_RANGE = 270;
const GRID_SIZE = 5;
const CELL_SIZE = 8;
const QUEST_GROUND_Y = 37.45;
const SHELL_WARNING_TIME = 6.8;
const SHELL_RELOAD = 1.25;
const SHELL_RELOAD_RANDOM = 1.15;
const SHELL_IMPACT_TIME = 0.7;
const MAX_ACTIVE_SHELLS_BASE = 2;
const MAX_ACTIVE_SHELLS_PEAK = 4;
const START_CELL = { x: 2, y: 4 };
const GOAL_CELL = { x: 2, y: 0 };
const DIRS = {
  KeyW: { x: 0, y: -1 },
  ArrowUp: { x: 0, y: -1 },
  KeyS: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: 1 },
  KeyA: { x: -1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};
const DIR_BUTTONS = [
  ["↑ Вперёд", { x: 0, y: -1 }],
  ["← Влево", { x: -1, y: 0 }],
  ["→ Вправо", { x: 1, y: 0 }],
  ["↓ Назад", { x: 0, y: 1 }],
];

const QUESTIONS = [
  { text: "Сколько будет 7 + 8?", answers: ["15", "14", "16"], correct: "15" },
  { text: "Какой ветер быстрее ведёт корабль?", answers: ["Попутный", "Встречный", "Штиль"], correct: "Попутный" },
  { text: "Сколько клеток в поле 5 на 5?", answers: ["25", "20", "10"], correct: "25" },
  { text: "Что чинит пробоину?", answers: ["Доска", "Парус", "Якорь"], correct: "Доска" },
  { text: "Куда выливают полное ведро?", answers: ["За борт", "В трюм", "В пушку"], correct: "За борт" },
  { text: "Что показывает компас крепости?", answers: ["Направление к острову", "Запас досок", "Перезарядку"], correct: "Направление к острову" },
];

function mat(color, roughness = 0.85, metalness = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

function sameCell(a, b) {
  return a.x === b.x && a.y === b.y;
}

function clampCell(cell) {
  return {
    x: THREE.MathUtils.clamp(cell.x, 0, GRID_SIZE - 1),
    y: THREE.MathUtils.clamp(cell.y, 0, GRID_SIZE - 1),
  };
}

function lookYaw(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) + Math.abs(dz) < 1e-4) return 0;
  return Math.atan2(-dx, -dz);
}

function lerpAngle(a, b, t) {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function buildRaider(parent, position, scale = 1) {
  const group = new THREE.Group();
  group.name = "QuestRaiderShip";
  group.position.copy(position);
  group.scale.setScalar(scale);
  parent.add(group);

  const hull = mat(0x261a13, 0.9);
  const wood = mat(0x6f3d1f, 0.88);
  const sail = mat(0x101317, 0.72);
  const metal = mat(0x202a2f, 0.48, 0.55);

  const body = new THREE.Mesh(new THREE.BoxGeometry(12, 3, 22), hull);
  body.position.y = 1.5;
  group.add(body);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(10, 0.5, 18), wood);
  deck.position.y = 3.2;
  group.add(deck);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 19, 8), wood);
  mast.position.y = 12;
  group.add(mast);
  const sailMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 10, 12), sail);
  sailMesh.position.set(0, 14, -1.5);
  sailMesh.rotation.z = 0.04;
  group.add(sailMesh);
  const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 5.5, 10), metal);
  cannon.rotation.x = Math.PI / 2;
  cannon.position.set(0, 4.2, 9.5);
  group.add(cannon);
  const muzzle = new THREE.Vector3(0, 4.2, 13.0);
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc05a, transparent: true, opacity: 0.85 })
  );
  flash.position.copy(muzzle);
  flash.visible = false;
  group.add(flash);

  return { group, muzzle, flash, flashTimer: 0, baseY: position.y };
}

export class IslandQuestSystem {
  constructor({ scene, island, ship, sailing, hud, onMessage, onComplete }) {
    this.scene = scene;
    this.island = island;
    this.ship = ship;
    this.sailing = sailing;
    this.hud = hud;
    this.onMessage = onMessage || (() => {});
    this.onComplete = onComplete || (() => {});
    this.player = null;
    this.active = false;
    this.completed = false;
    this.playerCell = { ...START_CELL };
    this.pendingMove = { x: 0, y: -1 };
    this.directionReady = false;
    this.currentQuestion = null;
    this.renderedQuestion = null;
    this.renderedDirectionKey = "";
    this.shell = null;
    this.shells = [];
    this.shellTimer = SHELL_RELOAD;
    this.returnPose = null;
    this.currentPose = null;
    this.moveAnim = null;
    this.blocked = new Set();
    this.tiles = new Map();
    this.raiders = [];
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._buildScene();
    this._bindInput();
  }

  setPlayer(player) {
    this.player = player;
  }

  _buildScene() {
    const root = new THREE.Group();
    root.name = "IslandQuest3DShrine";
    root.position.copy(this.island.position).add(new THREE.Vector3(0, QUEST_GROUND_Y, -118));
    this.scene.add(root);
    this.root = root;

    const grass = mat(0x3f8b3f, 0.96);
    const tileMat = mat(0x4b9a4b, 0.92);
    const tileGoalMat = mat(0x6fae47, 0.9);
    const gold = mat(0xd6af42, 0.42, 0.55);
    const stone = mat(0x77756b, 0.95);
    const dark = mat(0x201710, 0.96);

    const ground = new THREE.Mesh(new THREE.BoxGeometry(62, 0.28, 80), grass);
    ground.name = "QuestGreenGroundPatch";
    ground.position.set(0, -0.2, 12);
    root.add(ground);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(10, 12, 5, 10), stone);
    base.position.set(0, 2.5, -20);
    root.add(base);
    const body = new THREE.Mesh(new THREE.BoxGeometry(9, 18, 7), stone);
    body.position.set(0, 14, -20);
    root.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 8), stone);
    head.position.set(0, 26, -20);
    root.add(head);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(5, 7, 7), gold);
    crown.position.set(0, 32, -20);
    root.add(crown);
    const treasure = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 6), gold);
    treasure.name = "QuestShrineTreasure";
    treasure.position.set(0, 4, -5);
    root.add(treasure);

    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x050505,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const explosionMat = new THREE.MeshBasicMaterial({
      color: 0xffb13b,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    });

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const tile = new THREE.Group();
        tile.position.copy(this._cellLocal({ x, y }));
        tile.position.y = 0.05;

        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(CELL_SIZE - 0.42, 0.16, CELL_SIZE - 0.42),
          x === GOAL_CELL.x && y === GOAL_CELL.y ? tileGoalMat.clone() : tileMat.clone()
        );
        floor.name = `QuestGroundCell_${x}_${y}`;
        tile.add(floor);

        const border = new THREE.Mesh(
          new THREE.RingGeometry((CELL_SIZE - 0.85) * 0.48, (CELL_SIZE - 0.35) * 0.5, 4),
          new THREE.MeshBasicMaterial({ color: 0xe7cf62, transparent: true, opacity: 0.72, side: THREE.DoubleSide })
        );
        border.rotation.x = -Math.PI / 2;
        border.rotation.z = Math.PI / 4;
        border.position.y = 0.13;
        tile.add(border);

        const block = new THREE.Group();
        block.visible = false;
        const burn = new THREE.Mesh(new THREE.BoxGeometry(CELL_SIZE - 0.9, 0.22, CELL_SIZE - 0.9), dark);
        burn.position.y = 0.22;
        block.add(burn);
        for (const rot of [Math.PI / 4, -Math.PI / 4]) {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(CELL_SIZE - 1.2, 0.35, 1.0), dark);
          beam.position.y = 0.55;
          beam.rotation.y = rot;
          block.add(beam);
        }
        tile.add(block);

        const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32), shadowMat.clone());
        shadow.name = `QuestShellShadow_${x}_${y}`;
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.72;
        shadow.visible = false;
        tile.add(shadow);

        const explosion = new THREE.Mesh(new THREE.CircleGeometry(3.5, 32), explosionMat.clone());
        explosion.name = `QuestShellExplosion_${x}_${y}`;
        explosion.rotation.x = -Math.PI / 2;
        explosion.position.y = 0.84;
        explosion.visible = false;
        tile.add(explosion);

        root.add(tile);
        this.tiles.set(cellKey({ x, y }), { tile, floor, border, block, shadow, explosion });
      }
    }

    this.marker = new THREE.Mesh(new THREE.RingGeometry(2.55, 3.2, 28), markerMat);
    this.marker.name = "QuestPlayerGroundMarker";
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.95;
    root.add(this.marker);

    this.shellBalls = [];
    for (let i = 0; i < MAX_ACTIVE_SHELLS_PEAK; i++) {
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0x101317, roughness: 0.35, metalness: 0.55 })
      );
      ball.name = `QuestIncomingCannonball_${i + 1}`;
      ball.visible = false;
      root.add(ball);
      this.shellBalls.push(ball);
    }

    const raiderPositions = [
      new THREE.Vector3(-46, -31, -74),
      new THREE.Vector3(0, -32, -82),
      new THREE.Vector3(46, -31, -74),
    ];
    this.raiders = raiderPositions.map((position, index) => {
      const raider = buildRaider(root, position, index === 1 ? 1.05 : 0.92);
      raider.group.rotation.y = Math.PI;
      raider.group.visible = false;
      return raider;
    });

    this._syncMarker();
  }

  _bindInput() {
    addEventListener("keydown", (e) => {
      if (!this.active) return;
      if (!DIRS[e.code]) return;
      this._chooseDirection(DIRS[e.code]);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  _distanceToIsland() {
    return this.ship.group.position.distanceTo(this.island.position);
  }

  _cellLocal(cell) {
    return new THREE.Vector3((cell.x - 2) * CELL_SIZE, 0, cell.y * CELL_SIZE + 12);
  }

  _cellWorld(cell, height = 0.58) {
    const world = this._cellLocal(cell);
    world.y = height;
    this.root.updateMatrixWorld(true);
    return this.root.localToWorld(world);
  }

  _yawTowardCell(fromCell, toCell) {
    return lookYaw(this._cellWorld(fromCell), this._cellWorld(toCell));
  }

  _targetForDirection(dir) {
    if (!dir) return null;
    return clampCell({
      x: this.playerCell.x + dir.x,
      y: this.playerCell.y + dir.y,
    });
  }

  _directionKey(dir = this.pendingMove) {
    return dir ? `${dir.x},${dir.y}` : "";
  }

  _moveName(dir = this.pendingMove) {
    if (!dir) return "";
    if (dir.x > 0) return "вправо";
    if (dir.x < 0) return "влево";
    if (dir.y > 0) return "назад";
    return "вперёд";
  }

  _syncMarker() {
    if (!this.marker) return;
    this.marker.position.copy(this._cellLocal(this.playerCell));
    this.marker.position.y = 0.95;
  }

  _setRaidersVisible(value) {
    for (const raider of this.raiders) {
      raider.group.visible = value;
      raider.flash.visible = false;
      raider.flashTimer = 0;
    }
  }

  _applyPose(position, yaw = 0, pitch = -0.08, eyeHeight = 4.2) {
    if (!this.player) return;
    this.currentPose = {
      position: position.clone(),
      yaw,
      pitch,
      eyeHeight,
    };
    this.player.setWorldPose(position, yaw, pitch, eyeHeight);
  }

  _applyCurrentPose() {
    if (!this.currentPose || !this.player) return;
    this.player.setWorldPosition(this.currentPose.position, this.currentPose.eyeHeight);
    const livePose = this.player.captureWorldPose();
    this.currentPose.yaw = livePose.yaw;
    this.currentPose.pitch = livePose.pitch;
  }

  _startMove(toCell, duration = 0.78, options = {}) {
    const fromPosition = this.currentPose?.position?.clone() || this._cellWorld(this.playerCell);
    const toPosition = this._cellWorld(toCell);
    const fromYaw = this.currentPose?.yaw ?? 0;
    const toYaw = options.toYaw ?? lookYaw(fromPosition, toPosition);
    this.moveAnim = {
      fromPosition,
      toPosition,
      fromYaw,
      toYaw,
      fromPitch: this.currentPose?.pitch ?? -0.08,
      toPitch: options.toPitch ?? -0.06,
      fromEye: this.currentPose?.eyeHeight ?? 4.2,
      toEye: 4.2,
      time: 0,
      duration,
      targetCell: { ...toCell },
      arc: options.arc ?? (duration > 1 ? 14 : 0.85),
    };
  }

  _updateMove(dt) {
    if (!this.moveAnim) {
      this._applyCurrentPose();
      return;
    }
    const anim = this.moveAnim;
    anim.time += dt;
    const raw = Math.min(1, anim.time / anim.duration);
    const t = smoothstep(raw);
    const position = anim.fromPosition.clone().lerp(anim.toPosition, t);
    position.y += Math.sin(Math.PI * t) * anim.arc;
    const yaw = lerpAngle(anim.fromYaw, anim.toYaw, t);
    const pitch = THREE.MathUtils.lerp(anim.fromPitch, anim.toPitch, t) + Math.sin(Math.PI * t) * 0.035;
    const eye = THREE.MathUtils.lerp(anim.fromEye, anim.toEye, t) + Math.sin(Math.PI * t) * 0.16;
    this._applyPose(position, yaw, pitch, eye);
    if (raw >= 1) {
      this.playerCell = { ...anim.targetCell };
      this._syncMarker();
      this._applyPose(anim.toPosition, anim.toYaw, anim.toPitch, anim.toEye);
      this.moveAnim = null;
      if (sameCell(this.playerCell, GOAL_CELL)) this._complete();
      else {
        this.pendingMove = { x: 0, y: -1 };
        this.directionReady = false;
        this.currentQuestion = null;
        this.renderedQuestion = null;
        this._renderHud(true);
      }
    }
  }

  _isBlocked(cell, extraKey = null) {
    const key = cellKey(cell);
    return this.blocked.has(key) || (extraKey instanceof Set ? extraKey.has(key) : key === extraKey);
  }

  _hasPathWith(extraKey = null) {
    const extraKeys = extraKey instanceof Set ? extraKey : new Set(extraKey ? [extraKey] : []);
    const start = this._isBlocked(this.playerCell, extraKeys) ? START_CELL : this.playerCell;
    const queue = [{ ...start }];
    const seen = new Set([cellKey(start)]);
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    while (queue.length) {
      const cell = queue.shift();
      if (sameCell(cell, GOAL_CELL)) return true;
      for (const dir of dirs) {
        const next = { x: cell.x + dir.x, y: cell.y + dir.y };
        if (next.x < 0 || next.x >= GRID_SIZE || next.y < 0 || next.y >= GRID_SIZE) continue;
        const key = cellKey(next);
        if (seen.has(key) || this._isBlocked(next, extraKeys)) continue;
        seen.add(key);
        queue.push(next);
      }
    }
    return false;
  }

  _blockCell(cell) {
    if (sameCell(cell, START_CELL) || sameCell(cell, GOAL_CELL)) return;
    const key = cellKey(cell);
    this.blocked.add(key);
    const entry = this.tiles.get(key);
    if (!entry) return;
    entry.block.visible = true;
    entry.floor.material.color.setHex(0x2f3225);
    entry.border.material.color.setHex(0xff6b4a);
    entry.border.material.opacity = 0.9;
  }

  _resetBlockedCells() {
    this.blocked.clear();
    for (const [key, entry] of this.tiles) {
      const [x, y] = key.split(",").map(Number);
      entry.block.visible = false;
      entry.floor.material.color.setHex(x === GOAL_CELL.x && y === GOAL_CELL.y ? 0x6fae47 : 0x4b9a4b);
      entry.border.material.color.setHex(0xe7cf62);
      entry.border.material.opacity = 0.72;
    }
  }

  getPrompt() {
    if (this.completed) return "";
    if (this.active) return this.moveAnim ? "Остров: идём к клетке..." : "Остров: осмотрись мышью, выбери направление, потом ответь на вопрос.";
    return this._distanceToIsland() <= ANCHOR_RANGE ? "E - бросить якорь и высадиться на остров" : "";
  }

  interact() {
    if (this.active || this.completed || this._distanceToIsland() > ANCHOR_RANGE || !this.player) return false;
    return this._begin();
  }

  forceStart() {
    if (this.active || !this.player) return false;
    this.completed = false;
    return this._begin();
  }

  _begin() {
    this.active = true;
    this.sailing.setAnchored(true);
    this.returnPose = this.player.captureWorldPose();
    this.player.setQuestMode(true);
    this.playerCell = { ...START_CELL };
    this.pendingMove = { x: 0, y: -1 };
    this.directionReady = false;
    this.currentQuestion = null;
    this.renderedQuestion = null;
    this.shell = null;
    this.shells = [];
    this.shellTimer = 1.15;
    this._resetBlockedCells();
    this._hideShellVisuals();
    this._setRaidersVisible(true);
    this._syncMarker();
    this.currentPose = {
      position: this.returnPose.position.clone(),
      yaw: this.returnPose.yaw,
      pitch: this.returnPose.pitch,
      eyeHeight: 4.2,
    };
    this.moveAnim = null;
    this._startMove(START_CELL, 1.12, {
      toYaw: this._yawTowardCell(START_CELL, GOAL_CELL),
      toPitch: -0.16,
      arc: 8,
    });
    this.hud.questPanel.style.display = "block";
    this._renderHud(true);
    this.onMessage("Высадка на остров: перед тобой святилище, поле и сокровище.");
    document.exitPointerLock?.();
    return true;
  }

  _askQuestion() {
    this.currentQuestion = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    this.renderedQuestion = null;
    this._renderHud(true);
  }

  _chooseDirection(dir) {
    if (!this.active || this.moveAnim) return;
    const target = this._targetForDirection(dir);
    if (!target || sameCell(target, this.playerCell)) {
      this.pendingMove = { x: 0, y: -1 };
      this.directionReady = false;
      this.currentQuestion = null;
      this.renderedQuestion = null;
      this.onMessage("Край поля. Выбери другое направление.");
      this._renderHud(true);
      return;
    }
    if (this._isBlocked(target)) {
      this.pendingMove = { x: 0, y: -1 };
      this.directionReady = false;
      this.currentQuestion = null;
      this.renderedQuestion = null;
      this.onMessage("Эта клетка разбита ядром. Выбери другой путь.");
      this._renderHud(true);
      return;
    }
    this.pendingMove = { ...dir };
    this.directionReady = true;
    this._askQuestion();
  }

  answer(value) {
    if (!this.active || !this.directionReady || !this.currentQuestion || this.moveAnim) return;
    if (value !== this.currentQuestion.correct) {
      this.onMessage("Неверно: статуя не даёт сделать ход.");
      this._askQuestion();
      return;
    }

    const target = this._targetForDirection(this.pendingMove);
    if (sameCell(target, this.playerCell)) {
      this.onMessage("Край поля. Выбери другое направление.");
      this._askQuestion();
      return;
    }
    if (this._isBlocked(target)) {
      this.onMessage("Эта клетка разбита ядром и закрыта. Выбери другой ход.");
      this._askQuestion();
      return;
    }
    this._startMove(target);
  }

  _complete() {
    this.completed = true;
    this.active = false;
    this.hud.questPanel.style.display = "none";
    this.shell = null;
    this.shells = [];
    this._hideShellVisuals();
    this._setRaidersVisible(false);
    this.onComplete();
    this.onMessage("Сокровище статуи получено. Победа!");
  }

  _activeShellLimit() {
    return this.playerCell.y <= 2 ? MAX_ACTIVE_SHELLS_PEAK : MAX_ACTIVE_SHELLS_BASE;
  }

  _reservedShellKeys() {
    return new Set(this.shells.map((shell) => cellKey(shell.cell)));
  }

  _chooseShellCell(reservedKeys = new Set()) {
    const candidates = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const cell = { x, y };
        const key = cellKey(cell);
        if (this.blocked.has(key) || reservedKeys.has(key) || sameCell(cell, START_CELL) || sameCell(cell, GOAL_CELL)) continue;
        const projected = new Set(reservedKeys);
        projected.add(key);
        if (!this._hasPathWith(projected)) continue;
        candidates.push(cell);
      }
    }
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  _startShell() {
    if (this.shells.length >= this._activeShellLimit()) return false;
    const cell = this._chooseShellCell(this._reservedShellKeys());
    if (!cell) {
      this.shellTimer = SHELL_RELOAD + 2;
      return false;
    }
    const raider = this.raiders[Math.floor(Math.random() * this.raiders.length)];
    raider.flash.visible = true;
    raider.flashTimer = 0.28;
    raider.group.updateMatrixWorld(true);
    this.root.updateMatrixWorld(true);
    const start = this.root.worldToLocal(raider.group.localToWorld(raider.muzzle.clone()));
    const target = this._cellLocal(cell);
    target.y = 1.1;
    const shell = {
      cell,
      timer: SHELL_WARNING_TIME + Math.random() * 0.75,
      exploding: 0,
      impacted: false,
      start,
      target,
    };
    this.shells.push(shell);
    this.shell = this.shells[0] || null;
    this.onMessage(this.shells.length > 1 ? "Враги ведут плотный обстрел поля." : "Вражеский корабль дал медленный залп по полю.");
    return true;
  }

  _hideShellVisuals() {
    for (const entry of this.tiles.values()) {
      entry.shadow.visible = false;
      entry.explosion.visible = false;
    }
    for (const ball of this.shellBalls || []) ball.visible = false;
  }

  _updateRaiders(dt) {
    const time = performance.now() * 0.001;
    for (let i = 0; i < this.raiders.length; i++) {
      const raider = this.raiders[i];
      if (!raider.group.visible) continue;
      raider.group.position.y = raider.baseY + Math.sin(time * 1.3 + i) * 0.35;
      raider.group.rotation.z = Math.sin(time * 0.9 + i * 0.8) * 0.025;
      if (raider.flashTimer > 0) {
        raider.flashTimer -= dt;
        raider.flash.visible = raider.flashTimer > 0;
        raider.flash.scale.setScalar(1 + (0.28 - Math.max(0, raider.flashTimer)) * 3.8);
      } else {
        raider.flash.visible = false;
      }
    }
  }

  _updateShellVisuals() {
    this._hideShellVisuals();
    for (let i = 0; i < this.shells.length; i++) {
      const shell = this.shells[i];
      const entry = this.tiles.get(cellKey(shell.cell));
      if (!entry) continue;

      if (shell.exploding > 0) {
        entry.explosion.visible = true;
        const k = 1 + (SHELL_IMPACT_TIME - shell.exploding) * 1.8;
        entry.explosion.scale.setScalar(k);
        entry.explosion.material.opacity = THREE.MathUtils.clamp(shell.exploding / SHELL_IMPACT_TIME, 0, 1);
        continue;
      }

      const progress = 1 - Math.max(0, shell.timer) / SHELL_WARNING_TIME;
      entry.shadow.visible = true;
      entry.shadow.scale.setScalar(0.45 + progress * 1.75);
      entry.shadow.material.opacity = 0.22 + progress * 0.48;

      const ball = this.shellBalls?.[i];
      if (!ball) continue;
      ball.visible = true;
      ball.position.copy(shell.start).lerp(shell.target, smoothstep(progress));
      ball.position.y += Math.sin(Math.PI * progress) * 26;
    }
  }

  update(dt) {
    if (!this.active) return;
    this._updateRaiders(dt);
    this._updateMove(dt);

    this.shellTimer -= dt;
    const maxActiveShells = this._activeShellLimit();
    while (this.shellTimer <= 0 && this.shells.length < maxActiveShells) {
      const fired = this._startShell();
      this.shellTimer += SHELL_RELOAD + Math.random() * SHELL_RELOAD_RANDOM;
      if (!fired) break;
    }

    let playerHitThisFrame = false;
    for (const shell of this.shells) {
      if (!shell.impacted) {
        shell.timer -= dt;
      }

      if (!shell.impacted && shell.timer <= 0) {
        shell.impacted = true;
        shell.exploding = SHELL_IMPACT_TIME;
        this._blockCell(shell.cell);
        const hitsPlayer =
          sameCell(shell.cell, this.playerCell) ||
          Boolean(this.moveAnim && sameCell(shell.cell, this.moveAnim.targetCell));
        if (hitsPlayer && !playerHitThisFrame) {
          playerHitThisFrame = true;
          this.moveAnim = null;
          this.playerCell = { ...START_CELL };
          this._syncMarker();
          this._startMove(START_CELL, 0.55);
          this.onMessage("Ядро накрыло твою клетку. Возврат на старт.");
        } else {
          this.onMessage("Ядро разбило клетку. Теперь через неё нельзя идти.");
        }
      }

      if (shell.impacted && shell.exploding > 0) {
        shell.exploding -= dt;
      }
    }
    this.shells = this.shells.filter((shell) => !shell.impacted || shell.exploding > 0);
    this.shell = this.shells[0] || null;

    this._updateShellVisuals();
    this._renderHud(false);
  }

  _renderHud(forceAnswers = false) {
    if (!this.hud?.questPanel || !this.active) return;
    this._renderDirectionControls();
    this.hud.questGrid.style.display = this.moveAnim ? "none" : "grid";
    this.hud.questQuestion.textContent = this.currentQuestion?.text || "Сначала выбери направление хода.";
    const moveName = this._moveName();
    this.hud.questStatus.textContent = this.moveAnim
      ? "Идём к клетке..."
      : this.directionReady
        ? `Ход: ${moveName}. Ответь на вопрос, чтобы сделать шаг. Разбитые клетки закрыты.`
        : "Выбери направление кнопкой, WASD или стрелками. Цель - верхняя центральная клетка у сокровища.";

    if (!forceAnswers && this.renderedQuestion === this.currentQuestion) return;
    this.renderedQuestion = this.currentQuestion;
    this.hud.questAnswers.innerHTML = "";
    for (const answer of this.currentQuestion?.answers || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = answer;
      let pointerSubmitted = false;
      const submit = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.answer(answer);
      };
      button.addEventListener("pointerdown", (event) => {
        pointerSubmitted = true;
        submit(event);
      });
      button.addEventListener("click", (event) => {
        if (pointerSubmitted) {
          pointerSubmitted = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        submit(event);
      });
      this.hud.questAnswers.appendChild(button);
    }
  }

  _renderDirectionControls() {
    if (!this.hud?.questGrid) return;
    const selectedKey = this.directionReady ? this._directionKey() : "";
    if (this.renderedDirectionKey === selectedKey && this.hud.questGrid.dataset.mode === "directions") return;
    this.renderedDirectionKey = selectedKey;
    this.hud.questGrid.dataset.mode = "directions";
    this.hud.questGrid.className = "direction-picker";
    this.hud.questGrid.innerHTML = "";
    for (const [label, dir] of DIR_BUTTONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `quest-dir-button${this._directionKey(dir) === selectedKey ? " selected" : ""}`;
      button.textContent = label;
      let pointerSubmitted = false;
      const choose = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._chooseDirection(dir);
      };
      button.addEventListener("pointerdown", (event) => {
        pointerSubmitted = true;
        choose(event);
      });
      button.addEventListener("click", (event) => {
        if (pointerSubmitted) {
          pointerSubmitted = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        choose(event);
      });
      this.hud.questGrid.appendChild(button);
    }
  }
}
