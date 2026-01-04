import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log("ECG cloud logic engine running");

/* ===== CONFIG ===== */
const FS = 250;
const RR_MIN = 0.35;
const RR_MAX = 1.6;

/* ===== STATE ===== */
let lastRTime = null;
let rrBuf = [];
let hrBuf = [];
let ecgBuf = [];

/* ===== HELPERS ===== */
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

/* ===== PROCESS ===== */
function processECG(ecg) {
  ecgBuf.push(ecg);
  if (ecgBuf.length > FS * 5) ecgBuf.shift();

  // R-peak detection (clean signal assumed)
  const thresh = 120;
  const now = Date.now();
  let R = false;

  if (ecg > thresh && (!lastRTime || now - lastRTime > RR_MIN * 1000)) {
    R = true;
    if (lastRTime) {
      const rr = (now - lastRTime) / 1000;
      if (rr > RR_MIN && rr < RR_MAX) {
        rrBuf.push(rr);
        if (rrBuf.length > 20) rrBuf.shift();
      }
    }
    lastRTime = now;
  }

  // HR
  let HR = null;
  if (rrBuf.length >= 3) {
    HR = Math.round(60 / mean(rrBuf));
    hrBuf.push(HR);
    if (hrBuf.length > 10) hrBuf.shift();
  }

  // HRV (RMSSD)
  let HRV = null;
  if (rrBuf.length >= 10) {
    let diffs = [];
    for (let i = 1; i < rrBuf.length; i++) {
      diffs.push((rrBuf[i] - rrBuf[i - 1]) ** 2);
    }
    HRV = Math.round(Math.sqrt(mean(diffs)) * 1000);
  }

  return {
    ecg,
    hr: HR ? Math.round(mean(hrBuf)) : null,
    hrv: HRV,
    r: R
  };
}

/* ===== WS ===== */
wss.on("connection", ws => {
  ws.on("message", msg => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (typeof data.ecg !== "number") return;

    const out = processECG(data.ecg);
    ws.send(JSON.stringify(out));
  });
});
