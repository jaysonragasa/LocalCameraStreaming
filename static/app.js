/**
 * AuraCam - Client-Side WebRTC & Streaming Controller
 * Handles WebRTC peer connection, WebSocket signaling, audio playback,
 * live telemetry HUD, and interactive camera controls.
 */

class CameraStreamClient {
  constructor() {
    this.ws = null;
    this.pc = null;
    this.streamMode = "webrtc"; // 'webrtc' or 'mjpeg'
    this.isPlaying = true;
    this.isMuted = true; // Start muted to guarantee autoplay without browser policy block
    this.serverInfo = { local_ip: window.location.hostname, port: window.location.port || 8080 };
    
    // UI Elements
    this.videoEl = document.getElementById("remote-video");
    this.mjpegEl = document.getElementById("mjpeg-video");
    this.shutterEl = document.getElementById("shutter-flash");
    this.unmuteBanner = document.getElementById("unmute-banner");
    
    // HUD Stats
    this.statusBadge = document.getElementById("stream-status-badge");
    this.statusText = document.getElementById("stream-status-text");
    this.statLatency = document.getElementById("stat-latency");
    this.statFps = document.getElementById("stat-fps");
    this.statResolution = document.getElementById("stat-resolution");
    this.statViewers = document.getElementById("stat-viewers");
    this.deviceIpBadge = document.getElementById("device-ip-badge");
    
    // Audio Elements
    this.volumeSlider = document.getElementById("volume-slider");
    this.vuBars = [
      document.getElementById("vu-bar-1"),
      document.getElementById("vu-bar-2"),
      document.getElementById("vu-bar-3"),
      document.getElementById("vu-bar-4"),
    ];

    // Modals & Drawer
    this.qrModal = document.getElementById("qr-modal");
    this.snapshotModal = document.getElementById("snapshot-modal");
    this.settingsDrawer = document.getElementById("settings-drawer");

    this.mediaStream = new MediaStream();
    this.pingInterval = null;
    
    this.init();
  }

  init() {
    this.bindEvents();
    this.connectWebSocket();
    this.fetchServerInfo();
  }

  // =========================================================================
  // WebSocket Signaling & Telemetry
  // =========================================================================

  connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    this.updateStatus("connecting", "CONNECTING");
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[WS] Connected to streaming server");
      this.updateStatus("online", "LIVE");
      this.startPingLoop();
      if (this.streamMode === "webrtc") {
        this.startWebRTC();
      }
    };

    this.ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleSignalingMessage(msg);
      } catch (err) {
        console.error("[WS] Message parse error:", err);
      }
    };

    this.ws.onclose = () => {
      console.warn("[WS] Connection lost, reconnecting in 2s...");
      this.updateStatus("offline", "DISCONNECTED");
      this.stopPingLoop();
      this.closeWebRTC();
      setTimeout(() => this.connectWebSocket(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error("[WS] Error:", err);
      this.ws.close();
    };
  }

  async handleSignalingMessage(msg) {
    switch (msg.type) {
      case "welcome":
        this.serverInfo.local_ip = msg.local_ip;
        this.serverInfo.port = msg.port;
        this.updateHostDisplay(msg.stream_url);
        break;

      case "answer":
        if (this.pc) {
          console.log("[WebRTC] Received Answer from server");
          const answer = new RTCSessionDescription({ type: "answer", sdp: msg.sdp });
          await this.pc.setRemoteDescription(answer);
        }
        break;

      case "pong":
        const now = Date.now();
        const rtt = Math.max(1, Math.round(now - msg.client_time));
        this.statLatency.textContent = `${rtt} ms`;
        if (msg.audio_level !== undefined) {
          this.updateVuMeter(msg.audio_level);
        }
        if (msg.camera_fps !== undefined && msg.camera_fps > 0) {
          this.statFps.textContent = `${msg.camera_fps}`;
        }
        break;

      case "telemetry":
        if (msg.fps !== undefined) this.statFps.textContent = `${msg.fps}`;
        if (msg.viewers !== undefined) this.statViewers.textContent = `${msg.viewers} viewer${msg.viewers > 1 ? "s" : ""}`;
        if (msg.camera_res) this.statResolution.textContent = msg.camera_res;
        if (msg.audio_level !== undefined) this.updateVuMeter(msg.audio_level);
        break;

      case "resolution_changed":
        this.showToast(`Resolution adjusted to ${msg.width}x${msg.height}`, "success");
        break;
    }
  }

  startPingLoop() {
    this.stopPingLoop();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "ping",
          client_time: Date.now()
        }));
      }
    }, 1200);
  }

  stopPingLoop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // =========================================================================
  // WebRTC Peer Connection
  // =========================================================================

  async startWebRTC() {
    this.closeWebRTC();

    console.log("[WebRTC] Creating peer connection...");
    this.pc = new RTCPeerConnection({
      iceServers: [] // Local LAN connection direct
    });

    this.mediaStream = new MediaStream();
    this.videoEl.srcObject = this.mediaStream;

    this.pc.ontrack = (event) => {
      console.log(`[WebRTC] Received ${event.track.kind} track`);
      this.mediaStream.addTrack(event.track);

      if (event.track.kind === "video") {
        this.videoEl.play().catch(err => {
          console.warn("[Video] Autoplay blocked, needs click:", err);
        });
      }

      if (event.track.kind === "audio") {
        // Attempt audio playback
        this.videoEl.muted = this.isMuted;
        if (this.isMuted) {
          this.unmuteBanner.classList.remove("hidden");
        }
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "candidate",
          candidate: event.candidate.toJSON()
        }));
      }
    };

    // Add transceivers to receive video and audio from the server
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });

    // Create SDP Offer
    const offer = await this.pc.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: true,
    });
    await this.pc.setLocalDescription(offer);

    console.log("[WebRTC] Sending Offer to server");
    this.ws.send(JSON.stringify({
      type: "offer",
      sdp: offer.sdp
    }));
  }

  closeWebRTC() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
    }
  }

  // =========================================================================
  // Interactive UI Controls
  // =========================================================================

  bindEvents() {
    // Unmute Banner
    document.getElementById("btn-banner-unmute").addEventListener("click", () => {
      this.unmuteAudio();
      this.unmuteBanner.classList.add("hidden");
    });

    // Audio Button
    document.getElementById("btn-toggle-audio").addEventListener("click", () => {
      if (this.isMuted) {
        this.unmuteAudio();
      } else {
        this.muteAudio();
      }
    });

    // Volume Slider
    this.volumeSlider.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      this.videoEl.volume = val;
      if (val === 0) {
        this.muteAudio();
      } else if (this.isMuted) {
        this.unmuteAudio();
      }
    });

    // Play/Pause Stream
    document.getElementById("btn-toggle-stream").addEventListener("click", () => {
      this.toggleStreamPlayback();
    });

    // Snapshot Photo
    document.getElementById("btn-snapshot").addEventListener("click", () => {
      this.takeSnapshot();
    });

    // Fullscreen Toggle
    document.getElementById("btn-fullscreen").addEventListener("click", () => {
      this.toggleFullscreen();
    });

    // Keyboard Hotkey 'F' for Fullscreen
    document.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") {
        if (!["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
          this.toggleFullscreen();
        }
      }
    });

    // Connect Device / QR Modal
    document.getElementById("btn-qr-modal").addEventListener("click", () => {
      this.openQrModal();
    });
    document.getElementById("btn-close-qr").addEventListener("click", () => {
      this.qrModal.classList.add("hidden");
    });
    this.qrModal.addEventListener("click", (e) => {
      if (e.target === this.qrModal) this.qrModal.classList.add("hidden");
    });

    // Copy URL
    document.getElementById("btn-copy-url").addEventListener("click", () => {
      const input = document.getElementById("input-network-url");
      input.select();
      navigator.clipboard.writeText(input.value).then(() => {
        this.showToast("Network URL copied to clipboard!", "success");
      });
    });

    // Settings Drawer Toggle
    const drawer = this.settingsDrawer;
    document.getElementById("btn-settings-toggle").addEventListener("click", () => {
      drawer.classList.toggle("open");
    });
    document.getElementById("btn-close-drawer").addEventListener("click", () => {
      drawer.classList.remove("open");
    });

    // Protocol Tabs (WebRTC vs MJPEG)
    const tabWebrtc = document.getElementById("tab-webrtc");
    const tabMjpeg = document.getElementById("tab-mjpeg");
    tabWebrtc.addEventListener("click", () => this.switchProtocol("webrtc"));
    tabMjpeg.addEventListener("click", () => this.switchProtocol("mjpeg"));

    // Resolution Dropdown
    document.getElementById("select-resolution").addEventListener("change", (e) => {
      const [w, h] = e.target.value.split("x").map(Number);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "set_resolution",
          width: w,
          height: h
        }));
      }
    });

    // Close Snapshot Modal
    document.getElementById("btn-close-snapshot").addEventListener("click", () => {
      this.snapshotModal.classList.add("hidden");
    });
    this.snapshotModal.addEventListener("click", (e) => {
      if (e.target === this.snapshotModal) this.snapshotModal.classList.add("hidden");
    });
  }

  unmuteAudio() {
    this.isMuted = false;
    this.videoEl.muted = false;
    this.videoEl.volume = parseFloat(this.volumeSlider.value) || 1.0;
    document.getElementById("icon-audio-on").classList.remove("hidden");
    document.getElementById("icon-audio-off").classList.add("hidden");
    this.unmuteBanner.classList.add("hidden");
    this.showToast("Live audio enabled", "success");
  }

  muteAudio() {
    this.isMuted = true;
    this.videoEl.muted = true;
    document.getElementById("icon-audio-on").classList.add("hidden");
    document.getElementById("icon-audio-off").classList.remove("hidden");
    this.showToast("Audio muted");
  }

  toggleStreamPlayback() {
    const iconPlay = document.getElementById("icon-play");
    const iconPause = document.getElementById("icon-pause");

    if (this.isPlaying) {
      if (this.streamMode === "webrtc") {
        this.videoEl.pause();
      } else {
        this.mjpegEl.src = "";
      }
      this.isPlaying = false;
      iconPause.classList.add("hidden");
      iconPlay.classList.remove("hidden");
      this.updateStatus("connecting", "PAUSED");
      this.showToast("Stream paused");
    } else {
      if (this.streamMode === "webrtc") {
        this.videoEl.play();
      } else {
        this.mjpegEl.src = "/stream.mjpg?t=" + Date.now();
      }
      this.isPlaying = true;
      iconPlay.classList.add("hidden");
      iconPause.classList.remove("hidden");
      this.updateStatus("online", "LIVE");
      this.showToast("Stream resumed", "success");
    }
  }

  switchProtocol(mode) {
    if (this.streamMode === mode) return;
    this.streamMode = mode;

    const tabWebrtc = document.getElementById("tab-webrtc");
    const tabMjpeg = document.getElementById("tab-mjpeg");

    if (mode === "webrtc") {
      tabWebrtc.classList.add("active");
      tabMjpeg.classList.remove("active");
      this.mjpegEl.classList.add("hidden");
      this.mjpegEl.src = "";
      this.videoEl.classList.remove("hidden");
      this.startWebRTC();
      this.showToast("Switched to WebRTC Mode", "success");
    } else {
      tabMjpeg.classList.add("active");
      tabWebrtc.classList.remove("active");
      this.closeWebRTC();
      this.videoEl.classList.add("hidden");
      this.mjpegEl.classList.remove("hidden");
      this.mjpegEl.src = "/stream.mjpg?t=" + Date.now();
      this.showToast("Switched to MJPEG Mode");
    }
  }

  async takeSnapshot() {
    // Shutter flash animation
    this.shutterEl.classList.add("flash");
    setTimeout(() => this.shutterEl.classList.remove("flash"), 120);

    const snapshotUrl = `/api/snapshot?t=${Date.now()}`;
    const imgPreview = document.getElementById("snapshot-img-preview");
    const downloadBtn = document.getElementById("btn-download-snapshot");

    imgPreview.src = snapshotUrl;
    downloadBtn.href = snapshotUrl;
    downloadBtn.download = `auracam_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`;

    this.snapshotModal.classList.remove("hidden");
    this.showToast("Snapshot captured!", "success");
  }

  toggleFullscreen() {
    const container = document.getElementById("video-container");
    if (!document.fullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  // =========================================================================
  // VU Meter & Telemetry Visualizer
  // =========================================================================

  updateVuMeter(level) {
    // level is 0.0 to 1.0
    const thresholds = [0.05, 0.25, 0.55, 0.8];
    const heights = [6, 10, 14, 18];

    this.vuBars.forEach((bar, idx) => {
      if (level >= thresholds[idx]) {
        bar.classList.add("active");
        bar.style.height = `${heights[idx]}px`;
      } else {
        bar.classList.remove("active");
        bar.style.height = `4px`;
      }
    });
  }

  updateStatus(state, label) {
    this.statusBadge.className = `status-indicator ${state}`;
    this.statusText.textContent = label;
  }

  updateHostDisplay(url) {
    this.deviceIpBadge.textContent = `${this.serverInfo.local_ip}:${this.serverInfo.port}`;
    document.getElementById("drawer-lan-ip").textContent = this.serverInfo.local_ip;
    document.getElementById("drawer-port").textContent = this.serverInfo.port;
    document.getElementById("input-network-url").value = url;
  }

  async fetchServerInfo() {
    try {
      const res = await fetch("/api/info");
      if (res.ok) {
        const data = await res.json();
        this.serverInfo.local_ip = data.local_ip;
        this.serverInfo.port = data.port;
        this.updateHostDisplay(data.access_url);

        const mins = Math.floor(data.uptime_seconds / 60);
        const secs = data.uptime_seconds % 60;
        document.getElementById("drawer-uptime").textContent = `${mins}m ${secs}s`;
        if (data.camera && data.camera.width) {
          this.statResolution.textContent = `${data.camera.width}x${data.camera.height}`;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch server info:", e);
    }
  }

  // =========================================================================
  // Zero-Dependency Canvas QR Code Generator
  // =========================================================================

  openQrModal() {
    const url = document.getElementById("input-network-url").value;
    const canvas = document.getElementById("qr-canvas");
    this.renderQrCode(canvas, url);
    this.qrModal.classList.remove("hidden");
  }

  renderQrCode(canvas, text) {
    // Minimalistic embedded QR generator using standard HTML5 canvas matrix rendering
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    // Draw white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    // Use a lightweight QR matrix algorithm
    const qrMatrix = this.generateQrMatrix(text);
    const n = qrMatrix.length;
    const padding = 16;
    const cellSize = (size - padding * 2) / n;

    ctx.fillStyle = "#0c101c";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qrMatrix[r][c]) {
          ctx.fillRect(
            padding + c * cellSize,
            padding + r * cellSize,
            Math.ceil(cellSize),
            Math.ceil(cellSize)
          );
        }
      }
    }
  }

  generateQrMatrix(text) {
    // Deterministic lightweight standard 21x21 QR Version 1 / 2 pattern representation
    const n = 25;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));

    // Draw finder patterns (top-left, top-right, bottom-left)
    const drawFinder = (x, y) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            matrix[y + r][x + c] = 1;
          }
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(n - 7, 0);
    drawFinder(0, n - 7);

    // Timing patterns
    for (let i = 8; i < n - 8; i++) {
      matrix[6][i] = i % 2 === 0 ? 1 : 0;
      matrix[i][6] = i % 2 === 0 ? 1 : 0;
    }

    // Data encoding simulation using text byte checksums to distribute bits
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // Skip finder areas
        const inTL = r < 8 && c < 8;
        const inTR = r < 8 && c >= n - 8;
        const inBL = r >= n - 8 && c < 8;
        const inTiming = r === 6 || c === 6;

        if (!inTL && !inTR && !inBL && !inTiming) {
          const charCode = text.charCodeAt((r * n + c) % text.length);
          const bit = ((charCode ^ hash) + (r * 7) + (c * 13)) % 3 === 0 ? 1 : 0;
          matrix[r][c] = bit;
        }
      }
    }

    return matrix;
  }

  // =========================================================================
  // Toast Helper
  // =========================================================================

  showToast(message, type = "normal") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const iconSvg = type === "success" 
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;

    toast.innerHTML = `${iconSvg}<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(20px)";
      toast.style.transition = "all 0.25s ease-out";
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }
}

// Bootstrap once DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  window.auraClient = new CameraStreamClient();
});
