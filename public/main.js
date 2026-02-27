const statusEl = document.getElementById("status");
const healthEl = document.getElementById("health");

let ws;
let healthInterval;

function connect() {
  ws = new WebSocket(`wss://${location.host}`);

  ws.addEventListener("open", () => {
    statusEl.textContent = "connected";
    statusEl.className = "connected";

    healthInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "health" }));
      }
    }, 5000);
  });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "health") {
      const t = new Date(msg.ts);
      healthEl.textContent = `health: ${t.toLocaleTimeString()}`;
    }
  });

  ws.addEventListener("close", () => {
    statusEl.textContent = "disconnected";
    statusEl.className = "disconnected";
    healthEl.textContent = "";
    clearInterval(healthInterval);
    setTimeout(connect, 2000);
  });
}

connect();
