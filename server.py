"""
Local Camera & Audio Streaming Server
Headless WebRTC + WebSocket streaming server with MJPEG fallback and real-time telemetry.
"""

import asyncio
import json
import logging
import os
import socket
import sys
import time
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate

from camera_streamer import CameraManager, AudioManager, CameraVideoStreamTrack, MicrophoneAudioStreamTrack

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("server")

# Global instances
camera_manager = CameraManager(device_index=0, width=1280, height=720, target_fps=30)
audio_manager = AudioManager(sample_rate=48000, channels=1)

active_peer_connections = set()
active_websockets = set()
server_start_time = time.time()


def get_local_ip() -> str:
    """Detect the host's primary local LAN IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


async def index_handler(request):
    """Serve the viewer SPA index.html."""
    html_path = os.path.join(os.path.dirname(__file__), "static", "index.html")
    if os.path.exists(html_path):
        return web.FileResponse(html_path)
    return web.Response(text="index.html not found", status=404)


async def api_info_handler(request):
    """Return JSON server and streaming telemetry."""
    local_ip = get_local_ip()
    port = request.app.get("port", 8080)
    return web.json_response({
        "status": "online",
        "local_ip": local_ip,
        "port": port,
        "access_url": f"http://{local_ip}:{port}",
        "viewers_count": len(active_peer_connections) + len(active_websockets),
        "uptime_seconds": int(time.time() - server_start_time),
        "camera": camera_manager.get_status(),
        "audio": audio_manager.get_status(),
    })


async def api_snapshot_handler(request):
    """Capture full resolution instant photo."""
    jpeg_bytes = camera_manager.get_jpeg(quality=92)
    return web.Response(
        body=jpeg_bytes,
        content_type="image/jpeg",
        headers={"Content-Disposition": f"inline; filename=snapshot_{int(time.time())}.jpg"}
    )


async def mjpeg_stream_handler(request):
    """Fallback MJPEG video stream."""
    response = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "multipart/x-mixed-replace; boundary=frame",
            "Cache-Control": "no-cache",
            "Connection": "close",
        },
    )
    await response.prepare(request)

    try:
        while True:
            jpeg = camera_manager.get_jpeg(quality=75)
            frame_header = (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
            )
            await response.write(frame_header)
            await asyncio.sleep(1.0 / 25.0)
    except (asyncio.CancelledError, ConnectionResetError):
        pass
    return response


async def websocket_handler(request):
    """WebSocket handler for WebRTC signaling, ping/pong, and telemetry."""
    ws = web.WebSocketResponse(heartbeat=20.0)
    await ws.prepare(request)

    active_websockets.add(ws)
    logger.info(f"WebSocket client connected. Total clients: {len(active_websockets)}")

    # Associated WebRTC connection for this client
    pc = None
    video_track = None
    audio_track = None

    async def cleanup_pc():
        nonlocal pc, video_track, audio_track
        if pc is not None:
            active_peer_connections.discard(pc)
            try:
                await pc.close()
            except Exception:
                pass
            pc = None
        if audio_track:
            audio_track.stop()
            audio_track = None

    try:
        # Send initial welcome and IP info
        local_ip = get_local_ip()
        port = request.app.get("port", 8080)
        await ws.send_json({
            "type": "welcome",
            "local_ip": local_ip,
            "port": port,
            "stream_url": f"http://{local_ip}:{port}",
        })

        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                data = json.loads(msg.data)
                msg_type = data.get("type")

                # WebRTC Offer
                if msg_type == "offer":
                    await cleanup_pc()
                    pc = RTCPeerConnection()
                    active_peer_connections.add(pc)

                    # Create and bind tracks
                    video_track = CameraVideoStreamTrack(camera_manager, fps=30)
                    audio_track = MicrophoneAudioStreamTrack(audio_manager)

                    pc.addTrack(video_track)
                    pc.addTrack(audio_track)

                    @pc.on("connectionstatechange")
                    async def on_connectionstatechange():
                        logger.info(f"PeerConnection state: {pc.connectionState}")
                        if pc.connectionState in ["failed", "closed"]:
                            await cleanup_pc()

                    offer = RTCSessionDescription(sdp=data["sdp"], type="offer")
                    await pc.setRemoteDescription(offer)

                    answer = await pc.createAnswer()
                    await pc.setLocalDescription(answer)

                    await ws.send_json({
                        "type": "answer",
                        "sdp": pc.localDescription.sdp,
                    })
                    logger.info("WebRTC answer sent to client")

                # ICE Candidate from browser
                elif msg_type == "candidate":
                    candidate_info = data.get("candidate")
                    if candidate_info and pc and pc.remoteDescription:
                        try:
                            # Handle standard candidate format
                            cand_str = candidate_info.get("candidate", "")
                            if cand_str:
                                parts = cand_str.split()
                                if len(parts) >= 8:
                                    candidate = RTCIceCandidate(
                                        component=int(parts[1]),
                                        foundation=parts[0].split(":")[1] if ":" in parts[0] else parts[0],
                                        ip=parts[4],
                                        port=int(parts[5]),
                                        priority=int(parts[3]),
                                        protocol=parts[2].lower(),
                                        type=parts[7],
                                        sdpMid=candidate_info.get("sdpMid"),
                                        sdpMLineIndex=candidate_info.get("sdpMLineIndex"),
                                    )
                                    await pc.addIceCandidate(candidate)
                        except Exception as e:
                            logger.debug(f"Candidate add error: {e}")

                # Ping for latency calculation
                elif msg_type == "ping":
                    await ws.send_json({
                        "type": "pong",
                        "client_time": data.get("client_time", 0),
                        "server_time": time.time(),
                        "audio_level": audio_manager.get_audio_level(),
                        "camera_fps": camera_manager.get_status()["fps"],
                    })

                # Change resolution request
                elif msg_type == "set_resolution":
                    w = int(data.get("width", 1280))
                    h = int(data.get("height", 720))
                    camera_manager.set_resolution(w, h)
                    await ws.send_json({
                        "type": "resolution_changed",
                        "width": w,
                        "height": h,
                    })

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"WebSocket error: {ws.exception()}")

    finally:
        active_websockets.discard(ws)
        await cleanup_pc()
        logger.info("WebSocket client disconnected")

    return ws


async def telemetry_broadcast_loop(app):
    """Background task to broadcast periodic stats to all connected WebSocket clients."""
    try:
        while True:
            await asyncio.sleep(1.0)
            if active_websockets:
                cam_status = camera_manager.get_status()
                aud_status = audio_manager.get_status()
                payload = json.dumps({
                    "type": "telemetry",
                    "fps": cam_status["fps"],
                    "audio_level": aud_status["level"],
                    "viewers": len(active_peer_connections) + len(active_websockets),
                    "camera_res": f"{cam_status['width']}x{cam_status['height']}",
                })
                for ws in list(active_websockets):
                    if not ws.closed:
                        try:
                            await ws.send_str(payload)
                        except Exception:
                            pass
    except asyncio.CancelledError:
        pass


async def on_startup(app):
    """Server startup hook."""
    logger.info("Starting headless Camera and Audio capture...")
    camera_manager.start()
    audio_manager.start()
    app["telemetry_task"] = asyncio.create_task(telemetry_broadcast_loop(app))


async def on_cleanup(app):
    """Graceful shutdown hook."""
    logger.info("Shutting down camera streaming server...")
    if "telemetry_task" in app:
        app["telemetry_task"].cancel()

    for pc in list(active_peer_connections):
        try:
            await pc.close()
        except Exception:
            pass
    active_peer_connections.clear()

    camera_manager.stop()
    audio_manager.stop()


def create_app(port=8080) -> web.Application:
    app = web.Application()
    app["port"] = port
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    # Static assets directory
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    os.makedirs(static_dir, exist_ok=True)

    app.router.add_get("/", index_handler)
    app.router.add_get("/api/info", api_info_handler)
    app.router.add_get("/api/snapshot", api_snapshot_handler)
    app.router.add_get("/stream.mjpg", mjpeg_stream_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_static("/static/", static_dir, name="static")

    return app


def print_banner(host, port, local_ip):
    banner = f"""
====================================================================
           CAMERA STREAMING - LOCAL SERVER IS LIVE
====================================================================
  * Mode: Headless Camera + Microphone WebRTC Server
  * Local Access:   http://localhost:{port}
  * Network Access: http://{local_ip}:{port}
--------------------------------------------------------------------
  Connect from your phone, tablet, or another computer on the same
  Wi-Fi network by opening the Network Access URL above!
====================================================================
"""
    print(banner)


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    local_ip = get_local_ip()
    app = create_app(port=port)
    print_banner("0.0.0.0", port, local_ip)

    web.run_app(app, host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    main()
