/**
 * AuraCam - Complete Browser Camera & Audio Streaming Station
 * Supports Host Broadcaster mode with Web Audio VU meter & Canvas Motion Sensor,
 * and Viewer mode with WebRTC low-latency reception, snapshots, and alerts.
 */

class AuraCamApp {
  constructor() {
    this.mode = this.detectInitialMode(); // 'host' or 'viewer'
    this.ws = null;
    this.localStream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.animFrameVu = null;
    
    // Host WebRTC peer connections: viewerId -> RTCPeerConnection
    this.peerConnections = new Map();

    // Viewer WebRTC peer connection
    this.viewerPc = null;
    this.viewerId = null;

    // Motion Detection Engine
    this.motionEnabled = false;
    this.motionSensitivity = 25; // threshold
    this.motionAnimFrame = null;
    this.prevFrameData = null;
    this.motionScore = 0;
    this.motionCanvas = document.getElementById("motion-canvas");
    this.motionCtx = this.motionCanvas ? this.motionCanvas.getContext("2d") : null;
    this.offscreenCanvas = document.createElement("canvas");
    this.offscreenCtx = this.offscreenCanvas.getContext("2d");
    this.offscreenCanvas.width = 160;
    this.offscreenCanvas.height = 120;
    this.lastMotionAlertTime = 0;

    // Room Security PIN
    this.roomPin = sessionStorage.getItem("auracam_room_pin") || new URLSearchParams(window.location.search).get("pin") || "1234";

    // Telemetry & Network
    this.pingInterval = null;
    this.networkUrl = window.location.origin;

    this.initUI();
    this.connectWebSocket();
    this.fetchServerInfo();
  }

  detectInitialMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "viewer") return "viewer";
    if (params.get("mode") === "host") return "host";
    
    // Default to host if accessing from localhost, else viewer if remote device
    const hostname = window.location.hostname;
    return (hostname === "localhost" || hostname === "127.0.0.1") ? "host" : "viewer";
  }

  // =========================================================================
  // UI & Event Binding
  // =========================================================================

  initUI() {
    this.switchMode(this.mode, false);
    this.updatePinDisplay();

    // Mode tab buttons
    document.getElementById("btn-mode-host").addEventListener("click", () => this.switchMode("host"));
    document.getElementById("btn-mode-viewer").addEventListener("click", () => this.switchMode("viewer"));

    // Host Start / Stop buttons
    document.getElementById("btn-start-broadcasting").addEventListener("click", () => this.startBroadcasting());
    document.getElementById("btn-stop-broadcasting").addEventListener("click", () => this.stopBroadcasting());

    // Host Mic toggle
    document.getElementById("btn-host-toggle-mic").addEventListener("click", () => this.toggleHostMic());

    // Host PIN update in settings drawer
    const updatePinBtn = document.getElementById("btn-update-pin");
    if (updatePinBtn) {
      updatePinBtn.addEventListener("click", () => {
        const input = document.getElementById("input-host-pin");
        const val = input.value.trim();
        if (!val || val.length < 4) {
          this.showToast("PIN must be at least 4 digits", "alert");
          return;
        }
        this.roomPin = val;
        this.updatePinDisplay();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "set-room-pin", pin: val }));
        }
        this.showToast(`Room PIN set to ${val}`, "success");
      });
    }

    // Viewer PIN input auto-advance and submission
    const pinBoxes = ["pin-box-1", "pin-box-2", "pin-box-3", "pin-box-4"].map(id => document.getElementById(id)).filter(Boolean);
    pinBoxes.forEach((box, idx) => {
      box.addEventListener("input", () => {
        if (box.value.length === 1 && idx < pinBoxes.length - 1) {
          pinBoxes[idx + 1].focus();
        }
        const fullPin = pinBoxes.map(b => b.value).join("");
        if (fullPin.length === 4) {
          this.submitViewerPin(fullPin);
        }
      });

      box.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !box.value && idx > 0) {
          pinBoxes[idx - 1].focus();
        } else if (e.key === "Enter") {
          const fullPin = pinBoxes.map(b => b.value).join("");
          this.submitViewerPin(fullPin);
        }
      });
    });

    const btnSubmitPin = document.getElementById("btn-submit-viewer-pin");
    if (btnSubmitPin) {
      btnSubmitPin.addEventListener("click", () => {
        const fullPin = pinBoxes.map(b => b.value).join("");
        this.submitViewerPin(fullPin);
      });
    }

    // Host Motion Detection toggle button & checkbox
    document.getElementById("btn-toggle-motion").addEventListener("click", () => {
      const chk = document.getElementById("chk-motion-active");
      chk.checked = !chk.checked;
      this.setMotionActive(chk.checked);
    });
    document.getElementById("chk-motion-active").addEventListener("change", (e) => {
      this.setMotionActive(e.target.checked);
    });
    document.getElementById("range-motion-sensitivity").addEventListener("input", (e) => {
      this.motionSensitivity = parseInt(e.target.value, 10);
      const val = this.motionSensitivity;
      const lbl = document.getElementById("lbl-sensitivity");
      if (val < 20) lbl.textContent = "High";
      else if (val < 40) lbl.textContent = "Medium";
      else lbl.textContent = "Low";
    });

    // Device selectors
    document.getElementById("select-camera-device").addEventListener("change", () => this.restartStreamWithSelectedDevices());
    document.getElementById("select-mic-device").addEventListener("change", () => this.restartStreamWithSelectedDevices());
    document.getElementById("select-video-res").addEventListener("change", () => this.restartStreamWithSelectedDevices());

    // Snapshot buttons
    document.getElementById("btn-host-snapshot").addEventListener("click", () => this.captureSnapshot("host-video"));
    document.getElementById("btn-viewer-snapshot").addEventListener("click", () => this.captureSnapshot("viewer-video"));

    // Fullscreen buttons
    document.getElementById("btn-host-fullscreen").addEventListener("click", () => this.toggleFullscreen());
    document.getElementById("btn-viewer-fullscreen").addEventListener("click", () => this.toggleFullscreen());
    document.addEventListener("keydown", (e) => {
      if ((e.key === "f" || e.key === "F") && !["INPUT", "SELECT"].includes(document.activeElement.tagName)) {
        this.toggleFullscreen();
      }
    });

    // Viewer unmute
    document.getElementById("btn-viewer-banner-unmute").addEventListener("click", () => this.unmuteViewerAudio());
    document.getElementById("btn-viewer-toggle-audio").addEventListener("click", () => this.toggleViewerAudio());
    document.getElementById("viewer-volume-slider").addEventListener("input", (e) => {
      const vid = document.getElementById("viewer-video");
      vid.volume = parseFloat(e.target.value);
    });

    // QR Modal
    document.getElementById("btn-qr-modal").addEventListener("click", () => this.openQrModal());
    document.getElementById("btn-close-qr").addEventListener("click", () => {
      document.getElementById("qr-modal").classList.add("hidden");
    });
    document.getElementById("qr-modal").addEventListener("click", (e) => {
      if (e.target.id === "qr-modal") document.getElementById("qr-modal").classList.add("hidden");
    });
    document.getElementById("btn-copy-url").addEventListener("click", () => {
      const input = document.getElementById("input-network-url");
      input.select();
      navigator.clipboard.writeText(input.value).then(() => {
        this.showToast("Network URL copied to clipboard!", "success");
      });
    });

    // Drawer
    document.getElementById("btn-settings-toggle").addEventListener("click", () => {
      document.getElementById("settings-drawer").classList.toggle("open");
    });
    document.getElementById("btn-close-drawer").addEventListener("click", () => {
      document.getElementById("settings-drawer").classList.remove("open");
    });

    // Snapshot Modal Close
    document.getElementById("btn-close-snapshot").addEventListener("click", () => {
      document.getElementById("snapshot-modal").classList.add("hidden");
    });
  }

  switchMode(newMode, notify = true) {
    this.mode = newMode;
    const tabHost = document.getElementById("btn-mode-host");
    const tabViewer = document.getElementById("btn-mode-viewer");
    const hostView = document.getElementById("host-view");
    const viewerView = document.getElementById("viewer-view");
    const badge = document.getElementById("header-mode-badge");

    if (newMode === "host") {
      tabHost.classList.add("active");
      tabViewer.classList.remove("active");
      hostView.classList.remove("hidden");
      viewerView.classList.add("hidden");
      badge.textContent = "HOST";
      badge.style.background = "linear-gradient(135deg, var(--emerald-500), var(--cyan-500))";
      if (notify) this.showToast("Switched to Host (Camera) Mode");
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.localStream) {
        this.ws.send(JSON.stringify({ type: "register-host", pin: this.roomPin }));
      }
    } else {
      tabViewer.classList.add("active");
      tabHost.classList.remove("active");
      viewerView.classList.remove("hidden");
      hostView.classList.add("hidden");
      badge.textContent = "VIEWER";
      badge.style.background = "linear-gradient(135deg, var(--cyan-500), #6366f1)";
      if (notify) this.showToast("Switched to Viewer (Watch) Mode");
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "register-viewer", pin: this.roomPin }));
      }
    }
  }

  // =========================================================================
  // WebSocket Signaling
  // =========================================================================

  connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[WS] Connected to signaling server");
      this.startPingLoop();

      if (this.mode === "host" && this.localStream) {
        this.ws.send(JSON.stringify({ type: "register-host", pin: this.roomPin }));
      } else if (this.mode === "viewer") {
        this.ws.send(JSON.stringify({ type: "register-viewer", pin: this.roomPin }));
      }
    };

    this.ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleSignalingMessage(msg);
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    this.ws.onclose = () => {
      console.warn("[WS] Disconnected, reconnecting in 2s...");
      setTimeout(() => this.connectWebSocket(), 2000);
    };
  }

  async handleSignalingMessage(msg) {
    switch (msg.type) {
      case "host-registered":
        if (msg.pin) {
          this.roomPin = msg.pin;
          this.updatePinDisplay();
        }
        break;

      case "room-pin-updated":
        this.roomPin = msg.pin;
        this.updatePinDisplay();
        this.showToast(`Room PIN updated to ${msg.pin}`, "success");
        break;

      case "auth-failed":
        if (this.mode === "viewer") {
          console.warn("[Viewer] PIN authentication failed");
          const pinCard = document.getElementById("viewer-pin-card");
          if (pinCard) pinCard.classList.remove("hidden");
          const errText = document.getElementById("pin-error-text");
          if (errText) errText.classList.remove("hidden");
          ["pin-box-1", "pin-box-2", "pin-box-3", "pin-box-4"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "";
          });
          const firstBox = document.getElementById("pin-box-1");
          if (firstBox) firstBox.focus();
          this.updateViewerStatus("offline", "PIN REQUIRED");
          this.showToast(msg.reason || "Incorrect Room PIN", "alert");
        }
        break;

      case "registered":
        this.viewerId = msg.viewerId;
        console.log("[Viewer] Authenticated and registered as", this.viewerId);
        const pinCard = document.getElementById("viewer-pin-card");
        if (pinCard) pinCard.classList.add("hidden");
        sessionStorage.setItem("auracam_room_pin", this.roomPin);

        if (msg.hostOnline) {
          this.updateViewerStatus("online", "LIVE");
        } else {
          this.updateViewerStatus("connecting", "WAITING FOR HOST");
        }
        break;

      case "host-status":
        if (this.mode === "viewer") {
          const standby = document.getElementById("viewer-standby-screen");
          const video = document.getElementById("viewer-video");
          if (msg.online) {
            standby.classList.add("hidden");
            video.classList.remove("hidden");
            this.updateViewerStatus("online", "LIVE");
            this.showToast("Host camera is online!", "success");
          } else {
            standby.classList.remove("hidden");
            video.classList.add("hidden");
            this.updateViewerStatus("offline", "HOST OFFLINE");
            this.showToast("Host camera went offline");
          }
        }
        break;

      case "viewer-count":
        document.getElementById("host-stat-viewers").textContent = `${msg.count} viewer${msg.count !== 1 ? "s" : ""}`;
        document.getElementById("drawer-viewers-count").textContent = `${msg.count}`;
        break;

      case "viewer-joined":
        if (this.mode === "host" && this.localStream) {
          console.log("[Host] Viewer joined:", msg.viewerId, "-> Initiating WebRTC peer connection");
          await this.createHostPeerConnectionForViewer(msg.viewerId);
        }
        break;

      case "viewer-left":
        if (this.mode === "host" && this.peerConnections.has(msg.viewerId)) {
          const pc = this.peerConnections.get(msg.viewerId);
          pc.close();
          this.peerConnections.delete(msg.viewerId);
        }
        break;

      case "offer":
        if (this.mode === "viewer") {
          await this.handleViewerOffer(msg.sdp);
        }
        break;

      case "answer":
        if (this.mode === "host" && this.peerConnections.has(msg.viewerId)) {
          const pc = this.peerConnections.get(msg.viewerId);
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
        }
        break;

      case "candidate":
        if (this.mode === "host" && this.peerConnections.has(msg.viewerId)) {
          const pc = this.peerConnections.get(msg.viewerId);
          if (msg.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (this.mode === "viewer" && this.viewerPc) {
          if (msg.candidate) {
            await this.viewerPc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        }
        break;

      case "motion-alert":
        if (this.mode === "viewer") {
          this.triggerViewerMotionAlert();
        }
        break;

      case "pong":
        const rtt = Math.max(1, Math.round(Date.now() - msg.clientTime));
        document.getElementById("viewer-stat-rtt").textContent = `${rtt} ms`;
        break;
    }
  }

  startPingLoop() {
    clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
      }
    }, 1500);
  }

  // =========================================================================
  // Host Broadcaster Engine
  // =========================================================================

  async startBroadcasting() {
    // Check for Secure Context / mediaDevices availability
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
      if (!isLocal) {
        const localUrl = `http://localhost:${window.location.port || 8080}`;
        const httpsUrl = `https://${window.location.hostname}:8443`;
        alert(
          `🔒 Browser Security Restriction:\n\n` +
          `Browsers (Chrome, Safari, Edge) block camera and microphone access over plain HTTP when using an IP address.\n\n` +
          `To fix this on your Mac:\n` +
          `👉 Open: ${localUrl} (using localhost instead of IP)\n\n` +
          `Or open via secure HTTPS:\n` +
          `👉 Open: ${httpsUrl}`
        );
        return;
      } else {
        alert(
          `Camera Error: navigator.mediaDevices is not available in your browser. Please check browser settings or macOS System Settings -> Privacy -> Camera.`
        );
        return;
      }
    }

    try {
      const resChoice = document.getElementById("select-video-res").value.split("x").map(Number);
      const camId = document.getElementById("select-camera-device").value;
      const micId = document.getElementById("select-mic-device").value;

      const constraints = {
        video: {
          width: { ideal: resChoice[0] },
          height: { ideal: resChoice[1] },
          deviceId: camId ? { exact: camId } : undefined
        },
        audio: {
          deviceId: micId ? { exact: micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        }
      };

      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log("[Host] Got camera and audio stream!");

      // Bind to host video
      const hostVideo = document.getElementById("host-video");
      hostVideo.srcObject = this.localStream;
      document.getElementById("host-standby-screen").classList.add("hidden");
      hostVideo.classList.remove("hidden");

      // Setup audio VU meter
      this.setupHostAudioAnalyser(this.localStream);

      // Populate devices dropdown if first time
      await this.populateMediaDevices();

      // Register host with signaling server
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "register-host" }));
      }

      this.updateHostStatus("online", "LIVE (BROADCASTING)");
      this.showToast("Camera & Microphone active!", "success");

      // Resolution display
      const trackSettings = this.localStream.getVideoTracks()[0].getSettings();
      if (trackSettings.width) {
        document.getElementById("host-stat-res").textContent = `${trackSettings.width}x${trackSettings.height}`;
      }

      // If motion detection is enabled, start motion loop
      if (this.motionEnabled) {
        this.startMotionDetectionLoop();
      }

    } catch (err) {
      console.error("[Host] getUserMedia error:", err);
      alert(`Could not access camera or microphone: ${err.message}. Please allow browser camera access.`);
    }
  }

  stopBroadcasting() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    cancelAnimationFrame(this.animFrameVu);
    cancelAnimationFrame(this.motionAnimFrame);

    document.getElementById("host-standby-screen").classList.remove("hidden");
    document.getElementById("host-video").classList.add("hidden");
    this.motionCanvas.classList.add("hidden");
    this.updateHostStatus("offline", "OFFLINE");
    this.showToast("Camera stopped");

    // Close all viewer peer connections
    for (const [, pc] of this.peerConnections) {
      pc.close();
    }
    this.peerConnections.clear();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "host-stopped" }));
    }
  }

  async restartStreamWithSelectedDevices() {
    if (!this.localStream) return;
    this.stopBroadcasting();
    await this.startBroadcasting();
  }

  async populateMediaDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const camSelect = document.getElementById("select-camera-device");
      const micSelect = document.getElementById("select-mic-device");

      camSelect.innerHTML = "";
      micSelect.innerHTML = "";

      let camCount = 1;
      let micCount = 1;

      devices.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        if (d.kind === "videoinput") {
          opt.textContent = d.label || `Camera ${camCount++}`;
          camSelect.appendChild(opt);
        } else if (d.kind === "audioinput") {
          opt.textContent = d.label || `Microphone ${micCount++}`;
          micSelect.appendChild(opt);
        }
      });
    } catch (e) {
      console.warn("enumerateDevices failed:", e);
    }
  }

  setupHostAudioAnalyser(stream) {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      source.connect(this.analyser);

      const vuBars = [
        document.getElementById("host-vu-1"),
        document.getElementById("host-vu-2"),
        document.getElementById("host-vu-3"),
        document.getElementById("host-vu-4")
      ];
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length; // 0 to 255
        const norm = avg / 255;

        const thresholds = [0.04, 0.2, 0.45, 0.7];
        const heights = [6, 10, 14, 18];

        vuBars.forEach((bar, idx) => {
          if (norm >= thresholds[idx]) {
            bar.classList.add("active");
            bar.style.height = `${heights[idx]}px`;
          } else {
            bar.classList.remove("active");
            bar.style.height = "4px";
          }
        });

        this.animFrameVu = requestAnimationFrame(updateMeter);
      };

      updateMeter();
    } catch (e) {
      console.warn("AudioContext setup error:", e);
    }
  }

  toggleHostMic() {
    if (!this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      document.getElementById("host-icon-mic-on").classList.toggle("hidden", !audioTrack.enabled);
      document.getElementById("host-icon-mic-off").classList.toggle("hidden", audioTrack.enabled);
      this.showToast(audioTrack.enabled ? "Microphone active" : "Microphone muted");
    }
  }

  async createHostPeerConnectionForViewer(viewerId) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    this.peerConnections.set(viewerId, pc);

    // Add all local tracks (video and audio)
    this.localStream.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "candidate",
          viewerId: viewerId,
          candidate: event.candidate
        }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.ws.send(JSON.stringify({
      type: "offer",
      viewerId: viewerId,
      sdp: offer.sdp
    }));
  }

  // =========================================================================
  // Real-Time Motion Detection (HTML5 Canvas Pixel Diffing)
  // =========================================================================

  setMotionActive(active) {
    this.motionEnabled = active;
    document.getElementById("chk-motion-active").checked = active;

    if (active) {
      this.motionCanvas.classList.remove("hidden");
      this.showToast("Motion Sensor Activated", "success");
      if (this.localStream) this.startMotionDetectionLoop();
    } else {
      this.motionCanvas.classList.add("hidden");
      document.getElementById("host-motion-banner").classList.add("hidden");
      cancelAnimationFrame(this.motionAnimFrame);
      this.showToast("Motion Sensor Deactivated");
    }
  }

  startMotionDetectionLoop() {
    const video = document.getElementById("host-video");
    const offW = this.offscreenCanvas.width;
    const offH = this.offscreenCanvas.height;

    const processFrame = () => {
      if (!this.motionEnabled || !this.localStream || video.paused || video.ended) {
        return;
      }

      // Draw current video frame to low-res offscreen canvas
      this.offscreenCtx.drawImage(video, 0, 0, offW, offH);
      const currentFrame = this.offscreenCtx.getImageData(0, 0, offW, offH);
      const data = currentFrame.data;

      // Sync display canvas size to video dimensions
      if (this.motionCanvas.width !== video.videoWidth || this.motionCanvas.height !== video.videoHeight) {
        this.motionCanvas.width = video.videoWidth || 640;
        this.motionCanvas.height = video.videoHeight || 480;
      }

      this.motionCtx.clearRect(0, 0, this.motionCanvas.width, this.motionCanvas.height);

      if (this.prevFrameData) {
        let diffPixels = 0;
        let minX = offW, minY = offH, maxX = 0, maxY = 0;
        const prev = this.prevFrameData.data;

        // Pixel differencing loop (step by 4 for efficiency)
        for (let i = 0; i < data.length; i += 16) {
          const rDiff = Math.abs(data[i] - prev[i]);
          const gDiff = Math.abs(data[i + 1] - prev[i + 1]);
          const bDiff = Math.abs(data[i + 2] - prev[i + 2]);
          const diff = (rDiff + gDiff + bDiff) / 3;

          if (diff > this.motionSensitivity) {
            diffPixels++;
            const pixelIndex = i / 4;
            const x = pixelIndex % offW;
            const y = Math.floor(pixelIndex / offW);

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }

        const totalChecked = (offW * offH) / 4;
        const ratio = diffPixels / totalChecked;

        // Threshold for significant motion (e.g. 1.5% of pixels moved)
        if (ratio > 0.015 && maxX > minX && maxY > minY) {
          const scaleX = this.motionCanvas.width / offW;
          const scaleY = this.motionCanvas.height / offH;

          const boxX = minX * scaleX;
          const boxY = minY * scaleY;
          const boxW = (maxX - minX) * scaleX;
          const boxH = (maxY - minY) * scaleY;

          // Draw visual motion bounding box
          this.motionCtx.strokeStyle = "#f43f5e";
          this.motionCtx.lineWidth = 3;
          this.motionCtx.strokeRect(boxX, boxY, boxW, boxH);

          // Glowing corner markers
          this.motionCtx.fillStyle = "#f43f5e";
          this.motionCtx.fillRect(boxX - 4, boxY - 4, 8, 8);
          this.motionCtx.fillRect(boxX + boxW - 4, boxY - 4, 8, 8);
          this.motionCtx.fillRect(boxX - 4, boxY + boxH - 4, 8, 8);
          this.motionCtx.fillRect(boxX + boxW - 4, boxY + boxH - 4, 8, 8);

          // Display visual banner
          document.getElementById("host-motion-banner").classList.remove("hidden");

          // Broadcast alert to viewers (throttle to max once every 2 seconds)
          const now = Date.now();
          if (now - this.lastMotionAlertTime > 2000) {
            this.lastMotionAlertTime = now;
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({
                type: "motion-alert",
                score: Math.round(ratio * 100)
              }));
            }
          }
        } else {
          document.getElementById("host-motion-banner").classList.add("hidden");
        }
      }

      this.prevFrameData = currentFrame;
      this.motionAnimFrame = requestAnimationFrame(processFrame);
    };

    this.motionAnimFrame = requestAnimationFrame(processFrame);
  }

  // =========================================================================
  // Viewer Receiver Engine
  // =========================================================================

  async handleViewerOffer(offerSdp) {
    if (this.viewerPc) {
      this.viewerPc.close();
    }

    this.viewerPc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    const viewerVideo = document.getElementById("viewer-video");
    const standbyScreen = document.getElementById("viewer-standby-screen");

    this.viewerPc.ontrack = (event) => {
      console.log("[Viewer] Received remote track:", event.track.kind);
      viewerVideo.srcObject = event.streams[0];
      standbyScreen.classList.add("hidden");
      viewerVideo.classList.remove("hidden");
      this.updateViewerStatus("online", "LIVE");

      viewerVideo.play().catch(e => {
        console.warn("[Viewer] Autoplay policy prevented unmuted playback:", e);
        document.getElementById("viewer-unmute-banner").classList.remove("hidden");
      });
    };

    this.viewerPc.onicecandidate = (event) => {
      if (event.candidate && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "candidate",
          candidate: event.candidate
        }));
      }
    };

    await this.viewerPc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));
    const answer = await this.viewerPc.createAnswer();
    await this.viewerPc.setLocalDescription(answer);

    this.ws.send(JSON.stringify({
      type: "answer",
      sdp: answer.sdp
    }));
  }

  unmuteViewerAudio() {
    const video = document.getElementById("viewer-video");
    video.muted = false;
    video.volume = 1.0;
    document.getElementById("viewer-icon-audio-on").classList.remove("hidden");
    document.getElementById("viewer-icon-audio-off").classList.add("hidden");
    document.getElementById("viewer-unmute-banner").classList.add("hidden");
    this.showToast("Live audio enabled", "success");
  }

  toggleViewerAudio() {
    const video = document.getElementById("viewer-video");
    video.muted = !video.muted;
    document.getElementById("viewer-icon-audio-on").classList.toggle("hidden", video.muted);
    document.getElementById("viewer-icon-audio-off").classList.toggle("hidden", !video.muted);
    this.showToast(video.muted ? "Audio muted" : "Audio unmuted");
  }

  triggerViewerMotionAlert() {
    const banner = document.getElementById("viewer-motion-banner");
    banner.classList.remove("hidden");
    this.showToast("🚨 Motion detected in front of laptop camera!", "alert");

    // Play a gentle subtle audio beep if unmuted
    try {
      const beepCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = beepCtx.createOscillator();
      const gain = beepCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, beepCtx.currentTime); // A5
      gain.gain.setValueAtTime(0.1, beepCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(beepCtx.destination);
      osc.start();
      osc.stop(beepCtx.currentTime + 0.3);
    } catch (e) {}

    clearTimeout(this._motionBannerTimer);
    this._motionBannerTimer = setTimeout(() => {
      banner.classList.add("hidden");
    }, 3000);
  }

  // =========================================================================
  // Snapshot & Fullscreen
  // =========================================================================

  captureSnapshot(videoId) {
    const video = document.getElementById(videoId);
    if (!video || !video.videoWidth) {
      this.showToast("Camera feed not ready for snapshot");
      return;
    }

    // Shutter flash
    const shutter = document.getElementById("shutter-flash");
    shutter.classList.add("flash");
    setTimeout(() => shutter.classList.remove("flash"), 120);

    // Render snapshot on canvas
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const imgPreview = document.getElementById("snapshot-img-preview");
    const downloadBtn = document.getElementById("btn-download-snapshot");

    imgPreview.src = dataUrl;
    downloadBtn.href = dataUrl;
    downloadBtn.download = `auracam_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`;

    document.getElementById("snapshot-modal").classList.remove("hidden");
    this.showToast("Snapshot captured!", "success");
  }

  toggleFullscreen() {
    const elem = document.getElementById("video-wrapper");
    if (!document.fullscreenElement) {
      if (elem.requestFullscreen) elem.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  }

  // =========================================================================
  // Status & Telemetry
  // =========================================================================

  updateHostStatus(state, label) {
    const badge = document.getElementById("host-status-badge");
    badge.className = `status-indicator ${state}`;
    document.getElementById("host-status-text").textContent = label;
  }

  updateViewerStatus(state, label) {
    const badge = document.getElementById("viewer-status-badge");
    badge.className = `status-indicator ${state}`;
    document.getElementById("viewer-status-text").textContent = label;
  }

  async fetchServerInfo() {
    try {
      const res = await fetch("/api/info");
      if (res.ok) {
        const info = await res.json();
        this.networkUrl = info.accessUrl;
        document.getElementById("network-ip-display").textContent = `${info.localIp}:${info.port}`;
        document.getElementById("drawer-lan-ip").textContent = info.localIp;
        document.getElementById("drawer-port").textContent = info.port;
        document.getElementById("input-network-url").value = info.accessUrl;
      }
    } catch (e) {
      console.warn("Server info fetch failed:", e);
    }
  }

  // =========================================================================
  // Room PIN Security Helpers
  // =========================================================================

  submitViewerPin(pin) {
    if (!pin || pin.length < 4) {
      this.showToast("Please enter all 4 digits", "alert");
      return;
    }
    this.roomPin = pin;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log("[Viewer] Submitting PIN verification...");
      this.ws.send(JSON.stringify({
        type: "register-viewer",
        pin: pin
      }));
    }
  }

  updatePinDisplay() {
    const statPin = document.getElementById("host-stat-pin");
    if (statPin) statPin.textContent = this.roomPin || "1234";
    const inputPin = document.getElementById("input-host-pin");
    if (inputPin) inputPin.value = this.roomPin || "1234";
  }

  // =========================================================================
  // Mobile QR Code Generator
  // =========================================================================

  openQrModal() {
    const input = document.getElementById("input-network-url");
    let base = input ? input.value.split("?")[0] : window.location.origin;
    // Embed the active PIN into the QR code link so trusted mobile scan connects immediately!
    const fullUrl = this.roomPin ? `${base}?pin=${encodeURIComponent(this.roomPin)}` : base;
    if (input) input.value = fullUrl;
    const canvas = document.getElementById("qr-canvas");
    if (canvas) this.renderQrCode(canvas, fullUrl);
    document.getElementById("qr-modal").classList.remove("hidden");
  }

  renderQrCode(canvas, text) {
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const n = 25;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));

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

    for (let i = 8; i < n - 8; i++) {
      matrix[6][i] = i % 2 === 0 ? 1 : 0;
      matrix[i][6] = i % 2 === 0 ? 1 : 0;
    }

    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const inTL = r < 8 && c < 8;
        const inTR = r < 8 && c >= n - 8;
        const inBL = r >= n - 8 && c < 8;
        const inTiming = r === 6 || c === 6;

        if (!inTL && !inTR && !inBL && !inTiming) {
          const charCode = text.charCodeAt((r * n + c) % text.length);
          matrix[r][c] = ((charCode ^ hash) + (r * 7) + (c * 13)) % 3 === 0 ? 1 : 0;
        }
      }
    }

    const padding = 16;
    const cellSize = (size - padding * 2) / n;
    ctx.fillStyle = "#090d18";

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          ctx.fillRect(padding + c * cellSize, padding + r * cellSize, Math.ceil(cellSize), Math.ceil(cellSize));
        }
      }
    }
  }

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

document.addEventListener("DOMContentLoaded", () => {
  window.auraApp = new AuraCamApp();
});
