import * as THREE from "three";

const SNSD_MAGIC = 0x534e5344; // "SNSD" (1397642035)
const INDEX_TO_POSE = ["walk", "kneel", "beads", "dance"];
const BOW_CYCLE_MS = 4800;
const BOW_REST_MS = 400;
const BUFF_DURATION_MS = 300_000; // 5 minutes (Iy = 300_000ms)

const fmtNum = (n) => Number(n || 0).toLocaleString("ko-KR");

/* ==========================================================================
 * 1. Modern Web Guidance: <dialog> Light-Dismiss & Top-Layer Exit Fallbacks
 * ========================================================================== */
let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.("transition-behavior", "allow-discrete") || !document.body) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  supportsDisplayTransition = getComputedStyle(probe).display === "block";
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit() {
  return window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay();
}

async function closeTopLayer(dialog) {
  if (!dialog || !dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute("data-closing", "");
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
    if (!dialog.hasAttribute("data-closing")) return;
    dialog.removeAttribute("data-closing");
  }
  dialog.close();
}

function setupDialogs() {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeTopLayer(dialog);
    });
    dialog.addEventListener("close", () => {
      dialog.returnValue = "";
    });

    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      dialog.addEventListener("pointerdown", (e) => {
        pressedOutside = outside(e, dialog);
      });
      dialog.addEventListener("pointerup", (e) => {
        if (pressedOutside && outside(e, dialog)) closeTopLayer(dialog);
      });
    }
  }
}

/* ==========================================================================
 * 2. SNSD (0x534E5344) Binary Delta Frame Decoder (Reconstructed class De)
 * ========================================================================== */
function decodeSnsdDelta(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 28) return null;
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== SNSD_MAGIC) return null;

  const jsonByteLength = view.getUint32(4, true);
  const recordCount = view.getUint32(8, true);
  const revision = view.getFloat64(12, true);
  const serverTime = view.getFloat64(20, true);

  let offset = 28;
  let meta = {};
  if (jsonByteLength > 0 && offset + jsonByteLength <= buffer.byteLength) {
    const jsonBytes = new Uint8Array(buffer, offset, jsonByteLength);
    try {
      meta = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch (_e) {
      meta = {};
    }
    offset += jsonByteLength;
  }

  const records = [];
  for (let i = 0; i < recordCount; i++) {
    if (offset + 30 > buffer.byteLength) break;
    const seat = view.getUint16(offset, true);
    const cushionRaw = view.getInt16(offset + 2, true);
    const poseIdx = view.getUint8(offset + 4);
    const hasBow = view.getUint8(offset + 5);
    const x = view.getFloat64(offset + 6, true);
    const z = view.getFloat64(offset + 14, true);
    const yaw = view.getFloat64(offset + 22, true);
    offset += 30;

    let bowAt;
    if (hasBow === 1 && offset + 8 <= buffer.byteLength) {
      bowAt = view.getFloat64(offset, true);
      offset += 8;
    }

    records.push({
      seat,
      cushion: cushionRaw < 0 ? null : cushionRaw,
      pose: INDEX_TO_POSE[poseIdx] || "walk",
      x,
      z,
      yaw,
      bowAt,
    });
  }

  return { revision, serverTime, meta, records };
}

