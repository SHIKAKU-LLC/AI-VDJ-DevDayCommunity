import importlib.util
from pathlib import Path
import tempfile
import unittest

import numpy as np
import soundfile as sf

spec = importlib.util.spec_from_file_location('dj_dsp', Path(__file__).with_name('dj-transition-dsp.py'))
dsp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dsp)


class DSPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sr = 44100
        t = np.arange(8 * cls.sr) / cls.sr
        mono = .1 * np.sin(2 * np.pi * 80 * t) + .03 * np.sin(2 * np.pi * 2000 * t)
        cls.x = np.column_stack([mono, mono])

    def transition(self, kind='bass-swap', seconds=2):
        n = round(seconds * self.sr)
        return {'type':kind,'entryFrame':n//2,'exitFrame':len(self.x)-n//2,'overlapFrames':n,
                'sampleRate':self.sr,'relativeIncomingGainDb':0,'eqCurves':dsp.bass_curves(n,self.sr) if kind=='bass-swap' else None}

    def test_geometry_and_exact_duration(self):
        x, seam, double = dsp.render_pair(self.x,self.x,self.sr,self.transition())
        self.assertEqual(len(x),14*self.sr)
        self.assertEqual(double,0)
        self.assertTrue(np.isfinite(x).all())

    def test_bass_overlap_baseline_vs_single_owner(self):
        baseline, _, doubles = dsp.render_pair(self.x,self.x,self.sr,self.transition('equal-power-baseline'))
        improved, _, managed = dsp.render_pair(self.x,self.x,self.sr,self.transition())
        self.assertGreater(doubles,0)
        self.assertEqual(managed,0)
        self.assertLess(np.max(abs(improved)),np.max(abs(baseline)))

    def test_render_preserves_unmixed_source_and_never_normalizes(self):
        y, _, _ = dsp.render_pair(self.x,self.x,self.sr,self.transition())
        np.testing.assert_array_equal(y[:6*self.sr],self.x[:6*self.sr])
        np.testing.assert_array_equal(y[-6*self.sr:],self.x[-6*self.sr:])

    def test_late_cue_and_previous_overlap_rejected(self):
        p = self.transition()
        start = p['exitFrame']-p['overlapFrames']//2
        for kwargs in [{'played_until_frame':start+1},{'prior_incoming_end':start+1}]:
            with self.assertRaisesRegex(ValueError,'LATE_OR_OVERLAPPING'):
                dsp.render_pair(self.x,self.x,self.sr,p,**kwargs)

    def test_negative_odd_and_oversize_frames_rejected(self):
        for name,value in [('overlapFrames',3),('overlapFrames',-2),('entryFrame',0),('exitFrame',len(self.x)+2)]:
            p = self.transition();p[name]=value
            with self.assertRaises(ValueError):dsp.render_pair(self.x,self.x,self.sr,p)

    def test_native_is_full_endpoint_without_overlap(self):
        p = {'type':'native-continuation','entryFrame':0,'exitFrame':len(self.x),'overlapFrames':0,
             'sampleRate':self.sr,'relativeIncomingGainDb':0,'eqCurves':None}
        y, _, double = dsp.render_pair(self.x,self.x,self.sr,p)
        np.testing.assert_array_equal(y,np.concatenate([self.x,self.x]))
        self.assertEqual(double,0)

    def test_native_declick_keeps_duration_and_cannot_edit_queued_samples(self):
        p={'type':'native-continuation','entryFrame':0,'exitFrame':len(self.x),'overlapFrames':0,
           'seamDeclickFrames':882,'sampleRate':self.sr,'relativeIncomingGainDb':0,'eqCurves':None}
        y,_,double=dsp.render_pair(self.x,self.x,self.sr,p)
        self.assertEqual(len(y),len(self.x)*2);self.assertEqual(double,0)
        self.assertAlmostEqual(float(y[len(self.x),0]),0.)
        with self.assertRaisesRegex(ValueError,'LATE'):dsp.render_pair(self.x,self.x,self.sr,p,played_until_frame=len(self.x)-440)

    def test_silence_and_effective_silence_are_detected(self):
        for x in [self.x*1e-4,np.zeros_like(self.x)]:
            m = dsp.render_metrics(x,self.sr,len(x)//2,0)
            self.assertIn('EFFECTIVE_SILENCE',dsp.qc_reasons(m))

    def test_loud_clip_with_long_silent_suffix_is_detected(self):
        x = self.x.copy();x[-self.sr:]=0
        m = dsp.render_metrics(x,self.sr,len(x)//2,0)
        self.assertAlmostEqual(m['maxQuietRunSeconds'],1.)
        self.assertIn('EFFECTIVE_SILENCE',dsp.qc_reasons(m))

    def test_float_render_keeps_clip_evidence_and_sha(self):
        with tempfile.TemporaryDirectory() as d:
            a,b,out=[Path(d)/n for n in ['a.wav','b.wav','out.wav']]
            sf.write(a,self.x*12,self.sr,subtype='FLOAT');sf.write(b,self.x,self.sr,subtype='FLOAT')
            q=dsp.inspect_pair(a,b,self.transition(),out)
            self.assertFalse(q['passed']);self.assertGreater(q['renderMetrics']['clippedFraction'],0)
            self.assertEqual(q['renderedSha256'],dsp.digest_file(out))
            self.assertEqual(q['renderSpecSha256'],dsp.digest_object(self.transition()))

    def test_beat_proxy_never_claims_downbeat_phrase_or_measured_tempo(self):
        beat=dsp.rhythm_proxy(self.x,self.sr)
        self.assertEqual(beat['confidence'],'proxy')
        self.assertFalse(beat['beatGridVerified']);self.assertFalse(beat['downbeatVerified']);self.assertFalse(beat['phraseVerified'])

    def test_half_double_error_on_regular_140bpm_material_is_flagged(self):
        t=np.arange(12*self.sr)/self.sr
        phase=np.mod(t,60/140)
        x=.2*np.sin(2*np.pi*80*t)*np.exp(-phase/.035)
        beat=dsp.rhythm_proxy(np.column_stack([x,x]),self.sr)
        self.assertTrue(beat['octaveAmbiguous'])
        self.assertEqual(beat['confidence'],'proxy')

    def test_nonfinite_samples_never_render(self):
        x=self.x.copy();x[0,0]=np.nan
        with self.assertRaisesRegex(ValueError,'NONFINITE'):dsp.render_pair(x,self.x,self.sr,self.transition())

    def test_stereo_antiphase_band_energy_does_not_cancel(self):
        x=self.x.copy();x[:,1]*=-1
        self.assertGreater(dsp.band_fractions(x,self.sr)[0],.8)

    def test_headroom_copy_preserves_original_and_exact_source_order(self):
        with tempfile.TemporaryDirectory() as d:
            source,target=Path(d)/'source.wav',Path(d)/'prepared.wav'
            sf.write(source,self.x*12,self.sr,subtype='FLOAT');original=dsp.digest_file(source)
            p=dsp.prepare_headroom(source,target)
            self.assertEqual(dsp.digest_file(source),original)
            y,_=dsp.read_audio(target);x,_=dsp.read_audio(source)
            np.testing.assert_allclose(y,x*10**(p['gainDb']/20),atol=1e-7)
            self.assertLessEqual(p['after']['truePeakDbtp'],-1.)
            self.assertFalse(p['limiterApplied']);self.assertFalse(p['room24SecondDurationEligible'])

    def test_headroom_never_overwrites_or_pads_short_source(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source.wav';sf.write(source,self.x,self.sr,subtype='FLOAT')
            with self.assertRaisesRegex(ValueError,'OVERWRITE'):dsp.prepare_headroom(source,source)
            with self.assertRaisesRegex(ValueError,'INVALID'):dsp.prepare_headroom(source,Path(d)/'new.wav',end_frame=len(self.x)+1)
            with self.assertRaisesRegex(ValueError,'OVERWRITE'):dsp.inspect_pair(source,source,self.transition(),source)


    def test_measured_crossfade_carries_a_faded_tail_that_a_final_frame_cut_fails(self):
        # A generated Cue that fades out over its last second: a cut at the final
        # frame jumps back to the incoming level, while the measured 3s
        # single-bass-owner crossfade passes the same objective gates.
        sr, frames = self.sr, 24 * self.sr
        t = np.arange(frames) / sr
        tone = lambda f: .08 * np.sin(2 * np.pi * f * t) + .03 * np.sin(2 * np.pi * 3 * f * t)
        fade = np.ones(frames); fade[-sr:] = np.logspace(0, -1.2, sr)
        a = np.column_stack([tone(110) * fade] * 2); b = np.column_stack([tone(147)] * 2)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sf.write(root/'a.wav', a, sr, subtype='FLOAT'); sf.write(root/'b.wav', b, sr, subtype='FLOAT')
            cut = {'type':'measured-nonoverlap-cut','entryFrame':0,'exitFrame':frames,'overlapFrames':0,'sampleRate':sr,
                   'relativeIncomingGainDb':0,'eqCurves':None,'seamDeclickFrames':882}
            failed = dsp.inspect_pair(root/'a.wav', root/'b.wav', cut, root/'cut.wav')
            self.assertFalse(failed['passed']); self.assertIn('LEVEL_STEP', failed['renderQC']['reasons'])
            n = 3 * sr
            crossfade = {'type':'measured-overlap-crossfade','entryFrame':n//2,'exitFrame':frames-n//2,'overlapFrames':n,
                         'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':dsp.bass_curves(n, sr)}
            receipt = dsp.inspect_pair(root/'a.wav', root/'b.wav', crossfade, root/'crossfade.wav')
            self.assertTrue(receipt['passed'], receipt['renderQC']['reasons'])
            self.assertEqual(receipt['measuredCrossfadePolicy'], 'objective-overlap-crossfade-no-musical-grid-claim-v1')
            self.assertEqual(receipt['renderedFrameCount'], 2 * frames - n)
            self.assertEqual(receipt['renderMetrics']['bassDoubleOwnershipFrames'], 0)
            rendered, _ = dsp.read_audio(root/'crossfade.wav')
            saved_a, _ = dsp.read_audio(root/'a.wav'); saved_b, _ = dsp.read_audio(root/'b.wav')
            self.assertTrue(np.array_equal(rendered[:frames - n], saved_a[:frames - n]), 'the queued prefix is unchanged')
            self.assertTrue(np.array_equal(rendered[frames:], saved_b[n:]), 'the incoming tail is unchanged')

    def test_overlap_low_band_lift_above_the_live_ceiling_fails(self):
        metrics = {'truePeakDbtp':-3., 'clippedFraction':0., 'maxQuietRunSeconds':0., 'minimumWindowDbfs':-20.,
                   'maxLevelStepDb':1., 'seamJump':0., 'bassDoubleOwnershipFrames':0, 'nonfiniteSamples':0, 'overlapLowBandLiftDb':3.5}
        self.assertEqual(dsp.qc_reasons(metrics), ['LOW_BAND_LIFT'])
        self.assertEqual(dsp.qc_reasons({**metrics, 'overlapLowBandLiftDb':2.9}), [])


    def test_render_is_pcm16_only_when_both_sources_are_and_copies_stay_exact(self):
        sr, frames = self.sr, 24 * self.sr
        t = np.arange(frames) / sr
        a = np.column_stack([.2 * np.sin(2 * np.pi * 110 * t)] * 2); b = np.column_stack([.2 * np.sin(2 * np.pi * 147 * t)] * 2)
        n = 3 * sr
        spec = {'type':'measured-overlap-crossfade','entryFrame':n//2,'exitFrame':frames-n//2,'overlapFrames':n,
                'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':dsp.bass_curves(n, sr)}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sf.write(root/'a16.wav', dsp.pcm16_exact(a), sr, subtype='PCM_16'); sf.write(root/'b16.wav', dsp.pcm16_exact(b), sr, subtype='PCM_16')
            sf.write(root/'bf.wav', b, sr, subtype='FLOAT')
            receipt = dsp.inspect_pair(root/'a16.wav', root/'b16.wav', spec, root/'r16.wav')
            self.assertTrue(receipt['passed'], receipt['renderQC']['reasons'])
            self.assertEqual(sf.info(str(root/'r16.wav')).subtype, 'PCM_16')
            self.assertLess((root/'r16.wav').stat().st_size, 2 * frames * 2 * 2 + 1024, 'half the bytes of FLOAT')
            r = sf.read(root/'r16.wav', dtype='int16', always_2d=True)[0]
            ai = sf.read(root/'a16.wav', dtype='int16', always_2d=True)[0]; bi = sf.read(root/'b16.wav', dtype='int16', always_2d=True)[0]
            self.assertTrue(np.array_equal(r[:frames - n], ai[:frames - n]), 'queued prefix stays bit-identical')
            self.assertTrue(np.array_equal(r[frames:], bi[n:]), 'incoming tail stays bit-identical')
            dsp.inspect_pair(root/'a16.wav', root/'bf.wav', spec, root/'rf.wav')
            self.assertEqual(sf.info(str(root/'rf.wav')).subtype, 'FLOAT', 'a FLOAT source keeps a FLOAT render')


if __name__=='__main__':unittest.main()
