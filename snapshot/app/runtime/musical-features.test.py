import importlib.util, unittest
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('features',Path(__file__).with_name('musical-features.py'));f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
class Features(unittest.TestCase):
 def test_silence_never_invents_key_or_tempo(self):
  v=f.observe_array(np.zeros((44100*4,2),dtype=np.float32),44100)
  self.assertEqual(v['key']['status'],'unknown');self.assertEqual(v['pulse']['status'],'unknown');self.assertFalse(v['phrase']['verified'])
 def test_antiphase_retains_stereo_features(self):
  t=np.arange(4*44100)/44100;s=.1*np.sin(2*np.pi*440*t)
  a=f.observe_array(np.stack([s,s],axis=1),44100);b=f.observe_array(np.stack([s,-s],axis=1),44100)
  self.assertEqual(a['key']['hypotheses'],b['key']['hypotheses']);self.assertTrue(b['analysis']['stereoPowerCombined']);self.assertFalse(b['key']['verified'])
 def test_missing_beat_fit_preserves_actual_pulse_not_false_slow_tempo(self):
  t=np.arange(30)*60/145;v=f.fit_beats(np.delete(t,[8,16]))
  self.assertAlmostEqual(v['tempoBpm'],145,places=6);self.assertEqual(v['missingBeatSteps'],2);self.assertFalse(v['calibrated'])
 def test_pulse_harmonics_are_estimates_not_calibrated_beat_confidence(self):
  fps=100;v=np.zeros(1200);v[::40]=1;p=f.pulse_candidates(v,fps)
  self.assertTrue(any(abs(x['bpm']-150)<1 for x in p));self.assertTrue(any(abs(x['bpm']-75)<1 for x in p))
 def test_bad_audio_contract(self):
  for a,r in [(np.zeros((44100*4,1)),44100),(np.zeros((44100*4,2)),48000),(np.full((44100*4,2),np.nan),44100)]:
   with self.assertRaises(ValueError):f.observe_array(a,r)
 def test_insufficient_beats_and_no_model_cannot_make_plans(self):
  self.assertEqual(f.fit_beats([0,1])['status'],'insufficient');self.assertEqual(f.propose({}, {})['status'],'HOLD')
class SharedSearch(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('bridge',Path(__file__).parents[1]/'prepare-shared-pcm-bridge.py');self.bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.bridge)
 def test_exact_shifted_stereo_passage_is_found(self):
  rng=np.random.default_rng(29);a=rng.uniform(-.2,.2,(1000,2)).astype(np.float32);b=rng.uniform(-.2,.2,(1000,2)).astype(np.float32)
  b[100:600]=a[200:700];self.assertEqual(self.bridge.shared_range(a,b,100),(200,100,500))
 def test_similar_is_not_exact(self):
  rng=np.random.default_rng(29);a=rng.uniform(-.2,.2,(1000,2)).astype(np.float32);b=a.copy();b[:,1]+=1e-5
  self.assertIsNone(self.bridge.shared_range(a,b,100))
 def test_unequal_channel_or_reverse_does_not_qualify(self):
  rng=np.random.default_rng(29);a=rng.uniform(-.2,.2,(1000,2)).astype(np.float32)
  self.assertIsNone(self.bridge.shared_range(a,a[:,::-1],100));self.assertIsNone(self.bridge.shared_range(a,a[::-1],100))
if __name__=='__main__':unittest.main()
