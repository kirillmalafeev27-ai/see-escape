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
  constructor({ hud, state, systems, onMessage, onSelect }) {
    this.hud = hud;
    this.state = state;
    this.systems = systems;
    this.onMessage = onMessage || (() => {});
    this.onSelect = onSelect || null;
    this.active = false;
    this.choices = [];
    this.token = "";
  }

  showChoices(options = {}) {
    if (!this.hud?.bonusChoice || this.active) return;
    const requestedChoices = Array.isArray(options.choices)
      ? options.choices
          .map((item) => typeof item === "string" ? item : item?.id)
          .map((id) => BONUS_POOL.find((bonus) => bonus.id === id))
          .filter(Boolean)
      : [];
    this.active = true;
    this.token = String(options.token || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    this.choices = (requestedChoices.length ? requestedChoices : shuffle(BONUS_POOL)).slice(0, 3);
    this.hud.bonusCards.innerHTML = "";
    for (const bonus of this.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bonus-card";
      button.innerHTML = `<b>${bonus.title}</b><span>${bonus.description}</span>`;
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const choiceIds = this.choices.map((item) => item.id);
        if (this.onSelect?.(bonus.id, { token: this.token, choices: choiceIds, bonus }) === false) {
          this.lock("Ждём синхронизацию выбора...");
          return;
        }
        this.apply(bonus.id, { token: this.token });
      });
      this.hud.bonusCards.appendChild(button);
    }
    this.hud.bonusChoice.style.display = "flex";
    const optionsText = this.choices
      .map((bonus, index) => `${index + 1}: ${bonus.title}. ${bonus.description}`)
      .join(" ");
    this.onMessage(`Выбери один трофейный бонус. ${optionsText}`);
    this.systems.player?.enterCursorMode?.();
    return { token: this.token, choices: this.choices.map((bonus) => bonus.id) };
  }

  lock(message = "Ждём выбор команды...") {
    if (!this.active || !this.hud?.bonusChoice) return;
    this.hud.bonusCards.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    this.onMessage(message);
  }

  apply(id, _options = {}) {
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
    this.token = "";
    this.onMessage(`Бонус выбран: ${bonus.title}.`);
  }

  reset() {
    this.active = false;
    this.choices = [];
    this.token = "";
    if (this.hud?.bonusChoice) this.hud.bonusChoice.style.display = "none";
  }
}
