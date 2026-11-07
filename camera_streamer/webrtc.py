"""
WebRTC Media Tracks Module
Provides aiortc VideoStreamTrack and AudioStreamTrack implementations
bound to CameraManager and AudioManager.
"""

import asyncio
import fractions
import time
import av
import numpy as np
from aiortc import MediaStreamTrack
import logging

logger = logging.getLogger("webrtc_tracks")

VIDEO_CLOCK_RATE = 90000
VIDEO_TIME_BASE = fractions.Fraction(1, VIDEO_CLOCK_RATE)

AUDIO_CLOCK_RATE = 48000
AUDIO_TIME_BASE = fractions.Fraction(1, AUDIO_CLOCK_RATE)


class CameraVideoStreamTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, camera_manager, fps=30):
        super().__init__()
        self.camera_manager = camera_manager
        self.fps = fps
        self._start_time = None
        self._timestamp = 0
        self._interval = 1.0 / fps

    async def recv(self):
        pts, time_base = await self.next_timestamp()

        # Fetch latest frame from headless camera manager
        bgr_frame = self.camera_manager.get_latest_frame()

        # Wrap in av.VideoFrame
        video_frame = av.VideoFrame.from_ndarray(bgr_frame, format="bgr24")
        video_frame.pts = pts
        video_frame.time_base = time_base
        return video_frame


class MicrophoneAudioStreamTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self, audio_manager):
        super().__init__()
        self.audio_manager = audio_manager
        self.queue = audio_manager.create_subscriber_queue()
        self._timestamp = 0
        self.block_size = audio_manager.block_size
        self.sample_rate = audio_manager.sample_rate

    async def recv(self):
        pts, time_base = await self.next_timestamp()

        # Try to pull audio block non-blocking or with short async wait
        data = None
        loop = asyncio.get_running_loop()
        try:
            # Check queue without blocking
            data = self.queue.get_nowait()
        except Exception:
            # If empty, generate silence block
            data = np.zeros((self.block_size, self.audio_manager.channels), dtype=np.int16)

        # Ensure correct shape for av AudioFrame (channels, samples)
        if self.audio_manager.channels == 1:
            samples = data.reshape(1, -1)
            layout = "mono"
        else:
            samples = data.T
            layout = "stereo"

        audio_frame = av.AudioFrame.from_ndarray(samples, format="s16", layout=layout)
        audio_frame.sample_rate = self.sample_rate
        audio_frame.pts = pts
        audio_frame.time_base = time_base
        return audio_frame

    def stop(self):
        super().stop()
        self.audio_manager.remove_subscriber_queue(self.queue)
