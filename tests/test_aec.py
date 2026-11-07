"""Tests for the standard-library AEC engine in ``aec_daemon.py``.

Runs under a bare ``python3 -m unittest discover -s tests -p 'test_*.py'``: no
``numpy`` and no ``sounddevice``. When numpy happens to be installed the DSP
takes its fast path, and :class:`StdlibPathTest` forces the pure-Python path so
both implementations are still covered.
"""
import array
import contextlib
import io
import json
import math
import os
import random
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, '.')
import aec_daemon as aec

# A small but realistic room: the direct path plus a few early reflections with
# alternating polarity, roughly what a soundbar in a living room produces.
ROOM_IMPULSE = [0.7, -0.25, 0.12, -0.06, 0.035, -0.018, 0.009]
ROOM_TAP_SPACING = 7


def tv_reference(length, rate, seed=7):
    """Broadband, TV-like far-end audio: shaped noise plus a low tone."""
    rng = random.Random(seed)
    samples = []
    low = 0.0
    for index in range(length):
        white = rng.gauss(0.0, 0.22)
        low = 0.8 * low + 0.2 * white
        tone = 0.10 * math.sin(2.0 * math.pi * 320.0 * index / rate)
        samples.append(0.6 * white + 0.9 * low + tone)
    return samples


def room_echo(reference, delay, impulse=ROOM_IMPULSE, spacing=ROOM_TAP_SPACING,
              noise=1e-4, seed=13):
    """Microphone copy of ``reference`` through ``impulse`` at ``delay`` samples.

    A positive ``delay`` puts the room signal behind the reference (the Roku is
    behind Chrome); a negative delay means Chrome is behind the Roku.
    """
    rng = random.Random(seed)
    length = len(reference)
    mic = [0.0] * length
    for index in range(length):
        total = 0.0
        for tap, gain in enumerate(impulse):
            position = index - delay - tap * spacing
            if 0 <= position < length:
                total += gain * reference[position]
        mic[index] = total + rng.gauss(0.0, noise)
    return mic


def voice_burst(length, rate, start_s, stop_s, amplitude=0.25, seed=29):
    """A near-end voice-like burst: two formant-ish tones with an envelope."""
    rng = random.Random(seed)
    burst = [0.0] * length
    begin = int(start_s * rate)
    end = min(length, int(stop_s * rate))
    ramp = max(1, int(0.02 * rate))
    for index in range(begin, end):
        t = index / rate
        envelope = min(1.0, (index - begin) / ramp, (end - index) / ramp)
        burst[index] = amplitude * envelope * (
            0.6 * math.sin(2.0 * math.pi * 190.0 * t)
            + 0.35 * math.sin(2.0 * math.pi * 610.0 * t)
            + 0.2 * rng.gauss(0.0, 1.0))
    return burst


def energy(values):
    return sum(value * value for value in values)


def erle_db(mic, clean, start=0):
    """Echo Return Loss Enhancement over ``mic[start:]`` against ``clean[start:]``."""
    reference = energy(mic[start:])
    residual = energy(clean[start:])
    if residual <= 0.0:
        return float('inf')
    return 10.0 * math.log10(reference / residual)


class FftTest(unittest.TestCase):
    """The radix-2 FFT is the foundation under the stdlib GCC-PHAT path."""

    def test_fft_ifft_round_trip_is_identity(self):
        rng = random.Random(5)
        signal = [rng.gauss(0.0, 1.0) for _ in range(64)]
        spectrum = aec.fft([complex(value, 0.0) for value in signal])
        recovered = aec.ifft(spectrum)
        for expected, actual in zip(signal, recovered):
            self.assertAlmostEqual(actual.real, expected, places=9)
            self.assertAlmostEqual(actual.imag, 0.0, places=9)

    def test_fft_matches_dft_for_a_known_impulse(self):
        # A unit impulse has a flat spectrum: every bin is 1 + 0j.
        spectrum = aec.fft([complex(1.0, 0.0)] + [0j] * 15)
        for value in spectrum:
            self.assertAlmostEqual(value.real, 1.0, places=12)
            self.assertAlmostEqual(value.imag, 0.0, places=12)

    def test_fft_rejects_non_power_of_two(self):
        with self.assertRaises(ValueError):
            aec.fft([0j] * 12)

    def test_next_power_of_two(self):
        self.assertEqual(aec.next_power_of_two(0), 1)
        self.assertEqual(aec.next_power_of_two(1), 1)
        self.assertEqual(aec.next_power_of_two(2049), 4096)
        self.assertEqual(aec.next_power_of_two(4096), 4096)


