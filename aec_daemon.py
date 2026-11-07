#!/usr/bin/env python3
"""Real-time acoustic echo canceller that strips Roku TV audio from the mic.

The Roku soundbar plays the episode in the room while the synced Chrome tab
holds a digital copy of the same audio. Routing that tab silently into a
virtual loopback device gives this daemon a clean far-end reference, so the TV
bleed picked up by the MacBook microphone can be subtracted before it reaches
a call.

Two things make the room different from a phone speakerphone:

* the acoustic path is long (a soundbar across a living room, tens of
  milliseconds) and
* the Chrome reference and the Roku are only synced to within a few hundred
  milliseconds, so the lag to track is in the hundreds of milliseconds,
  sometimes with the reference *ahead* of the microphone.

:func:`estimate_delay_samples` therefore runs a GCC-PHAT cross-correlation over
a +/-600 ms window, and :class:`AcousticEchoCanceller` feeds the delay-aligned
reference into a normalised-LMS adaptive filter guarded by a Geigel
double-talk detector, followed by a residual echo suppressor.

Everything here runs on the Python standard library. ``numpy`` and
``sounddevice`` are used automatically when installed, which makes the offline
and live paths faster/louder, but the DSP is pure stdlib so the unit tests pass
on a bare ``python3``:

    python3 -m unittest discover -s tests -p 'test_*.py'
    python3 aec_daemon.py --selftest
"""
import argparse
import array
import cmath
import json
import math
import operator
import platform
import shutil
import struct
import subprocess
import sys
import wave

try:  # Optional fast path: only used when already installed.
    import numpy as _np
except ImportError:  # pragma: no cover - the stdlib path is the tested one
    _np = None

try:  # Optional: only needed for --live capture/playback.
    import sounddevice as _sd
except (ImportError, OSError):  # pragma: no cover - depends on the host
    _sd = None

DEFAULT_SAMPLE_RATE = 16000
DEFAULT_FILTER_LENGTH = 256
DEFAULT_MAX_DELAY_MS = 600.0
DEFAULT_MU = 0.5
DEFAULT_MU_MIN = 0.01
DEFAULT_BLOCK_SIZE = 512
DEFAULT_DELAY_UPDATE_S = 0.5
DEFAULT_DELAY_WINDOW_S = 0.25
DEFAULT_DELAY_CONFIDENCE = 0.4
# Residual echo power over predicted echo power that counts as near-end speech.
DEFAULT_DOUBLE_TALK_RATIO = 0.05
DEFAULT_GEIGEL_RATIO = 1.0

_MUL = operator.mul


def _dot(a, b):
    """Sum of element products, using C-level iteration over ``map``."""
    return sum(map(_MUL, a, b))


def _energy(values):
    return _dot(values, values)


def _db(ratio):
    return 10.0 * math.log10(ratio) if ratio > 0 else -999.0


# ---------------------------------------------------------------------------
# Radix-2 FFT
# ---------------------------------------------------------------------------
_TWIDDLE_CACHE = {}
_TWIDDLE_CACHE_LIMIT = 8


def next_power_of_two(n):
    """Smallest power of two >= ``n`` (and at least 1)."""
    n = int(n)
    if n <= 1:
        return 1
    return 1 << (n - 1).bit_length()


def _twiddles(size):
    """Forward twiddle factors ``exp(-2*pi*i*k/size)`` for ``k < size // 2``."""
    table = _TWIDDLE_CACHE.get(size)
    if table is not None:
        return table
    if len(_TWIDDLE_CACHE) >= _TWIDDLE_CACHE_LIMIT:
        _TWIDDLE_CACHE.clear()
    table = [cmath.exp(-2j * math.pi * k / size) for k in range(size >> 1)]
    _TWIDDLE_CACHE[size] = table
    return table


def fft(values):
    """In-place iterative radix-2 Cooley-Tukey FFT over a power-of-two list."""
    size = len(values)
    if size <= 1:
        return values
    if size & (size - 1):
        raise ValueError('fft length must be a power of two')
    j = 0
    for i in range(1, size):
        bit = size >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            values[i], values[j] = values[j], values[i]
    twiddle = _twiddles(size)
    length = 2
    while length <= size:
        half = length >> 1
        step = size // length
        for start in range(0, size, length):
            k = 0
            end = start + half
            for i in range(start, end):
                w = twiddle[k]
                u = values[i]
                v = values[i + half] * w
                values[i] = u + v
                values[i + half] = u - v
                k += step
        length <<= 1
    return values


def ifft(values):
    """Inverse of :func:`fft` via the conjugate trick."""
    size = len(values)
    if size <= 1:
        return values
    conj = [value.conjugate() for value in values]
    fft(conj)
    scale = 1.0 / size
    return [value.conjugate() * scale for value in conj]


