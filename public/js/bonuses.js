const BONUS_POOL = [
  {
    id: "ship-speed",
    title: "Быстрый ход",
    description: "Корабль быстрее разгоняется и держит большую скорость по ветру.",
  },
  {
    id: "grapeshot",
    title: "Картечь",
    description: "Открывает режим G: широкий залп мелкими ядрами на 135 градусов, по 50% корпуса.",
  },
  {
    id: "slow-flooding",
    title: "Плотный корпус",
    description: "Затопление от всех пробоин становится медленнее.",
  },
  {
    id: "bail-helper",
    title: "Матрос с ведром",
    description: "Помощник постепенно вычерпывает воду из трюма.",
  },
  {
    id: "repair-helper",
    title: "Плотник",
    description: "Помощник время от времени сам заколачивает активную пробоину.",
  },
  {
    id: "harpoon",
    title: "Гарпун сокровищ",
    description: "Сундуки издалека цепляются тросом и подтягиваются к кораблю.",
  },
  {
    id: "player-speed",
    title: "Лёгкий шаг",
    description: "Игрок быстрее ходит по палубе и в трюме.",
  },
  {
    id: "hand-cannon",
    title: "Канонир",
    description: "Даёт 3 ручных выстрела прямо из рук, когда ты не у обычной пушки.",
  },
];

function shuffle(value) {
  const arr = [...value];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class BonusSystem {
  constructor({ hud, state, systems, onMessage }) {
    this.hud = hud;
    this.state = state;
    this.systems = systems;
    this.onMessage = onMessage || (() => {});
    this.active = false;
    this.choices = [];
  }

  showChoices() {
    if (!this.hud?.bonusChoice || this.active) return;
    this.active = true;
    this.choices = shuffle(BONUS_POOL).slice(0, 3);
    this.hud.bonusCards.innerHTML = "";
    for (const bonus of this.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bonus-card";
      button.innerHTML = `<b>${bonus.title}</b><span>${bonus.description}</span>`;
      button.addEventListener("click", () => this.apply(bonus.id));
      this.hud.bonusCards.appendChild(button);
    }
    this.hud.bonusChoice.style.display = "flex";
    const options = this.choices
      .map((bonus, index) => `${index + 1}: ${bonus.title}. ${bonus.description}`)
      .join(" ");
    this.onMessage(`Выбери один трофейный бонус. ${options}`);
    document.exitPointerLock?.();
  }

  apply(id) {
    const bonus = BONUS_POOL.find((item) => item.id === id);
    if (!bonus) return;
    const bonuses = this.state.bonuses;
    bonuses[id] = (bonuses[id] || 0) + 1;
    if (id === "ship-speed") this.systems.sailing.addSpeedMultiplier(0.22);
    if (id === "grapeshot") this.systems.player.unlockGrapeshot();
    if (id === "slow-flooding") this.systems.damageControl.addFloodSlow(0.28);
    if (id === "bail-helper") this.systems.damageControl.addBailHelper();
    if (id === "repair-helper") this.systems.damageControl.addRepairHelper();
    if (id === "harpoon") bonuses.harpoon = true;
    if (id === "player-speed") this.systems.player.addWalkMultiplier(0.25);
    if (id === "hand-cannon") this.systems.player.addHandCannonCharges(3);
    this.hud.bonusChoice.style.display = "none";
    this.active = false;
    this.onMessage(`Бонус выбран: ${bonus.title}.`);
  }
}
