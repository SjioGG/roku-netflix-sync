"""WebRTC AEC3 echo canceller fed by a synced Chrome reference.

The pure-Python NLMS canceller in ``aec_daemon`` models 16 ms of room echo and
cannot run a long filter in real time. A living room needs several hundred
milliseconds, so the live path uses WebRTC's AEC3 (through the ``livekit``
wheel) with noise suppression and a high-pass filter.

AEC3 is causal: the reference must reach it *before* the echo reaches the
microphone, and it works best with the reference leading by 100 ms or more.
Measured on a real Roku TV and MacBook microphone, cancellation was 4-6 dB with
the reference 0-50 ms ahead, about 25 dB at 100-250 ms and better beyond that.

``ReferenceAligner`` measures the acoustic lag between the Chrome reference and
the microphone with GCC-PHAT. The extension uses that measurement to keep
Chrome ``TARGET_LEAD_MS`` ahead of the TV. Until it gets there, the mic is
delayed here so that the canceller always sees at least ``MIN_LEAD_MS``.
"""
import math

try:
    import numpy as np
except ImportError:  # pragma: no cover - the bundled runtime ships numpy
    np = None

try:
    from livekit import rtc as _rtc
except ImportError:  # pragma: no cover - optional until the runtime has it
    _rtc = None

FRAME_MS = 10
TARGET_LEAD_MS = 200.0
MIN_LEAD_MS = 120.0
MAX_MIC_DELAY_MS = 600.0
LAG_WINDOW_S = 3.0
LAG_SEARCH_MS = 1500.0
LAG_UPDATE_S = 1.0
# GCC-PHAT peak over the mean |correlation|. Real room takes scored 45-165;
# silence and unrelated audio stay under 10.
LAG_MIN_PEAK = 12.0
# Lead changes bigger than this need a second agreeing window.
JUMP_MS = 30.0
# Ignore mic-delay corrections smaller than this, so every new
# measurement does not reset the canceller.
MIC_DELAY_STEP_MS = 40.0


def available():
    return _rtc is not None and np is not None


def gcc_phat_lag(ref, mic, max_lag):
    """Lag ``tau`` (samples) with ``mic[n] ~= ref[n - tau]`` and its peak score."""
    n = 1 << int(math.ceil(math.log2(len(ref) + len(mic))))
    spec = np.fft.rfft(mic, n) * np.conj(np.fft.rfft(ref, n))
    spec /= np.abs(spec) + 1e-9
    corr = np.fft.irfft(spec, n)
    window = np.concatenate([corr[-max_lag:], corr[:max_lag + 1]])
    index = int(np.argmax(window))
    score = float(window[index] / (np.mean(np.abs(window)) + 1e-12))
    return index - max_lag, score


class ReferenceAligner:
    """Tracks how far the Chrome reference leads the room echo."""

    def __init__(self, sample_rate, window_s=LAG_WINDOW_S, search_ms=LAG_SEARCH_MS,
                 update_s=LAG_UPDATE_S, min_peak=LAG_MIN_PEAK):
        self.sample_rate = int(sample_rate)
        self.window = int(window_s * sample_rate)
        self.max_lag = int(search_ms * sample_rate / 1000.0)
        self.update = int(update_s * sample_rate)
        self.min_peak = float(min_peak)
        size = self.window + self.max_lag
        self._ref = np.zeros(size, np.float32)
        self._mic = np.zeros(size, np.float32)
        self._filled = 0
        self._since = 0
        self.lead_ms = None
        self._pending_lead = None
        self.score = 0.0
        self.measurements = 0

    def push(self, ref, mic):
        """Add raw (unshifted) blocks; returns True when a new lag was measured."""
        count = len(ref)
        for buf, block in ((self._ref, ref), (self._mic, mic)):
            buf[:-count] = buf[count:]
            buf[-count:] = block
        self._filled = min(len(self._ref), self._filled + count)
        self._since += count
        if self._since < self.update or self._filled < len(self._ref):
            return False
        self._since = 0
        mic_win = self._mic[-self.window:]
        ref_win = self._ref[-self.window:]
        if float(np.std(ref_win)) < 1e-4 or float(np.std(mic_win)) < 1e-4:
            self.score = 0.0
            return False
        lag, score = gcc_phat_lag(ref_win, mic_win, self.max_lag)
        self.score = score
        if score < self.min_peak:
            return False
        lead = lag * 1000.0 / self.sample_rate
        # A single odd window (a scene cut, a digital click on both paths) can
        # score high at the wrong lag. Accept a jump only once two windows in
        # a row agree on it.
        if self.lead_ms is not None and abs(lead - self.lead_ms) > JUMP_MS:
            pending = self._pending_lead
            self._pending_lead = lead
            if pending is None or abs(pending - lead) > JUMP_MS:
                return False
        self._pending_lead = None
        self.lead_ms = lead
        self.measurements += 1
        return True