class DelayEstimateTest(unittest.TestCase):
    """GCC-PHAT over a +/-600 ms window, the range the Roku/Chrome drift needs."""

    RATE = 8000
    MAX_LAG_MS = 600.0

    def _estimate(self, shift_ms, frame=2048, seed=7, start=4000):
        rate = self.RATE
        delay = int(round(shift_ms * rate / 1000.0))
        length = start + frame + abs(delay) + 64
        reference = tv_reference(length, rate, seed=seed)
        mic = room_echo(reference, delay)
        ref_frame = reference[start:start + frame]
        mic_frame = mic[start:start + frame]
        max_lag = int(round(self.MAX_LAG_MS * rate / 1000.0))
        lag, confidence = aec.estimate_delay_samples(ref_frame, mic_frame, max_lag)
        return lag, confidence, delay

    def test_gcc_phat_recovers_positive_and_negative_tv_drift(self):
        # +180 ms: the Roku soundbar is behind the Chrome reference.
        lag, confidence, expected = self._estimate(180.0)
        self.assertLessEqual(abs(lag - expected), 2,
                             'positive drift: recovered %d, expected %d' % (lag, expected))
        self.assertGreater(confidence, 0.5,
                           'positive drift should be confident, got %.2f' % confidence)

        # -120 ms: Chrome is behind the Roku, so the reference arrives late.
        lag, confidence, expected = self._estimate(-120.0, seed=11)
        self.assertLessEqual(abs(lag - expected), 2,
                             'negative drift: recovered %d, expected %d' % (lag, expected))
        self.assertGreater(confidence, 0.5,
                           'negative drift should be confident, got %.2f' % confidence)

    def test_delay_estimate_is_stable_across_seeds(self):
        for seed in (3, 17, 23):
            lag, confidence, expected = self._estimate(150.0, seed=seed)
            self.assertLessEqual(abs(lag - expected), 2,
                                 'seed %d recovered %d, expected %d' % (seed, lag, expected))
            self.assertGreater(confidence, 0.4)

    def test_silent_frames_report_zero_confidence(self):
        silent = [0.0] * 1024
        signal = tv_reference(1024, self.RATE)
        lag, confidence = aec.estimate_delay_samples(silent, signal, 4800)
        self.assertEqual(lag, 0)
        self.assertEqual(confidence, 0.0)
        lag, confidence = aec.estimate_delay_samples(signal, silent, 4800)
        self.assertEqual(lag, 0)
        self.assertEqual(confidence, 0.0)

    def test_short_or_degenerate_frames_are_safe(self):
        lag, confidence = aec.estimate_delay_samples([], [], 4800)
        self.assertEqual((lag, confidence), (0, 0.0))
        lag, confidence = aec.estimate_delay_samples([0.1] * 4, [0.1] * 4, 4800)
        self.assertEqual((lag, confidence), (0, 0.0))

    def test_lag_is_clamped_to_the_search_window(self):
        rate = self.RATE
        max_lag = 64
        reference = tv_reference(1024, rate)
        mic = room_echo(reference, 300)  # far outside the window
        lag, _ = aec.estimate_delay_samples(reference[:512], mic[:512], max_lag)
        self.assertLessEqual(abs(lag), max_lag)