def gcc_phat_correlation(ref, mic, size, eps=1e-9):
    """Cross-correlation surface of the GCC-PHAT weighted spectra.

    ``corr[lag % size]`` estimates the correlation of the microphone against
    the reference at that lag, so a room echo arriving ``D`` samples late (that
    is, ``mic[n] ~= ref[n - D]``) peaks at index ``D`` and a reference that lags
    the room peaks at ``size - D``.
    """
    if _np is not None:
        ref_array = _np.asarray(ref, dtype=float)
        mic_array = _np.asarray(mic, dtype=float)
        spectrum = _np.conj(_np.fft.rfft(ref_array, size)) * _np.fft.rfft(mic_array, size)
        spectrum /= _np.abs(spectrum) + eps
        return [float(value) for value in _np.fft.irfft(spectrum, size)]
    ref_spectrum = fft([complex(value, 0.0) for value in ref] + [0j] * (size - len(ref)))
    mic_spectrum = fft([complex(value, 0.0) for value in mic] + [0j] * (size - len(mic)))
    cross = [x.conjugate() * y for x, y in zip(ref_spectrum, mic_spectrum)]
    normalised = [value / (abs(value) + eps) for value in cross]
    return [value.real for value in ifft(normalised)]


def _parabolic_offset(correlation, index, size):
    """Sub-sample offset of a correlation peak from its neighbours."""
    left = correlation[(index - 1) % size]
    centre = correlation[index]
    right = correlation[(index + 1) % size]
    denominator = left - 2.0 * centre + right
    if abs(denominator) < 1e-20:
        return 0.0
    offset = 0.5 * (left - right) / denominator
    return offset if -1.0 < offset < 1.0 else 0.0


def _decimate(samples, factor):
    """Average groups of ``factor`` samples, a cheap anti-aliased downsampler."""
    if factor <= 1:
        return list(samples)
    scale = 1.0 / factor
    return [sum(samples[start:start + factor]) * scale
            for start in range(0, len(samples) - factor + 1, factor)]


def normalized_correlation(ref, mic, lag):
    """Normalised cross-correlation of ``mic[n]`` and ``ref[n - lag]`` in [-1, 1]."""
    length = min(len(ref), len(mic))
    if lag >= 0:
        span = length - lag
        if span <= 1:
            return 0.0
        a = mic[lag:lag + span]
        b = ref[:span]
    else:
        span = length + lag
        if span <= 1:
            return 0.0
        a = mic[:span]
        b = ref[-lag:-lag + span]
    numerator = _dot(a, b)
    denominator = math.sqrt(max(0.0, _energy(a) * _energy(b)))
    if denominator <= 0.0:
        return 0.0
    return min(1.0, abs(numerator) / denominator)


def estimate_delay_samples(ref_frame, mic_frame, max_lag_samples,
                           min_energy=1e-9, eps=1e-9):
    """GCC-PHAT delay of ``mic`` behind ``ref``, in samples, plus confidence.

    The search covers ``[-max_lag_samples, +max_lag_samples]``. The returned lag
    ``tau`` satisfies ``mic[n] ~= ref[n - tau]``; a positive value means the
    room signal arrives after the reference (the Roku is behind Chrome) and a
    negative value means the Chrome tab is behind the Roku.

    Returns ``(0, 0.0)`` when either frame is silent, which is what the caller's
    confidence gate needs to keep the previous delay.
    """
    ref = [float(value) for value in ref_frame]
    mic = [float(value) for value in mic_frame]
    length = min(len(ref), len(mic))
    if length < 8 or max_lag_samples is None:
        return 0, 0.0
    del ref[length:]
    del mic[length:]
    if _energy(ref) <= min_energy or _energy(mic) <= min_energy:
        return 0, 0.0
    max_lag = int(min(max_lag_samples, length - 1))
    if max_lag < 1:
        return 0, 0.0

    size = next_power_of_two(max(2 * length - 1, length + max_lag))
    correlation = gcc_phat_correlation(ref, mic, size, eps)

    best_lag, best_value = 0, -float('inf')
    for lag in range(-max_lag, max_lag + 1):
        value = correlation[lag % size]
        if value > best_value:
            best_value, best_lag = value, lag
    refined = best_lag + _parabolic_offset(correlation, best_lag % size, size)
    best_lag = max(-max_lag, min(max_lag, int(round(refined))))
    return best_lag, normalized_correlation(ref, mic, best_lag)


