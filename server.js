import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log("ECG cloud processor running on port", PORT);

/* ===================== CONFIG ===================== */
const fs = 250;
const BUFFER = 1250;

/* ===================== BUFFERS ===================== */
let ecgBuf = new Array(BUFFER).fill(0);
let rrBuf = [];
let hrBuf = [];
let qrsBuf = [];

let lastR = null;

/* ===================== FILTERS ===================== */
// Simple IIR high-pass + low-pass (JS-safe approximation)
function highPass(x, prevX, prevY) {
  const alpha = 0.995;
  return alpha * (prevY + x - prevX);
}

function lowPass(x, prevY) {
  const alpha = 0.1;
  return prevY + alpha * (x - prevY);
}

let hpPrevX = 0, hpPrevY = 0, lpPrevY = 0;

/* ===================== PROCESS ===================== */
function processSample(raw) {
  // --- Filtering ---
  let hp = highPass(raw, hpPrevX, hpPrevY);
  hpPrevX = raw; hpPrevY = hp;

  let lp = lowPass(hp, lpPrevY);
  lpPrevY = lp;

  ecgBuf.shift();
  ecgBuf.push(lp);

  // --- QRS detection (energy based) ---
  const energy = lp * lp;
  const threshold = 0.6 * median(ecgBuf.map(x => x * x));

  let R_detected = false;
  let index = ecgBuf.length - 1;

  if (energy > threshold && (!lastR || index - lastR > 0.45 * fs)) {
    R_detected = true;
    if (lastR) {
      const rr = (index - lastR) / fs;
      if (rr > 0.35 && rr < 1.6) rrBuf.push(rr);
      if (rrBuf.length > 20) rrBuf.shift();
    }
    lastR = index;
  }

  // --- HR ---
  let HR = 0;
  if (rrBuf.length >= 3) {
    HR = 60 / mean(rrBuf);
    hrBuf.push(HR);
    if (hrBuf.length > 10) hrBuf.shift();
  }

  // --- HRV (RMSSD) ---
  let HRV = 0;
  if (rrBuf.length >= 10) {
    let diffs = [];
    for (let i = 1; i < rrBuf.length; i++) {
      diffs.push((rrBuf[i] - rrBuf[i - 1]) ** 2);
    }
    HRV = Math.sqrt(mean(diffs)) * 1000;
  }

  // --- QRS width (approx) ---
  let QRS = R_detected ? 80 : (qrsBuf.at(-1) || 80);
  if (R_detected) {
    qrsBuf.push(QRS);
    if (qrsBuf.length > 8) qrsBuf.shift();
  }

  return {
    ecg: lp,
    HR: round(mean(hrBuf), 1),
    HRV: round(HRV, 1),
    QRS: round(mean(qrsBuf), 1),
    R: R_detected
  };
}

/* ===================== HELPERS ===================== */
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] || 0;
}

function round(x, d) {
  return Number(x.toFixed(d));
}

/* ===================== WS ===================== */
wss.on("connection", ws => {
  console.log("Client connected");

  ws.on("message", msg => {
    let v;

    try {
      const parsed = JSON.parse(msg.toString());
      v = typeof parsed === "number" ? parsed :
          parsed.ecg ?? parsed.value ?? parsed.raw;
    } catch {
      v = Number(msg.toString());
    }

    if (typeof v !== "number" || isNaN(v)) return;

    const out = processSample(v);
    ws.send(JSON.stringify(out));
  });
});
