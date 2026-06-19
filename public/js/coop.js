(function () {
  const SYNC_INTERVAL_MS = 33;
  const HTTP_STATE_INTERVAL_MS = 500;
  const WS_BUFFER_LIMIT = 256 * 1024;

  function $(id) {
    return document.getElementById(id);
  }

  function cleanRoom(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }

  function wsUrl(path) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}${path}`;
  }

  const SeaCoop = {
    enabled: false,
    room: "",
    playerId: "",
    seat: 1,
    color: "#3aa0ff",
    transport: "",
    players: new Map(),
    configs: new Map(),
    eventHandlers: new Set(),
    seenEventIds: new Set(),
    socket: null,
    socketOpened: false,
    reconnectTimer: 0,
    eventSource: null,
    statusEl: null,
    badgeEl: null,
    lastSendAt: 0,
    lastHttpStateAt: 0,
    sending: false,

    get isHost() {
      return this.seat === 1;
    },

    get realtimeReady() {
      return typeof WebSocket !== "undefined" && this.socket?.readyState === WebSocket.OPEN;
    },

    async join(roomCodeValue = "", options = {}) {
      const room = cleanRoom(roomCodeValue);
      const response = await fetch("/api/coop/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, create: Boolean(options.create) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      this.enabled = true;
      this.room = data.room;
      this.playerId = data.playerId;
      this.seat = data.seat;
      this.color = data.color || this.color;
      this.applyRoomState(data.state);
      this.openRealtime();
      this.updateUi(`Комната ${this.room}. Ты игрок ${this.seat}. Канал синхронизации запускается...`, "on");
      const deckReady = Boolean(this.configForKey("quiz-deck")?.questions?.length);
      const startHint = this.isHost
        ? "Ты капитан. Нажми старт, чтобы подготовить общие задания."
        : deckReady
          ? "Общие задания получены. Нажми старт, чтобы зайти вторым игроком."
          : "Подключено. Нажми старт: если колода уже готова, она подтянется с сервера.";
      this.updateUi(`Комната ${this.room}. Ты игрок ${this.seat}. ${startHint}`, "on");
      this.updateBadge();
      this.publishQuizSettings();
      try {
        const url = new URL(location.href);
        url.searchParams.set("room", this.room);
        history.replaceState(null, "", url);
      } catch (_) {}
      return data;
    },

    async refreshRoomState() {
      if (!this.enabled || !this.room) return null;
      const response = await fetch(`/api/coop/room?room=${encodeURIComponent(this.room)}`, {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) return null;
      this.applyRoomState(data.state);
      return data.state || null;
    },

    openRealtime() {
      if ("WebSocket" in window) {
        this.openSocket();
      } else {
        this.openEvents();
      }
    },

    openSocket() {
      clearTimeout(this.reconnectTimer);
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
      }
      this.socketOpened = false;
      const socket = new WebSocket(wsUrl(`/api/coop/ws?room=${encodeURIComponent(this.room)}&player=${encodeURIComponent(this.playerId)}`));
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.socketOpened = true;
        this.transport = "ws";
        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }
        this.updateUi(`Комната ${this.room}. Быстрая синхронизация включена.`, "on");
        this.publishQuizSettings();
      });
      socket.addEventListener("message", (event) => this.handleRealtimeMessage(event.data));
      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!this.enabled) return;
        if (!this.socketOpened) {
          this.openEvents();
          return;
        }
        this.updateUi(`Комната ${this.room}: переподключаю быстрый канал...`, "warn");
        this.reconnectTimer = setTimeout(() => this.openSocket(), 650);
      });
      socket.addEventListener("error", () => {});
    },

    openEvents() {
      if (this.eventSource) this.eventSource.close();
      this.transport = "sse";
      this.eventSource = new EventSource(`/api/coop/events?room=${encodeURIComponent(this.room)}&player=${encodeURIComponent(this.playerId)}`);
      this.eventSource.addEventListener("room", (event) => this.applyRoomState(JSON.parse(event.data || "{}")));
      this.eventSource.addEventListener("state", (event) => this.applyRoomState(JSON.parse(event.data || "{}")));
      this.eventSource.addEventListener("config", (event) => {
        const payload = JSON.parse(event.data || "{}");
        if (payload.key && payload.config) this.applyConfig(payload.key, payload.config);
      });
      this.eventSource.addEventListener("event", (event) => {
        const payload = JSON.parse(event.data || "{}");
        this.handleRealtimeMessage(JSON.stringify({ type: "event", ...payload }));
      });
      this.eventSource.onerror = () => {
        if (this.enabled) this.updateUi(`Комната ${this.room}: резервный канал переподключается...`, "warn");
      };
    },

    handleRealtimeMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw || "{}");
      } catch (_) {
        return;
      }
      if (message.type === "room" || message.type === "state") {
        this.applyRoomState(message.state || message.data || {});
      } else if (message.type === "config") {
        this.applyConfig(message.key || message.floor, message.config);
      } else if (message.type === "event") {
        const eventId = String(message.id || "");
        if (eventId) {
          if (this.seenEventIds.has(eventId)) return;
          this.seenEventIds.add(eventId);
          if (this.seenEventIds.size > 240) this.seenEventIds.delete(this.seenEventIds.values().next().value);
        }
        for (const handler of [...this.eventHandlers]) {
          try { handler(message); } catch (_) {}
        }
      }
    },

    applyRoomState(roomState = {}) {
      if (roomState.room) this.room = roomState.room;
      if (roomState.configs) {
        Object.entries(roomState.configs).forEach(([key, config]) => this.applyConfig(key, config));
      }
      const nextPlayers = new Map();
      for (const playerInfo of roomState.players || []) {
        if (!playerInfo || playerInfo.id === this.playerId) continue;
        nextPlayers.set(playerInfo.id, playerInfo);
      }
      this.players = nextPlayers;
      this.updateBadge();
    },

    applyConfig(key, config) {
      const cleanKey = String(key || "");
      if (!cleanKey || !config) return;
      this.configs.set(cleanKey, config);
      if (cleanKey === "quiz-settings" && !this.isHost) {
        window.applySeaQuizSettings?.(config);
      } else if (cleanKey === "quiz-deck") {
        window.applySeaQuizDeck?.(config);
      }
    },

    configForKey(key) {
      return this.enabled ? this.configs.get(String(key || "")) : null;
    },

    sendRealtime(message) {
      if (!this.realtimeReady || this.socket.bufferedAmount > WS_BUFFER_LIMIT) return false;
      try {
        this.socket.send(JSON.stringify(message));
        return true;
      } catch (_) {
        return false;
      }
    },

    publishConfig(key, config, options = {}) {
      if (!this.enabled || !this.room || !this.playerId || !config) return;
      const cleanKey = String(key || "").trim();
      if (!cleanKey) return;
      this.configs.set(cleanKey, config);
      this.sendRealtime({ type: "config", key: cleanKey, config, replace: Boolean(options.replace) });
      fetch("/api/coop/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: this.room,
          playerId: this.playerId,
          key: cleanKey,
          config,
          replace: Boolean(options.replace),
        }),
      })
        .then((response) => response.ok ? response.json() : null)
        .then((data) => {
          if (data?.config) this.applyConfig(cleanKey, data.config);
        })
        .catch(() => {});
    },

    publishQuizSettings() {
      if (!this.isHost) return;
      const settings = window.getSeaQuizSettings?.();
      if (settings) this.publishConfig("quiz-settings", settings, { replace: true });
    },

    publishState(state) {
      if (!this.enabled || !this.room || !this.playerId) return;
      const now = performance.now();
      if (now - this.lastSendAt < SYNC_INTERVAL_MS) return;
      this.lastSendAt = now;
      const sentRealtime = this.sendRealtime({ type: "state", state });
      if (sentRealtime && now - this.lastHttpStateAt < HTTP_STATE_INTERVAL_MS) return;
      if (this.sending) return;
      this.lastHttpStateAt = now;
      this.sending = true;
      fetch("/api/coop/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: this.room, playerId: this.playerId, state }),
      })
        .catch(() => {})
        .finally(() => {
          this.sending = false;
        });
    },

    publishEvent(name, payload = {}) {
      if (!this.enabled || !name) return false;
      const id =
        (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.sendRealtime({ type: "event", id, name, payload });
      fetch("/api/coop/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: this.room, playerId: this.playerId, id, name, payload }),
      }).catch(() => {});
      return true;
    },

    onEvent(handler) {
      if (typeof handler !== "function") return () => {};
      this.eventHandlers.add(handler);
      return () => this.eventHandlers.delete(handler);
    },

    peers() {
      return [...this.players.values()].filter((player) => player?.state);
    },

    hostPeer() {
      return [...this.players.values()].find((player) => player?.seat === 1 && player?.state) || null;
    },

    hasPeers() {
      return this.peers().length > 0;
    },

    peerSummary() {
      const peers = this.peers();
      const inHold = peers.filter((player) => player.state?.insideHold).length;
      return { peers: peers.length, inHold };
    },

    updateUi(text, variant = "") {
      if (!this.statusEl) return;
      this.statusEl.textContent = text;
      this.statusEl.className = `coop-status ${variant}`.trim();
    },

    updateBadge() {
      if (!this.badgeEl) return;
      if (!this.enabled) {
        this.badgeEl.classList.remove("on");
        return;
      }
      const { peers, inHold } = this.peerSummary();
      const holdText = inHold ? `, в трюме ${inHold}` : "";
      const mode = this.transport === "ws" ? "sync" : "fallback";
      this.badgeEl.textContent = `Кооп ${this.room}: ты P${this.seat}, рядом ${peers}${holdText} · ${mode}`;
      this.badgeEl.classList.add("on");
    },
  };

  function initCoopUi() {
    const panel = document.querySelector("#boot .boot-box");
    const startButton = $("start");
    if (!panel || !startButton || $("coop-panel")) return;

    const initialRoom = cleanRoom(new URLSearchParams(location.search).get("room"));
    const el = document.createElement("div");
    el.id = "coop-panel";
    el.className = "coop-panel";
    el.innerHTML = `
      <div class="coop-title">Сетевая игра</div>
      <div class="coop-row">
        <input id="coop-room" maxlength="8" autocomplete="off" placeholder="Код комнаты" value="${initialRoom}">
        <button type="button" id="coop-create">Создать</button>
        <button type="button" id="coop-join">Войти</button>
      </div>
      <div id="coop-status" class="coop-status">Можно играть одному или подключить второго игрока по коду комнаты.</div>
    `;
    panel.insertBefore(el, startButton);

    const badge = document.createElement("div");
    badge.id = "coop-badge";
    badge.className = "coop-badge";
    document.body.appendChild(badge);

    SeaCoop.statusEl = $("coop-status");
    SeaCoop.badgeEl = badge;

    const input = $("coop-room");
    const connect = async (room, options = {}) => {
      try {
        SeaCoop.updateUi("Подключаю комнату...", "warn");
        await SeaCoop.join(room, options);
      } catch (error) {
        SeaCoop.updateUi(`Не удалось подключиться: ${error.message || error}`, "warn");
      }
    };

    $("coop-create")?.addEventListener("click", () => connect("", { create: true }));
    $("coop-join")?.addEventListener("click", () => connect(input?.value || "", { create: false }));
    if (initialRoom) connect(initialRoom, { create: false });
  }

  window.SeaCoop = SeaCoop;
  document.addEventListener("DOMContentLoaded", initCoopUi);
})();