class AcousticEchoCancellerTest(unittest.TestCase):
    RATE = 8000
    FRAME = 512
    DELAY_MS = 150.0

    def _run(self, seconds=4.0, burst=None, canceller=None, delay_ms=None, seed=7):
        rate = self.RATE
        delay = int(round((delay_ms if delay_ms is not None else self.DELAY_MS) * rate / 1000.0))
        length = int(seconds * rate)
        reference = tv_reference(length, rate, seed=seed)
        mic = room_echo(reference, delay)
        near_end = [0.0] * length
        if burst:
            near_end = voice_burst(length, rate, *burst)
            mic = [sample + extra for sample, extra in zip(mic, near_end)]
        engine = canceller or aec.AcousticEchoCanceller(sample_rate=rate)
        clean = []
        stats = []
        for start in range(0, length, self.FRAME):
            block, block_stats = engine.process_frame(reference[start:start + self.FRAME],
                                                     mic[start:start + self.FRAME])
            clean.extend(block)
            stats.append(block_stats)
        return {'reference': reference, 'mic': mic, 'near_end': near_end,
                'clean': clean, 'stats': stats, 'engine': engine, 'delay': delay}

    def test_nlms_cancels_room_echo_by_at_least_15db(self):
        run = self._run(seconds=4.0)
        # Judge the steady state, after the delay lock and the tap convergence.
        tail = int(2.5 * self.RATE)
        achieved = erle_db(run['mic'], run['clean'], start=tail)
        self.assertGreaterEqual(achieved, 15.0,
                                'steady-state ERLE was only %.2f dB' % achieved)
        final = run['stats'][-1]
        self.assertEqual(final['delay_samples'], run['delay'])
        self.assertGreater(final['confidence'], 0.5)
        self.assertGreater(final['erle_db'], 15.0)

    def test_tracks_a_lag_near_the_search_limit(self):
        # Regression: the correlation window must be long enough to contain the
        # lag it searches, otherwise a large Roku/Chrome offset is never found.
        for rate, delay_ms in ((8000, 500.0), (16000, 500.0), (8000, -450.0)):
            delay = int(round(delay_ms * rate / 1000.0))
            reference = tv_reference(abs(delay) + int(5.0 * rate), rate, seed=71)
            mic = room_echo(reference, delay)
            engine = aec.AcousticEchoCanceller(sample_rate=rate)
            for start in range(0, int(5.0 * rate), self.FRAME):
                engine.process_frame(reference[start:start + self.FRAME],
                                     mic[start:start + self.FRAME])
            self.assertLessEqual(abs(engine.delay_samples - delay), 2,
                                 '%d Hz %.0f ms tracked as %.0f ms'
                                 % (rate, delay_ms, engine.delay_samples * 1000.0 / rate))

    def test_delay_locks_once_the_correlation_window_is_full(self):
        # The tracker needs a full correlation frame (1.5x the search span) of
        # audio before it can score a lag, so the lock arrives about one second
        # in at 8 kHz, not on the very first block.
        run = self._run(seconds=3.0)
        locks = [index for index, stats in enumerate(run['stats'])
                 if stats['delay_samples'] == run['delay']]
        self.assertTrue(locks, 'the delay tracker never locked onto the room lag')
        engine = run['engine']
        window_blocks = engine._delay_window // self.FRAME + 1
        self.assertLessEqual(locks[0], window_blocks,
                             'delay took %d blocks, window is %d'
                             % (locks[0], window_blocks))
        # And it stays locked for the rest of the call.
        self.assertEqual(run['stats'][-1]['delay_samples'], run['delay'])

    def test_double_talk_preserves_near_end_voice(self):
        burst = (3.0, 3.5, 0.25)
        run = self._run(seconds=5.0, burst=burst)
        rate = self.RATE
        begin = int(burst[0] * rate)
        end = int(burst[1] * rate)
        injected = energy(run['near_end'][begin:end])
        preserved = energy(run['clean'][begin:end])
        self.assertGreater(injected, 0.0)
        kept_db = 10.0 * math.log10(preserved / injected)
        self.assertGreater(kept_db, -6.0,
                           'near-end voice lost %.2f dB during double talk' % -kept_db)

        during = [stats for stats in run['stats']
                  if begin <= run['stats'].index(stats) * self.FRAME < end]
        self.assertTrue(any(stats['double_talk'] for stats in during),
                        'the double-talk detector never fired during the burst')

        # The adaptive filter must not blow up: weights stay bounded and the
        # echo is still cancelled after the burst.
        before = max(stats['filter_energy'] for stats in run['stats'][:len(run['stats']) // 2])
        after = run['stats'][-1]['filter_energy']
        self.assertLess(after, 2.0 * before,
                        'filter energy grew %.2fx during double talk' % (after / before))
        trailing = erle_db(run['mic'], run['clean'], start=int(4.5 * rate))
        self.assertGreater(trailing, 10.0,
                           'echo cancellation collapsed after double talk: %.2f dB' % trailing)

    def test_frame_shape_and_errors(self):
        engine = aec.AcousticEchoCanceller(sample_rate=self.RATE)
        with self.assertRaises(ValueError):
            engine.process_frame([0.0] * 8, [0.0] * 4)
        clean, stats = engine.process_frame([], [])
        self.assertEqual(clean, [])
        self.assertIn('delay_ms', stats)

    def test_accepts_array_and_list_samples(self):
        engine = aec.AcousticEchoCanceller(sample_rate=self.RATE)
        frame = array.array('f', [0.0] * 64)
        for index in range(64):
            frame[index] = 0.1 * math.sin(index / 4.0)
        clean, _ = engine.process_frame(frame, list(frame))
        self.assertEqual(len(clean), 64)

    def test_reference_ahead_of_mic_never_adds_latency(self):
        # Positive lag: the room echo arrives after the reference, so no output
        # buffering is needed.
        run = self._run(seconds=2.0, delay_ms=120.0)
        self.assertEqual(run['stats'][-1]['latency_ms'], 0.0)

    def test_delay_reset_clears_stale_weights(self):
        engine = aec.AcousticEchoCanceller(sample_rate=self.RATE)
        engine.weights = [0.5] * engine.filter_length
        engine.delay_samples = 100
        engine._reset_weights()
        self.assertEqual(engine.delay_samples, 100)  # delay itself is kept
        self.assertEqual(sum(map(abs, engine.weights)), 0.0)
        self.assertEqual(engine._adaptive_mu, engine.mu)

    def test_invalid_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            aec.AcousticEchoCanceller(sample_rate=0)
        with self.assertRaises(ValueError):
            aec.AcousticEchoCanceller(filter_length=2)
        with self.assertRaises(ValueError):
            aec.AcousticEchoCanceller(max_delay_ms=-1)

    def test_history_stays_bounded_over_a_long_call(self):
        # A long call must not accumulate reference history forever. This uses
        # a small delay budget so the check itself stays fast.
        engine = aec.AcousticEchoCanceller(sample_rate=self.RATE, max_delay_ms=20.0)
        frame = [0.05] * self.FRAME
        limit = engine._history_limit
        for _ in range(int(limit / self.FRAME) * 2 + 8):
            engine.process_frame(frame, frame)
        self.assertLessEqual(len(engine._ref_hist), limit)
        self.assertLessEqual(len(engine._mic_hist), limit)
        # And it still processes a block correctly after trimming.
        clean, stats = engine.process_frame(frame, frame)
        self.assertEqual(len(clean), self.FRAME)
        self.assertIn('erle_db', stats)

    def test_delay_jump_blanks_the_filter(self):
        # The room response belongs to one lag; a re-lock must not reuse taps
        # learned against the old alignment.
        engine = aec.AcousticEchoCanceller(sample_rate=self.RATE)
        engine.weights = [0.3] * engine.filter_length
        engine.delay_samples = 40
        engine._reset_weights()
        engine.delay_samples = 400
        self.assertEqual(engine.delay_samples, 400)
        self.assertEqual(max(map(abs, engine.weights)), 0.0)
        self.assertFalse(engine._locked)


class WavCliTest(unittest.TestCase):
    """The offline path processes real 16-bit PCM files end to end."""

    def setUp(self):
        self.tempdir = tempfile.mkdtemp(prefix='aec-test-')
        self.addCleanup(shutil.rmtree, self.tempdir, True)

    def _paths(self):
        return (os.path.join(self.tempdir, 'ref.wav'),
                os.path.join(self.tempdir, 'mic.wav'),
                os.path.join(self.tempdir, 'out.wav'))

    def _make_inputs(self, seconds=4.0, rate=8000, delay_ms=150.0):
        ref_path, mic_path, out_path = self._paths()
        length = int(seconds * rate)
        reference = tv_reference(length, rate)
        mic = room_echo(reference, int(round(delay_ms * rate / 1000.0)))
        aec.write_wav(ref_path, reference, rate)
        aec.write_wav(mic_path, mic, rate)
        return ref_path, mic_path, out_path, mic, length

    def test_wav_round_trip(self):
        ref_path, mic_path, out_path, mic, length = self._make_inputs()
        stats = aec.process_wav_files(ref_path, mic_path, out_path, sample_rate=8000)
        self.assertTrue(os.path.exists(out_path))
        self.assertEqual(stats['sample_rate'], 8000)

        clean, rate = aec.read_wav(out_path)
        self.assertEqual(rate, 8000)
        self.assertEqual(len(clean), length)

        half = length // 2
        before = energy(mic[half:])
        after = energy(clean[half:])
        self.assertLess(after, before,
                        'output echo energy %.4g is not below the input mic %.4g'
                        % (after, before))
        self.assertLess(after, 0.3 * before,
                        'output only improved to %.4g from %.4g' % (after, before))
        self.assertGreater(stats['erle_total_db'], 3.0)

    def test_cli_processes_wav_files_and_prints_measurements(self):
        ref_path, mic_path, out_path, _mic, _length = self._make_inputs()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = aec.main(['--ref-wav', ref_path, '--mic-wav', mic_path,
                             '--out-wav', out_path, '--sample-rate', '8000'])
        self.assertEqual(code, 0)
        text = stdout.getvalue()
        self.assertIn('delay', text)
        self.assertIn('ERLE', text)
        self.assertTrue(os.path.exists(out_path))

    def test_cli_requires_all_three_wav_arguments(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                aec.main(['--ref-wav', 'only-one.wav'])

    def test_wav_helpers_round_trip_samples(self):
        path = os.path.join(self.tempdir, 'roundtrip.wav')
        samples = [0.0, 0.25, -0.5, 0.999, -0.999] * 20
        aec.write_wav(path, samples, 16000)
        recovered, rate = aec.read_wav(path)
        self.assertEqual(rate, 16000)
        self.assertEqual(len(recovered), len(samples))
        for expected, actual in zip(samples, recovered):
            self.assertAlmostEqual(actual, expected, places=3)

    def test_read_wav_rejects_unsupported_width(self):
        path = os.path.join(self.tempdir, 'odd.wav')
        import wave
        with wave.open(path, 'wb') as handle:
            handle.setnchannels(1)
            handle.setsampwidth(3)
            handle.setframerate(8000)
            handle.writeframes(b'\x00\x00\x00' * 16)
        with self.assertRaises(ValueError):
            aec.read_wav(path)

    def test_resample_linear_keeps_length_and_shape(self):
        samples = [math.sin(index / 5.0) for index in range(100)]
        doubled = aec.resample_linear(samples, 8000, 16000)
        self.assertEqual(len(doubled), 200)
        halved = aec.resample_linear(samples, 16000, 8000)
        self.assertEqual(len(halved), 50)
        self.assertEqual(aec.resample_linear(samples, 8000, 8000), samples)
        self.assertEqual(aec.resample_linear([], 8000, 16000), [])


class SelftestTest(unittest.TestCase):
    def test_selftest_recovers_the_synthetic_delay(self):
        result = aec.run_selftest(sample_rate=8000, seconds=3.0, delay_ms=185.0,
                                  verbose=False)
        self.assertAlmostEqual(result['true_delay_ms'], 185.0, places=3)
        self.assertLessEqual(abs(result['delay_ms'] - 185.0), 6.0)
        self.assertGreaterEqual(result['erle_db'], 10.0)
        self.assertTrue(result['ok'])

    def test_selftest_cli_exits_zero(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = aec.main(['--selftest'])
        self.assertEqual(code, 0)
        self.assertIn('recovered delay', stdout.getvalue())


class StdlibPathTest(unittest.TestCase):
    """Force the pure-Python FFT so the GitHub CI path is genuinely covered."""

    def setUp(self):
        self.saved = aec._np
        aec._np = None
        self.addCleanup(self._restore)

    def _restore(self):
        aec._np = self.saved

    def test_stdlib_gcc_phat_finds_the_lag(self):
        rate = 8000
        frame = 2048
        reference = tv_reference(frame + 4000, rate, seed=41)
        mic = room_echo(reference, 960)
        lag, confidence = aec.estimate_delay_samples(reference[2000:2000 + frame],
                                                     mic[2000:2000 + frame], 4800)
        self.assertLessEqual(abs(lag - 960), 2)
        self.assertGreater(confidence, 0.4)

    def test_stdlib_canceller_still_converges(self):
        rate = 8000
        length = int(3.0 * rate)
        reference = tv_reference(length, rate, seed=53)
        mic = room_echo(reference, 1200)
        engine = aec.AcousticEchoCanceller(sample_rate=rate)
        clean = []
        for start in range(0, length, 512):
            block, _ = engine.process_frame(reference[start:start + 512],
                                            mic[start:start + 512])
            clean.extend(block)
        self.assertGreaterEqual(erle_db(mic, clean, start=int(2.0 * rate)), 15.0)

    def test_stdlib_correlation_matches_the_direct_form(self):
        rng = random.Random(9)
        ref = [rng.gauss(0.0, 1.0) for _ in range(64)]
        mic = [0.0] * 64
        for index in range(10, 64):
            mic[index] = 0.5 * ref[index - 10]
        size = 128
        correlation = aec.gcc_phat_correlation(ref, mic, size)
        # The PHAT surface at the true lag must be the strongest positive peak.
        peak = max(range(1, 40), key=lambda lag: correlation[lag])
        self.assertEqual(peak, 10)


def device(name, kind, channels=1, index=0):
    """A discovery input/output entry, shaped like ``discover_audio_devices``."""
    return {'index': index, 'name': name, 'kind': kind, 'channels': channels}


def device_set(names, outputs=('MacBook Pro Speakers',)):
    """Build a discovery dict from ``(name, kind, index)`` input tuples."""
    inputs = [device(name, kind, 1, index) for index, (name, kind) in enumerate(names)]
    outs = []
    for index, name in enumerate(outputs):
        kind = 'builtin' if 'MacBook' in name else 'virtual'
        outs.append(device(name, kind, 2, len(inputs) + index))
    return {'inputs': inputs, 'outputs': outs}


# The physical setup this ticket is about: a MacBook, a Continuity iPhone mic,
# Zoom's virtual device, and an optional Focusrite USB soundcard.
USB_SET = (('Focusrite Scarlett 2i2 USB', 'usb'), ('MacBook Pro Microphone', 'builtin'),
           ('iPhone Microphone', 'continuity'), ('ZoomAudioDevice', 'virtual'))
UNPLUGGED_SET = (('MacBook Pro Microphone', 'builtin'),
                 ('iPhone Microphone', 'continuity'), ('ZoomAudioDevice', 'virtual'))


class DeviceClassifyTest(unittest.TestCase):
    def test_names_are_classified_by_kind(self):
        self.assertEqual(aec.classify_device('BlackHole 2ch'), 'virtual')
        self.assertEqual(aec.classify_device('ZoomAudioDevice'), 'virtual')
        self.assertEqual(aec.classify_device('Soundflower (2ch)'), 'virtual')
        self.assertEqual(aec.classify_device('Loopback Audio'), 'virtual')
        self.assertEqual(aec.classify_device('VB-Cable'), 'virtual')
        self.assertEqual(aec.classify_device('Existential Audio Device'), 'virtual')
        self.assertEqual(aec.classify_device('iPhone Microphone'), 'continuity')
        self.assertEqual(aec.classify_device('iPad Microphone'), 'continuity')
        self.assertEqual(aec.classify_device('Continuity Capture Mic'), 'continuity')
        self.assertEqual(aec.classify_device('MacBook Pro Microphone'), 'builtin')
        self.assertEqual(aec.classify_device('Built-in Microphone'), 'builtin')
        self.assertEqual(aec.classify_device('Internal Microphone'), 'builtin')

    def test_external_soundcards_are_usb(self):
        for name in ('Focusrite Scarlett 2i2 USB', 'USB PnP Sound Device',
                     'Sound Blaster Play! 3', 'Rode NT-USB', 'Shure MV7',
                     'Steinberg UR22C', 'Behringer UMC202HD', 'Audio-Technica AT2020USB',
                     'Blue Yeti', 'External Microphone', 'USB Audio Codec',
                     'Scarlett Solo Audio Interface'):
            self.assertEqual(aec.classify_device(name), 'usb', name)

    def test_transport_breaks_ties_for_generic_names(self):
        self.assertEqual(aec.classify_device('Aggregate Device',
                                             'coreaudio_device_type_virtual'), 'virtual')
        self.assertEqual(aec.classify_device('Aggregate Device',
                                             'coreaudio_device_type_builtin'), 'builtin')


class AutoSelectDevicesTest(unittest.TestCase):
    """Auto-selection is the heart of BEE-232: plugging the soundcard in wins."""

    def test_usb_soundcard_beats_builtin_continuity_and_virtual(self):
        picked = aec.auto_select_devices(device_set(USB_SET))
        self.assertEqual(picked['mic_device'], 'Focusrite Scarlett 2i2 USB')
        self.assertEqual(picked['mic_kind'], 'usb')
        self.assertEqual(picked['mic_source'], 'usb')

    def test_usb_pnp_sound_device_is_also_auto_picked(self):
        devices = device_set((('USB PnP Sound Device', 'usb'),
                             ('MacBook Pro Microphone', 'builtin'),
                             ('iPhone Microphone', 'continuity')))
        picked = aec.auto_select_devices(devices)
        self.assertEqual(picked['mic_device'], 'USB PnP Sound Device')

    def test_unplugging_the_soundcard_falls_back_to_the_macbook_mic(self):
        plugged = aec.auto_select_devices(device_set(USB_SET))
        unplugged = aec.auto_select_devices(device_set(UNPLUGGED_SET))
        self.assertEqual(plugged['mic_device'], 'Focusrite Scarlett 2i2 USB')
        self.assertEqual(unplugged['mic_device'], 'MacBook Pro Microphone')
        self.assertEqual(unplugged['mic_kind'], 'builtin')
        # Continuity and virtual devices must never be picked as the physical mic.
        self.assertNotEqual(unplugged['mic_device'], 'iPhone Microphone')
        self.assertNotEqual(unplugged['mic_device'], 'ZoomAudioDevice')

    def test_preferred_mic_wins_when_still_connected(self):
        preferred = {'mic_device': 'MacBook Pro Microphone'}
        picked = aec.auto_select_devices(device_set(USB_SET), preferred)
        self.assertEqual(picked['mic_device'], 'MacBook Pro Microphone')
        self.assertEqual(picked['mic_source'], 'preferred')

    def test_preferred_mic_that_is_gone_falls_back_and_notes_it(self):
        preferred = {'mic_device': 'Focusrite Scarlett 2i2 USB'}
        picked = aec.auto_select_devices(device_set(UNPLUGGED_SET), preferred)
        self.assertEqual(picked['mic_device'], 'MacBook Pro Microphone')
        self.assertTrue(any('not connected' in note for note in picked['notes']))

    def test_preferred_virtual_mic_is_honoured_when_explicitly_asked(self):
        preferred = {'mic_device': 'ZoomAudioDevice'}
        picked = aec.auto_select_devices(device_set(UNPLUGGED_SET), preferred)
        self.assertEqual(picked['mic_device'], 'ZoomAudioDevice')
        self.assertEqual(picked['mic_source'], 'preferred')

    def test_two_virtual_devices_split_reference_and_output(self):
        devices = device_set(USB_SET, outputs=('BlackHole 2ch', 'BlackHole 16ch',
                                              'ZoomAudioDevice', 'MacBook Pro Speakers'))
        picked = aec.auto_select_devices(devices)
        self.assertEqual(picked['ref_device'], 'BlackHole 2ch')
        self.assertEqual(picked['out_device'], 'ZoomAudioDevice')
        self.assertFalse(any('Only one virtual' in note for note in picked['notes']))

    def test_blackhole_16ch_is_the_output_when_zoom_is_absent(self):
        devices = device_set((('Focusrite Scarlett 2i2 USB', 'usb'),
                              ('MacBook Pro Microphone', 'builtin')),
                             outputs=('BlackHole 2ch', 'BlackHole 16ch',
                                      'MacBook Pro Speakers'))
        picked = aec.auto_select_devices(devices)
        self.assertEqual(picked['ref_device'], 'BlackHole 2ch')
        self.assertEqual(picked['out_device'], 'BlackHole 16ch')

    def test_single_virtual_device_warns_with_the_brew_command(self):
        picked = aec.auto_select_devices(device_set(UNPLUGGED_SET))
        self.assertEqual(picked['ref_device'], 'ZoomAudioDevice')
        self.assertEqual(picked['out_device'], 'ZoomAudioDevice')
        warnings = [note for note in picked['notes'] if 'Only one virtual audio device' in note]
        self.assertEqual(len(warnings), 1, picked['notes'])
        self.assertIn('ZoomAudioDevice', warnings[0])
        self.assertIn('brew install --cask blackhole-2ch', warnings[0])

    def test_no_virtual_device_asks_for_blackhole(self):
        devices = device_set((('MacBook Pro Microphone', 'builtin'),),
                             outputs=('MacBook Pro Speakers',))
        picked = aec.auto_select_devices(devices)
        self.assertIsNone(picked['ref_device'])
        self.assertIsNone(picked['out_device'])
        self.assertTrue(any('brew install --cask blackhole-2ch' in note
                            for note in picked['notes']))

    def test_preferred_reference_and_output_are_kept(self):
        devices = device_set(USB_SET, outputs=('BlackHole 2ch', 'BlackHole 16ch',
                                              'ZoomAudioDevice'))
        preferred = {'ref_device': 'ZoomAudioDevice', 'out_device': 'BlackHole 16ch'}
        picked = aec.auto_select_devices(devices, preferred)
        self.assertEqual(picked['ref_device'], 'ZoomAudioDevice')
        self.assertEqual(picked['out_device'], 'BlackHole 16ch')

    def test_accepts_a_bare_list_of_inputs(self):
        entries = [device('Focusrite Scarlett 2i2 USB', 'usb'),
                   device('MacBook Pro Microphone', 'builtin')]
        picked = aec.auto_select_devices(entries)
        self.assertEqual(picked['mic_device'], 'Focusrite Scarlett 2i2 USB')

    def test_empty_device_list_is_safe(self):
        picked = aec.auto_select_devices({'inputs': [], 'outputs': []})
        self.assertIsNone(picked['mic_device'])
        self.assertIsNone(picked['ref_device'])
        self.assertIsNone(picked['out_device'])
        self.assertTrue(picked['notes'])


class DiscoverAudioDevicesTest(unittest.TestCase):
    """``discover_audio_devices`` must be structured, JSON-ready and host-safe."""

    def _fake_module(self, devices):
        class FakeSoundDevice:
            @staticmethod
            def query_devices():
                return devices
        return FakeSoundDevice()

    def test_structure_matches_the_documented_shape(self):
        module = self._fake_module([
            {'name': 'MacBook Pro Microphone', 'max_input_channels': 1,
             'max_output_channels': 0},
            {'name': 'Focusrite Scarlett 2i2 USB', 'max_input_channels': 2,
             'max_output_channels': 2},
            {'name': 'ZoomAudioDevice', 'max_input_channels': 2,
             'max_output_channels': 2},
        ])
        found = aec.discover_audio_devices(module=module)
        self.assertEqual(set(found), {'inputs', 'outputs', 'recommended', 'source'})
        self.assertEqual(found['source'], 'sounddevice')
        self.assertEqual([entry['name'] for entry in found['inputs']],
                         ['MacBook Pro Microphone', 'Focusrite Scarlett 2i2 USB',
                          'ZoomAudioDevice'])
        self.assertEqual([entry['name'] for entry in found['outputs']],
                         ['Focusrite Scarlett 2i2 USB', 'ZoomAudioDevice'])
        for entry in found['inputs']:
            self.assertEqual(set(entry), {'index', 'name', 'kind', 'channels'})
            self.assertIn(entry['kind'], ('usb', 'builtin', 'virtual', 'continuity'))
            self.assertIsInstance(entry['index'], int)
            self.assertIsInstance(entry['channels'], int)
        self.assertEqual(found['inputs'][1]['kind'], 'usb')
        self.assertEqual(found['inputs'][2]['kind'], 'virtual')
        recommended = found['recommended']
        for key in ('mic_device', 'ref_device', 'out_device', 'notes'):
            self.assertIn(key, recommended)
        self.assertEqual(recommended['mic_device'], 'Focusrite Scarlett 2i2 USB')
        self.assertIsInstance(recommended['notes'], list)
        json.dumps(found)  # must be serialisable for `--list-devices --json`

    def test_empty_or_broken_backend_does_not_raise(self):
        class Broken:
            @staticmethod
            def query_devices():
                raise RuntimeError('no core audio')
        saved = aec.platform.system
        aec.platform.system = lambda: 'Linux'
        try:
            found = aec.discover_audio_devices(module=Broken())
        finally:
            aec.platform.system = saved
        self.assertEqual(found['inputs'], [])
        self.assertIn('recommended', found)

    def test_cli_json_flag_prints_machine_readable_structure(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = aec.main(['--list-devices', '--json'])
        self.assertEqual(code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertIn('inputs', payload)
        self.assertIn('outputs', payload)
        self.assertIn('recommended', payload)
        self.assertIn('mic_device', payload['recommended'])

    def test_list_devices_text_mode_mentions_the_recommendation(self):
        stdout = io.StringIO()
        code = aec.list_devices(stream=stdout)
        self.assertIn(code, (0, 1))
        self.assertIn('recommended: mic=', stdout.getvalue())


class LiveAutoSelectionTest(unittest.TestCase):
    """``--live --auto`` must open the auto-selected devices, not defaults."""

    def _run(self, devices, argv):
        opened = []

        class FakeStream:
            def __init__(self, device):
                self.device = device
                self.calls = 0

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, size):
                self.calls += 1
                if self.calls > 4:
                    raise KeyboardInterrupt
                return ([[0.01]] * size, None)

            def write(self, data):
                pass

        class FakeSoundDevice:
            @staticmethod
            def InputStream(**kwargs):
                opened.append(('in', kwargs['device']))
                return FakeStream(kwargs['device'])

            @staticmethod
            def OutputStream(**kwargs):
                opened.append(('out', kwargs['device']))
                return FakeStream(kwargs['device'])

            @staticmethod
            def query_devices():
                return devices

        saved = aec._sd
        aec._sd = FakeSoundDevice
        self.addCleanup(setattr, aec, '_sd', saved)
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = aec.main(argv)
        return code, opened, stdout.getvalue()

    DEVICES = [
        {'name': 'Focusrite Scarlett 2i2 USB', 'max_input_channels': 2,
         'max_output_channels': 2},
        {'name': 'MacBook Pro Microphone', 'max_input_channels': 1,
         'max_output_channels': 0},
        {'name': 'ZoomAudioDevice', 'max_input_channels': 2,
         'max_output_channels': 2},
    ]

    def test_live_auto_opens_the_usb_soundcard_reference_and_output(self):
        code, opened, stdout = self._run(self.DEVICES, ['--live', '--auto', '--json'])
        self.assertEqual(code, 0)
        self.assertEqual(opened, [('in', 'ZoomAudioDevice'),
                                  ('in', 'Focusrite Scarlett 2i2 USB'),
                                  ('out', 'ZoomAudioDevice')])
        start = json.loads(stdout.splitlines()[0])
        self.assertEqual(start['event'], 'start')
        self.assertEqual(start['mic_device'], 'Focusrite Scarlett 2i2 USB')
        self.assertEqual(start['ref_device'], 'ZoomAudioDevice')
        self.assertEqual(start['out_device'], 'ZoomAudioDevice')
        self.assertTrue(any('brew install --cask blackhole-2ch' in note
                            for note in start['notes']))
        # Telemetry lines carry the live figures the desktop meters display.
        telemetry = [json.loads(line) for line in stdout.splitlines()
                     if '"telemetry"' in line]
        self.assertTrue(telemetry)
        for key in ('delay_ms', 'erle_db', 'double_talk', 'confidence',
                    'mic_device', 'ref_device', 'out_device'):
            self.assertIn(key, telemetry[0])

    def test_live_without_flags_still_auto_selects(self):
        code, opened, _ = self._run(self.DEVICES, ['--live', '--json'])
        self.assertEqual(code, 0)
        self.assertIn(('in', 'Focusrite Scarlett 2i2 USB'), opened)

    def test_no_prefer_usb_keeps_the_builtin_mic(self):
        code, opened, _ = self._run(self.DEVICES,
                                    ['--live', '--auto', '--json', '--no-prefer-usb'])
        self.assertEqual(code, 0)
        self.assertIn(('in', 'MacBook Pro Microphone'), opened)
        self.assertNotIn(('in', 'Focusrite Scarlett 2i2 USB'), opened)

    def test_explicit_device_flag_beats_auto(self):
        code, opened, _ = self._run(
            self.DEVICES,
            ['--live', '--auto', '--json', '--mic-device', 'MacBook Pro Microphone'])
        self.assertEqual(code, 0)
        self.assertIn(('in', 'MacBook Pro Microphone'), opened)


class DeviceListTest(unittest.TestCase):
    def test_list_devices_without_sounddevice_does_not_raise(self):
        device_backend = aec._sd
        aec._sd = None
        self.addCleanup(setattr, aec, '_sd', device_backend)
        stdout = io.StringIO()
        code = aec.list_devices(stream=stdout)
        self.assertIn(code, (0, 1))
        self.assertTrue(stdout.getvalue())

    def test_live_without_sounddevice_explains_the_install(self):
        saved_sd = aec._sd
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        aec._sd = None
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        try:
            with self.assertRaises(RuntimeError) as caught:
                aec.run_live()
            self.assertIn('sounddevice', str(caught.exception))
            code = aec.main(['--live'])
            self.assertEqual(code, 1)
        finally:
            aec._sd = saved_sd
            sys.stdout = saved_stdout
            sys.stderr = saved_stderr

    def test_ffmpeg_backend_requires_all_three_indices(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = aec.main(['--live', '--backend', 'ffmpeg'])
        self.assertEqual(code, 1)
        message = stderr.getvalue()
        for flag in ('--ref-index', '--mic-index', '--out-index'):
            self.assertIn(flag, message)

    def test_run_live_ffmpeg_rejects_a_missing_output_index(self):
        with self.assertRaises(RuntimeError) as caught:
            aec.run_live_ffmpeg(ref_index=1, mic_index=2)
        self.assertIn('out-index', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
