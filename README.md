# AuraCam — Local Camera & Audio Streaming

An ultra low-latency (<100ms) headless camera and audio streaming server designed to stream your laptop's webcam and microphone across your local Wi-Fi network.

Viewers can connect from any phone, tablet, smart TV, or secondary computer by opening the server's local IP address in any modern web browser.

---

## Key Features

- **Headless Backend**: Directly captures webcam and microphone in the background using OpenCV, PyAudio/SoundDevice, and PyAV — no need to keep a browser tab open on the host laptop.
- **WebRTC + WebSocket Signaling**: Hardware-accelerated, crystal-clear 1080p/720p 30 FPS video with synchronized Opus audio.
- **Glassmorphic Viewer UI**:
  - Live stream display with sub-second RTT latency counter, actual FPS, and active viewer count.
  - Interactive audio toggle, volume slider, and real-time 4-stage VU meter (audio level indicator).
  - One-click HD Snapshot capture with shutter flash animation and instant download.
  - Mobile QR Code generator: Scan directly with a smartphone camera to connect immediately.
  - Fullscreen mode (press `F` or click fullscreen button).
- **MJPEG Fallback**: Easily switch to standard Motion JPEG stream for compatibility with smart home dashboards (Home Assistant), VLC player, or older devices.
- **Motion Detection Architecture**: Extensible `CameraManager.register_frame_hook()` architecture ready for the upcoming motion detection and alert module.

---

## Quick Start

### 1. Requirements

Python 3.10+ is required (works on macOS Apple Silicon M1/M2/M3/M4, Intel Mac, and Windows).
```bash
pip install -r requirements.txt
```

### 2. Launch the Server

- **On macOS (Mac Terminal)**:
  ```bash
  chmod +x start.sh
  ./start.sh
  ```
  *(or simply run: `python3 server.py`)*

  > **Note for macOS**: The first time you run this, macOS will prompt you: *"Terminal would like to access the Camera"* and *"Terminal would like to access the Microphone"*. Click **OK / Allow**.

- **On Windows**:
  ```cmd
  python server.py
  ```
  *(or double-click `start.bat`)*

### 3. Connect

When the server starts, it prints your local network IP:
```
====================================================================
           CAMERA STREAMING - LOCAL SERVER IS LIVE
====================================================================
  * Mode: Headless Camera + Microphone WebRTC Server
  * Local Access:   http://localhost:8080
  * Network Access: http://10.89.124.164:8080
--------------------------------------------------------------------
  Connect from your phone, tablet, or another computer on the same
  Wi-Fi network by opening the Network Access URL above!
====================================================================
```

- **From the Laptop**: Open `http://localhost:8080`
- **From Phone / Other PC**: Open `http://<YOUR_LAN_IP>:8080` (or click "Connect Device" on the web page to scan the QR code).

---

## Architecture

```
Laptop (Host)
  │
  ├── CameraManager (OpenCV VideoCapture in background thread)
  │     ├── WebRTC VideoStreamTrack (H.264 / VP8)
  │     ├── MJPEG Endpoint (/stream.mjpg)
  │     └── Snapshot API (/api/snapshot)
  │
  ├── AudioManager (SoundDevice InputStream at 48kHz)
  │     └── WebRTC AudioStreamTrack (Opus PCM frames)
  │
  └── aiohttp Web & WebSocket Server (Port 8080)
        ├── HTTP Static SPA (HTML5, Vanilla CSS, JS)
        ├── WebSocket Signaling (/ws)
        └── Real-time Telemetry & Ping/Pong
```

---

## Future Roadmap: Motion Detection

The `CameraManager` includes a built-in frame hook system (`register_frame_hook(callback)`). The upcoming motion detection update will provide:
- Frame-differencing motion tracker with adjustable sensitivity thresholds.
- Visual bounding boxes / heatmaps overlaid onto the video stream.
- Audio or visual alert triggers when motion is detected.
- Timestamped motion event log and thumbnail capture.
