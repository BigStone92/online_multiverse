import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

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
   * Three.js r180 Scene, GLTFLoader + Meshopt + PBR & IBL World Construction
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
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x212721);
    this.scene.fog = new THREE.FogExp2(0x212721, 0.014);

    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.2, 180);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // Texture & GLTF Loaders (EXT_meshopt_compression + KHR_mesh_quantization + native EXT_texture_webp)
    this.textureLoader = new THREE.TextureLoader();
    this.pbrCache = new Map();
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);

    // Load Equirectangular IBL Environment Map (woodland.jpg) for Goryeo gilded-bronze reflections
    this.textureLoader.load("/assets/environment/woodland.jpg", (envTex) => {
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      envTex.colorSpace = THREE.SRGBColorSpace;
      this.scene.environment = envTex;
      this.scene.environmentIntensity = 0.95;
    });

    // Preload sculpted novice monk rig (/assets/monk.glb)
    this.monkGltf = null;
    this.monkAssetPromise = this.gltfLoader
      .loadAsync("/assets/monk.glb")
      .then((gltf) => {
        gltf.scene.traverse((obj) => {
          if (obj.isMesh) {
            if (!obj.geometry.getAttribute("uv")) {
              const pos = obj.geometry.getAttribute("position");
              const uvs = new Float32Array(pos.count * 2);
              for (let i = 0; i < pos.count; i++) {
                uvs[i * 2] = (pos.getX(i) + pos.getZ(i)) * 0.8;
                uvs[i * 2 + 1] = pos.getY(i) * 0.8;
              }
              obj.geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
            }
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
              if (m && m.isMeshStandardMaterial) {
                m.roughness = Math.max(0.8, m.roughness);
              }
            }
          }
        });
        this.monkGltf = gltf;
        for (const [id, mesh] of this.avatarMeshes.entries()) {
          const v = this.visitors.get(id);
          if (v) this.upgradeAvatarToGltf(v, mesh);
        }
        return gltf;
      })
      .catch((err) => {
        console.warn("monk.glb load fallback:", err);
      });

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
      this.camPitch = Math.max(0.14, Math.min(1.15, this.camPitch + dy * 0.005));
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
        this.camDist = Math.max(5.5, Math.min(28, this.camDist + e.deltaY * 0.012));
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

  loadPbrMaterial(setName, repeatX = 2, repeatY = 2, options = {}) {
    const key = `${setName}|${repeatX}|${repeatY}|${options.color || "#ffffff"}|${options.roughness ?? 0.85}`;
    if (this.pbrCache.has(key)) return this.pbrCache.get(key);

    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy() || 4);
    const loadTex = (file, isSrgb) => {
      const t = this.textureLoader.load(`/assets/materials/${setName}/${file}`);
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeatX, repeatY);
      t.anisotropy = maxAniso;
      t.colorSpace = isSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return t;
    };

    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(options.color || "#ffffff"),
      map: loadTex("color.jpg", true),
      normalMap: loadTex("normal.jpg", false),
      normalScale: new THREE.Vector2(options.normalScale ?? 0.35, options.normalScale ?? 0.35),
      roughnessMap: loadTex("roughness.jpg", false),
      roughness: options.roughness ?? 0.86,
      metalness: options.metalness ?? 0.02,
      ...(options.emissive ? { emissive: new THREE.Color(options.emissive), emissiveIntensity: options.emissiveIntensity ?? 0.2 } : {}),
    });

    this.pbrCache.set(key, mat);
    return mat;
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
    // Natural Sanctuary Lighting
    const hemi = new THREE.HemisphereLight(0xe5ebd8, 0x2c3228, 0.92);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff0d4, 1.35);
    dir.position.set(18, 30, 20);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = 85;
    dir.shadow.bias = -0.0004;
    const d = 30;
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
    this.catMixer = null;

    this.buildGarden();
    this.buildHall();
  }

  buildGarden() {
    const groundPbr = this.loadPbrMaterial("ground", 14, 14, { color: "#8c9181", roughness: 0.95, normalScale: 0.45 });
    const stonePbr = this.loadPbrMaterial("stone", 4, 2, { color: "#c4c2b8", roughness: 0.85, normalScale: 0.4 });
    const pathStonePbr = this.loadPbrMaterial("stone", 2, 12, { color: "#b0b2a8", roughness: 0.86, normalScale: 0.45 });
    const woodPbr = this.loadPbrMaterial("wood", 2, 2, { color: "#c8a986", roughness: 0.78, normalScale: 0.35 });
    const darkWoodPbr = this.loadPbrMaterial("wood", 2, 2, { color: "#8c6d50", roughness: 0.8, normalScale: 0.35 });
    const plasterPbr = this.loadPbrMaterial("plaster", 3, 2, { color: "#e8e0cf", roughness: 0.9, normalScale: 0.25 });
    const roofPbr = this.loadPbrMaterial("roof", 8, 5, { color: "#767a7c", roughness: 0.72, metalness: 0.08, normalScale: 0.55 });
    const hanjiPbr = this.loadPbrMaterial("cloth", 2, 2, {
      color: "#f5e6c8",
      roughness: 0.85,
      normalScale: 0.15,
      emissive: "#dca959",
      emissiveIntensity: 0.38,
    });
    const rockPbr = this.loadPbrMaterial("rock", 2, 2, { color: "#989a92", roughness: 0.88, normalScale: 0.5 });

    // 1. Courtyard Ground & Dressed Stone Path (박석 참도)
    const ground = new THREE.Mesh(new THREE.CircleGeometry(52, 64), groundPbr);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, 14);
    ground.receiveShadow = true;
    this.gardenGroup.add(ground);

    const stonePath = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.06, 29), pathStonePbr);
    stonePath.position.set(0, 0.01, 16.5);
    stonePath.receiveShadow = true;
    this.gardenGroup.add(stonePath);

    // Stepping stone slabs along the path
    for (let i = 0; i < 12; i++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.08, 0.72), stonePbr);
      slab.position.set(0, 0.03, 3.2 + i * 2.2);
      slab.receiveShadow = true;
      this.gardenGroup.add(slab);
    }

    // 2. Chungyeondang (청연당 전통 한옥 목조 법당) at z = -6
    const temple = new THREE.Group();
    temple.name = "Cheongyeon-timber-devotional-hall";
    this.gardenGroup.add(temple);

    // 2a. Dressed Stone Foundation Platform (석조 기단) & 3-Tier Stone Steps (돌계단)
    const baseLower = new THREE.Mesh(new THREE.BoxGeometry(20.4, 0.52, 13.4), stonePbr);
    baseLower.position.set(0, 0.26, -6);
    baseLower.castShadow = true;
    baseLower.receiveShadow = true;
    const baseUpper = new THREE.Mesh(new THREE.BoxGeometry(19.4, 0.44, 12.4), stonePbr);
    baseUpper.position.set(0, 0.74, -6);
    baseUpper.castShadow = true;
    baseUpper.receiveShadow = true;
    const maruDeck = new THREE.Mesh(new THREE.BoxGeometry(18.2, 0.16, 11.4), darkWoodPbr);
    maruDeck.position.set(0, 1.02, -6);
    maruDeck.receiveShadow = true;
    temple.add(baseLower, baseUpper, maruDeck);

    for (let s = 0; s < 3; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.3, 0.65), stonePbr);
      step.position.set(0, 0.15 + s * 0.3, 1.45 - s * 0.6);
      step.castShadow = true;
      step.receiveShadow = true;
      temple.add(step);
    }
    // Stepped stone side cheeks (소맷돌)
    [-2.45, 2.45].forEach((sx) => {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.95, 2.1), stonePbr);
      cheek.position.set(sx, 0.48, 0.85);
      cheek.rotation.x = 0.36;
      cheek.castShadow = true;
      temple.add(cheek);
    });

    // 2b. Entasis Timber Pillars (배흘림 기둥, LatheGeometry) & Multi-tier Brackets (3단 공포)
    const pillarPts = [
      new THREE.Vector2(0.24, 0.0),
      new THREE.Vector2(0.28, 0.12),
      new THREE.Vector2(0.31, 0.9),
      new THREE.Vector2(0.32, 2.1),
      new THREE.Vector2(0.29, 3.6),
      new THREE.Vector2(0.25, 4.45),
    ];
    const pillarGeo = new THREE.LatheGeometry(pillarPts, 24);
    const colXs = [-7.8, -4.68, -1.56, 1.56, 4.68, 7.8];
    const colZs = [-1.15, -10.85];

    for (const cx of colXs) {
      for (const cz of colZs) {
        const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.22, 16), stonePbr);
        plinth.position.set(cx, 1.12, cz);
        const col = new THREE.Mesh(pillarGeo, woodPbr);
        col.position.set(cx, 1.22, cz);
        col.castShadow = true;
        col.receiveShadow = true;

        // 3-tier Korean Gongpo bracket cluster (주두 + 소로 + 첨차)
        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.2, 0.64), darkWoodPbr);
        cap.position.set(cx, 5.72, cz);
        const bracket1 = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.18, 0.85), woodPbr);
        bracket1.position.set(cx, 5.92, cz);
        const bracket2 = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.18, 1.15), darkWoodPbr);
        bracket2.position.set(cx, 6.12, cz);
        temple.add(plinth, col, cap, bracket1, bracket2);
      }
    }

    // Horizontal Eaves Beams (창방 · 평방 · 도리)
    for (const cz of colZs) {
      const beam1 = new THREE.Mesh(new THREE.BoxGeometry(16.6, 0.28, 0.38), woodPbr);
      beam1.position.set(0, 5.52, cz);
      const beam2 = new THREE.Mesh(new THREE.BoxGeometry(17.2, 0.26, 0.44), darkWoodPbr);
      beam2.position.set(0, 6.28, cz);
      temple.add(beam1, beam2);
    }

    // 2c. Plaster Side/Rear Walls (회벽) & Traditional Lattice Doors (분합문 창살 + 한지)
    const rearWall = new THREE.Mesh(new THREE.BoxGeometry(15.6, 4.3, 0.34), plasterPbr);
    rearWall.position.set(0, 3.35, -10.85);
    rearWall.castShadow = true;
    temple.add(rearWall);

    [-7.8, 7.8].forEach((wx) => {
      const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.3, 9.7), plasterPbr);
      sideWall.position.set(wx, 3.35, -6.0);
      sideWall.castShadow = true;
      const wainscoting = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.15, 9.8), darkWoodPbr);
      wainscoting.position.set(wx, 1.65, -6.0);
      temple.add(sideWall, wainscoting);
    });

    // 5 Front Bays between the 6 front pillars: outer 4 have closed Hanji lattice doors, center bay has open folding doors revealing a glimpse of the sanctuary
    for (let bay = 0; bay < 5; bay++) {
      const bx = (bay - 2) * 3.12;
      const transoms = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.75, 0.16), darkWoodPbr);
      transoms.position.set(bx, 5.05, -1.15);
      temple.add(transoms);

      if (bay === 2) {
        // Center entrance bay: warm golden interior glow + open side door leaves
        [-1.18, 1.18].forEach((dx) => {
          const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.58, 3.4, 0.1), hanjiPbr);
          leaf.position.set(bx + dx, 2.9, -1.15);
          temple.add(leaf);
        });
      } else {
        const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(2.86, 3.4, 0.1), hanjiPbr);
        doorPanel.position.set(bx, 2.9, -1.15);
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.72, 0.14), darkWoodPbr);
        skirt.position.set(bx, 1.52, -1.15);
        temple.add(doorPanel, skirt);

        // Wooden lattice ribs (띠살 창호)
        for (let r = -2; r <= 2; r++) {
          const vRib = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.4, 0.13), darkWoodPbr);
          vRib.position.set(bx + r * 0.52, 2.9, -1.15);
          temple.add(vRib);
        }
        for (let h = 0; h < 4; h++) {
          const hRib = new THREE.Mesh(new THREE.BoxGeometry(2.86, 0.05, 0.13), darkWoodPbr);
          hRib.position.set(bx, 2.05 + h * 0.65, -1.15);
          temple.add(hRib);
        }
      }
    }

    // Signboard (청연당 편액)
    const plaqueFrame = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.88, 0.18), darkWoodPbr);
    plaqueFrame.position.set(0, 6.08, -0.52);
    plaqueFrame.rotation.x = 0.08;
    temple.add(plaqueFrame);

    // 2d. Curved Korean Giwa Tiled Roof (팔작 기와지붕 + 처마 서까래 + 용마루/내림마루)
    const roofGroup = new THREE.Group();
    roofGroup.position.set(0, 6.42, -6.0);
    temple.add(roofGroup);

    // Eaves rafters (부연 · 서까래)
    for (let i = -18; i <= 18; i++) {
      const rx = i * 0.52;
      [-1, 1].forEach((dirZ) => {
        const rafter = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 2.4, 8), woodPbr);
        rafter.rotation.x = dirZ * 1.18;
        rafter.position.set(rx, 0.22, dirZ * 5.65);
        roofGroup.add(rafter);
      });
    }

    // Layered curved roof slopes (하단 처마 + 상단 팔작 물매)
    const lowerEave = new THREE.Mesh(new THREE.ConeGeometry(14.8, 2.35, 4), roofPbr);
    lowerEave.rotation.y = Math.PI / 4;
    lowerEave.scale.set(1.32, 1.0, 0.86);
    lowerEave.position.y = 1.05;
    lowerEave.castShadow = true;
    lowerEave.receiveShadow = true;

    const upperGable = new THREE.Mesh(new THREE.ConeGeometry(11.2, 2.45, 4), roofPbr);
    upperGable.rotation.y = Math.PI / 4;
    upperGable.scale.set(1.36, 1.0, 0.78);
    upperGable.position.y = 2.05;
    upperGable.castShadow = true;

    // Main horizontal ridge (용마루) & end ornaments (취두)
    const mainRidge = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.36, 0.44), stonePbr);
    mainRidge.position.set(0, 3.05, 0);
    [-6.3, 6.3].forEach((rx) => {
      const finial = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.58, 0.52), stonePbr);
      finial.position.set(rx, 3.22, 0);
      roofGroup.add(finial);
    });
    roofGroup.add(lowerEave, upperGable, mainRidge);

    // 3. Lotus Pond (연꽃 연못) & Natural Rock Boulders at x = -8.5, z = 15.5
    const pondGroup = new THREE.Group();
    pondGroup.position.set(-8.5, 0.02, 15.5);
    this.pondWater = new THREE.Mesh(
      new THREE.CircleGeometry(4.8, 40),
      new THREE.MeshStandardMaterial({
        color: 0x224642,
        roughness: 0.12,
        metalness: 0.55,
      })
    );
    this.pondWater.rotation.x = -Math.PI / 2;
    pondGroup.add(this.pondWater);

    // Natural rock rim around the pond
    for (let i = 0; i < 18; i++) {
      const ang = (i / 18) * Math.PI * 2;
      const boulder = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45 + (i % 3) * 0.16, 1), rockPbr);
      boulder.scale.set(1.2, 0.65, 1.0);
      boulder.position.set(Math.cos(ang) * 4.85, 0.18, Math.sin(ang) * 4.85);
      boulder.rotation.y = ang;
      boulder.castShadow = true;
      boulder.receiveShadow = true;
      pondGroup.add(boulder);
    }

    // Lotus pads & blossoms
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2;
      const rad = 1.3 + (i % 3) * 1.05;
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(0.46, 18),
        new THREE.MeshStandardMaterial({ color: 0x3b6e45, roughness: 0.78 })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(Math.cos(ang) * rad, 0.03, Math.sin(ang) * rad);
      pondGroup.add(pad);

      if (i % 2 === 0) {
        const flower = new THREE.Mesh(
          new THREE.ConeGeometry(0.2, 0.28, 10),
          new THREE.MeshStandardMaterial({
            color: 0xf4bfd0,
            emissive: 0x6a2c3e,
            emissiveIntensity: 0.28,
            roughness: 0.5,
          })
        );
        flower.position.set(Math.cos(ang) * rad, 0.16, Math.sin(ang) * rad);
        pondGroup.add(flower);
      }
    }
    this.gardenGroup.add(pondGroup);

    // 4. Temple Cat 'Gongyang-i' (사찰 고양이 공양이: /assets/cafe25-v5/gongyang-cat.glb)
    this.catGroup = new THREE.Group();
    this.gardenGroup.add(this.catGroup);
    this.gltfLoader
      .loadAsync("/assets/cafe25-v5/gongyang-cat.glb")
      .then((gltf) => {
        const catScene = gltf.scene;
        catScene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(catScene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const targetHeight = 0.52;
        const scale = targetHeight / Math.max(0.05, size.y);
        catScene.scale.setScalar(scale);
        catScene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
        catScene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        this.catGroup.add(catScene);
        if (gltf.animations && gltf.animations.length > 0) {
          this.catMixer = new THREE.AnimationMixer(catScene);
          this.catMixer.clipAction(gltf.animations[0]).play();
        }
      })
      .catch((err) => console.warn("gongyang-cat.glb load warning:", err));

    // 5. CAFE25 × Sansa Pavilion & Snowdrop Artwork at x = 9.2, z = 15.0
    const cafeBooth = new THREE.Group();
    cafeBooth.position.set(9.2, 0, 15.0);
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.08, 1.6), woodPbr);
    counter.position.y = 0.54;
    counter.castShadow = true;
    counter.receiveShadow = true;

    // 4 wooden corner posts & tiled pavilion roof
    [
      [-1.55, -0.68],
      [1.55, -0.68],
      [-1.55, 0.68],
      [1.55, 0.68],
    ].forEach(([px, pz]) => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 2.4, 12), darkWoodPbr);
      post.position.set(px, 1.2, pz);
      post.castShadow = true;
      cafeBooth.add(post);
    });

    const canopy = new THREE.Mesh(new THREE.ConeGeometry(3.1, 1.25, 4), roofPbr);
    canopy.rotation.y = Math.PI / 4;
    canopy.scale.set(1.25, 1, 0.85);
    canopy.position.y = 2.85;
    canopy.castShadow = true;

    // Framed Snowdrop Artwork (/assets/cafe25-v12/snowdrop-artwork.webp)
    const snowdropTex = this.textureLoader.load("/assets/cafe25-v12/snowdrop-artwork.webp");
    snowdropTex.colorSpace = THREE.SRGBColorSpace;
    const artFrame = new THREE.Mesh(new THREE.BoxGeometry(1.45, 1.05, 0.08), darkWoodPbr);
    artFrame.position.set(0, 1.72, -0.66);
    const artCanvas = new THREE.Mesh(
      new THREE.PlaneGeometry(1.32, 0.92),
      new THREE.MeshBasicMaterial({ map: snowdropTex })
    );
    artCanvas.position.set(0, 1.72, -0.61);

    const kettle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, 0.28, 16),
      new THREE.MeshStandardMaterial({ color: 0xd4b475, metalness: 0.78, roughness: 0.25 })
    );
    kettle.position.set(-0.35, 1.22, 0.15);
    const dripStand = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.22, 16), hanjiPbr);
    dripStand.position.set(0.35, 1.19, 0.15);

    const cafeLight = new THREE.PointLight(0xffcb80, 1.8, 11);
    cafeLight.position.set(0, 2.25, 0.4);
    cafeBooth.add(counter, canopy, artFrame, artCanvas, kettle, dripStand, cafeLight);
    this.gardenGroup.add(cafeBooth);

    // 6. Garden Benches (wood PBR, cushion 100..105)
    const benchCoords = [
      { x: -7.5, z: 10.0, yaw: 0.4 },
      { x: -7.5, z: 21.0, yaw: 2.6 },
      { x: 7.5, z: 10.5, yaw: -0.5 },
      { x: 8.0, z: 19.5, yaw: -2.4 },
      { x: -3.5, z: 25.0, yaw: 0.0 },
      { x: 3.5, z: 25.0, yaw: 0.0 },
    ];
    benchCoords.forEach((b, idx) => {
      const benchGroup = new THREE.Group();
      benchGroup.position.set(b.x, 0, b.z);
      benchGroup.rotation.y = b.yaw;
      const seatPlank = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.62), woodPbr);
      seatPlank.position.y = 0.42;
      seatPlank.castShadow = true;
      seatPlank.receiveShadow = true;
      [-0.72, 0.72].forEach((lx) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.54), darkWoodPbr);
        leg.position.set(lx, 0.2, 0);
        leg.castShadow = true;
        benchGroup.add(leg);
      });
      benchGroup.add(seatPlank);
      this.gardenGroup.add(benchGroup);
      this.benchPositions.push({ id: 100 + idx, x: b.x, z: b.z, yaw: b.yaw });
    });

    // 7. Traditional Korean Stone Lanterns (석등) along the courtyard path
    for (let i = 0; i < 5; i++) {
      const zPos = 4.5 + i * 5.2;
      [-2.6, 2.6].forEach((xPos) => {
        const sl = new THREE.Group();
        sl.position.set(xPos, 0, zPos);
        const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.35, 8), stonePbr);
        pedestal.position.y = 0.175;
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.95, 8), stonePbr);
        shaft.position.y = 0.82;
        const lightBox = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.38, 6), hanjiPbr);
        lightBox.position.y = 1.48;
        const capRoof = new THREE.Mesh(new THREE.ConeGeometry(0.46, 0.28, 6), roofPbr);
        capRoof.position.y = 1.8;
        sl.add(pedestal, shaft, lightBox, capRoof);
        this.gardenGroup.add(sl);
      });
    }

    // 8. Sculpted 3D Korean Pine Trees (/assets/models/pine.glb)
    const pineCoords = [];
    for (let i = 0; i < 20; i++) {
      const ang = (i / 20) * Math.PI * 2;
      const rad = 18.2 + (i % 3) * 4.2;
      const px = Math.cos(ang) * rad;
      const pz = 14 + Math.sin(ang) * rad;
      if (pz < 2.5 && Math.abs(px) < 11.5) continue;
      if (Math.hypot(px + 8.5, pz - 15.5) < 7.5) continue;
      if (Math.hypot(px - 9.2, pz - 15.0) < 5.5) continue;
      pineCoords.push({ x: px, z: pz, height: 4.8 + (i % 4) * 1.15, yaw: i * 1.37 });
    }

    this.gltfLoader
      .loadAsync("/assets/models/pine.glb")
      .then((gltf) => {
        const variants = gltf.scene.children.filter((c) => c.name.startsWith("pine_sapling"));
        const pool = variants.length > 0 ? variants : [gltf.scene];

        pineCoords.forEach((pc, idx) => {
          const sample = pool[idx % pool.length].clone(true);
          sample.position.set(0, 0, 0);
          sample.rotation.set(0, 0, 0);
          sample.scale.setScalar(1);
          const wrapper = new THREE.Group();
          wrapper.add(sample);
          wrapper.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(sample);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const scale = pc.height / Math.max(0.1, size.y);
          sample.scale.setScalar(scale);
          sample.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
          sample.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          wrapper.position.set(pc.x, 0, pc.z);
          wrapper.rotation.y = pc.yaw;
          this.gardenGroup.add(wrapper);
        });
      })
      .catch((err) => {
        console.warn("pine.glb fallback:", err);
      });
  }

  buildHall() {
    const floorWoodPbr = this.loadPbrMaterial("wood", 6, 6, { color: "#967252", roughness: 0.62, normalScale: 0.28 });
    const darkWoodPbr = this.loadPbrMaterial("wood", 3, 2, { color: "#6e4f35", roughness: 0.68, normalScale: 0.35 });
    const stonePbr = this.loadPbrMaterial("stone", 4, 1, { color: "#b5b3a8", roughness: 0.82, normalScale: 0.35 });
    const plasterPbr = this.loadPbrMaterial("plaster", 4, 2, { color: "#dfd6c3", roughness: 0.9, normalScale: 0.2 });

    // 1. Sanctuary Wooden Well-Frame Floor (청연당 우물마루 바닥)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 16.5), floorWoodPbr);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.01, -6.5);
    floor.receiveShadow = true;
    this.hallGroup.add(floor);

    // Interior Timber Columns & Ceiling Beams
    for (const cx of [-7.6, 7.6]) {
      for (const cz of [-2.5, -6.5, -10.5]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 6.2, 20), darkWoodPbr);
        col.position.set(cx, 3.1, cz);
        col.castShadow = true;
        this.hallGroup.add(col);
      }
    }

    // 2. Rear Sanctuary Mural Wall (후불탱화: /assets/altar-wall-calm-20261102.jpg)
    const muralTex = this.textureLoader.load("/assets/altar-wall-calm-20261102.jpg");
    muralTex.colorSpace = THREE.SRGBColorSpace;
    muralTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy() || 4);
    const muralMat = new THREE.MeshStandardMaterial({
      map: muralTex,
      color: 0xd8ceb8,
      roughness: 0.88,
      metalness: 0.02,
      normalMap: plasterPbr.normalMap,
      normalScale: new THREE.Vector2(0.08, 0.08),
    });
    const rearMuralWall = new THREE.Mesh(new THREE.BoxGeometry(15.6, 7.2, 0.28), [
      plasterPbr,
      plasterPbr,
      plasterPbr,
      plasterPbr,
      muralMat,
      plasterPbr,
    ]);
    rearMuralWall.position.set(0, 3.6, -13.65);
    rearMuralWall.receiveShadow = true;
    this.hallGroup.add(rearMuralWall);

    // 3. Multi-Tier Altar Platform (수미단 / 불단) at z = -12.1
    const stoneDais = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.24, 3.2), stonePbr);
    stoneDais.position.set(0, 0.12, -12.1);
    stoneDais.receiveShadow = true;

    const altarLower = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.56, 2.75), darkWoodPbr);
    altarLower.position.set(0, 0.52, -12.1);
    altarLower.castShadow = true;
    altarLower.receiveShadow = true;

    const altarWaist = new THREE.Mesh(new THREE.BoxGeometry(11.1, 0.36, 2.45), floorWoodPbr);
    altarWaist.position.set(0, 0.98, -12.1);
    altarWaist.castShadow = true;

    const altarTop = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.18, 2.85), darkWoodPbr);
    altarTop.position.set(0, 1.25, -12.1);
    altarTop.castShadow = true;
    altarTop.receiveShadow = true;
    this.hallGroup.add(stoneDais, altarLower, altarWaist, altarTop);

    // 4. Sculpted Bronze Lotus Pedestals (연화대좌) & Goryeo Gilded Bronze Amitabha Triad (.glb)
    const bronzePedestalMat = new THREE.MeshStandardMaterial({
      color: 0xb89958,
      metalness: 0.72,
      roughness: 0.36,
      normalMap: plasterPbr.normalMap,
      normalScale: new THREE.Vector2(0.08, 0.08),
    });

    const buildLotusPedestal = (x, y, z, radius, height) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      const pts = [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(radius * 0.96, 0),
        new THREE.Vector2(radius * 1.02, height * 0.18),
        new THREE.Vector2(radius * 0.86, height * 0.42),
        new THREE.Vector2(radius * 0.82, height * 0.68),
        new THREE.Vector2(radius * 0.95, height * 0.86),
        new THREE.Vector2(radius * 0.98, height),
        new THREE.Vector2(0, height),
      ];
      const base = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), bronzePedestalMat);
      base.scale.set(1, 1, 0.78);
      base.castShadow = true;
      base.receiveShadow = true;
      g.add(base);

      const petalGeo = new THREE.SphereGeometry(radius * 0.16, 12, 10);
      for (let i = 0; i < 18; i++) {
        const ang = (i / 18) * Math.PI * 2;
        const petal = new THREE.Mesh(petalGeo, bronzePedestalMat);
        petal.scale.set(0.85, 0.55, 1.25);
        petal.position.set(Math.sin(ang) * radius * 0.92, height * 0.52, Math.cos(ang) * radius * 0.72);
        petal.rotation.y = ang;
        g.add(petal);
      }
      this.hallGroup.add(g);
    };

    buildLotusPedestal(0, 1.34, -12.05, 1.18, 0.34);
    buildLotusPedestal(-3.35, 1.34, -12.15, 0.86, 0.28);
    buildLotusPedestal(3.35, 1.34, -12.15, 0.86, 0.28);

    const triadSpecs = [
      { url: "/assets/models/buddha.glb", x: 0, baseY: 1.66, z: -12.05, height: 3.15, yaw: 0, name: "본존 아미타불" },
      { url: "/assets/models/mahastamaprapta.glb", x: -3.35, baseY: 1.6, z: -12.15, height: 2.68, yaw: 0.06, name: "대세지보살" },
      { url: "/assets/models/avalokitesvara.glb", x: 3.35, baseY: 1.6, z: -12.15, height: 2.68, yaw: -0.06, name: "관세음보살" },
    ];

    triadSpecs.forEach((spec) => {
      this.gltfLoader
        .loadAsync(spec.url)
        .then((gltf) => {
          const root = gltf.scene;
          root.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(root);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const scale = spec.height / Math.max(0.1, size.y);

          const holder = new THREE.Group();
          holder.name = spec.name;
          holder.add(root);
          holder.scale.setScalar(scale);
          holder.rotation.y = spec.yaw;
          holder.position.set(
            spec.x - center.x * scale,
            spec.baseY - box.min.y * scale,
            spec.z - center.z * scale
          );

          root.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              for (const m of mats) {
                if (m && m.isMeshStandardMaterial) {
                  m.envMapIntensity = 1.25;
                  m.needsUpdate = true;
                }
              }
            }
          });
          this.hallGroup.add(holder);
        })
        .catch((err) => console.warn(`Failed to load ${spec.url}:`, err));
    });

    // Offering Candlesticks (청동 촛대) & Celadon Vases (청자 화병) on the Altar
    const celadonMat = new THREE.MeshStandardMaterial({ color: 0x6d8978, roughness: 0.42, metalness: 0.1 });
    const candleWaxMat = new THREE.MeshStandardMaterial({
      color: 0xf4ead5,
      emissive: 0xffd28a,
      emissiveIntensity: 0.35,
      roughness: 0.6,
    });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffbe55 });

    [-1.95, 1.95].forEach((cx) => {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.14, 0.32, 16), bronzePedestalMat);
      stand.position.set(cx, 1.5, -11.0);
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.32, 16), candleWaxMat);
      candle.position.set(cx, 1.82, -11.0);
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 10), flameMat);
      flame.scale.set(0.7, 1.8, 0.7);
      flame.position.set(cx, 2.02, -11.0);
      this.hallGroup.add(stand, candle, flame);
    });

    [-4.8, 4.8].forEach((vx) => {
      const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.38, 18), celadonMat);
      vase.position.set(vx, 1.53, -11.05);
      this.hallGroup.add(vase);
    });

    // Hanging Hanji Hall Lanterns (법당 한지 연등) & Warm Altar Illumination
    const lanternMat = new THREE.MeshStandardMaterial({
      color: 0xf6ebd4,
      emissive: 0xffb866,
      emissiveIntensity: 0.55,
      roughness: 0.7,
    });
    for (const lx of [-4.2, 0, 4.2]) {
      for (const lz of [-5.2, -8.8]) {
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.2, 6), darkWoodPbr);
        cord.position.set(lx, 5.6, lz);
        const globe = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 14), lanternMat);
        globe.scale.set(1, 1.15, 1);
        globe.position.set(lx, 4.95, lz);
        this.hallGroup.add(cord, globe);
      }
    }

    const altarLightCenter = new THREE.PointLight(0xffd285, 2.8, 22);
    altarLightCenter.position.set(0, 4.6, -9.8);
    const altarLightLeft = new THREE.PointLight(0xffca7a, 1.6, 16);
    altarLightLeft.position.set(-4.2, 3.8, -10.2);
    const altarLightRight = new THREE.PointLight(0xffca7a, 1.6, 16);
    altarLightRight.position.set(4.2, 3.8, -10.2);
    this.hallGroup.add(altarLightCenter, altarLightLeft, altarLightRight);

    // 5. Incense Burner (청동 향로) & Smoke Particles + Donation Box (복전함)
    const incenseStand = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.76, 0.68), darkWoodPbr);
    incenseStand.position.set(0, 0.38, -10.2);
    incenseStand.castShadow = true;
    const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.24, 0.42, 24), bronzePedestalMat);
    burner.position.set(0, 0.96, -10.2);
    burner.castShadow = true;
    this.hallGroup.add(incenseStand, burner);

    const donationBox = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.76, 0.58), darkWoodPbr);
    donationBox.position.set(2.35, 0.38, -10.2);
    donationBox.castShadow = true;
    this.hallGroup.add(donationBox);

    const smokeMat = new THREE.MeshBasicMaterial({ color: 0xe2dfd4, transparent: true, opacity: 0.32 });
    for (let i = 0; i < 12; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), smokeMat.clone());
      puff.position.set(0, 1.25 + i * 0.16, -10.2);
      puff.userData = { phase: i * 0.55 };
      this.hallGroup.add(puff);
      this.smokeParticles.push(puff);
    }

    // 6. 24 Woven Linen Meditation Cushions (좌복 그리드, cloth PBR, cushion 0..23)
    const cushionMats = ["#85877f", "#8e8d83", "#7c8179"].map((hex) =>
      this.loadPbrMaterial("cloth", 1, 1, { color: hex, roughness: 0.92, normalScale: 0.25 })
    );
    let idx = 0;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 6; col++) {
        const cx = (col - 2.5) * 2.2;
        const cz = -4.2 - row * 1.75;
        const cushion = new THREE.Mesh(
          new THREE.BoxGeometry(0.96, 0.1, 0.96),
          cushionMats[(row + col) % cushionMats.length]
        );
        cushion.position.set(cx, 0.06, cz);
        cushion.castShadow = true;
        cushion.receiveShadow = true;
        this.hallGroup.add(cushion);
        this.cushionPositions.push({ id: idx++, x: cx, z: cz, yaw: Math.PI });
      }
    }
  }

  /* ------------------------------------------------------------------------
   * Child Monk Avatar (/assets/monk.glb SkinnedMesh + 2-Bone IK + Morph Rig)
   * ------------------------------------------------------------------------ */
  createMonkAvatar(visitor) {
    const group = new THREE.Group();
    const bodyRoot = new THREE.Group();
    group.add(bodyRoot);

    // Fallback mesh while monk.glb finishes loading
    const fallbackGroup = new THREE.Group();
    const robeMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(visitor.color || "#a89f91"),
      roughness: 0.82,
    });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xeed9c4, roughness: 0.65 });
    const torso = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.92, 14), robeMat);
    torso.position.y = 0.48;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 16), skinMat);
    head.position.y = 1.12;
    const hands = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 10), skinMat);
    hands.position.set(0, 0.65, 0.32);
    fallbackGroup.add(torso, head, hands);
    bodyRoot.add(fallbackGroup);

    // Greeting / Warmth Aura Ring on ground
    const auraRing = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.6, 28),
      new THREE.MeshBasicMaterial({
        color: 0xe7c98c,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.0,
      })
    );
    auraRing.rotation.x = -Math.PI / 2;
    auraRing.position.y = 0.03;
    group.add(auraRing);

    // Floating Nameplate Sprite
    const nameplate = this.createNameplateSprite(visitor.name, visitor.id === this.selfId);
    nameplate.position.set(0, 1.55, 0);
    group.add(nameplate);

    group.userData = {
      bodyRoot,
      fallbackGroup,
      torso,
      head,
      hands,
      auraRing,
      nameplate,
      helloUntil: 0,
      rig: null,
      stance: visitor.pose === "walk" ? 1 : 0,
      prevX: visitor.x,
      prevZ: visitor.z,
      walkSpeed: 0,
    };

    if (this.monkGltf) {
      this.upgradeAvatarToGltf(visitor, group);
    }
    return group;
  }

  upgradeAvatarToGltf(visitor, group) {
    if (!this.monkGltf || group.userData.rig) return;

    const cloned = SkeletonUtils.clone(this.monkGltf.scene);
    // In monk.glb, forward is -Z; rotate Math.PI so local +Z of bodyRoot is forward
    cloned.rotation.y = Math.PI;

    const bones = new Map();
    const restPose = new Map();
    const morphTargets = [];

    cloned.traverse((node) => {
      if (node.isBone) {
        bones.set(node.name.replace(/([LR])$/, ".$1"), node);
      }
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;

        // Subtle personalized robe tint on outer saffron robe for companions
        if (visitor.color && (node.name.includes("Saffron") || node.name.includes("Robe"))) {
          const baseMat = node.material;
          if (baseMat && baseMat.isMeshStandardMaterial) {
            const tinted = baseMat.clone();
            tinted.color.lerp(new THREE.Color(visitor.color), 0.28);
            node.material = tinted;
          }
        }

        for (const kind of ["restingFold", "prayerCloth", "bowCloth", "kneelingCover"]) {
          const idx = node.morphTargetDictionary?.[kind];
          if (idx !== undefined) {
            morphTargets.push({ mesh: node, index: idx, kind });
          }
        }
      }
    });

    const bodyRoot = group.userData.bodyRoot;
    if (group.userData.fallbackGroup) {
      bodyRoot.remove(group.userData.fallbackGroup);
      group.userData.fallbackGroup = null;
    }
    bodyRoot.add(cloned);
    cloned.updateWorldMatrix(true, true);

    const rootInvQuat = cloned.getWorldQuaternion(new THREE.Quaternion()).invert();
    const axisXConst = new THREE.Vector3(1, 0, 0);
    const axisZConst = new THREE.Vector3(0, 0, 1);

    for (const [name, bone] of bones.entries()) {
      const worldQ = rootInvQuat.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
      const childBone = bone.children.find((c) => c.isBone);
      const boneLocalPos = cloned.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
      let dir = (
        childBone
          ? cloned.worldToLocal(childBone.getWorldPosition(new THREE.Vector3()))
          : boneLocalPos.clone().add(new THREE.Vector3(0, 0.1, 0))
      )
        .sub(boneLocalPos)
        .normalize();
      if (name.startsWith("hand.")) {
        dir = new THREE.Vector3(0, -1, 0);
      }
      const invWorldQ = worldQ.clone().invert();
      restPose.set(name, {
        rotation: bone.quaternion.clone(),
        world: worldQ,
        position: bone.position.clone(),
        direction: dir,
        axisX: axisXConst.clone().applyQuaternion(invWorldQ),
        axisZ: axisZConst.clone().applyQuaternion(invWorldQ),
      });
    }

    group.userData.rig = {
      root: cloned,
      bones,
      restPose,
      morphTargets,
      scratch: {
        rot: new THREE.Quaternion(),
        dir: new THREE.Vector3(),
        desired: new THREE.Quaternion(),
        twist: new THREE.Quaternion(),
        parentQ: new THREE.Quaternion(),
        rootQ: new THREE.Quaternion(),
        rootInvMat: new THREE.Matrix4(),
        pos: new THREE.Vector3(),
        scale: new THREE.Vector3(),
        shoulder: new THREE.Vector3(),
        to: new THREE.Vector3(),
        pole: new THREE.Vector3(),
        elbow: new THREE.Vector3(),
        target: new THREE.Vector3(),
        handDir: new THREE.Vector3(),
        handTarget: new THREE.Vector3(),
        leftFoot: new THREE.Vector3(),
        rightFoot: new THREE.Vector3(),
      },
    };
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

  applyAvatarPose(v, mesh, nowPerf, dt = 0.016) {
    const ud = mesh.userData;
    const { bodyRoot, torso, head, hands, auraRing, rig } = ud;
    const smoothstep5 = (x) => {
      const c = THREE.MathUtils.clamp(x, 0, 1);
      return c * c * c * (c * (c * 6 - 15) + 10);
    };

    // Estimate walking speed for natural stride swing
    const dx = v.x - (ud.prevX ?? v.x);
    const dz = v.z - (ud.prevZ ?? v.z);
    ud.prevX = v.x;
    ud.prevZ = v.z;
    const instSpeed = dt > 0.001 ? Math.hypot(dx, dz) / dt : 0;
    ud.walkSpeed = THREE.MathUtils.lerp(ud.walkSpeed || 0, THREE.MathUtils.clamp(instSpeed / 3.8, 0, 1), Math.min(1, dt * 10));

    // 1. Prostration cycle (4,800ms + 400ms rest)
    let bowG = 0;
    let bowPrepareLift = 0;
    if (v.pose === "kneel" && Number.isFinite(v.bowAt)) {
      const totalCycle = BOW_CYCLE_MS + BOW_REST_MS;
      const elapsed = Math.max(0, this.serverNow - v.bowAt);
      const cycleIndex = Math.floor(elapsed / totalCycle);
      const t = (elapsed % totalCycle) / 1000;

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

      if (t < 0.55) {
        bowPrepareLift = Math.sin((t / 0.55) * Math.PI) * 0.028;
      } else if (t >= 0.55 && t < 2.25) {
        bowG = smoothstep5((t - 0.55) / (2.25 - 0.55));
      } else if (t >= 2.25 && t < 2.9) {
        bowG = 1.0;
      } else if (t >= 2.9 && t < 4.8) {
        bowG = 1.0 - smoothstep5((t - 2.9) / (4.8 - 2.9));
      }
    }

    // 2. If monk.glb SkinnedMesh rig is active, drive full 17-bone + 2-bone IK + 4 morph targets
    if (rig) {
      const s = rig.scratch;
      const timeSec = nowPerf * 0.001 + (v.seat || 0) * 0.37;
      const isStandingMode = v.pose === "walk" || v.pose === "dance";
      ud.stance = THREE.MathUtils.damp(ud.stance ?? (isStandingMode ? 1 : 0), isStandingMode ? 1 : 0, 7, Math.min(0.1, dt));
      const l = ud.stance; // 0 = kneeling, 1 = standing
      const z = 1 - l; // kneeling blend

      // Greeting bow & clasp blend
      const helloRem = (ud.helloUntil - nowPerf) / 1000;
      const greetClasp = helloRem > 0 ? Math.sin(THREE.MathUtils.clamp(helloRem / 3.2, 0, 1) * Math.PI) : 0;
      const greetBow = helloRem > 0 ? Math.sin(THREE.MathUtils.clamp((helloRem - 0.3) / 2.6, 0, 1) * Math.PI) * 0.55 : 0;

      // Cloth morph targets (restingFold, prayerCloth, bowCloth, kneelingCover)
      for (const mt of rig.morphTargets) {
        if (mt.mesh.morphTargetInfluences) {
          mt.mesh.morphTargetInfluences[mt.index] =
            z * (mt.kind === "prayerCloth" ? 1 - bowG : mt.kind === "bowCloth" ? bowG : 1);
        }
      }

      const rotateBone = (name, angleX, angleZ = 0) => {
        const bone = rig.bones.get(name);
        const rest = rig.restPose.get(name);
        if (!bone || !rest) return;
        bone.quaternion.copy(rest.rotation).multiply(s.rot.setFromAxisAngle(rest.axisX, angleX));
        if (angleZ) {
          bone.quaternion.multiply(s.rot.setFromAxisAngle(rest.axisZ, angleZ));
        }
      };

      const localBonePos = (bone, out) => out.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(s.rootInvMat);

      const aimBone = (name, targetVec, twist = 0) => {
        const bone = rig.bones.get(name);
        const rest = rig.restPose.get(name);
        if (!bone || !rest || !bone.parent) return;
        const dir = s.dir.copy(targetVec).sub(localBonePos(bone, s.pos)).normalize();
        const desired = s.desired.setFromUnitVectors(rest.direction, dir).multiply(rest.world);
        if (twist) desired.premultiply(s.twist.setFromAxisAngle(dir, twist));
        desired.premultiply(s.rootQ);
        bone.parent.matrixWorld.decompose(s.pos, s.parentQ, s.scale);
        bone.quaternion.copy(s.parentQ.invert().multiply(desired));
        bone.updateWorldMatrix(false, true);
      };

      const solveArmIK = (side, targetVec, handDir, twist, prayerBlend = 0) => {
        const upper = rig.bones.get(`upper_arm.${side}`);
        const forearm = rig.bones.get(`forearm.${side}`);
        const hand = rig.bones.get(`hand.${side}`);
        if (!upper || !forearm) return;
        const shoulder = localBonePos(upper, s.shoulder);
        const sign = side === "L" ? -1 : 1;
        const l1 = 0.2016;
        const l2 = 0.1517;
        const to = s.to.copy(targetVec).sub(shoulder);
        const dist = THREE.MathUtils.clamp(to.length(), 0.045, l1 + l2 - 0.004);
        const dir = to.normalize();
        const pole = s.pole
          .set(
            sign * THREE.MathUtils.lerp(0.38, 0.24, prayerBlend),
            shoulder.y - THREE.MathUtils.lerp(0.1, 0.15, prayerBlend),
            shoulder.z - 0.045
          )
          .sub(shoulder);
        const ortho = pole.addScaledVector(dir, -pole.dot(dir)).normalize();
        const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
        const elbow = s.elbow
          .copy(shoulder)
          .addScaledVector(dir, a)
          .addScaledVector(ortho, Math.sqrt(Math.max(0, l1 * l1 - a * a)));
        aimBone(`upper_arm.${side}`, elbow);
        aimBone(`forearm.${side}`, targetVec);
        if (hand) {
          aimBone(`hand.${side}`, localBonePos(hand, s.handTarget).add(handDir), twist);
        }
      };

      // Hips height & breathing
      const breath = Math.sin(timeSec * 1.35) * 0.008;
      const hipTargetY = THREE.MathUtils.lerp(0.18 - bowG * 0.03, 0.7, l);
      const hipsBone = rig.bones.get("hips");
      const hipsRest = rig.restPose.get("hips");
      if (hipsBone && hipsRest) {
        hipsBone.position.copy(hipsRest.position);
        hipsBone.position.y += hipTargetY - 0.7;
      }

      rotateBone("hips", 0);
      rotateBone("spine", (-bowG * 1.43 + bowPrepareLift + breath) * z - greetBow);
      rotateBone("chest", -bowG * 0.03 * z + breath * 0.5);
      rotateBone("neck", bowG * 0.12 * z);
      rotateBone("head", -0.04 * z);

      // Leg & arm stride / kneeling angles
      const walkPhase = timeSec * 7.0;
      const stride = Math.sin(walkPhase) * 0.42 * ud.walkSpeed;
      const kneelKneeAngle = Math.acos(THREE.MathUtils.clamp((0.18 - bowG * 0.03 - 0.095) / 0.34, -1, 1));

      for (const side of ["L", "R"]) {
        const legSwing = stride * (side === "L" ? -1 : 1);
        const kneeLift = Math.max(0, -Math.sin(walkPhase + (side === "L" ? Math.PI : 0))) * 0.7 * ud.walkSpeed;
        rotateBone(`thigh.${side}`, kneelKneeAngle * z + legSwing * l);
        rotateBone(`shin.${side}`, (-kneelKneeAngle - 1.5) * z - kneeLift * l);
        rotateBone(`foot.${side}`, 1.5 * z + (kneeLift - legSwing) * l);
        rotateBone(`upper_arm.${side}`, -legSwing * 0.64 * l);
        rotateBone(`forearm.${side}`, 0.18 * l);
        rotateBone(`hand.${side}`, 0);
      }

      if (v.pose === "dance") {
        const beat = timeSec * (108 / 60) * Math.PI * 2;
        rotateBone("head", Math.sin(beat) * 0.07, -Math.sin(beat * 0.5) * 0.08);
        for (const side of ["L", "R"]) {
          const sign = side === "L" ? -1 : 1;
          rotateBone(`upper_arm.${side}`, 0.65 + Math.sin(beat * 0.5 + sign * 0.7) * 0.28, sign * (0.42 + Math.sin(beat) * 0.12));
          rotateBone(`forearm.${side}`, 0.9 - Math.sin(beat * 0.5 + sign) * 0.3);
          rotateBone(`thigh.${side}`, 0.08 + Math.sin(beat + sign) * 0.1);
          rotateBone(`shin.${side}`, -0.16 - Math.max(0, Math.sin(beat + sign)) * 0.14);
          rotateBone(`foot.${side}`, 0.12);
        }
      }

      rig.root.updateWorldMatrix(true, true);
      s.rootInvMat.copy(rig.root.matrixWorld).invert();
      rig.root.matrixWorld.decompose(s.pos, s.rootQ, s.scale);

      // Ground contact foot clamp
      if (hipsBone) {
        const lf = rig.bones.get("foot.L");
        const rf = rig.bones.get("foot.R");
        if (lf && rf) {
          const minY = Math.min(localBonePos(lf, s.leftFoot).y, localBonePos(rf, s.rightFoot).y);
          hipsBone.position.y -= minY - (0.077 + 0.022 * z);
          hipsBone.updateWorldMatrix(false, true);
        }
      }

      // 2-bone IK for Hapjang (합장) when kneeling, bowing, greeting, or standing serenely
      const idleHapjangBlend = v.pose !== "dance" ? Math.max(z, greetClasp, (1 - ud.walkSpeed) * 0.88) : 0;
      if (idleHapjangBlend > 0.02) {
        const claspY = THREE.MathUtils.lerp(0.37, 0.84, l);
        for (const side of ["L", "R"]) {
          const sign = side === "L" ? -1 : 1;
          const target = s.target.set(
            sign * THREE.MathUtils.lerp(0.026, 0.18, bowG),
            THREE.MathUtils.lerp(claspY, 0.075, bowG),
            THREE.MathUtils.lerp(-0.148, -0.43, bowG)
          );
          const handBone = rig.bones.get(`hand.${side}`);
          if (handBone && idleHapjangBlend < 0.99) {
            target.lerp(localBonePos(handBone, s.handTarget), 1 - idleHapjangBlend);
          }
          const handDir = s.handDir.set(0, 1 - bowG, -bowG).normalize();
          const twist = sign * (Math.PI / 2);
          solveArmIK(
            side,
            target,
            handDir,
            THREE.MathUtils.lerp(twist, Math.PI, bowG),
            idleHapjangBlend
          );
        }
      }
    } else if (torso && head && hands) {
      // Fallback primitive pose while .glb loads
      if (v.pose === "kneel" && Number.isFinite(v.bowAt)) {
        bodyRoot.position.y = -bowG * 0.28;
        torso.rotation.x = bowG * 1.12;
      } else if (v.pose === "kneel" || v.pose === "beads") {
        bodyRoot.position.y = -0.16;
        torso.rotation.x = 0.05;
      } else {
        bodyRoot.position.y = 0;
        torso.rotation.x = 0;
      }
    }

    // 3. Aura ring (Hello wave or CAFE25 Pulsoyu warmth buff)
    const isBuffedSelf = v.id === this.selfId && nowPerf < this.buffUntil;
    if (nowPerf < ud.helloUntil || isBuffedSelf) {
      auraRing.material.opacity = 0.48 + Math.sin(nowPerf * 0.008) * 0.2;
      const sc = 1 + Math.sin(nowPerf * 0.006) * 0.12;
      auraRing.scale.set(sc, sc, 1);
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

    // Animate temple cat 'Gongyang-i' (.glb skeletal mixer + path around lotus pond)
    if (this.catGroup && this.space === "garden") {
      if (this.catMixer) this.catMixer.update(dt);
      const catAngle = now * 0.00042;
      const r = 5.45;
      this.catGroup.position.set(-8.5 + Math.cos(catAngle) * r, 0, 15.5 + Math.sin(catAngle) * r);
      this.catGroup.rotation.y = -catAngle;
    }

    // Animate incense smoke in Hall
    if (this.space === "hall") {
      for (const puff of this.smokeParticles) {
        puff.position.y += dt * 0.42;
        puff.position.x = Math.sin(now * 0.002 + puff.userData.phase) * 0.14;
        if (puff.position.y > 3.4) {
          puff.position.y = 1.25;
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
      this.applyAvatarPose(v, mesh, now, dt);
    }

    // Update Third-Person Orbit Camera following self
    const self = this.visitors.get(this.selfId);
    const focusX = self ? self.x : 0;
    const focusZ = self ? self.z : this.space === "hall" ? -6.5 : 18;
    const camX = focusX + Math.sin(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const camY = Math.max(1.4, Math.sin(this.camPitch) * this.camDist);
    const camZ = focusZ + Math.cos(this.camYaw) * Math.cos(this.camPitch) * this.camDist;

    this.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), 0.18);
    this.camera.lookAt(focusX, 1.15, focusZ);

    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.sansaApp = new SansaApp();
});
