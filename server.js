import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log("Clinical ECG Cloud Engine running on port", PORT);

/* =========================================================
   CONFIG (mirrors MATLAB)
========================================================= */

const FS = 250;

// --- Filter parameters ---
const HP_CUTOFF = 1.5;
const LP_CUTOFF = 30;
const QRS_BP_LOW = 5;
const QRS_BP_HIGH = 18;

// --- RR gating ---
const RR_MIN = 0.35;
const RR_MAX = 1.6;

/* =========================================================
   STATE
========================================================= */

// Filter states
let hp_y = 0;
let hp_x_prev = 0;

let lp_y = 0;

let qrs_lp = 0;

// Buffers
let ecgBuffer = [];
let qrsEnergy = [];

const ECG_BUF_LEN = 1250;

// R-peak state
let rPeaks = [];
let lastRTime = null;
let bpmPrev = null;

// Metrics
let hr = null;
let hrv = null;
let qrsWidth = null;

/* =========================================================
   FILTER HELPERS (causal, real-time)
========================================================= */

// High-pass (baseline removal)
function highPass(x) {
  const alpha = Math.exp(-2 * Math.PI * HP_CUTOFF / FS);
  const y = alpha * (hp_y + x - hp_x_prev);
  hp_x_prev = x;
  hp_y = y;
  return y;
}

// Low-pass (noise reduction)
function lowPass(x) {
  const alpha = 2 * Math.PI * LP_CUTOFF / FS;
  lp_y = lp_y + alpha * (x - lp_y);
  return lp_y;
}

// QRS band-energy
function qrsBandEnergy(x) {
  const alpha = 2 * Math.PI * QRS_BP_HIGH / FS;
  qrs_lp = qrs_lp + alpha * (x - qrs_lp);
  return qrs_lp * qrs_lp;
}

/* =========================================================
   MAIN ECG PROCESSOR
========================================================= */

function processSample(raw) {
  // Center ADC
  let x = raw - 2048;

  // Filtering (A stage)
  let hp = highPass(x);
  let clean = lowPass(hp);

  // Store waveform
  ecgBuffer.push(clean);
  if (ecgBuffer.length > ECG_BUF_LEN) ecgBuffer.shift();

  // QRS energy (B stage)
  let e = qrsBandEnergy(clean);
  qrsEnergy.push(e);
  if (qrsEnergy.length > ECG_BUF_LEN) qrsEnergy.shift();

  // Need buffer filled before detection
  if (qrsEnergy.length < FS * 2) {
    return { ecg: clean, hr, hrv, qrsWidth };
  }

  // Adaptive threshold (median)
  const sorted = [...qrsEnergy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = 0.6 * median;

  const now = Date.now();

  // R-peak detection (C stage)
  if (e > threshold && (!lastRTime || now - lastRTime > RR_MIN * 1000)) {
    if (lastRTime) {
      const rr = (now - lastRTime) / 1000;
      if (rr > RR_MIN && rr < RR_MAX) {
        rPeaks.push(rr);
        if (rPeaks.length > 10) rPeaks.shift();

        // HR (smoothed)
        const bpmRaw = 60 / rr;
        hr = bpmPrev === null ? bpmRaw : 0.8 * bpmPrev + 0.2 * bpmRaw;
        bpmPrev = hr;

        // HRV (RMSSD)
        if (rPeaks.length >= 3) {
          let diffs = [];
          for (let i = 1; i < rPeaks.length; i++) {
            diffs.push(rPeaks[i] - rPeaks[i - 1]);
          }
          const rms = Math.sqrt(
            diffs.reduce((s, d) => s + d * d, 0) / diffs.length
          );
          hrv = rms * 1000;
        }

        // QRS width (Q–S)
        const idx = ecgBuffer.length - 1;
        const qWindow = Math.floor(0.025 * FS);
        const sWindow = Math.floor(0.06 * FS);

        let qMin = Infinity;
        let sMin = Infinity;

        for (let i = idx - qWindow; i < idx; i++) {
          if (i >= 0) qMin = Math.min(qMin, ecgBuffer[i]);
        }
        for (let i = idx; i < idx + sWindow && i < ecgBuffer.length; i++) {
          sMin = Math.min(sMin, ecgBuffer[i]);
        }

        qrsWidth = ((qWindow + sWindow) / FS) * 1000;
      }
    }
    lastRTime = now;
  }

  return {
    ecg: clean,
    hr: hr ? Math.round(hr) : null,
    hrv: hrv ? Math.round(hrv) : null,
    qrs: qrsWidth ? Math.round(qrsWidth) : null
  };
}

/* =========================================================
   WEBSOCKET
========================================================= */

wss.on("connection", ws => {
  ws.on("message", msg => {
    const data = JSON.parse(msg.toString());
    const out = processSample(data.ecg);

    ws.send(JSON.stringify(out));
  });
});
