import os
os.environ.setdefault('NUMBA_CACHE_DIR','/tmp/vdj-independent-numba')
import importlib.util,unittest
from pathlib import Path
import numpy as np
ROOT=Path(__file__).parent

def module(name,file):
 s=importlib.util.spec_from_file_location(name,ROOT/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
analysis=module('analysis','independent-musical-evidence.py');audition=module('audition','prepare-independent-audition.py')

class EvidenceTests(unittest.TestCase):
 def test_agreement_measures_errors_not_probability(self):
  good=analysis.agreement([1,2,3],[1.02,2.02,3.02]);bad=analysis.agreement([1,2,3],[1.2,2.2,3.2]);self.assertEqual(good['referenceCoverage'],1);self.assertEqual(bad['referenceCoverage'],0);self.assertAlmostEqual(bad['medianErrorSeconds'],.2)
 def test_empty_track_has_no_false_agreement(self):
  self.assertEqual(analysis.agreement([],[])['referenceCoverage'],0)
 def test_constant_texture_has_no_novelty(self):
  data=np.ones((3,50));n=analysis.novelty(data,4);self.assertLess(np.nanmax(n),1e-12);self.assertTrue(np.isnan(n[:4]).all());self.assertTrue(np.isnan(n[-4:]).all())
 def test_real_feature_change_peak_is_not_assumed_bar(self):
  data=np.zeros((2,50));data[0,:25]=1;data[1,25:]=1;n=analysis.novelty(data,4);self.assertEqual(np.nanargmax(n),25)
 def test_novelty_large_finite_values_remain_bounded(self):
  n=analysis.novelty(np.full((3,50),1e300),4);self.assertTrue(np.isfinite(n[4:-4]).all());self.assertLess(np.nanmax(n),1e-10)
 def test_novelty_rejects_nan_instead_of_inventing_boundaries(self):
  with self.assertRaises(ValueError):analysis.novelty(np.full((3,50),np.nan),4)
 def test_nonoverlap_taper_preserves_all_other_source_frames(self):
  a=np.full((100,2),.2);b=np.full((120,2),-.1);x=audition.nonoverlap(a,b,80,20,10)
  self.assertEqual(x.shape,(180,2));np.testing.assert_array_equal(x[:70],a[:70]);np.testing.assert_array_equal(x[90:],b[30:]);self.assertLess(abs(x[79]).max(),1e-12);self.assertEqual(abs(x[80]).max(),0);self.assertLessEqual(abs(x).max(),.2)
 def test_nonoverlap_rejects_invalid_geometry_and_nonfinite(self):
  a=np.ones((20,2));b=a.copy()
  for o,e,n in [(0,0,2),(30,0,2),(10,21,2),(10,1,500)]:
   with self.assertRaises(ValueError):audition.nonoverlap(a,b,o,e,n)
  b[0,0]=np.nan
  with self.assertRaises(ValueError):audition.nonoverlap(a,b,10,0,2)
 def test_phase_checks_do_not_borrow_neural_success_for_independent_method(self):
  times=np.arange(0,4,.4).tolist()
  def row(shift):return {'beatThisRepeatability':[{'condition':c,'beatSeconds':times} for c in ['original','gain-minus6db','crop137ms']], 'independentDynamicProgramming':[{'input':c,'startBpmPrior':120,'beatSeconds':(np.array(times)+shift).tolist()} for c in ['full','percussive']]}
  r=audition.phase_checks(row(0),row(.15),2,2,.8,.4);self.assertTrue(all(x['withinExistingPhaseTolerance'] for x in r[:3]));self.assertFalse(any(x['withinExistingPhaseTolerance'] for x in r[3:]))
 def test_cqt_pitch_class_mapping_on_known_triad(self):
  sr=44100;t=np.arange(4*sr)/sr;y=sum(np.sin(2*np.pi*f*t) for f in [146.8323839587,184.9972113558,220.])/6
  r=audition.local_tonal(np.stack([y,y],axis=1),sr,1,3);top=set(np.argsort(r['pitchClassMass']['cqt'])[-3:]);self.assertEqual(top,{2,6,9});self.assertFalse(r['harmonicSafetyVerified'])
if __name__=='__main__':unittest.main()
