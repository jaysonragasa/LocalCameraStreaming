"""
Camera Manager Module
Handles headless webcam capture in a dedicated background thread,
providing thread-safe frames for WebRTC tracks, MJPEG streaming, and snapshots.
"""

import cv2
import numpy as np
import threading
import time
import logging
import sys

logger = logging.getLogger("camera_manager")


class CameraManager:
    def __init__(self, device_index=0, width=1280, height=720, target_fps=30):
        self.device_index = device_index
        self.target_width = width
        self.target_height = height
        self.target_fps = target_fps

        self._cap = None
        self._running = False
        self._thread = None
        self._lock = threading.Lock()

        self._latest_frame = None
        self._latest_timestamp = 0.0
        self._frame_count = 0
        self._actual_fps = 0.0
        self._fps_last_time = time.time()
        self._fps_counter = 0

        # Frame hook for future motion detection
        self._frame_hooks = []

        # Placeholder frame if camera is starting or unavailable
        self._placeholder = self._create_placeholder("Initializing Camera...")

    def _create_placeholder(self, text: str) -> np.ndarray:
        img = np.zeros((self.target_height, self.target_width, 3), dtype=np.uint8)
        # Gradient background
        for y in range(self.target_height):
            c = int(15 + 25 * (y / self.target_height))
            img[y, :] = (c, c, int(c * 1.3))
        
        # Add text
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 1.0
        color = (200, 220, 255)
        thickness = 2
        size = cv2.getTextSize(text, font, font_scale, thickness)[0]
        tx = (self.target_width - size[0]) // 2
        ty = (self.target_height + size[1]) // 2
        cv2.putText(img, text, (tx, ty), font, font_scale, color, thickness, cv2.LINE_AA)
        return img

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()
        logger.info(f"Camera manager thread started for device {self.device_index}")

    def _init_capture(self) -> bool:
        if self._cap is not None:
            self._cap.release()
        
        # Select optimal backend based on operating system
        if sys.platform == "darwin":
            # macOS AVFoundation native camera backend
            cap = cv2.VideoCapture(self.device_index, cv2.CAP_AVFOUNDATION)
        elif sys.platform == "win32":
            # Windows DirectShow backend for fast initialization
            cap = cv2.VideoCapture(self.device_index, cv2.CAP_DSHOW)
        elif sys.platform.startswith("linux"):
            # Linux Video4Linux2 backend
            cap = cv2.VideoCapture(self.device_index, cv2.CAP_V4L2)
        else:
            cap = cv2.VideoCapture(self.device_index)

        if not cap.isOpened():
            logger.warning("Platform-specific backend failed, falling back to default camera backend")
            cap = cv2.VideoCapture(self.device_index)

        if not cap.isOpened():
            logger.error(f"Unable to open camera index {self.device_index}")
            return False

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.target_width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.target_height)
        cap.set(cv2.CAP_PROP_FPS, self.target_fps)

        self._cap = cap
        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        logger.info(f"Camera opened: {actual_w}x{actual_h} @ {self.target_fps}fps target")
        return True

    def _capture_loop(self):
        if not self._init_capture():
            self._placeholder = self._create_placeholder("Camera Not Detected / In Use")

        interval = 1.0 / self.target_fps

        while self._running:
            start_t = time.time()

            if self._cap is None or not self._cap.isOpened():
                time.sleep(1.0)
                if not self._init_capture():
                    continue

            ret, frame = self._cap.read()
            if ret and frame is not None:
                # Update latest frame
                with self._lock:
                    self._latest_frame = frame
                    self._latest_timestamp = time.time()
                    self._frame_count += 1
                    self._fps_counter += 1

                # Calculate actual FPS every second
                now = time.time()
                if now - self._fps_last_time >= 1.0:
                    self._actual_fps = self._fps_counter / (now - self._fps_last_time)
                    self._fps_counter = 0
                    self._fps_last_time = now

                # Execute motion detection or other analysis hooks
                for hook in self._frame_hooks:
                    try:
                        hook(frame)
                    except Exception as e:
                        logger.error(f"Error in frame hook: {e}")
            else:
                logger.warning("Failed to read camera frame, attempting reconnect...")
                time.sleep(0.5)
                self._init_capture()

            elapsed = time.time() - start_t
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

        if self._cap is not None:
            self._cap.release()
            self._cap = None
        logger.info("Camera capture loop stopped")

    def register_frame_hook(self, callback):
        """Register a callback for each new frame (e.g. motion detection)."""
        self._frame_hooks.append(callback)

    def get_latest_frame(self) -> np.ndarray:
        with self._lock:
            if self._latest_frame is not None:
                return self._latest_frame
            return self._placeholder

    def get_jpeg(self, quality=80) -> bytes:
        frame = self.get_latest_frame()
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
        ret, buf = cv2.imencode(".jpg", frame, encode_param)
        if ret:
            return buf.tobytes()
        return b""

    def set_resolution(self, width: int, height: int):
        self.target_width = width
        self.target_height = height
        if self._cap is not None:
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        logger.info(f"Resolution set to {width}x{height}")

    def get_status(self) -> dict:
        frame = self.get_latest_frame()
        h, w = frame.shape[:2]
        return {
            "device_index": self.device_index,
            "running": self._running,
            "width": w,
            "height": h,
            "fps": round(self._actual_fps, 1),
            "frame_count": self._frame_count,
        }

    def stop(self):
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