# ---------------------------------------------------------------------------
# Adaptive echo canceller
# ---------------------------------------------------------------------------
class AcousticEchoCanceller:
    """NLMS echo canceller with GCC-PHAT delay tracking, DTD and NLP.

    ``process_frame`` consumes equal-length reference (far end, from the synced
    Chrome tab) and microphone blocks of float samples in ``[-1, 1]`` and
    returns ``(clean_samples, stats)``.

    The reference history keeps ``max_delay_ms`` of signal, so a lag of up to
    +/-600 ms can be tracked. When the reference *lags* the microphone the
    output is delayed by the same amount (reported as ``latency_ms``), because
    the samples the filter needs have not arrived yet.
    """

    def __init__(self, sample_rate=DEFAULT_SAMPLE_RATE, filter_length=DEFAULT_FILTER_LENGTH,
                 max_delay_ms=DEFAULT_MAX_DELAY_MS, mu=DEFAULT_MU, mu_min=DEFAULT_MU_MIN,
                 mu_decay_s=0.5, delay_update_s=DEFAULT_DELAY_UPDATE_S,
                 delay_window_s=DEFAULT_DELAY_WINDOW_S,
                 delay_confidence=DEFAULT_DELAY_CONFIDENCE, delay_reset_samples=8,
                 double_talk_ratio=DEFAULT_DOUBLE_TALK_RATIO, geigel_ratio=DEFAULT_GEIGEL_RATIO, lock_ratio=0.02,
                 nlp=True, nlp_strength=0.85, nlp_k=1.0, double_talk_window_s=0.03,
                 energy_floor=1e-7, eps=1e-9):
        if sample_rate <= 0:
            raise ValueError('sample_rate must be positive')
        if filter_length < 4:
            raise ValueError('filter_length must be at least 4 taps')
        if max_delay_ms < 0:
            raise ValueError('max_delay_ms must not be negative')
        self.sample_rate = int(sample_rate)
        self.filter_length = int(filter_length)
        self.max_delay_ms = float(max_delay_ms)
        self.max_delay_samples = int(round(self.max_delay_ms * self.sample_rate / 1000.0))
        self.mu = float(mu)
        self.mu_min = float(mu_min)
        self.mu_decay_samples = max(1.0, float(mu_decay_s) * self.sample_rate)
        self.delay_confidence = float(delay_confidence)
        self.delay_reset_samples = int(delay_reset_samples)
        self.double_talk_ratio = float(double_talk_ratio)
        self.geigel_ratio = float(geigel_ratio)
        self.lock_ratio = float(lock_ratio)
        self.nlp = bool(nlp)
        self.nlp_strength = float(nlp_strength)
        self.nlp_k = float(nlp_k)
        self.energy_floor = float(energy_floor)
        self.eps = float(eps)
        # The correlation frame must be long enough to contain the deepest lag
        # it searches, so every candidate delay overlaps the reference. 1.5x the
        # search span leaves a third of the frame overlapping at the extreme
        # lag, which is what keeps the confidence score meaningful there.
        # Below ~16 kHz a raw frame of that length is expensive, so the
        # correlation runs on a decimated copy and the lag is scaled back up.
        wanted = min(int(1.5 * self.max_delay_samples) + 1024,
                     int(2.0 * self.sample_rate))
        self._delay_window = max(64, int(float(delay_window_s) * self.sample_rate),
                                 wanted)
        # Keep the FFT budget near 8192 bins: a 16 kHz / 2 s frame is 32k.
        self._delay_decimate = max(1, self._delay_window // 4096)
        self._delay_update_samples = max(int(float(delay_update_s) * self.sample_rate),
                                         self._delay_window)
        alpha = math.exp(-1.0 / max(1.0, float(double_talk_window_s) * self.sample_rate))
        self._ema_alpha = alpha
        self._ema_beta = 1.0 - alpha

        self.weights = [0.0] * self.filter_length
        self.delay_samples = 0
        self.confidence = 0.0

        # Bounded histories: enough for the deepest lag plus the filter, the
        # tracking window, and slack so trimming never cuts into the block that
        # is about to be processed.
        self._history_limit = (self.max_delay_samples + self.filter_length
                               + self._delay_window + 4096)
        self._ref_hist = []
        self._mic_hist = []

        self._adaptive_mu = self.mu
        self._since_delay = self._delay_update_samples
        self._pow_mic = 0.0
        self._pow_echo = 0.0
        self._pow_error = 0.0
        self._last_double_talk = False
        self._locked = False
        self._double_talk_frames = 0
        self._frame_in = 0.0
        self._frame_out = 0.0
        self._total_in = 0.0
        self._total_out = 0.0
        self._erle_db = 0.0
        self._processed = 0
        self._delay_updates = 0
        self._block = 0

    # -- public API ---------------------------------------------------------
    def process_frame(self, ref_samples, mic_samples):
        """Cancel the reference echo in one block; returns ``(clean, stats)``."""
        ref = [float(value) for value in ref_samples]
        mic = [float(value) for value in mic_samples]
        if len(ref) != len(mic):
            raise ValueError('reference and microphone frames must be the same length')
        if not ref:
            return [], self.stats()

        count = len(ref)
        self._block = count
        # Keep each history at a fixed bound so a long call cannot grow memory.
        # Trim before appending, leaving room for this block.
        target = max(0, self._history_limit - count)
        for history in (self._ref_hist, self._mic_hist):
            if len(history) > target:
                del history[:len(history) - target]
        self._ref_hist.extend(ref)
        self._mic_hist.extend(mic)
        # Keep each history at a fixed bound so a long call cannot grow memory.
        limit = self._history_limit
        for history in (self._ref_hist, self._mic_hist):
            if len(history) > limit:
                del history[:len(history) - limit]
        self._maybe_update_delay()

        taps = self.filter_length
        delay = self.delay_samples
        # A negative lag means the reference arrives late, so the microphone
        # stream is held back until those reference samples exist.
        mic_delay = -delay if delay < 0 else 0
        ref_lag = mic_delay + delay

        reversed_ref = self._ref_hist[::-1]
        needed = ref_lag + count + taps + 1
        if len(reversed_ref) < needed:
            reversed_ref.extend([0.0] * (needed - len(reversed_ref)))
        mic_history = self._mic_hist
        mic_needed = mic_delay + count + 1
        if len(mic_history) < mic_needed:
            mic_history = [0.0] * (mic_needed - len(mic_history)) + mic_history

        weights = self.weights
        alpha = self._ema_alpha
        beta = self._ema_beta
        floor = self.energy_floor
        geigel_ratio = self.geigel_ratio
        residual_ratio = self.double_talk_ratio
        nlp = self.nlp
        nlp_k = self.nlp_k
        nlp_strength = self.nlp_strength

        pow_mic = self._pow_mic
        pow_echo = self._pow_echo
        pow_error = self._pow_error
        step = self._adaptive_mu
        locked = self._locked

        h_norm = sum(map(abs, weights))

        clean = [0.0] * count
        frame_in = 0.0
        frame_out = 0.0
        double_talk_samples = 0

        index = count - 1
        base = ref_lag + index
        window = reversed_ref[base:base + taps]
        window_energy = _energy(window)

        for position in range(count):
            sample = mic_history[len(mic_history) - 1 - mic_delay - index]
            estimate = _dot(weights, window)
            error = sample - estimate

            pow_mic = alpha * pow_mic + beta * sample * sample
            pow_echo = alpha * pow_echo + beta * estimate * estimate
            pow_error = alpha * pow_error + beta * error * error

            # Geigel: |d(n)| is louder than any echo the current filter plus the
            # loudest reference sample in its window could produce, bounded by
            # ||h||_1 * ||x||_2 (Cauchy-Schwarz). It needs no convergence, so it
            # never blocks the initial lock.
            #
            # Residual test: once the filter has converged, the residual is far
            # below the echo it predicts. A residual that climbs back toward the
            # echo power means the microphone contains something the reference
            # cannot explain, which is near-end speech. This is the sensitive
            # branch; the Geigel bound is the loud-speech backstop.
            double_talk = (h_norm > 1e-6 and window_energy > floor
                           and abs(sample) > geigel_ratio * h_norm * math.sqrt(window_energy))
            if not double_talk and locked and pow_echo > floor:
                double_talk = pow_error > residual_ratio * pow_echo

            if not double_talk and window_energy > floor:
                factor = step * error / window_energy
                weights = [w + factor * x for w, x in zip(weights, window)]

            output = error
            if nlp and not double_talk and pow_echo > floor:
                ratio_sq = (error * error) / pow_echo
                gate = ratio_sq / (ratio_sq + nlp_k)
                output = error * (1.0 - nlp_strength * (1.0 - gate))

            clean[position] = output
            frame_in += sample * sample
            frame_out += output * output
            if double_talk:
                double_talk_samples += 1

            index -= 1
            base -= 1
            if position + 1 < count:
                window = reversed_ref[base:base + taps]
                window_energy += reversed_ref[base] * reversed_ref[base] \
                    - reversed_ref[base + taps] * reversed_ref[base + taps]

        # Adapt the step size so a fast initial lock settles into a small
        # steady-state misadjustment.
        step = self.mu_min + (step - self.mu_min) * math.exp(-count / self.mu_decay_samples)

        self.weights = weights
        self._adaptive_mu = step
        self._pow_mic = pow_mic
        self._pow_echo = pow_echo
        self._pow_error = pow_error
        self._last_double_talk = double_talk_samples * 2 >= count
        # The energy/RES ratio branch stays disarmed until a quiet block shows
        # real cancellation (residual well under the microphone power). Locking
        # on an empty filter would freeze adaptation immediately.
        if self._last_double_talk:
            self._double_talk_frames += 1
        elif pow_error < self.lock_ratio * pow_mic and pow_mic > floor:
            self._locked = True
        self._frame_in = 0.5 * self._frame_in + 0.5 * frame_in
        self._frame_out = 0.5 * self._frame_out + 0.5 * frame_out
        self._total_in += frame_in
        self._total_out += frame_out
        self._processed += count
        self._erle_db = _db((self._frame_in + self.eps) / (self._frame_out + self.eps))

        return clean, self.stats()

    def stats(self):
        """Current tracker/filter state, shaped for logging and tests."""
        total_in = self._total_in
        total_out = self._total_out
        echo_estimate = self._pow_echo
        microphone = self._pow_mic
        residual_db = _db((echo_estimate + self.eps) / (microphone + self.eps))
        return {
            'delay_samples': self.delay_samples,
            'delay_ms': round(self.delay_samples * 1000.0 / self.sample_rate, 2),
            'confidence': round(self.confidence, 4),
            'double_talk': bool(self._last_double_talk),
            'double_talk_frames': self._double_talk_frames,
            'erle_db': round(self._erle_db, 2),
            'erle_total_db': round(_db((total_in + self.eps) / (total_out + self.eps)), 2),
            'residual_db': round(residual_db, 2),
            'mu': round(self._adaptive_mu, 5),
            'filter_energy': round(sum(w * w for w in self.weights), 6),
            'latency_ms': round(max(0, -self.delay_samples) * 1000.0 / self.sample_rate, 2),
            'delay_updates': self._delay_updates,
            'samples': self._processed,
        }

    # -- internals ----------------------------------------------------------
    def _reset_weights(self):
        """Blank the taps after the acoustic path moved to a new lag."""
        self.weights = [0.0] * self.filter_length
        self._adaptive_mu = self.mu
        # The detector must re-arm from scratch: with a blank filter every
        # residual looks like near-end speech.
        self._pow_echo = 0.0
        self._pow_error = 0.0
        self._locked = False

    def _maybe_update_delay(self):
        """Re-estimate the Roku/Chrome lag when the reference has real audio."""
        self._since_delay += self._block
        if self._since_delay < self._delay_update_samples:
            return
        if self._last_double_talk:
            return
        window = self._delay_window
        if len(self._mic_hist) < window or len(self._ref_hist) < window:
            return
        mic_frame = self._mic_hist[-window:]
        ref_frame = self._ref_hist[-window:]
        factor = self._delay_decimate
        max_lag = self.max_delay_samples // factor
        coarse, confidence = estimate_delay_samples(_decimate(ref_frame, factor),
                                                    _decimate(mic_frame, factor),
                                                    max_lag, eps=self.eps)
        if confidence < self.delay_confidence:
            self.confidence = confidence
            return
        # The decimated search is accurate to `factor` samples; refine at full
        # rate over that span so the NLMS filter starts aligned.
        lag, fine = self._refine_lag(ref_frame, mic_frame, coarse * factor, factor)
        self.confidence = fine if fine > 0.0 else confidence
        if self.confidence < self.delay_confidence:
            return
        if lag != self.delay_samples:
            if abs(lag - self.delay_samples) >= self.delay_reset_samples:
                self._reset_weights()
            self.delay_samples = lag
            self._delay_updates += 1
        self._since_delay = 0

    def _refine_lag(self, ref_frame, mic_frame, lag, span):
        """Pick the best lag within ``lag +/- span`` at the native rate."""
        best_lag, best_score = lag, -1.0
        for candidate in range(max(-self.max_delay_samples, lag - span),
                               min(self.max_delay_samples, lag + span) + 1):
            score = normalized_correlation(ref_frame, mic_frame, candidate)
            if score > best_score:
                best_score, best_lag = score, candidate
        return best_lag, best_score


# ---------------------------------------------------------------------------
# WAV helpers and the offline pipeline
# ---------------------------------------------------------------------------
def read_wav(path):
    """Read a PCM WAV as ``(mono_float_samples, sample_rate)``."""
    with wave.open(path, 'rb') as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width == 1:
        values = array.array('B')
        values.frombytes(frames)
        samples = [(value - 128) / 128.0 for value in values]
    elif width == 2:
        values = array.array('h')
        values.frombytes(frames)
        if sys.byteorder == 'big':
            values.byteswap()
        samples = [value / 32768.0 for value in values]
    elif width == 4:
        values = array.array('i')
        values.frombytes(frames)
        if sys.byteorder == 'big':
            values.byteswap()
        samples = [value / 2147483648.0 for value in values]
    else:
        raise ValueError('unsupported WAV sample width: %d bytes' % width)
    if channels > 1:
        samples = [sum(samples[index:index + channels]) / channels
                   for index in range(0, len(samples) - channels + 1, channels)]
    return samples, rate


def write_wav(path, samples, rate):
    """Write mono float samples as 16-bit PCM."""
    clipped = []
    for value in samples:
        if value > 1.0:
            value = 1.0
        elif value < -1.0:
            value = -1.0
        clipped.append(int(round(value * 32767.0)))
    payload = struct.pack('<%dh' % len(clipped), *clipped)
    with wave.open(path, 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(payload)
    return path


def resample_linear(samples, source_rate, target_rate):
    """Cheap linear resampler, enough for a rate mismatch between two captures."""
    if source_rate == target_rate or not samples:
        return list(samples)
    ratio = target_rate / float(source_rate)
    length = int(round(len(samples) * ratio))
    last = len(samples) - 1
    result = [0.0] * length
    for index in range(length):
        position = index / ratio
        left = int(position)
        if left >= last:
            result[index] = samples[last]
            continue
        fraction = position - left
        result[index] = samples[left] + (samples[left + 1] - samples[left]) * fraction
    return result


def process_wav_files(ref_path, mic_path, out_path, frame_size=DEFAULT_BLOCK_SIZE,
                      sample_rate=None, canceller=None, **kwargs):
    """Run the canceller over two WAV files and report the achieved figures."""
    ref_samples, ref_rate = read_wav(ref_path)
    mic_samples, mic_rate = read_wav(mic_path)
    rate = int(sample_rate or ref_rate)
    ref_samples = resample_linear(ref_samples, ref_rate, rate)
    mic_samples = resample_linear(mic_samples, mic_rate, rate)
    length = min(len(ref_samples), len(mic_samples))
    if length == 0:
        raise ValueError('input WAV files are empty')
    del ref_samples[length:]
    del mic_samples[length:]

    aec = canceller or AcousticEchoCanceller(sample_rate=rate, **kwargs)
    clean = []
    for start in range(0, length, frame_size):
        block, _ = aec.process_frame(ref_samples[start:start + frame_size],
                                     mic_samples[start:start + frame_size])
        clean.extend(block)
    write_wav(out_path, clean, rate)

    stats = aec.stats()
    stats.update({'sample_rate': rate, 'output_samples': len(clean),
                  'ref_path': ref_path, 'mic_path': mic_path, 'out_path': out_path})
    return stats


# ---------------------------------------------------------------------------
# Devices and live capture
# ---------------------------------------------------------------------------
def list_devices(stream=sys.stdout):
    """Print the input/output devices the host exposes."""
    if _sd is not None:
        print('sounddevice devices:', file=stream)
        for index, device in enumerate(_sd.query_devices()):
            inputs = device['max_input_channels']
            outputs = device['max_output_channels']
            kind = 'in/out' if inputs and outputs else ('in' if inputs else 'out')
            print('  [%d] %-40s %-6s %d in, %d out, %d Hz'
                  % (index, device['name'], kind, inputs, outputs,
                     int(device['default_samplerate'])), file=stream)
        try:
            default_in, default_out = _sd.default.device
            print('  default input: %s' % default_in, file=stream)
            print('  default output: %s' % default_out, file=stream)
        except (TypeError, ValueError):  # pragma: no cover - host dependent
            pass
        return 0
    print('sounddevice is not installed (pip install sounddevice) - '
          'falling back to the system device list:', file=stream)
    if platform.system() == 'Darwin' and shutil.which('ffmpeg'):
        _ffmpeg_audio_devices(stream)
        # ffmpeg exposes no output-device enumeration for audiotoolbox, so the
        # output index is positional: it follows the order of the output
        # devices in Audio MIDI Setup.
        print('audio output indices follow the Audio MIDI Setup output-device '
              'order; pass the one for BlackHole 16ch / ZoomAudioDevice as '
              '--out-index', file=stream)
        return 0
    if platform.system() == 'Darwin' and shutil.which('system_profiler'):
        result = subprocess.run(['system_profiler', 'SPAudioDataType'],
                                capture_output=True, text=True, check=False)
        print(result.stdout, file=stream)
        return 0
    print('no device enumerator found; install sounddevice for --live', file=stream)
    return 1


def _install_hint():
    return ('Live capture needs sounddevice:  pip install sounddevice\n'
            'On macOS also create the virtual devices once:\n'
            '  brew install blackhole-2ch\n'
            '  # Audio MIDI Setup -> Multi-Output Device (speakers + BlackHole 2ch)\n'
            '  # Chrome tab audio -> that Multi-Output Device (or mute the tab\n'
            '  # and rely on the Roku for room sound)\n'
            '  # Mic input  -> MacBook Pro Microphone\n'
            '  # Messenger  -> ZoomAudioDevice / BlackHole 16ch output of this daemon')


def run_live(ref_device=None, mic_device=None, out_device=None,
             sample_rate=DEFAULT_SAMPLE_RATE, block_size=DEFAULT_BLOCK_SIZE,
             report_every=4, **kwargs):
    """Real-time loop: read reference + mic, write the cleaned voice."""
    if _sd is None:
        raise RuntimeError(_install_hint())
    aec = AcousticEchoCanceller(sample_rate=sample_rate, **kwargs)
    streams = [
        _sd.InputStream(device=ref_device, channels=1, samplerate=sample_rate,
                        blocksize=block_size, dtype='float32'),
        _sd.InputStream(device=mic_device, channels=1, samplerate=sample_rate,
                        blocksize=block_size, dtype='float32'),
        _sd.OutputStream(device=out_device, channels=1, samplerate=sample_rate,
                         blocksize=block_size, dtype='float32'),
    ]
    reference, microphone, speaker = streams
    print('AEC live: ref=%s mic=%s out=%s rate=%d block=%d'
          % (ref_device, mic_device, out_device, sample_rate, block_size))
    try:
        with reference, microphone, speaker:
            frames = 0
            while True:
                ref_block, _ = reference.read(block_size)
                mic_block, _ = microphone.read(block_size)
                clean, stats = aec.process_frame([frame[0] for frame in ref_block],
                                                 [frame[0] for frame in mic_block])
                speaker.write(array.array('f', clean))
                frames += 1
                if report_every and frames % report_every == 0:
                    print('delay %7.1f ms (conf %.2f)  ERLE %5.1f dB%s'
                          % (stats['delay_ms'], stats['confidence'], stats['erle_db'],
                             '  [double talk]' if stats['double_talk'] else ''))
    except KeyboardInterrupt:
        pass
    return aec.stats()


class _PipeReader:
    """Read exactly ``size`` bytes from a subprocess pipe."""

    def __init__(self, process):
        self.process = process

    def read(self, size):
        chunks = []
        remaining = size
        while remaining > 0:
            chunk = self.process.stdout.read(remaining)
            if not chunk:
                raise EOFError('audio pipe closed')
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks)


def _ffmpeg_audio_devices(stream=sys.stdout):
    """Print the avfoundation *audio* devices with their indices.

    ``ffmpeg -f avfoundation -list_devices true -i ""`` numbers audio devices
    from 0 in their own list, which is what ``-i "none:<index>"`` expects.
    """
    result = subprocess.run(['ffmpeg', '-hide_banner', '-f', 'avfoundation',
                             '-list_devices', 'true', '-i', ''],
                            capture_output=True, text=True, check=False)
    for line in result.stderr.splitlines():
        if 'AVFoundation' not in line:
            continue
        marker = line.find('] ')
        print(line[marker + 2:] if marker >= 0 else line.strip(), file=stream)


def run_live_ffmpeg(ref_index=1, mic_index=2, out_index=None, sample_rate=DEFAULT_SAMPLE_RATE,
                    block_size=DEFAULT_BLOCK_SIZE, **kwargs):
    """Fallback live loop over ffmpeg ``avfoundation`` pipes.

    Two ``ffmpeg`` capture processes deliver little-endian float32 audio on
    stdout, and a third writes the cleaned voice to the chosen output device
    through the ``audiotoolbox`` muxer, the only output device ffmpeg exposes on
    macOS. Input indices come from :func:`_ffmpeg_audio_devices`, where the
    avfoundation *audio* list is numbered from zero and specified as
    ``-i "none:<index>"`` (an empty video slot).
    """
    if out_index is None:
        raise RuntimeError('the ffmpeg backend needs --out-index for the virtual '
                           'microphone output; list devices with --list-devices')
    if not shutil.which('ffmpeg'):
        raise RuntimeError('ffmpeg not found; install it with brew install ffmpeg')
    base = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'avfoundation']
    capture_audio = ['-ac', '1', '-ar', str(sample_rate), '-f', 'f32le']
    capture = []

    def spawn(index):
        process = subprocess.Popen(base + ['-i', 'none:%d' % index] + capture_audio + ['-'],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        capture.append(process)
        return _PipeReader(process)

    ref_reader = spawn(ref_index)
    mic_reader = spawn(mic_index)
    sink = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error',
                             '-f', 'f32le', '-ar', str(sample_rate), '-ac', '1',
                             '-i', 'pipe:0',
                             '-f', 'audiotoolbox', '-audio_device_index', str(out_index), '-'],
                            stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_bytes = block_size * 4
    aec = AcousticEchoCanceller(sample_rate=sample_rate, **kwargs)
    print('AEC live (ffmpeg): ref=%d mic=%d out=%d rate=%d block=%d'
          % (ref_index, mic_index, out_index, sample_rate, block_size))
    try:
        while True:
            ref_block = struct.unpack('<%df' % block_size, ref_reader.read(frame_bytes))
            mic_block = struct.unpack('<%df' % block_size, mic_reader.read(frame_bytes))
            clean, stats = aec.process_frame(ref_block, mic_block)
            sink.stdin.write(struct.pack('<%df' % len(clean), *clean))
            sink.stdin.flush()
            print('delay %7.1f ms  ERLE %5.1f dB' % (stats['delay_ms'], stats['erle_db']))
    except (KeyboardInterrupt, EOFError, BrokenPipeError):
        pass
    finally:
        for process in capture + [sink]:
            process.terminate()
        for process in capture + [sink]:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover - stubborn ffmpeg
                process.kill()
    return aec.stats()


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------
def _synthetic_room(sample_rate=8000, seconds=4.0, delay_ms=185.0, burst=None,
                    seed=11, noise=1e-3):
    """TV track, room response and an optional near-end speech burst."""
    import random

    rng = random.Random(seed)
    length = int(sample_rate * seconds)
    # Broadband TV-ish audio: shaped noise plus a couple of tones.
    reference = []
    low = 0.0
    for index in range(length):
        white = rng.gauss(0.0, 0.25)
        low = 0.85 * low + 0.15 * white
        tone = 0.12 * math.sin(2 * math.pi * 440.0 * index / sample_rate)
        reference.append(0.55 * white + 0.9 * low + tone)
    room = [0.72, -0.28, 0.14, -0.07, 0.035, -0.018]
    delay = int(round(delay_ms * sample_rate / 1000.0))
    mic = [0.0] * length
    for index in range(delay, length):
        total = 0.0
        for tap, gain in enumerate(room):
            position = index - delay - tap * 7
            if position >= 0:
                total += gain * reference[position]
        mic[index] = total
    near_end = [0.0] * length
    if burst:
        start, stop, amplitude = burst
        burst_start = int(start * sample_rate)
        burst_stop = min(length, int(stop * sample_rate))
        for index in range(burst_start, burst_stop):
            t = index / sample_rate
            envelope = min(1.0, (index - burst_start) / (0.02 * sample_rate),
                           (burst_stop - index) / (0.02 * sample_rate))
            near_end[index] = amplitude * envelope * (
                0.6 * math.sin(2 * math.pi * 180.0 * t)
                + 0.35 * math.sin(2 * math.pi * 620.0 * t)
                + 0.25 * rng.gauss(0.0, 1.0))
            mic[index] += near_end[index]
    for index in range(length):
        mic[index] += rng.gauss(0.0, noise)
    return reference, mic, near_end, delay


