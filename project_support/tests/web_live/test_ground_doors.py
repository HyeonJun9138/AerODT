"""Closed hatch geometry must preserve the original aircraft size and surface."""
import json
import re
import sys
import unittest
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'project_support/tools/visual_assets'))
from build_ground_doors import HATCHES,matrix
from split_rotor_nodes import read_glb,read_accessor

def metrics(path):
    doc,data=read_glb(path);lo=np.full(3,np.inf);hi=-lo.copy();area=0.
    def visit(index,parent):
        nonlocal lo,hi,area
        node=doc['nodes'][index];transform=parent@matrix(node)
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                if primitive.get('mode',4)!=4:continue
                pos=np.asarray(read_accessor(doc,data,primitive['attributes']['POSITION']))
                pos=(np.c_[pos,np.ones(len(pos))]@transform.T)[:,:3]
                ids=np.asarray(read_accessor(doc,data,primitive['indices'])).astype(int).reshape(-1,3) if 'indices' in primitive else np.arange(len(pos)).reshape(-1,3)
                if not len(ids):continue
                tri=pos[ids];lo=np.minimum(lo,tri.min(axis=(0,1)));hi=np.maximum(hi,tri.max(axis=(0,1)))
                area+=np.linalg.norm(np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]),axis=1).sum()/2
        for child in node.get('children',[]):visit(child,transform)
    for index in doc['scenes'][doc.get('scene',0)]['nodes']:visit(index,np.eye(4))
    return doc,np.r_[lo,hi],area

class GroundDoorGeometryTests(unittest.TestCase):
    def test_closed_airframes_keep_size_surface_and_original_animation_rig(self):
        for aid in HATCHES:
            with self.subTest(aircraft=aid):
                folder=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'/aid
                original,bounds,area=metrics(folder/'flight_model.glb');derived,after,newarea=metrics(folder/'turnaround_model.glb')
                np.testing.assert_allclose(bounds,after,atol=2e-5)
                self.assertAlmostEqual(newarea/area,1,places=5)
                self.assertEqual(original.get('animations',[]),derived.get('animations',[]))
                names={n.get('name') for n in derived['nodes']}
                self.assertTrue({'Ground_door_left','Ground_door_right'}<=names)
                self.assertTrue({n.get('name') for n in original['nodes']}<=names)


# Which glTF axis is starboard, answered by the model rather than by a
# convention argument. The original authors named nodes L and R - navigation
# position lights above all, which are port and starboard by definition - so
# reading where those sit settles it for each rig on its own terms.
SIDE_SUFFIX = re.compile(r"_(?:CW_|CCW_|F|R|front_)?(L|R)$")

# +z. Derived, not assumed: test_the_rigs_agree_on_which_side_is_starboard
# checks it against every rig whose author wrote the side into a node name.
STARBOARD_Z = 1


def placements(path):
    """Every node's accumulated translation, by name."""
    doc, data = read_glb(path)
    out = {}

    def visit(index, parent):
        node = doc['nodes'][index]
        here = parent @ matrix(node)
        name = node.get('name')
        if name and name not in out:
            out[name] = here[:3, 3]
        for child in node.get('children', []):
            visit(child, here)

    for index in doc['scenes'][doc.get('scene', 0)]['nodes']:
        visit(index, np.eye(4))
    return out


def starboard_sign(place):
    """+1 if the airframe's right is +z, -1 if it is -z, from author-named nodes."""
    votes = []
    for name, position in place.items():
        found = SIDE_SUFFIX.search(name)
        if found and abs(position[2]) > 1e-3:
            votes.append(position[2] if found.group(1) == 'R' else -position[2])
    return (1 if sum(votes) > 0 else -1) if votes else 0


class GroundDoorSideTests(unittest.TestCase):
    """The door that opens must be the one the passengers walk to.

    `passenger_boarding.prepare` puts the walk on the airframe's starboard side
    when `door_side` is +1, and `showDoors` opens `ground_door.nodes['right']`
    for that same +1. Those two agree only while that key names the node that is
    physically on the right. It did not: `build_ground_doors` named the
    negative-z hatch 'right', while every node the original authors named puts L
    at negative z - so the door swung open on the side opposite the stairs and
    the queue.
    """

    def doors(self):
        root = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian'
        for folder in sorted(p for p in root.iterdir() if (p / 'asset.json').is_file()):
            meta = json.loads((folder / 'asset.json').read_text(encoding='utf-8'))
            spec = meta.get('cockpit', {}).get('ground_door')
            if spec:
                yield folder.name, spec, folder / (meta.get('flight_visual', {}).get('path')
                                                  or meta['model']['path'])

    def test_the_rigs_agree_on_which_side_is_starboard(self):
        # Only some rigs carry author-named L/R nodes, so the frame is read from
        # those and then applied to the rest: every rig is loaded the same way
        # (forwardAxis X, upAxis Y), so they share one frame. If two rigs ever
        # disagree, nothing below can be trusted and this says so first.
        named = {}
        for aircraft, _spec, rig in self.doors():
            sign = starboard_sign(placements(rig))
            if sign:
                named[aircraft] = sign
        self.assertTrue(named, 'no rig carries a node its author named L or R')
        self.assertEqual(set(named.values()), {STARBOARD_Z},
                         f'rigs disagree on the starboard axis: {named}')

    def test_the_hatch_named_right_is_the_one_on_the_aircraft_s_right(self):
        checked = 0
        for aircraft, spec, rig in self.doors():
            with self.subTest(aircraft=aircraft, rig=rig.name):
                place = placements(rig)
                for key, wanted in (('right', STARBOARD_Z), ('left', -STARBOARD_Z)):
                    name = spec['nodes'][key]
                    self.assertIn(name, place, f'{key} hatch node missing from the rig')
                    z = place[name][2]
                    self.assertGreater(z * wanted, 0,
                        f"ground_door.nodes['{key}'] is {name} at z={z:+.3f}, on the "
                        f"{'starboard' if z * STARBOARD_Z > 0 else 'port'} side")
                checked += 1
        self.assertGreater(checked, 0, 'no aircraft carried a ground door')

if __name__=='__main__':unittest.main()
