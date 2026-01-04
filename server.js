import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log("ECG Cloud Engine running on port", PORT);

/* ================= ECG PROCESSING ================= */

// Parameters (tuned once, never again)
const FS = 250;
const HP_ALPHA = 0.995;   // baseline removal
const LP_ALPHA = 0.1;     // smoothing
const GAIN = 0.6;

// State per device (single device demo)
let hpPrev = 0;
let lpPrev = 0;

// Simple HR detection
let lastPeakTime = null;
let hr = null;

function processECG(raw) {
  // Convert ADC to centered signal
  let x = raw - 2048;

  // High-pass (baseline removal)
  hpPrev = HP_ALPHA * hpPrev + (1 - HP_ALPHA) * x;
  let hp = x - hpPrev;

  // Low-pass (noise smoothing)
  lpPrev = LP_ALPHA * hp + (1 - LP_ALPHA) * lpPrev;
  let filtered = lpPrev * GAIN;

  // R-peak detection (simple but stable)
  const now = Date.now();
  if (filtered > 180 && (!lastPeakTime || now - lastPeakTime > 300)) {
    if (lastPeakTime) {
      const rr = now - lastPeakTime;
      hr = Math.round(60000 / rr);
    }
    lastPeakTime = now;
  }

  return { ecg: filtered, hr };
}

/* ================= WEBSOCKET ================= */

wss.on("connection", ws => {
  ws.on("message", msg => {
    const data = JSON.parse(msg.toString());
    const out = processECG(data.ecg);

    const packet = JSON.stringify({
      ecg: out.ecg,
      hr: out.hr
    });

    // Broadcast processed signal
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(packet);
      }
    });
  });
});