def run_selftest(sample_rate=8000, seconds=4.0, delay_ms=185.0, frame_size=512,
                 verbose=True):
    """Offline proof: recover a known lag and suppress the room echo."""
    reference, mic, near_end, true_delay = _synthetic_room(
        sample_rate=sample_rate, seconds=seconds, delay_ms=delay_ms,
        burst=(3.0, 3.4, 0.12))
    aec = AcousticEchoCanceller(sample_rate=sample_rate)
    clean = []
    steady = []
    for start in range(0, min(len(reference), len(mic)), frame_size):
        block, stats = aec.process_frame(reference[start:start + frame_size],
                                         mic[start:start + frame_size])
        clean.extend(block)
        steady.append(stats['erle_db'])
    stats = aec.stats()
    tail = steady[-6:] or [0.0]
    burst_start = int(3.0 * sample_rate)
    burst_stop = int(3.4 * sample_rate)
    near_energy = sum(value * value for value in near_end[burst_start:burst_stop])
    out_energy = sum(value * value for value in clean[burst_start:burst_stop])
    preserved = 10.0 * math.log10((out_energy + 1e-12) / (near_energy + 1e-12))
    result = {
        'true_delay_ms': true_delay * 1000.0 / sample_rate,
        'delay_ms': stats['delay_ms'],
        'confidence': stats['confidence'],
        'erle_db': round(sum(tail) / len(tail), 2),
        'erle_total_db': stats['erle_total_db'],
        'near_end_preserved_db': round(preserved, 2),
        'stats': stats,
    }
    if verbose:
        print('self-test: %.1f s of synthetic TV audio at %d Hz' % (seconds, sample_rate))
        print('  true delay        %8.2f ms (%d samples)'
              % (result['true_delay_ms'], true_delay))
        print('  recovered delay   %8.2f ms  confidence %.2f'
              % (result['delay_ms'], result['confidence']))
        print('  ERLE              %8.2f dB steady state, %.2f dB whole file'
              % (result['erle_db'], result['erle_total_db']))
        print('  near-end burst    %8.2f dB relative to the injected voice' % preserved)
    result['ok'] = (abs(result['delay_ms'] - result['true_delay_ms']) <= 6.0
                    and result['erle_db'] >= 10.0
                    and preserved > -6.0)
    if verbose:
        print('  result            %s' % ('PASS' if result['ok'] else 'FAIL'))
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser():
    parser = argparse.ArgumentParser(
        description='Acoustic echo canceller that removes Roku TV audio from the MacBook mic.')
    parser.add_argument('--list-devices', action='store_true',
                        help='list audio devices and exit')
    parser.add_argument('--ref-wav', help='far-end reference WAV (synced Chrome audio)')
    parser.add_argument('--mic-wav', help='microphone WAV (voice + TV room echo)')
    parser.add_argument('--out-wav', help='destination WAV for the cleaned voice')
    parser.add_argument('--live', action='store_true', help='run the real-time loop')
    parser.add_argument('--selftest', action='store_true',
                        help='run the synthetic verification and exit')
    parser.add_argument('--backend', choices=('sounddevice', 'ffmpeg'),
                        default='sounddevice', help='live audio backend')
    parser.add_argument('--ref-device', default=None, help='reference input device')
    parser.add_argument('--mic-device', default=None, help='microphone input device')
    parser.add_argument('--out-device', default=None, help='cleaned voice output device')
    parser.add_argument('--ref-index', type=int, default=None,
                        help='ffmpeg avfoundation audio index for the reference')
    parser.add_argument('--mic-index', type=int, default=None,
                        help='ffmpeg avfoundation audio index for the microphone')
    parser.add_argument('--out-index', type=int, default=None,
                        help='audiotoolbox output device index for the virtual mic')
    parser.add_argument('--sample-rate', type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument('--block', type=int, default=DEFAULT_BLOCK_SIZE)
    parser.add_argument('--filter-length', type=int, default=DEFAULT_FILTER_LENGTH)
    parser.add_argument('--max-delay-ms', type=float, default=DEFAULT_MAX_DELAY_MS)
    parser.add_argument('--mu', type=float, default=DEFAULT_MU)
    parser.add_argument('--json', action='store_true', help='print machine-readable output')
    return parser


def canceller_kwargs(args):
    return {'filter_length': args.filter_length,
            'max_delay_ms': args.max_delay_ms,
            'mu': args.mu}


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list_devices:
        return list_devices()

    if args.selftest:
        result = run_selftest(verbose=not args.json)
        if args.json:
            print(json.dumps(result, indent=2))
        return 0 if result['ok'] else 1

    if args.ref_wav or args.mic_wav:
        if not (args.ref_wav and args.mic_wav and args.out_wav):
            parser.error('--ref-wav, --mic-wav and --out-wav are required together')
        stats = process_wav_files(args.ref_wav, args.mic_wav, args.out_wav,
                                  frame_size=args.block, sample_rate=args.sample_rate,
                                  **canceller_kwargs(args))
        if args.json:
            print(json.dumps(stats, indent=2))
        else:
            print('measured delay  %.2f ms (confidence %.2f)'
                  % (stats['delay_ms'], stats['confidence']))
            print('achieved ERLE   %.2f dB (whole file %.2f dB)'
                  % (stats['erle_db'], stats['erle_total_db']))
            print('cleaned voice   %s' % args.out_wav)
        return 0

    if args.live:
        if args.backend == 'ffmpeg':
            if args.ref_index is None or args.mic_index is None or args.out_index is None:
                print('the ffmpeg backend needs --ref-index, --mic-index and '
                      '--out-index; run --list-devices to see them', file=sys.stderr)
                return 1
            try:
                run_live_ffmpeg(ref_index=args.ref_index, mic_index=args.mic_index,
                                out_index=args.out_index, sample_rate=args.sample_rate,
                                block_size=args.block, **canceller_kwargs(args))
            except RuntimeError as error:
                print(error, file=sys.stderr)
                return 1
            return 0
        if _sd is None:
            print(_install_hint(), file=sys.stderr)
            return 1
        run_live(ref_device=args.ref_device, mic_device=args.mic_device,
                 out_device=args.out_device, sample_rate=args.sample_rate,
                 block_size=args.block, **canceller_kwargs(args))
        return 0

    parser.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
