
"""Check authored model transforms, not just the sign of animation commands."""
import json
from pathlib import Path
import numpy as np
import pytest
from project_support.tools.visual_assets.split_rotor_nodes import read_glb, read_accessor

ROOT=Path(__file__).resolve().parents[3]

@pytest.mark.parametrize('identifier',['joby_s4','kp2a','amvlab_evtol'])
def test_control_surface_motion_in_airframe_coordinates(identifier):
    base=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'/identifier
    meta=json.loads((base/'asset.json').read_text(encoding='utf-8'))
    doc,binary=read_glb(base/meta['flight_visual']['path'])
    parents={child:i for i,node in enumerate(doc['nodes']) for child in node.get('children',[])}
    def matrix(node):
        if 'matrix' in node:return np.array(node['matrix']).reshape(4,4).T
        x,y,z,w=node.get('rotation',[0,0,0,1])
        m=np.eye(4)
        m[:3,:3]=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],
            [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],
            [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])@np.diag(node.get('scale',[1,1,1]))
        m[:3,3]=node.get('translation',[0,0,0]);return m
    def world(i):
        return (world(parents[i]) if i in parents else np.eye(4))@matrix(doc['nodes'][i])
    checked={'roll':0,'pitch':0,'yaw':0}
    for surface in meta['flight_visual']['rotors']['control_surfaces']['nodes']:
        i=next(i for i,n in enumerate(doc['nodes']) if n.get('name')==surface['name'])
        node=doc['nodes'][i];primitive=doc['meshes'][node['mesh']]['primitives'][0]
        centroid=np.array(read_accessor(doc,binary,primitive['attributes']['POSITION'])).mean(axis=0)
        axis=np.array(surface['axis']);axis/=np.linalg.norm(axis)
        parent=world(parents[i]) if i in parents else np.eye(4)
        centre=world(i)@np.r_[centroid,1]
        for channel,weight in surface['mix'].items():
            # Infinitesimal positive command, transformed to +X forward,
            # +Y up, +Z right. This catches a mirrored source export.
            delta=parent[:3,:3]@np.cross(axis,centroid)*weight
            assert np.isfinite(delta).all()
            if channel=='roll':assert centre[2]*delta[1]>0,(identifier,surface['name'],delta)
            if channel=='pitch':assert delta[1]>0,(identifier,surface['name'],delta)
            if channel=='yaw':assert delta[2]>0,(identifier,surface['name'],delta)
            checked[channel]+=1
    assert checked['roll']>=2 and checked['pitch']==2 and checked['yaw']==2
