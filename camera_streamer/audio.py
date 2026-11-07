"""
Audio Manager Module
Captures microphone audio in real time using sounddevice,
converts to av.AudioFrame (Opus-compatible 48kHz PCM),
and provides live audio level monitoring for UI visualizers.
"""

import sounddevice as sd
import numpy as np
import av
import threading
import queue
import time
import logging

logger = logging.getLogger("audio_manager")


class AudioManager:
    def __init__(self, sample_rate=48000, channels=1, block_duration_ms=20):
        self.sample_rate = sample_rate
        self.channels = channels
        self.block_size = int(self.sample_rate * (block_duration_ms / 1000.0))  # e.g. 960 for 20ms

        self._stream = None
        self._running = False
        self._audio_queues = []
        self._lock = threading.Lock()

        # Real-time audio meter (0.0 to 1.0)
        self._current_level = 0.0

        # Silence block fallback
        self._silence_data = np.zeros((self.block_size, self.channels), dtype=np.int16)

    def start(self):
        if self._running:
            return
        self._running = True
        try:
            self._stream = sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                blocksize=self.block_size,
                dtype="int16",
                callback=self._audio_callback,
            )
            self._stream.start()
            logger.info(f"Microphone audio stream started @ {self.sample_rate}Hz, blocksize={self.block_size}")
        except Exception as e:
            logger.warning(f"Could not initialize microphone input stream: {e}. Falling back to silence stream.")
            self._stream = None

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            logger.debug(f"Audio callback status: {status}")

        data_copy = indata.copy()

        # Calculate peak amplitude for UI VU meter
        peak = np.max(np.abs(data_copy)) if len(data_copy) > 0 else 0
        self._current_level = min(1.0, float(peak) / 32767.0)

        # Distribute to subscriber queues
        with self._lock:
            for q in list(self._audio_queues):
                try:
                    # Keep queue size small (max 5 frames) to avoid audio latency buffer bloat
                    if q.full():
                        try:
                            q.get_nowait()
                        except queue.Empty:
                            pass
                    q.put_nowait(data_copy)
                except Exception:
                    pass

    def create_subscriber_queue(self) -> queue.Queue:
        q = queue.Queue(maxsize=10)
        with self._lock:
            self._audio_queues.append(q)
        return q

    def remove_subscriber_queue(self, q: queue.Queue):
        with self._lock:
            if q in self._audio_queues:
                self._audio_queues.remove(q)

    def get_audio_level(self) -> float:
        """Returns peak audio level (0.0 to 1.0) for visualizer."""
        return round(self._current_level, 3)

    def get_status(self) -> dict:
        return {
            "running": self._running,
            "has_stream": self._stream is not None and self._stream.active,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "level": self.get_audio_level(),
        }

    def stop(self):
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception as e:
                logger.error(f"Error stopping audio stream: {e}")
            self._stream = None
        logger.info("Audio manager stopped")
