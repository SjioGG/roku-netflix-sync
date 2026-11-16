"""Lag tracking and mic-delay policy for the WebRTC AEC3 live path.

Needs numpy (bundled in Roku Sync.app's runtime); livekit is only needed for
the canceller round trip.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import aec_webrtc  # noqa: E402

np = aec_webrtc.np
SR = 16000


def room(seconds=6.0, lead_ms=150.0, seed=1):
    """Reference noise and a mic copy arriving ``lead_ms`` later, with a short tail."""
    rng = np.random.default_rng(seed)
    ref = rng.standard_normal(int(seconds * SR)).astype(np.float32) * 0.1
    shift = int(lead_ms * SR / 1000)
    mic = np.zeros_like(ref)
    mic[shift:] = 0.5 * ref[:-shift] if shift else 0.5 * ref
    mic[shift + 40:] += 0.2 * ref[:len(ref) - shift - 40]
    return ref, mic


def feed(aligner, ref, mic, block=160):
    for start in range(0, len(ref) - block + 1, block):
        aligner.push(ref[start:start + block], mic[start:start + block])


@unittest.skipIf(np is None, 'numpy is not installed')
class ReferenceAlignerTest(unittest.TestCase):
    def test_measures_how_far_chrome_leads_the_room_echo(self):
        aligner = aec_webrtc.ReferenceAligner(SR)
        feed(aligner, *room(lead_ms=150.0))
        self.assertIsNotNone(aligner.lead_ms)
        self.assertAlmostEqual(aligner.lead_ms, 150.0, delta=1.0)
        self.assertGreater(aligner.score, aec_webrtc.LAG_MIN_PEAK)

    def test_negative_lead_when_chrome_plays_after_the_tv(self):
        ref, mic = room(lead_ms=60.0)
        aligner = aec_webrtc.ReferenceAligner(SR)
        # Swap roles: the "reference" now trails the room by 60 ms.
        feed(aligner, mic, ref)
        self.assertAlmostEqual(aligner.lead_ms, -60.0, delta=1.0)

    def test_unrelated_audio_never_locks(self):
        rng = np.random.default_rng(7)
        ref = rng.standard_normal(6 * SR).astype(np.float32) * 0.1
        mic = rng.standard_normal(6 * SR).astype(np.float32) * 0.1
        aligner = aec_webrtc.ReferenceAligner(SR)
        feed(aligner, ref, mic)
        self.assertIsNone(aligner.lead_ms)

    def test_a_single_window_jump_needs_a_second_agreeing_window(self):
        aligner = aec_webrtc.ReferenceAligner(SR)
        aligner.lead_ms = 150.0
        aligner._filled = len(aligner._ref)
        calls = iter([(int(0.5 * SR), 80.0), (int(0.15 * SR), 80.0),
                      (int(0.5 * SR), 80.0), (int(0.5 * SR), 80.0)])
        saved = aec_webrtc.gcc_phat_lag
        aec_webrtc.gcc_phat_lag = lambda *_: next(calls)
        self.addCleanup(setattr, aec_webrtc, 'gcc_phat_lag', saved)
        block = np.full(aligner.update, 0.1, np.float32)
        noisy = block + np.linspace(0, 0.01, len(block), dtype=np.float32)
        self.assertFalse(aligner.push(noisy, noisy))  # 500 ms outlier: held
        self.assertTrue(aligner.push(noisy, noisy))   # back to 150 ms
        self.assertFalse(aligner.push(noisy, noisy))  # new jump: held
        self.assertTrue(aligner.push(noisy, noisy))   # confirmed
        self.assertAlmostEqual(aligner.lead_ms, 500.0)


class _StubAligner:
    def __init__(self, lead_ms):
        self.lead_ms = lead_ms


@unittest.skipIf(np is None, 'numpy is not installed')
class MicDelayPolicyTest(unittest.TestCase):
    def canceller(self, lead_ms, applied_ms=0.0):
        aec = aec_webrtc.WebRtcEchoCanceller.__new__(aec_webrtc.WebRtcEchoCanceller)
        aec.sample_rate = SR
        aec.frame = SR // 100
        aec.target_lead_ms = aec_webrtc.TARGET_LEAD_MS
        aec.min_lead_ms = aec_webrtc.MIN_LEAD_MS
        aec.max_mic_delay = int(aec_webrtc.MAX_MIC_DELAY_MS * SR / 1000)
        aec.aligner = _StubAligner(lead_ms)
        aec.mic_delay = int(applied_ms * SR / 1000)
        aec._resets = 0
        aec._new_apm = lambda: object()
        return aec

    def delay_ms(self, aec):
        return aec.mic_delay * 1000.0 / SR

    def test_chrome_behind_the_tv_is_covered_by_delaying_the_mic(self):
        aec = self.canceller(lead_ms=-47.0)
        aec._retune_mic_delay()
        self.assertAlmostEqual(self.delay_ms(aec), 247.0, delta=0.1)
        self.assertEqual(aec._resets, 1)

    def test_no_voice_latency_once_chrome_leads_enough(self):
        aec = self.canceller(lead_ms=175.0, applied_ms=87.0)
        aec._retune_mic_delay()
        self.assertEqual(aec.mic_delay, 0)

    def test_small_corrections_do_not_reset_the_canceller(self):
        aec = self.canceller(lead_ms=100.0, applied_ms=90.0)
        aec._retune_mic_delay()
        self.assertAlmostEqual(self.delay_ms(aec), 90.0, delta=0.1)
        self.assertEqual(aec._resets, 0)


@unittest.skipUnless(aec_webrtc.available(), 'livekit WebRTC runtime is not installed')
class WebRtcRoundTripTest(unittest.TestCase):
    def test_cancels_a_leading_reference_and_keeps_block_sizes(self):
        ref, mic = room(seconds=8.0, lead_ms=200.0)
        aec = aec_webrtc.WebRtcEchoCanceller(sample_rate=SR, noise_suppression=False)
        out = []
        for start in range(0, len(ref) - 512 + 1, 512):
            clean, stats = aec.process_frame(ref[start:start + 512], mic[start:start + 512])
            self.assertEqual(len(clean), 512)
            out.extend(clean)
        out = np.asarray(out[4 * SR:])
        tail = mic[4 * SR:4 * SR + len(out)]
        erle = 10 * np.log10(np.mean(tail ** 2) / (np.mean(out ** 2) + 1e-12))
        self.assertGreater(erle, 15.0)
        self.assertEqual(stats['engine'], 'webrtc-aec3')
        self.assertAlmostEqual(stats['acoustic_lead_ms'], 200.0, delta=1.0)
        self.assertEqual(stats['mic_delay_ms'], 0.0)


if __name__ == '__main__':
    unittest.main()