class WebRtcEchoCanceller:
    """Same ``process_frame`` contract as ``AcousticEchoCanceller``.

    Blocks of any size are re-chunked into 10 ms frames. Output is delayed by
    one frame plus any mic delay applied while Chrome catches up.
    """

    def __init__(self, sample_rate=16000, noise_suppression=True,
                 target_lead_ms=TARGET_LEAD_MS, min_lead_ms=MIN_LEAD_MS,
                 max_mic_delay_ms=MAX_MIC_DELAY_MS, **_ignored):
        if not available():
            raise RuntimeError('WebRTC AEC needs the livekit and numpy packages')
        self.sample_rate = int(sample_rate)
        self.frame = self.sample_rate * FRAME_MS // 1000
        self.target_lead_ms = float(target_lead_ms)
        self.min_lead_ms = float(min_lead_ms)
        self.max_mic_delay = int(max_mic_delay_ms * self.sample_rate / 1000.0)
        self._noise_suppression = bool(noise_suppression)
        self._apm = self._new_apm()
        self.aligner = ReferenceAligner(self.sample_rate)
        self.mic_delay = 0
        self._mic_line = np.zeros(self.max_mic_delay + self.frame, np.float32)
        self._ref_pending = np.zeros(0, np.float32)
        self._mic_pending = np.zeros(0, np.float32)
        self._out_pending = np.zeros(0, np.float32)
        self._in_energy = 0.0
        self._out_energy = 0.0
        self._erle_db = 0.0
        self._processed = 0
        self._resets = 0

    def _new_apm(self):
        return _rtc.AudioProcessingModule(echo_cancellation=True,
                                          noise_suppression=self._noise_suppression,
                                          high_pass_filter=True,
                                          auto_gain_control=False)

    def _frame(self, samples):
        pcm = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
        return _rtc.AudioFrame(pcm.tobytes(), self.sample_rate, 1, len(pcm))

    def _retune_mic_delay(self):
        """Delay the mic just enough that the reference leads by ``min_lead``."""
        lead = self.aligner.lead_ms
        if lead is None:
            return
        applied = self.mic_delay * 1000.0 / self.sample_rate
        effective = lead + applied
        if lead >= self.min_lead_ms:
            # Chrome alone leads enough: no extra voice latency.
            wanted = 0.0
        else:
            wanted = self.target_lead_ms - lead
        wanted = max(0.0, min(wanted, self.max_mic_delay * 1000.0 / self.sample_rate))
        if wanted > 0.0 and effective >= self.min_lead_ms and abs(wanted - applied) < MIC_DELAY_STEP_MS:
            return
        samples = int(round(wanted * self.sample_rate / 1000.0))
        if abs(samples - self.mic_delay) >= self.frame:
            self.mic_delay = samples
            # A jump in the echo path invalidates the adapted filter.
            self._apm = self._new_apm()
            self._resets += 1

    def process_frame(self, ref_samples, mic_samples):
        ref = np.asarray(ref_samples, dtype=np.float32)
        mic = np.asarray(mic_samples, dtype=np.float32)
        if len(ref) != len(mic):
            raise ValueError('reference and microphone frames must be the same length')
        count = len(mic)
        if self.aligner.push(ref, mic):
            self._retune_mic_delay()
        self._ref_pending = np.concatenate([self._ref_pending, ref])
        self._mic_pending = np.concatenate([self._mic_pending, mic])
        frame = self.frame
        produced = []
        while len(self._mic_pending) >= frame:
            ref_f = self._ref_pending[:frame]
            mic_f = self._mic_pending[:frame]
            self._ref_pending = self._ref_pending[frame:]
            self._mic_pending = self._mic_pending[frame:]
            line = self._mic_line
            line[:-frame] = line[frame:]
            line[-frame:] = mic_f
            start = len(line) - frame - self.mic_delay
            delayed = line[start:start + frame].copy()
            self._apm.process_reverse_stream(self._frame(ref_f))
            mic_frame = self._frame(delayed)
            self._apm.process_stream(mic_frame)
            clean = np.frombuffer(bytes(mic_frame.data), np.int16).astype(np.float32) / 32767.0
            produced.append(clean)
            e_in = float(np.dot(delayed, delayed))
            e_out = float(np.dot(clean, clean))
            self._in_energy = 0.97 * self._in_energy + 0.03 * e_in
            self._out_energy = 0.97 * self._out_energy + 0.03 * e_out
        if produced:
            self._out_pending = np.concatenate([self._out_pending] + produced)
        if len(self._out_pending) >= count:
            out = self._out_pending[:count]
            self._out_pending = self._out_pending[count:]
        else:
            out = np.concatenate([np.zeros(count - len(self._out_pending), np.float32),
                                  self._out_pending])
            self._out_pending = np.zeros(0, np.float32)
        self._processed += count
        if self._in_energy > 1e-9:
            self._erle_db = 10.0 * math.log10((self._in_energy + 1e-12) / (self._out_energy + 1e-12))
        return out.tolist(), self.stats()

    def stats(self):
        lead = self.aligner.lead_ms
        applied_ms = self.mic_delay * 1000.0 / self.sample_rate
        return {
            'engine': 'webrtc-aec3',
            # Positive: the Chrome reference plays before the TV echo arrives.
            'acoustic_lead_ms': None if lead is None else round(lead, 1),
            'acoustic_score': round(self.aligner.score, 1),
            'acoustic_measurements': self.aligner.measurements,
            'target_lead_ms': self.target_lead_ms,
            'mic_delay_ms': round(applied_ms, 1),
            'delay_ms': None if lead is None else round(lead + applied_ms, 1),
            'confidence': round(min(1.0, self.aligner.score / 50.0), 4),
            'erle_db': round(self._erle_db, 2),
            'latency_ms': round(applied_ms + FRAME_MS, 1),
            'double_talk': False,
            'resets': self._resets,
            'samples': self._processed,
        }
