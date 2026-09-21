import unittest,math
from communication.python.manual_runtime import ManualRuntime
from user_application.uam_mission.manual_surfaces import contact_decks

class SurfaceTests(unittest.TestCase):
 def test_elevated_deck_catches_descent_and_stays_grounded(self):
  m=ManualRuntime()
  try:
   for _ in range(220):s=m.step(.36)
   self.assertLess(s[3],-25)
   m.deck([(-500,-500),(500,-500),(500,500),(-500,500)],-20)
   for _ in range(1200):s=m.step(0)
   self.assertAlmostEqual(s[3],-20,places=2);self.assertLess(math.hypot(*s[4:7]),.01)
   for _ in range(20):s=m.step(0)
   self.assertAlmostEqual(s[3],-20,places=2)
  finally:m.close()
 def test_lower_terrain_replaces_departure_infinite_plane(self):
  m=ManualRuntime()
  try:
   for _ in range(100):m.step(.36)
   m.surface(30)
   for _ in range(1200):s=m.step(0)
   self.assertAlmostEqual(s[3],30,places=2)
  finally:m.close()
 def test_deck_outside_footprint_or_overhead_does_not_snap_vehicle(self):
  for points in [[(100,100),(200,100),(200,200),(100,200)],[(-20,-20),(20,-20),(20,20),(-20,20)]]:
   m=ManualRuntime()
   try:
    m.deck(points,-20)
    for _ in range(20):s=m.step(0)
    self.assertAlmostEqual(s[3],0,places=3)
   finally:m.close()
 def test_invalid_scene_geometry_rejected(self):
  for d in [None,[{'height_m':float('nan'),'outline':[]}],[{'height_m':80,'outline':[[127,37]]*3}]]:
   with self.assertRaises(ValueError):contact_decks(d,[127,37,80])
 def test_height_coordinate_contract(self):
  d=contact_decks([{'height_m':100,'outline':[[127,37],[127.001,37],[127,37.001]]}],[127,37,80])
  self.assertEqual(d[0][1],-20);self.assertGreater(d[0][0][1][1],80);self.assertGreater(d[0][0][2][0],100)

if __name__=='__main__':unittest.main()