/* ==========================================================================
 * 3. Web Audio API Procedural Sound Synthesizer (Reconstructed class pP)
 * ========================================================================== */
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverb = null;
    this.ambientGain = null;
    this.chantGain = null;
    this.birdTimer = null;

    this.ambientEnabled = localStorage.getItem("sansa:ambient-enabled") !== "0";
    this.chantEnabled = localStorage.getItem("sansa:chant-enabled") === "1";
    this.effectsEnabled = localStorage.getItem("sansa:effects-enabled") !== "0";
  }

  ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    this.ctx = new AudioCtx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.6, 2.4);
    const reverbGain = this.ctx.createGain();
    reverbGain.gain.value = 0.28;
    this.reverb.connect(reverbGain);
    reverbGain.connect(this.master);

    this.setupAmbient();
    this.setupChant();
    this.syncGains();
    return this.ctx;
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  setupAmbient() {
    const ctx = this.ctx;
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const out = buffer.getChannelData(ch);
      let prev = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        prev = prev * 0.985 + white * 0.08;
        out[i] = prev * 0.45;
      }
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 250;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 58;

    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = this.ambientEnabled ? 0.09 : 0.0001;

    // Dual LFO modulation for natural mountain breeze
    const lfo1 = ctx.createOscillator();
    const lfo1Gain = ctx.createGain();
    lfo1.frequency.value = 0.07;
    lfo1Gain.gain.value = 0.028;
    lfo1.connect(lfo1Gain);
    lfo1Gain.connect(this.ambientGain.gain);

    const lfo2 = ctx.createOscillator();
    const lfo2Gain = ctx.createGain();
    lfo2.frequency.value = 0.19;
    lfo2Gain.gain.value = 90;
    lfo2.connect(lfo2Gain);
    lfo2Gain.connect(lp.frequency);

    noise.connect(lp);
    lp.connect(hp);
    hp.connect(this.ambientGain);
    this.ambientGain.connect(this.master);

    noise.start();
    lfo1.start();
    lfo2.start();

    this.scheduleBird();
  }

  scheduleBird() {
    if (this.birdTimer) clearTimeout(this.birdTimer);
    this.birdTimer = setTimeout(() => {
      if (this.ctx && this.ambientEnabled && this.ctx.state === "running") {
        this.playBirdChirp();
      }
      this.scheduleBird();
    }, 6500 + Math.random() * 9000);
  }

  playBirdChirp() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const base = 1650 + Math.random() * 520;
    for (let i = 0; i < 2; i++) {
      const start = now + i * 0.14;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.exponentialRampToValueAtTime(base * 1.28, start + 0.055);
      osc.frequency.exponentialRampToValueAtTime(base * 0.92, start + 0.11);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(0.018, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(g);
      g.connect(this.reverb);
      osc.start(start);
      osc.stop(start + 0.13);
    }
  }

  setupChant() {
    const ctx = this.ctx;
    this.chantGain = ctx.createGain();
    this.chantGain.gain.value = this.chantEnabled ? 0.045 : 0.0001;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;

    [108, 162, 216].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = idx === 0 ? "sawtooth" : "triangle";
      osc.frequency.value = freq;
      g.gain.value = 0.22 / (idx + 1);
      osc.connect(g);
      g.connect(lp);
      osc.start();
    });

    lp.connect(this.chantGain);
    this.chantGain.connect(this.reverb);
    this.chantGain.connect(this.master);
  }

  syncGains() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.ambientGain) {
      this.ambientGain.gain.setTargetAtTime(this.ambientEnabled ? 0.09 : 0.0001, now, 0.25);
    }
    if (this.chantGain) {
      this.chantGain.gain.setTargetAtTime(this.chantEnabled ? 0.045 : 0.0001, now, 0.35);
    }
  }

  bell(accent = false) {
    if (!this.effectsEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const base = accent ? 528 : 432;
    const partials = [1, 2.71, 3.96, 5.43, 7.03];
    partials.forEach((ratio, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = idx === 0 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(base * ratio, now);
      const amp = (accent ? 0.095 : 0.068) / (idx * 1.15 + 1);
      const dur = 1.9 / (idx * 0.45 + 1);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(amp, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(gain);
      gain.connect(this.master);
      gain.connect(this.reverb);
      osc.start(now);
      osc.stop(now + dur + 0.04);
    });
  }

  bead() {
    if (!this.effectsEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const toneGain = ctx.createGain();
    osc1.type = "triangle";
    osc2.type = "sine";
    osc1.frequency.setValueAtTime(1010, now);
    osc1.frequency.exponentialRampToValueAtTime(510, now + 0.036);
    osc2.frequency.setValueAtTime(1470, now);
    osc2.frequency.exponentialRampToValueAtTime(760, now + 0.028);

    toneGain.gain.setValueAtTime(0.0001, now);
    toneGain.gain.linearRampToValueAtTime(0.048, now + 0.003);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

    osc1.connect(toneGain);
    osc2.connect(toneGain);
    toneGain.connect(this.master);
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.048);
    osc2.stop(now + 0.048);
  }

  moktak() {
    if (!this.effectsEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const click = ctx.createOscillator();
    const bp = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    bp.type = "bandpass";
    bp.frequency.value = 690;
    bp.Q.value = 5.5;

    osc.type = "triangle";
    osc.frequency.setValueAtTime(415, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.09);

    click.type = "sine";
    click.frequency.setValueAtTime(1180, now);
    click.frequency.exponentialRampToValueAtTime(480, now + 0.025);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    osc.connect(bp);
    click.connect(bp);
    bp.connect(gain);
    gain.connect(this.master);
    gain.connect(this.reverb);

    osc.start(now);
    click.start(now);
    osc.stop(now + 0.15);
    click.stop(now + 0.05);
  }
}

/* ==========================================================================
 * 4. Adaptive Frame Pacer (Reconstructed class Vy: 60 / 30 / 15 FPS)
 * ========================================================================== */
class FramePacer {
  constructor() {
    this.boostUntil = 0;
    this.lastRenderAt = 0;
  }

  noteInteraction(durationMs = 900) {
    this.boostUntil = Math.max(this.boostUntil, performance.now() + durationMs);
  }

  shouldRender(now, remoteCount, isDraggingOrMoving) {
    let interval = 1000 / 30;
    if (isDraggingOrMoving || now < this.boostUntil) {
      interval = 1000 / 60;
    } else if (remoteCount > 24) {
      interval = 1000 / 15;
    }
    if (now - this.lastRenderAt >= interval) {
      this.lastRenderAt = now;
      return true;
    }
    return false;
  }
}

/* ==========================================================================
 * 5. Main Sansa Temple 3D Application
 * ========================================================================== */
class SansaApp {
  constructor() {
    this.sound = new SoundEngine();
    this.pacer = new FramePacer();

    this.space = "garden"; // "garden" | "hall"
    this.room = "maru";
    this.selfId = "";
    this.clockOffset = 0;

    this.visitors = new Map(); // id -> visitor object
    this.seatToId = new Map(); // seat(0..99) -> id
    this.avatarMeshes = new Map(); // id -> THREE.Group
    this.nameplateCache = new Map();

    this.incenseQueue = [];
    this.sharedCoffees = [];

    // Practice state persisted in localStorage
    this.bowCount = Number(localStorage.getItem("sansa:bow-count") || 0);
    this.beadsCount = Number(localStorage.getItem("sansa:beads-count") || 0);
    this.beadsRounds = Number(localStorage.getItem("sansa:beads-rounds") || 0);
    this.bow25Active = false;
    this.bow25Count = 0;
    this.buffUntil = 0;
    this.totalDonation = Number(localStorage.getItem("sansa:total-donation") || 0);

    // Controls & movement
    this.keys = new Set();
    this.moveTarget = null;
    this.isBowingContinuous = false;
    this.lastBowCountedCycle = -1;
    this.moktakAutoTimer = null;
    this.moktakPulse = 0;
    this.beadsOffset = 0;

    // Camera spherical orbit
    this.camYaw = 0;
    this.camPitch = 0.42;
    this.camDist = 14.5;
    this.isDraggingCam = false;
    this.dragStart = { x: 0, y: 0 };

    // Multi-tab ownership
    this.tabId = crypto.randomUUID();
    this.renderPaused = false;

    this.initDOM();
    this.initThree();
    this.buildWorld();
    this.initPresenceWorker();
    this.initMultiTabLock();
    this.initOverlays();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  get serverNow() {
    return Date.now() - this.clockOffset;
  }

  /* ------------------------------------------------------------------------
   * DOM & Event Wiring
   * ------------------------------------------------------------------------ */
  initDOM() {
    setupDialogs();
    this.appEl = document.getElementById("app");
    this.canvas = document.getElementById("scene-canvas");
    this.entryEl = document.getElementById("entry");
    this.toastEl = document.getElementById("toast-banner");

    // Entry button
    document.getElementById("enter-btn").addEventListener("click", () => {
      this.sound.ensureContext();
      this.sound.bell(true);
      this.entryEl.classList.add("hidden");
      this.sendPresence({ type: "entry-active" });
      fetch("/api/entry-stage", {
        method: "POST",
        body: JSON.stringify({ stage: "entered", at: Date.now() }),
        keepalive: true,
      }).catch(() => {});
    });

    // Space toggle (Garden <-> Hall)
    document.getElementById("space-toggle").addEventListener("click", () => {
      this.toggleSpace();
    });

    // Audio toggles
    const btnAmbient = document.getElementById("audio-ambient");
    const btnChant = document.getElementById("audio-chant");
    const btnEffects = document.getElementById("audio-effects");

    const syncAudioButtons = () => {
      btnAmbient.setAttribute("aria-pressed", String(this.sound.ambientEnabled));
      btnAmbient.textContent = this.sound.ambientEnabled ? "🍃 바람음 켜짐" : "🍃 바람음 꺼짐";
      btnChant.setAttribute("aria-pressed", String(this.sound.chantEnabled));
      btnChant.textContent = this.sound.chantEnabled ? "📿 염불 켜짐" : "📿 염불 꺼짐";
      btnEffects.setAttribute("aria-pressed", String(this.sound.effectsEnabled));
      btnEffects.textContent = this.sound.effectsEnabled ? "🔔 효과음 켜짐" : "🔔 효과음 꺼짐";
    };
    syncAudioButtons();

    btnAmbient.addEventListener("click", () => {
      this.sound.ensureContext();
      this.sound.ambientEnabled = !this.sound.ambientEnabled;
      localStorage.setItem("sansa:ambient-enabled", this.sound.ambientEnabled ? "1" : "0");
      this.sound.syncGains();
      syncAudioButtons();
    });

    btnChant.addEventListener("click", () => {
      this.sound.ensureContext();
      this.sound.chantEnabled = !this.sound.chantEnabled;
      localStorage.setItem("sansa:chant-enabled", this.sound.chantEnabled ? "1" : "0");
      this.sound.syncGains();
      syncAudioButtons();
      if (this.sound.chantEnabled) {
        this.showToast("염불 독경 소리를 켰습니다. (매일 05:00 · 18:00 합동 염불)");
      }
    });

    btnEffects.addEventListener("click", () => {
      this.sound.ensureContext();
      this.sound.effectsEnabled = !this.sound.effectsEnabled;
      localStorage.setItem("sansa:effects-enabled", this.sound.effectsEnabled ? "1" : "0");
      syncAudioButtons();
    });

    // Dialog triggers
    document.getElementById("visitor-counter").addEventListener("click", () => {
      this.openServerPicker();
    });
    document.getElementById("cafe25-open").addEventListener("click", () => {
      this.renderPostcard();
      document.getElementById("cafe25-dialog").showModal();
    });
    document.getElementById("support-open").addEventListener("click", () => {
      document.getElementById("support-dialog").showModal();
    });
    document.getElementById("artwork-open").addEventListener("click", () => {
      document.getElementById("artwork-dialog").showModal();
    });

    // Context actions
    document.getElementById("incense-offer-btn").addEventListener("click", () => {
      this.offerIncenseRitual();
    });
    document.getElementById("cafe25-claim-btn").addEventListener("click", () => {
      if (this.sharedCoffees.length === 0) {
        this.showToast("현재 나눔 탁자에 놓인 커피가 없습니다. CAFE25에서 무소유 커피를 내려보세요.");
        return;
      }
      this.sendPresence({ type: "cafe25", action: "claim" });
    });
    document.getElementById("camera-reset-btn").addEventListener("click", () => {
      this.camYaw = 0;
      this.camPitch = 0.42;
      this.camDist = 14.5;
      this.pacer.noteInteraction();
    });

    // Bottom Thumb-Zone Practice Buttons
    document.getElementById("btn-hello").addEventListener("click", () => this.triggerHello());
    document.getElementById("btn-bow").addEventListener("click", () => this.toggleBowMode());
    document.getElementById("btn-beads").addEventListener("click", () => this.toggleBeadsOverlay());
    document.getElementById("btn-moktak").addEventListener("click", () => this.toggleMoktakOverlay());
    document.getElementById("btn-sit").addEventListener("click", () => this.toggleSit());

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      this.pacer.noteInteraction();
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        this.keys.add(k);
        this.moveTarget = null;
      } else if (k === "1") {
        this.toggleBowMode();
      } else if (k === "2") {
        this.toggleBeadsOverlay();
      } else if (k === "3") {
        this.triggerHello();
      } else if (k === "4") {
        this.toggleSit();
      } else if (k === "5") {
        this.toggleMoktakOverlay();
      } else if (e.code === "Space") {
        e.preventDefault();
        if (!document.getElementById("beads-host").hidden) {
          this.pullOneBead();
        } else if (!document.getElementById("moktak-host").hidden) {
          this.strikeMoktak();
        } else {
          this.toggleBowMode();
        }
      }
    });

    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
    });

    // Update initial counters with 1,000-unit commas
    this.updatePracticeHUD();
    this.setupCafe25Modal();
    this.setupDonationModal();
  }

  showToast(message, duration = 3800) {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.hidden = true;
    }, duration);
  }

  updatePracticeHUD() {
    document.getElementById("bow-counter").innerHTML = `절 <strong>${fmtNum(this.bowCount)}</strong>배`;
    document.getElementById("beads-counter").innerHTML =
      `염주 <strong>${fmtNum(this.beadsCount)}</strong>알 (<strong id="beads-round-inline">${fmtNum(this.beadsRounds)}</strong>바퀴)`;
    document.getElementById("beads-overlay-count").textContent = `${fmtNum(this.beadsCount % 108)} / 108알`;
    document.getElementById("beads-overlay-rounds").textContent = `108염주 ${fmtNum(this.beadsRounds)}바퀴`;

    const bow25El = document.getElementById("bow25-counter");
    const bow25Sep = document.getElementById("bow25-sep");
    if (this.bow25Active) {
      bow25El.hidden = false;
      bow25Sep.hidden = false;
      bow25El.innerHTML = `풀소유 25배: <strong>${fmtNum(this.bow25Count)} / 25</strong>`;
    } else {
      bow25El.hidden = true;
      bow25Sep.hidden = true;
    }
    document.getElementById("cafe-bow25-status").textContent = `${fmtNum(this.bow25Count)} / 25배`;
  }

  /* ------------------------------------------------------------------------
   * Multi-Tab Render Ownership (BroadcastChannel("sansa-render-owner-v1"))
   * ------------------------------------------------------------------------ */
  initMultiTabLock() {
    if (typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel("sansa-render-owner-v1");
    const claim = () => {
      this.renderPaused = false;
      document.getElementById("render-paused-banner").hidden = true;
      this.channel.postMessage({ type: "claim", tabId: this.tabId, at: Date.now() });
    };
    this.channel.onmessage = (ev) => {
      if (ev.data?.type === "claim" && ev.data.tabId !== this.tabId) {
        this.renderPaused = true;
        document.getElementById("render-paused-banner").hidden = false;
      }
    };
    window.addEventListener("focus", claim);
    document.getElementById("resume-render-btn").addEventListener("click", claim);
    claim();
  }

  /* ------------------------------------------------------------------------
   * Three.js r180 Scene, Garden & Hall World Construction
   * ------------------------------------------------------------------------ */
  initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e241e);
    this.scene.fog = new THREE.FogExp2(0x1e241e, 0.018);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.2, 160);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // Canvas pointer controls (Orbit drag + tap-to-walk)
    let downPos = { x: 0, y: 0 };
    let moved = false;

    this.canvas.addEventListener("pointerdown", (e) => {
      this.sound.ensureContext();
      this.pacer.noteInteraction();
      this.isDraggingCam = true;
      moved = false;
      downPos = { x: e.clientX, y: e.clientY };
      this.dragStart = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener("pointermove", (e) => {
      if (!this.isDraggingCam) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) moved = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.camYaw -= dx * 0.0065;
      this.camPitch = Math.max(0.16, Math.min(1.18, this.camPitch + dy * 0.005));
      this.pacer.noteInteraction();
    });

    window.addEventListener("pointerup", (e) => {
      if (!this.isDraggingCam) return;
      this.isDraggingCam = false;
      if (!moved && e.target === this.canvas) {
        this.handleCanvasTap(e);
      }
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.camDist = Math.max(6.5, Math.min(28, this.camDist + e.deltaY * 0.012));
        this.pacer.noteInteraction();
      },
      { passive: false }
    );

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.pacer.noteInteraction();
    });
  }

  handleCanvasTap(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      const self = this.visitors.get(this.selfId);
      if (!self) return;
      if (self.cushion !== null) {
        this.standUp();
      }
      this.isBowingContinuous = false;
      document.getElementById("btn-bow").setAttribute("aria-pressed", "false");
      if (this.space === "hall") {
        hit.x = Math.max(-7.5, Math.min(7.5, hit.x));
        hit.z = Math.max(-10.2, Math.min(-1.5, hit.z));
      } else {
        hit.x = Math.max(-22, Math.min(22, hit.x));
        hit.z = Math.max(3.5, Math.min(32, hit.z));
      }
      this.moveTarget = { x: hit.x, z: hit.z };
    }
  }

  buildWorld() {
    // Lighting
    const hemi = new THREE.HemisphereLight(0xdde4d6, 0x262b23, 0.85);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffeed2, 1.15);
    dir.position.set(16, 28, 18);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = 75;
    const d = 28;
    dir.shadow.camera.left = -d;
    dir.shadow.camera.right = d;
    dir.shadow.camera.top = d;
    dir.shadow.camera.bottom = -d;
    this.scene.add(dir);

    this.gardenGroup = new THREE.Group();
    this.hallGroup = new THREE.Group();
    this.scene.add(this.gardenGroup);
    this.scene.add(this.hallGroup);

    this.cushionPositions = [];
    this.benchPositions = [];
    this.smokeParticles = [];

    this.buildGarden();
    this.buildHall();
  }

  buildGarden() {
    // 1. Courtyard Ground & Stone Path
    const groundGeo = new THREE.CircleGeometry(46, 48);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x283026, roughness: 0.95 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, 14);
    ground.receiveShadow = true;
    this.gardenGroup.add(ground);

    const pathGeo = new THREE.PlaneGeometry(3.4, 28);
    const pathMat = new THREE.MeshStandardMaterial({ color: 0x52564e, roughness: 0.88 });
    const stonePath = new THREE.Mesh(pathGeo, pathMat);
    stonePath.rotation.x = -Math.PI / 2;
    stonePath.position.set(0, 0.01, 16);
    stonePath.receiveShadow = true;
    this.gardenGroup.add(stonePath);

    // 2. Chungyeondang (청연당 법당 외관) at z = -3
    const foundation = new THREE.Mesh(
      new THREE.BoxGeometry(19, 0.9, 12),
      new THREE.MeshStandardMaterial({ color: 0x676962, roughness: 0.85 })
    );
    foundation.position.set(0, 0.45, -6);
    foundation.receiveShadow = true;
    foundation.castShadow = true;
    this.gardenGroup.add(foundation);

    const stairs = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 0.5, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x797b73, roughness: 0.85 })
    );
    stairs.position.set(0, 0.25, 0.6);
    this.gardenGroup.add(stairs);

    const hallWalls = new THREE.Mesh(
      new THREE.BoxGeometry(16.4, 4.6, 9.6),
      new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.75 })
    );
    hallWalls.position.set(0, 3.1, -6);
    hallWalls.castShadow = true;
    this.gardenGroup.add(hallWalls);

    // Warm paper lattice doors (창호문)
    for (let i = -2; i <= 2; i++) {
      const door = new THREE.Mesh(
        new THREE.PlaneGeometry(2.1, 3.2),
        new THREE.MeshStandardMaterial({
          color: 0xf4dfb4,
          emissive: 0xd9a85b,
          emissiveIntensity: 0.35,
          roughness: 0.6,
        })
      );
      door.position.set(i * 2.5, 2.9, -1.18);
      this.gardenGroup.add(door);
    }

    // Traditional curved tiled roof (기와지붕)
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(13.2, 3.6, 4),
      new THREE.MeshStandardMaterial({ color: 0x26292b, roughness: 0.65, metalness: 0.15 })
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.25, 1, 0.82);
    roof.position.set(0, 7.1, -6);
    roof.castShadow = true;
    this.gardenGroup.add(roof);

    // 3. Lotus Pond (연꽃 연못) at x = -8, z = 15
    const pondGroup = new THREE.Group();
    pondGroup.position.set(-8.5, 0.02, 15.5);
    this.pondWater = new THREE.Mesh(
      new THREE.CircleGeometry(4.8, 36),
      new THREE.MeshStandardMaterial({
        color: 0x244945,
        roughness: 0.18,
        metalness: 0.35,
      })
    );
    this.pondWater.rotation.x = -Math.PI / 2;
    pondGroup.add(this.pondWater);

    // Lotus pads & pink lotus blossoms
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      const rad = 1.4 + (i % 3) * 1.05;
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(0.45, 16),
        new THREE.MeshStandardMaterial({ color: 0x3b6e45, roughness: 0.8 })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(Math.cos(ang) * rad, 0.03, Math.sin(ang) * rad);
      pondGroup.add(pad);

      if (i % 2 === 0) {
        const flower = new THREE.Mesh(
          new THREE.ConeGeometry(0.2, 0.28, 8),
          new THREE.MeshStandardMaterial({
            color: 0xf2b8c6,
            emissive: 0x5c2836,
            emissiveIntensity: 0.3,
          })
        );
        flower.position.set(Math.cos(ang) * rad, 0.16, Math.sin(ang) * rad);
        pondGroup.add(flower);
      }
    }
    this.gardenGroup.add(pondGroup);

    // 4. Temple Cat 'Gongyang-i' (사찰 고양이 공양이) walking by the pond
    this.catGroup = new THREE.Group();
    const catMat = new THREE.MeshStandardMaterial({ color: 0xe6dfd3, roughness: 0.7 });
    const catBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.38, 6, 12), catMat);
    catBody.rotation.x = Math.PI / 2;
    catBody.position.y = 0.25;
    const catHead = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 12), catMat);
    catHead.position.set(0, 0.38, 0.26);
    this.catGroup.add(catBody, catHead);
    this.gardenGroup.add(this.catGroup);

    // 5. CAFE25 × Sansa Booth at x = 9, z = 15
    const cafeBooth = new THREE.Group();
    cafeBooth.position.set(9.2, 0, 15.0);
    const counter = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 1.1, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x6e4d32, roughness: 0.78 })
    );
    counter.position.y = 0.55;
    counter.castShadow = true;
    const canopy = new THREE.Mesh(
      new THREE.ConeGeometry(2.8, 1.2, 4),
      new THREE.MeshStandardMaterial({ color: 0x333833, roughness: 0.7 })
    );
    canopy.rotation.y = Math.PI / 4;
    canopy.position.y = 2.6;
    const kettle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, 0.28, 12),
      new THREE.MeshStandardMaterial({ color: 0xd4b475, metalness: 0.7, roughness: 0.3 })
    );
    kettle.position.set(0, 1.24, 0);
    const cafeLight = new THREE.PointLight(0xffcb80, 1.4, 9);
    cafeLight.position.set(0, 2.1, 0);
    cafeBooth.add(counter, canopy, kettle, cafeLight);
    this.gardenGroup.add(cafeBooth);

    // 6. Garden Benches (10 benches = 20 seat slots, cushion 100..119)
    const benchCoords = [
      { x: -7.5, z: 10.0, yaw: 0.4 },
      { x: -7.5, z: 21.0, yaw: 2.6 },
      { x: 7.5, z: 10.5, yaw: -0.5 },
      { x: 8.0, z: 19.5, yaw: -2.4 },
      { x: -3.5, z: 25.0, yaw: 0.0 },
      { x: 3.5, z: 25.0, yaw: 0.0 },
    ];
    benchCoords.forEach((b, idx) => {
      const bench = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.42, 0.65),
        new THREE.MeshStandardMaterial({ color: 0x6b5037, roughness: 0.82 })
      );
      bench.position.set(b.x, 0.21, b.z);
      bench.rotation.y = b.yaw;
      bench.castShadow = true;
      this.gardenGroup.add(bench);
      this.benchPositions.push({ id: 100 + idx, x: b.x, z: b.z, yaw: b.yaw });
    });

    // 7. Lanterns & Pine Trees
    for (let i = 0; i < 6; i++) {
      const zPos = 4 + i * 4.4;
      [-2.4, 2.4].forEach((xPos) => {
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.08, 2.2, 8),
          new THREE.MeshStandardMaterial({ color: 0x4b3828 })
        );
        post.position.set(xPos, 1.1, zPos);
        const lantern = new THREE.Mesh(
          new THREE.SphereGeometry(0.22, 12, 12),
          new THREE.MeshStandardMaterial({
            color: 0xffd591,
            emissive: 0xffae42,
            emissiveIntensity: 0.85,
          })
        );
        lantern.position.set(xPos, 2.15, zPos);
        this.gardenGroup.add(post, lantern);
      });
    }

    for (let i = 0; i < 18; i++) {
      const ang = (i / 18) * Math.PI * 2;
      const rad = 18 + (i % 3) * 4.5;
      const px = Math.cos(ang) * rad;
      const pz = 14 + Math.sin(ang) * rad;
      if (pz < 2 && Math.abs(px) < 11) continue;
      const tree = this.createPineTree();
      tree.position.set(px, 0, pz);
      this.gardenGroup.add(tree);
    }
  }

  createPineTree() {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.28, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x4d3627, roughness: 0.9 })
    );
    trunk.position.y = 1.2;
    trunk.castShadow = true;
    g.add(trunk);

    const needlesMat = new THREE.MeshStandardMaterial({ color: 0x26422b, roughness: 0.85 });
    [2.5, 3.5, 4.4].forEach((y, idx) => {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.45 - idx * 0.3, 1.5, 9), needlesMat);
      cone.position.y = y;
      cone.castShadow = true;
      g.add(cone);
    });
    return g;
  }

  buildHall() {
    // 1. Wooden Temple Floor (법당 마루 바닥)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 16),
      new THREE.MeshStandardMaterial({ color: 0x46301f, roughness: 0.65 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.02, -6.5);
    floor.receiveShadow = true;
    this.hallGroup.add(floor);

    // 2. Altar Platform (수미단 / 불단) at z = -12.2
    const altar = new THREE.Mesh(
      new THREE.BoxGeometry(11.2, 1.35, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x593a22, roughness: 0.55 })
    );
    altar.position.set(0, 0.68, -12.2);
    altar.castShadow = true;
    altar.receiveShadow = true;
    this.hallGroup.add(altar);

    // 3. Amitabha Triad (아미타삼존불: 본존 아미타불, 관세음보살, 대세지보살)
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xe6c373,
      metalness: 0.78,
      roughness: 0.24,
      emissive: 0x3b2c0c,
      emissiveIntensity: 0.25,
    });

    const triadConfigs = [
      { x: 0, scale: 1.22, name: "본존 아미타불" },
      { x: -3.1, scale: 0.96, name: "관세음보살" },
      { x: 3.1, scale: 0.96, name: "대세지보살" },
    ];

    triadConfigs.forEach((cfg) => {
      const statue = new THREE.Group();
      statue.position.set(cfg.x, 1.35, -12.2);
      statue.scale.setScalar(cfg.scale);

      // Lotus pedestal (연화대좌)
      const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 0.42, 20), goldMat);
      pedestal.position.y = 0.21;
      // Seated body
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.66, 1.25, 16), goldMat);
      body.position.y = 1.0;
      // Head & Ushnisha (육계)
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 18), goldMat);
      head.position.y = 1.82;
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), goldMat);
      crown.position.y = 2.16;
      // Radiant Mandorla Halo (광배)
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1.15, 32),
        new THREE.MeshBasicMaterial({ color: 0xf3d486, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
      );
      halo.position.set(0, 1.45, -0.35);

      statue.add(pedestal, body, head, crown, halo);
      this.hallGroup.add(statue);
    });

    // Warm altar lighting
    const altarLight = new THREE.PointLight(0xffcf7c, 2.4, 18);
    altarLight.position.set(0, 4.5, -10.5);
    this.hallGroup.add(altarLight);

    // 4. Incense Burner (향로) & Smoke Particles + Donation Box (복전함)
    const burner = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.28, 0.55, 18),
      new THREE.MeshStandardMaterial({ color: 0x8f7952, metalness: 0.6, roughness: 0.35 })
    );
    burner.position.set(0, 1.15, -10.5);
    this.hallGroup.add(burner);

    const donationBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.72, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x6e472b, roughness: 0.6 })
    );
    donationBox.position.set(2.2, 0.38, -10.4);
    this.hallGroup.add(donationBox);

    // Rising incense smoke particles
    const smokeMat = new THREE.MeshBasicMaterial({ color: 0xdcdad0, transparent: true, opacity: 0.32 });
    for (let i = 0; i < 12; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), smokeMat.clone());
      puff.position.set(0, 1.45 + i * 0.16, -10.5);
      puff.userData = { phase: i * 0.55 };
      this.hallGroup.add(puff);
      this.smokeParticles.push(puff);
    }

    // 5. 24 Meditation Cushions (좌복 그리드, cushion 0..23)
    const cushionMat = new THREE.MeshStandardMaterial({ color: 0x7a563c, roughness: 0.85 });
    let idx = 0;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 6; col++) {
        const cx = (col - 2.5) * 2.2;
        const cz = -4.2 - row * 1.75;
        const cushion = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.12, 1.05), cushionMat);
        cushion.position.set(cx, 0.08, cz);
        cushion.receiveShadow = true;
        this.hallGroup.add(cushion);
        this.cushionPositions.push({ id: idx++, x: cx, z: cz, yaw: Math.PI });
      }
    }
  }

  /* ------------------------------------------------------------------------
   * Child Monk Avatar (동자승 3D Rig + Nameplate + Prostration Keyframes)
   * ------------------------------------------------------------------------ */
  createMonkAvatar(visitor) {
    const group = new THREE.Group();

    const bodyRoot = new THREE.Group();
    group.add(bodyRoot);

    const robeMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(visitor.color || "#a89f91"),
      roughness: 0.82,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xeed9c4,
      roughness: 0.65,
    });

    // Robe torso
    const torso = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.96, 14), robeMat);
    torso.position.y = 0.52;
    torso.castShadow = true;
    bodyRoot.add(torso);

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), skinMat);
    head.position.y = 1.18;
    head.castShadow = true;
    bodyRoot.add(head);

    // Hands folded in Hapjang (합장)
    const hands = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), skinMat);
    hands.position.set(0, 0.68, 0.34);
    bodyRoot.add(hands);

    // Greeting / Warmth Aura Ring on ground
    const auraRing = new THREE.Mesh(
      new THREE.RingGeometry(0.48, 0.62, 24),
      new THREE.MeshBasicMaterial({
        color: 0xe7c98c,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.0,
      })
    );
    auraRing.rotation.x = -Math.PI / 2;
    auraRing.position.y = 0.04;
    group.add(auraRing);

    // Floating Nameplate Sprite
    const nameplate = this.createNameplateSprite(visitor.name, visitor.id === this.selfId);
    nameplate.position.set(0, 1.78, 0);
    group.add(nameplate);

    group.userData = { bodyRoot, torso, head, hands, auraRing, nameplate, helloUntil: 0 };
    return group;
  }

  createNameplateSprite(name, isSelf) {
    const key = `${name}|${isSelf ? 1 : 0}`;
    let texture = this.nameplateCache.get(key);
    if (!texture) {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 64;
      const ctx = c.getContext("2d");
      ctx.fillStyle = isSelf ? "rgba(212, 180, 117, 0.88)" : "rgba(20, 24, 20, 0.72)";
      ctx.beginPath();
      ctx.roundRect(16, 10, 224, 44, 22);
      ctx.fill();
      ctx.font = "600 22px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = isSelf ? "#161814" : "#f2f0e8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(name, 128, 33);
      texture = new THREE.CanvasTexture(c);
      this.nameplateCache.set(key, texture);
    }
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.85, 0.46, 1);
    return sprite;
  }

  /* ------------------------------------------------------------------------
   * Presence Worker & SNSD Binary Sync
   * ------------------------------------------------------------------------ */
  initPresenceWorker() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/presence?roomLimit=100&garden=2&room=${encodeURIComponent(this.room)}&protocol=2&wire=3&cafe25=1&flow=latest-v1&interest=1`;

    this.worker = new Worker("/static/presence-worker.js");
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "status") {
        const dot = document.getElementById("conn-dot");
        dot.classList.toggle("disconnected", msg.status !== "connected");
      } else if (msg.type === "message") {
        this.handleJsonMessage(msg.text);
      } else if (msg.type === "binary") {
        this.handleBinaryDelta(msg.buffer);
      }
    };
    this.worker.postMessage({ type: "connect", url: wsUrl, idle: false });
  }

  sendPresence(payload) {
    if (!this.worker) return;
    this.worker.postMessage({ type: "send", data: JSON.stringify(payload) });
  }

  switchRoom(targetRoom) {
    if (!targetRoom || targetRoom === this.room) return;
    this.room = targetRoom;
    for (const mesh of this.avatarMeshes.values()) {
      this.scene.remove(mesh);
    }
    this.avatarMeshes.clear();
    this.visitors.clear();
    this.seatToId.clear();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/presence?roomLimit=100&garden=2&room=${encodeURIComponent(this.room)}&protocol=2&wire=3&cafe25=1&flow=latest-v1&interest=1`;
    this.worker.postMessage({ type: "connect", url: wsUrl, idle: false });
    this.showToast(`${this.formatRoomLabel(this.room)} 서버로 이동했습니다.`);
  }

  formatRoomLabel(roomId) {
    if (roomId === "maru") return "마루 1";
    const num = Number(roomId.replace("maru-", ""));
    return Number.isFinite(num) ? `마루 ${num}` : roomId;
  }

  handleJsonMessage(rawText) {
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_e) {
      return;
    }
    if (!data || typeof data !== "object") return;

    if (data.type === "snapshot") {
      this.room = data.room || this.room;
      this.selfId = data.selfId || this.selfId;
      if (Number.isFinite(data.serverTime)) {
        this.clockOffset = Date.now() - data.serverTime;
      }
      this.incenseQueue = Array.isArray(data.incenseQueue) ? data.incenseQueue : [];

      this.visitors.clear();
      this.seatToId.clear();
      for (const v of data.visitors || []) {
        this.upsertVisitorProfile(v);
      }
      this.syncRoomHUD();
      this.sendPresence({ type: "ack", revision: data.revision });
      this.sendPresence({
        type: "interest",
        bounds: { minX: -56, maxX: 56, minZ: -40, maxZ: 64 },
        requestId: 1,
      });
    } else if (data.type === "cafe25-state") {
      this.sharedCoffees = Array.isArray(data.shared) ? data.shared : [];
      document.getElementById("shared-coffee-count").textContent = fmtNum(this.sharedCoffees.length);
    } else if (data.type === "cafe25-claimed" && data.coffee) {
      this.sound.bell(false);
      this.showToast(`☕ ${data.coffee.fromName}님이 내려둔 커피를 마셨습니다: "${data.coffee.message}"`);
    }
  }

  handleBinaryDelta(buffer) {
    const delta = decodeSnsdDelta(buffer);
    if (!delta) return;

    if (Number.isFinite(delta.serverTime)) {
      this.clockOffset = Date.now() - delta.serverTime;
    }

    const { meta, records } = delta;
    if (meta) {
      if (Array.isArray(meta.profiles)) {
        for (const p of meta.profiles) {
          this.upsertVisitorProfile(p);
        }
      }
      if (Array.isArray(meta.removed)) {
        for (const remId of meta.removed) {
          const v = this.visitors.get(remId);
          if (v) this.seatToId.delete(v.seat);
          this.visitors.delete(remId);
          const mesh = this.avatarMeshes.get(remId);
          if (mesh) {
            this.scene.remove(mesh);
            this.avatarMeshes.delete(remId);
          }
        }
      }
      if (Array.isArray(meta.incenseQueue)) {
        this.incenseQueue = meta.incenseQueue;
      }
      if (Array.isArray(meta.events)) {
        for (const ev of meta.events) {
          this.handlePeerEvent(ev);
        }
      }
    }

    for (const rec of records) {
      const vid = this.seatToId.get(rec.seat);
      if (!vid) continue;
      const v = this.visitors.get(vid);
      if (!v) continue;
      v.cushion = rec.cushion;
      v.pose = rec.pose;
      v.bowAt = rec.bowAt;
      if (vid !== this.selfId) {
        v.targetX = rec.x;
        v.targetZ = rec.z;
        v.targetYaw = rec.yaw;
      }
    }

    this.syncRoomHUD();
    this.sendPresence({ type: "ack", revision: delta.revision });
    this.pacer.noteInteraction(300);
  }

  upsertVisitorProfile(p) {
    const pos = p.position || { x: 0, z: 24, yaw: Math.PI };
    const existing = this.visitors.get(p.id);
    const v = {
      id: p.id,
      name: p.name || "고요한 바람",
      color: p.color || "#a89f91",
      seat: p.seat ?? 0,
      cushion: p.cushion ?? null,
      pose: p.pose || "walk",
      x: existing ? existing.x : pos.x,
      z: existing ? existing.z : pos.z,
      yaw: existing ? existing.yaw : pos.yaw,
      targetX: pos.x,
      targetZ: pos.z,
      targetYaw: pos.yaw,
      bowAt: p.bowAt,
    };
    this.visitors.set(v.id, v);
    this.seatToId.set(v.seat, v.id);

    if (!this.avatarMeshes.has(v.id)) {
      const mesh = this.createMonkAvatar(v);
      mesh.position.set(v.x, 0, v.z);
      mesh.rotation.y = v.yaw;
      this.scene.add(mesh);
      this.avatarMeshes.set(v.id, mesh);
    }

    if (v.id === this.selfId) {
      document.getElementById("self-name-text").textContent = v.name;
    }
  }

  handlePeerEvent(ev) {
    if (!ev) return;
    const mesh = this.avatarMeshes.get(ev.id);
    if (ev.type === "hello") {
      if (mesh) mesh.userData.helloUntil = performance.now() + 2000;
      if (ev.id !== this.selfId) this.sound.bell(false);
    } else if (ev.type === "incense-offer") {
      this.sound.bell(true);
      this.showToast(`🕯️ ${ev.name || "동자승"}님이 불단에 향을 올렸습니다.`);
    }
  }

  syncRoomHUD() {
    const count = this.visitors.size;
    const rLabel = this.formatRoomLabel(this.room);
    document.getElementById("room-label").textContent = rLabel;
    document.getElementById("visitor-count-label").textContent = `${fmtNum(count)}명 머무는 중`;
    document.getElementById("entry-live-stats").textContent = `${rLabel} 서버 · 현재 ${fmtNum(count)}명 고요히 머무는 중`;
    document.getElementById("incense-queue-badge").textContent = `대기 ${fmtNum(this.incenseQueue.length)}`;
  }

  /* ------------------------------------------------------------------------
   * Space Switching & 6 Devotional Practices
   * ------------------------------------------------------------------------ */
  toggleSpace(forceSpace) {
    const next = forceSpace || (this.space === "garden" ? "hall" : "garden");
    this.space = next;
    this.appEl.setAttribute("data-space", next);
    const btn = document.getElementById("space-toggle");
    const self = this.visitors.get(this.selfId);

    if (next === "hall") {
      btn.textContent = "🌲 마당 나가기";
      if (self) {
        self.x = 0;
        self.z = -2.4;
        self.yaw = Math.PI;
        self.cushion = null;
        this.sendMove();
      }
      this.showToast("청연당 법당 안으로 들어왔습니다. 빈 좌복에 앉아 절을 올릴 수 있습니다.");
    } else {
      btn.textContent = "🏯 법당 들어가기";
      if (self) {
        self.x = 0;
        self.z = 12.0;
        self.yaw = 0;
        self.cushion = null;
        this.sendMove();
      }
      this.showToast("산사 마당으로 나왔습니다.");
    }
    this.pacer.noteInteraction();
  }

  triggerHello() {
    this.sound.bell(false);
    const mesh = this.avatarMeshes.get(this.selfId);
    if (mesh) mesh.userData.helloUntil = performance.now() + 2000;
    this.sendPresence({ type: "hello" });
    this.showToast("🙏 주변 수행자들에게 말없이 합장 인사를 건넸습니다.");
  }

  toggleBowMode() {
    const self = this.visitors.get(this.selfId);
    if (!self) return;
    this.isBowingContinuous = !this.isBowingContinuous;
    document.getElementById("btn-bow").setAttribute("aria-pressed", String(this.isBowingContinuous));

    if (this.isBowingContinuous) {
      if (this.space === "garden" && self.z > 2) {
        this.toggleSpace("hall");
      }
      if (self.cushion === null) {
        this.sitOnNearest();
      }
      self.pose = "kneel";
      self.bowAt = this.serverNow;
      this.lastBowCountedCycle = 0;
      this.sendPresence({ type: "bow" });
      this.sound.bell(false);
    } else {
      self.bowAt = undefined;
      this.sendMove();
    }
    this.pacer.noteInteraction();
  }

  toggleSit() {
    const self = this.visitors.get(this.selfId);
    if (!self) return;
    if (self.cushion !== null) {
      this.standUp();
    } else {
      this.sitOnNearest();
    }
  }

  sitOnNearest() {
    const self = this.visitors.get(this.selfId);
    if (!self) return;
    const occupied = new Set();
    for (const [id, v] of this.visitors.entries()) {
      if (id !== this.selfId && v.cushion !== null) occupied.add(v.cushion);
    }

    const pool = this.space === "hall" ? this.cushionPositions : this.benchPositions;
    let best = null;
    let bestDist = Infinity;
    for (const slot of pool) {
      if (occupied.has(slot.id)) continue;
      const d = Math.hypot(slot.x - self.x, slot.z - self.z);
      if (d < bestDist) {
        bestDist = d;
        best = slot;
      }
    }
    if (!best) return;

    self.x = best.x;
    self.z = best.z;
    self.yaw = best.yaw;
    self.cushion = best.id;
    self.pose = "kneel";
    this.moveTarget = null;
    document.getElementById("btn-sit").setAttribute("aria-pressed", "true");
    document.getElementById("sit-btn-label").textContent = "일어나기";
    this.sendPresence({ type: "seat", cushion: best.id, x: self.x, z: self.z, yaw: self.yaw });
    this.pacer.noteInteraction();
  }

  standUp() {
    const self = this.visitors.get(this.selfId);
    if (!self) return;
    self.cushion = null;
    self.pose = "walk";
    self.bowAt = undefined;
    this.isBowingContinuous = false;
    document.getElementById("btn-bow").setAttribute("aria-pressed", "false");
    document.getElementById("btn-sit").setAttribute("aria-pressed", "false");
    document.getElementById("sit-btn-label").textContent = "좌복 앉기";
    this.sendPresence({ type: "stand" });
    this.pacer.noteInteraction();
  }

  offerIncenseRitual() {
    if (this.space !== "hall") {
      this.toggleSpace("hall");
    }
    const self = this.visitors.get(this.selfId);
    if (self) {
      self.cushion = null;
      self.x = 0;
      self.z = -9.6;
      self.yaw = Math.PI;
      this.sendMove();
    }
    this.sendPresence({ type: "incense", action: "offer" });
    for (const puff of this.smokeParticles) {
      puff.scale.setScalar(1.9);
    }
  }

  /* ------------------------------------------------------------------------
   * 108 Prayer Beads Overlay & Moktak Overlay (108 BPM)
   * ------------------------------------------------------------------------ */
  initOverlays() {
    // 1. 108 Beads Canvas
    const beadsHost = document.getElementById("beads-host");
    const beadsCanvas = document.getElementById("beads-canvas");
    document.getElementById("beads-close-btn").addEventListener("click", () => this.toggleBeadsOverlay(false));
    document.getElementById("beads-pull-btn").addEventListener("click", () => this.pullOneBead());

    let dragY = null;
    beadsCanvas.addEventListener("pointerdown", (e) => {
      dragY = e.clientY;
    });
    beadsCanvas.addEventListener("pointermove", (e) => {
      if (dragY === null) return;
      const dy = e.clientY - dragY;
      if (Math.abs(dy) >= 24) {
        dragY = e.clientY;
        this.pullOneBead();
      }
    });
    window.addEventListener("pointerup", () => {
      dragY = null;
    });
    beadsCanvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.pullOneBead();
      },
      { passive: false }
    );

    // 2. Moktak Canvas & 108 BPM Auto
    const moktakCanvas = document.getElementById("moktak-canvas");
    const autoBtn = document.getElementById("moktak-auto-btn");
    document.getElementById("moktak-close-btn").addEventListener("click", () => this.toggleMoktakOverlay(false));
    document.getElementById("moktak-hit-btn").addEventListener("click", () => this.strikeMoktak());
    moktakCanvas.addEventListener("pointerdown", () => this.strikeMoktak());

    autoBtn.addEventListener("click", () => {
      if (this.moktakAutoTimer) {
        clearInterval(this.moktakAutoTimer);
        this.moktakAutoTimer = null;
        autoBtn.setAttribute("aria-pressed", "false");
        autoBtn.textContent = "108 BPM 자동";
      } else {
        this.strikeMoktak();
        // 108 BPM = 60,000 / 108 = 555.56ms
        this.moktakAutoTimer = setInterval(() => this.strikeMoktak(), 60000 / 108);
        autoBtn.setAttribute("aria-pressed", "true");
        autoBtn.textContent = "108 BPM 정지";
      }
    });
  }

  toggleBeadsOverlay(forceState) {
    const host = document.getElementById("beads-host");
    const btn = document.getElementById("btn-beads");
    const open = forceState !== undefined ? forceState : host.hidden;
    host.hidden = !open;
    btn.setAttribute("aria-pressed", String(open));
    if (open) {
      this.sendPresence({ type: "bead" });
      this.drawBeadsCanvas();
    }
  }

  pullOneBead() {
    this.sound.bead();
    this.beadsCount += 1;
    this.beadsOffset = (this.beadsOffset + 1) % 108;
    if (this.beadsCount % 108 === 0) {
      this.beadsRounds += 1;
      this.sound.bell(true);
      this.showToast(`📿 108염주 ${fmtNum(this.beadsRounds)}바퀴를 원만히 회향했습니다.`);
    }
    localStorage.setItem("sansa:beads-count", String(this.beadsCount));
    localStorage.setItem("sansa:beads-rounds", String(this.beadsRounds));
    this.updatePracticeHUD();
    this.drawBeadsCanvas();
  }

  drawBeadsCanvas() {
    const c = document.getElementById("beads-canvas");
    if (!c || c.parentElement.hidden) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    // Cord line
    ctx.strokeStyle = "rgba(212, 180, 117, 0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c.width / 2, 0);
    ctx.lineTo(c.width / 2, c.height);
    ctx.stroke();

    const step = 38;
    for (let i = -1; i <= 8; i++) {
      const cy = i * step + 22;
      const beadIdx = (this.beadsCount + i + 108) % 108;
      const isMotherBead = beadIdx === 0; // 모주 (108번째 중심 알)
      const r = isMotherBead ? 18 : 14;

      const grad = ctx.createRadialGradient(c.width / 2 - 4, cy - 4, 2, c.width / 2, cy, r);
      if (isMotherBead) {
        grad.addColorStop(0, "#f5d996");
        grad.addColorStop(1, "#9c722c");
      } else {
        grad.addColorStop(0, "#a87951");
        grad.addColorStop(1, "#4e331c");
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(c.width / 2, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  toggleMoktakOverlay(forceState) {
    const host = document.getElementById("moktak-host");
    const btn = document.getElementById("btn-moktak");
    const open = forceState !== undefined ? forceState : host.hidden;
    host.hidden = !open;
    btn.setAttribute("aria-pressed", String(open));
    if (open) this.drawMoktakCanvas();
  }

  strikeMoktak() {
    this.sound.moktak();
    this.moktakPulse = 1.0;
    this.drawMoktakCanvas();
  }

  drawMoktakCanvas() {
    const c = document.getElementById("moktak-canvas");
    if (!c || c.parentElement.hidden) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    const cx = c.width / 2;
    const cy = c.height / 2;

    if (this.moktakPulse > 0.02) {
      ctx.strokeStyle = `rgba(231, 201, 140, ${this.moktakPulse * 0.65})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 52 + (1 - this.moktakPulse) * 34, 0, Math.PI * 2);
      ctx.stroke();
    }

    const scale = 1 - this.moktakPulse * 0.06;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    // Carved wooden Moktak body
    const grad = ctx.createRadialGradient(-12, -12, 8, 0, 0, 52);
    grad.addColorStop(0, "#b88456");
    grad.addColorStop(1, "#5c3b1e");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, Math.PI * 2);
    ctx.fill();

    // Resonant slit
    ctx.fillStyle = "#1d1209";
    ctx.beginPath();
    ctx.roundRect(-28, -5, 56, 11, 5);
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------------------
   * Server Picker, CAFE25 & Donation Box Modals
   * ------------------------------------------------------------------------ */
  async openServerPicker() {
    const dialog = document.getElementById("server-picker-dialog");
    const grid = document.getElementById("server-grid");
    dialog.showModal();
    try {
      const res = await fetch("/api/rooms?roomLimit=100");
      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.rooms)) return;
      grid.innerHTML = "";
      for (const r of data.rooms) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `server-item ${r.id === this.room ? "active" : ""}`;
        btn.innerHTML = `
          <span class="server-item-name">마루 ${fmtNum(r.number)}</span>
          <span class="server-item-count">${fmtNum(r.count)} / ${fmtNum(r.capacity)}명</span>
        `;
        btn.addEventListener("click", () => {
          this.switchRoom(r.id);
          closeTopLayer(dialog);
        });
        grid.appendChild(btn);
      }
    } catch (_e) {
      // ignore fetch error
    }
  }

  setupCafe25Modal() {
    const tabs = document.querySelectorAll("[data-cafe-tab]");
    const panels = {
      gift: document.getElementById("cafe-panel-gift"),
      practice: document.getElementById("cafe-panel-practice"),
      delivery: document.getElementById("cafe-panel-delivery"),
    };

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.getAttribute("data-cafe-tab");
        tabs.forEach((t) => {
          const active = t === tab;
          t.classList.toggle("active", active);
          t.setAttribute("aria-selected", String(active));
        });
        Object.entries(panels).forEach(([k, el]) => {
          el.hidden = k !== key;
        });
        if (key === "delivery") this.renderPostcard();
      });
    });

    // 1. 무소유 (Gift coffee to room)
    document.getElementById("cafe-brew-gift-btn").addEventListener("click", () => {
      const note = document.getElementById("cafe-gift-note").value.trim();
      this.sendPresence({ type: "cafe25", action: "share", message: note });
      this.sound.bell(false);
      closeTopLayer(document.getElementById("cafe25-dialog"));
      this.showToast("☕ 정성껏 내린 무소유 커피를 마당 나눔 탁자에 올려두었습니다.");
    });

    // 2. 풀소유 (25-bow practice or drink for 5-min speed 1.2x buff)
    document.getElementById("cafe-start-bow25-btn").addEventListener("click", () => {
      closeTopLayer(document.getElementById("cafe25-dialog"));
      if (this.bow25Count >= 25) {
        this.activatePulsoyuBuff();
      } else {
        this.bow25Active = true;
        this.updatePracticeHUD();
        if (!this.isBowingContinuous) this.toggleBowMode();
        this.showToast("🙇 풀소유 커피를 위한 25배 절하기 수행을 시작합니다.");
      }
    });

    // 3. 배달 (Postcard live preview & download)
    const toInput = document.getElementById("cafe-card-to");
    const msgInput = document.getElementById("cafe-card-msg");
    toInput.addEventListener("input", () => this.renderPostcard());
    msgInput.addEventListener("input", () => this.renderPostcard());

    document.getElementById("cafe-download-card-btn").addEventListener("click", () => {
      this.renderPostcard();
      const canvas = document.getElementById("cafe-postcard-canvas");
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = "sansa-cafe25-card.png";
      a.click();
      this.showToast("💌 산사 커피 안부 카드를 이미지로 저장했습니다.");
    });
  }

  activatePulsoyuBuff() {
    this.bow25Count = 0;
    this.bow25Active = false;
    this.buffUntil = performance.now() + BUFF_DURATION_MS;
    this.sound.bell(true);
    this.updatePracticeHUD();
    this.showToast("☕ 25배 수행을 마치고 풀소유 커피를 마셨습니다! (5분간 온기 오라 & 이동속도 1.2배)");
  }

  renderPostcard() {
    const c = document.getElementById("cafe-postcard-canvas");
    if (!c) return;
    const ctx = c.getContext("2d");
    const toText = document.getElementById("cafe-card-to").value.trim() || "소중한 벗에게";
    const msgText =
      document.getElementById("cafe-card-msg").value.trim() ||
      "오늘 하루도 고생 많았어요. 산사에서 따뜻한 커피 한 잔 보냅니다.";

    const grad = ctx.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, "#1f261f");
    grad.addColorStop(1, "#2c251d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.strokeStyle = "rgba(212, 180, 117, 0.5)";
    ctx.lineWidth = 2;
    ctx.strokeRect(14, 14, c.width - 28, c.height - 28);

    ctx.fillStyle = "#d4b475";
    ctx.font = "600 14px sans-serif";
    ctx.fillText("CAFE25 × 산사 (山寺) 마음 배달 카드", 32, 46);

    ctx.fillStyle = "#f2f0e8";
    ctx.font = "700 20px serif";
    ctx.fillText(`To. ${toText}`, 32, 86);

    ctx.fillStyle = "rgba(242, 240, 232, 0.86)";
    ctx.font = "400 15px sans-serif";
    ctx.fillText(msgText.slice(0, 32), 32, 132);
    if (msgText.length > 32) {
      ctx.fillText(msgText.slice(32, 64), 32, 158);
    }

    const selfName = this.visitors.get(this.selfId)?.name || "고요한 바람";
    ctx.fillStyle = "#e7c98c";
    ctx.font = "600 14px serif";
    ctx.fillText(`From. 산사 동자승 '${selfName}' 드림 ☕`, 32, 222);
  }

  setupDonationModal() {
    const amountInput = document.getElementById("donation-amount-input");
    const totalEl = document.getElementById("total-donation-display");
    const presets = document.querySelectorAll(".amount-preset");

    const updateDisplay = () => {
      totalEl.textContent = `${fmtNum(this.totalDonation)}원`;
    };
    updateDisplay();

    // Live 1,000-unit comma formatting on numeric input
    amountInput.addEventListener("input", () => {
      const digits = amountInput.value.replace(/[^\d]/g, "");
      const num = digits ? parseInt(digits, 10) : 0;
      amountInput.value = num > 0 ? fmtNum(num) : "";
      presets.forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.amount) === num);
      });
    });

    presets.forEach((btn) => {
      btn.addEventListener("click", () => {
        const amt = Number(btn.dataset.amount || 0);
        amountInput.value = fmtNum(amt);
        presets.forEach((b) => b.classList.toggle("active", b === btn));
      });
    });

    document.getElementById("submit-donation-btn").addEventListener("click", () => {
      const raw = parseInt(amountInput.value.replace(/[^\d]/g, ""), 10) || 0;
      if (raw <= 0) return;
      this.totalDonation += raw;
      localStorage.setItem("sansa:total-donation", String(this.totalDonation));
      updateDisplay();
      this.sound.bell(true);
      closeTopLayer(document.getElementById("support-dialog"));
      this.showToast(`🪷 복전함에 ${fmtNum(raw)}원의 공양과 발원문을 올렸습니다. 고맙습니다.`);
    });
  }

  /* ------------------------------------------------------------------------
   * Frame Update & Animation Loop
   * ------------------------------------------------------------------------ */
  sendMove() {
    const self = this.visitors.get(this.selfId);
    if (!self) return;
    const now = performance.now();
    if (now - (this.lastMoveSentAt || 0) < 120) return;
    this.lastMoveSentAt = now;
    this.sendPresence({
      type: "move",
      x: Number(self.x.toFixed(3)),
      z: Number(self.z.toFixed(3)),
      yaw: Number(self.yaw.toFixed(4)),
      pose: self.pose,
    });
  }

  updateSelfMovement(dt) {
    const self = this.visitors.get(this.selfId);
    if (!self) return;

    const now = performance.now();
    const buffActive = now < this.buffUntil;
    const buffPill = document.getElementById("buff-pill");
    if (buffActive) {
      buffPill.hidden = false;
      const remSec = Math.max(0, Math.ceil((this.buffUntil - now) / 1000));
      const m = String(Math.floor(remSec / 60)).padStart(2, "0");
      const s = String(remSec % 60).padStart(2, "0");
      document.getElementById("buff-timer").textContent = `${m}:${s}`;
    } else {
      buffPill.hidden = true;
    }

    const baseSpeed = 4.6 * (buffActive ? 1.2 : 1.0);
    let vx = 0;
    let vz = 0;

    if (this.keys.has("w") || this.keys.has("arrowup")) vz -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) vz += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) vx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) vx += 1;

    if (vx !== 0 || vz !== 0) {
      if (self.cushion !== null) this.standUp();
      const len = Math.hypot(vx, vz);
      vx /= len;
      vz /= len;
      const sin = Math.sin(this.camYaw);
      const cos = Math.cos(this.camYaw);
      const wx = vx * cos + vz * sin;
      const wz = -vx * sin + vz * cos;

      self.x += wx * baseSpeed * dt;
      self.z += wz * baseSpeed * dt;
      self.yaw = Math.atan2(wx, wz);
      self.pose = "walk";
      this.sendMove();
    } else if (this.moveTarget) {
      const dx = this.moveTarget.x - self.x;
      const dz = this.moveTarget.z - self.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.18) {
        this.moveTarget = null;
      } else {
        const step = Math.min(dist, baseSpeed * dt);
        self.x += (dx / dist) * step;
        self.z += (dz / dist) * step;
        self.yaw = Math.atan2(dx, dz);
        self.pose = "walk";
        this.sendMove();
      }
    }

    // Auto enter hall if walking through Chungyeondang doors
    if (this.space === "garden" && self.z < 1.2 && Math.abs(self.x) < 4.5) {
      this.toggleSpace("hall");
    } else if (this.space === "hall" && self.z > -0.8) {
      this.toggleSpace("garden");
    }
  }

  applyAvatarPose(v, mesh, nowPerf) {
    const { bodyRoot, torso, head, hands, auraRing } = mesh.userData;

    // 1. Prostration cycle (4,800ms + 400ms rest)
    if (v.pose === "kneel" && Number.isFinite(v.bowAt)) {
      const totalCycle = BOW_CYCLE_MS + BOW_REST_MS;
      const elapsed = Math.max(0, this.serverNow - v.bowAt);
      const cycleIndex = Math.floor(elapsed / totalCycle);
      const t = (elapsed % totalCycle) / 1000; // seconds within current cycle

      if (v.id === this.selfId && this.isBowingContinuous && cycleIndex > this.lastBowCountedCycle) {
        this.lastBowCountedCycle = cycleIndex;
        this.bowCount += 1;
        localStorage.setItem("sansa:bow-count", String(this.bowCount));
        if (this.bow25Active) {
          this.bow25Count = Math.min(25, this.bow25Count + 1);
          if (this.bow25Count >= 25) {
            this.activatePulsoyuBuff();
          }
        }
        this.updatePracticeHUD();
        this.sound.bell(false);
      }

      // Keyframe phases: prepare(0..0.55) -> lower(0.55..2.25) -> hold(2.25..2.9) -> rise(2.9..4.8)
      let bowFactor = 0;
      if (t >= 0.55 && t < 2.25) {
        bowFactor = (t - 0.55) / (2.25 - 0.55);
      } else if (t >= 2.25 && t < 2.9) {
        bowFactor = 1.0;
      } else if (t >= 2.9 && t < 4.8) {
        bowFactor = 1.0 - (t - 2.9) / (4.8 - 2.9);
      }
      const smooth = bowFactor * bowFactor * (3 - 2 * bowFactor);
      bodyRoot.position.y = -smooth * 0.28;
      torso.rotation.x = smooth * 1.12;
      head.position.y = 1.18 - smooth * 0.52;
      head.position.z = smooth * 0.46;
      hands.position.set(0, 0.68 - smooth * 0.45, 0.34 + smooth * 0.26);
    } else if (v.pose === "kneel" || v.pose === "beads") {
      // Seated meditation posture
      const breath = Math.sin(nowPerf * 0.0025 + v.seat) * 0.015;
      bodyRoot.position.y = -0.16 + breath;
      torso.rotation.x = 0.05;
      head.position.set(0, 1.16 + breath, 0.04);
      hands.position.set(0, 0.62, 0.34);
    } else {
      // Standing / Walking
      bodyRoot.position.y = 0;
      torso.rotation.x = 0;
      head.position.set(0, 1.18, 0);
      hands.position.set(0, 0.68, 0.34);
    }

    // Aura ring (Hello wave or CAFE25 Pulsoyu warmth buff)
    const isBuffedSelf = v.id === this.selfId && nowPerf < this.buffUntil;
    if (nowPerf < mesh.userData.helloUntil || isBuffedSelf) {
      auraRing.material.opacity = 0.45 + Math.sin(nowPerf * 0.008) * 0.2;
      const s = 1 + Math.sin(nowPerf * 0.006) * 0.12;
      auraRing.scale.set(s, s, 1);
    } else {
      auraRing.material.opacity = 0;
    }
  }

  animate(now) {
    requestAnimationFrame(this.animate);
    if (this.renderPaused) return;

    const dt = Math.min(0.05, (now - (this.lastFrameTime || now)) / 1000);
    this.lastFrameTime = now;

    const isMoving = this.keys.size > 0 || this.moveTarget !== null || this.isBowingContinuous;
    if (!this.pacer.shouldRender(now, this.visitors.size, this.isDraggingCam || isMoving)) {
      return;
    }

    this.updateSelfMovement(dt);

    // Toggle visible group by space
    this.gardenGroup.visible = this.space === "garden";
    this.hallGroup.visible = this.space === "hall";

    // Animate temple cat 'Gongyang-i' around the lotus pond
    if (this.catGroup && this.space === "garden") {
      const catAngle = now * 0.00045;
      const r = 5.35;
      this.catGroup.position.set(-8.5 + Math.cos(catAngle) * r, 0, 15.5 + Math.sin(catAngle) * r);
      this.catGroup.rotation.y = -catAngle;
    }

    // Animate incense smoke in Hall
    if (this.space === "hall") {
      for (const puff of this.smokeParticles) {
        puff.position.y += dt * 0.42;
        puff.position.x = Math.sin(now * 0.002 + puff.userData.phase) * 0.14;
        if (puff.position.y > 3.4) {
          puff.position.y = 1.45;
          puff.scale.setScalar(1.0);
        }
      }
    }

    // Decay moktak ripple
    if (this.moktakPulse > 0) {
      this.moktakPulse = Math.max(0, this.moktakPulse - dt * 3.2);
      this.drawMoktakCanvas();
    }

    // Update all visitor avatars
    for (const [id, v] of this.visitors.entries()) {
      const mesh = this.avatarMeshes.get(id);
      if (!mesh) continue;

      const inHall = v.z < 0;
      mesh.visible = (this.space === "hall" && inHall) || (this.space === "garden" && !inHall);
      if (!mesh.visible) continue;

      if (id !== this.selfId) {
        v.x += (v.targetX - v.x) * Math.min(1, dt * 8);
        v.z += (v.targetZ - v.z) * Math.min(1, dt * 8);
        v.yaw += (v.targetYaw - v.yaw) * Math.min(1, dt * 8);
      }
      mesh.position.set(v.x, 0, v.z);
      mesh.rotation.y = v.yaw;
      this.applyAvatarPose(v, mesh, now);
    }

    // Update Third-Person Orbit Camera following self
    const self = this.visitors.get(this.selfId);
    const focusX = self ? self.x : 0;
    const focusZ = self ? self.z : this.space === "hall" ? -6.5 : 18;
    const camX = focusX + Math.sin(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const camY = Math.max(1.4, Math.sin(this.camPitch) * this.camDist);
    const camZ = focusZ + Math.cos(this.camYaw) * Math.cos(this.camPitch) * this.camDist;

    this.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), 0.18);
    this.camera.lookAt(focusX, 1.2, focusZ);

    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.sansaApp = new SansaApp();
});
