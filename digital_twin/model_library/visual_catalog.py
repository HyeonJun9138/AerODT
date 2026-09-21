"""Read-only render projection of the existing visual asset library."""
import json
import math
from pathlib import Path


def cockpit_profile(value):
    """Reject malformed view geometry rather than moving a camera to NaN."""
    def vector(v):
        return isinstance(v,list) and len(v)==3 and all(isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x) for x in v)
    if not isinstance(value,dict) or value.get('schema_version')!=1:
        return None
    if not all(vector(value.get(k)) for k in ('eye','forward','up')):
        return None
    if not all(sum(x*x for x in value[k])>1e-9 for k in ('forward','up')):
        return None
    screens=value.get('screens',[])
    if not isinstance(screens,list) or not screens:
        return None
    for screen in screens:
        if not isinstance(screen,dict) or not vector(screen.get('center')):
            return None
        if not all(isinstance(screen.get(k),(int,float)) and math.isfinite(screen[k]) and screen[k]>0 for k in ('width','height')):
            return None
        if not all(vector(screen[k]) for k in ('right','up') if k in screen):
            return None
    return value


def read_visual_catalog(root):
    root = Path(root).resolve()
    def safe(relative):
        path=(root/relative).resolve()
        if not path.is_relative_to(root):
            raise ValueError('Visual asset path escapes library')
        return path
    document=json.loads((root/'catalog.json').read_text(encoding='utf-8'))
    assets=[]
    for entry in document['assets']:
        if 'metadata' not in entry:
            assets.append(entry)
            continue
        path=safe(entry['metadata'])
        meta=json.loads(path.read_text(encoding='utf-8'))
        rights=meta.get('rights',{})
        if rights.get('public_export') is not True:
            continue
        model=safe(path.parent.relative_to(root)/meta['model']['path'])
        if not model.is_file():
            continue
        kind=('person' if meta['category'].startswith('people/') else
              'aircraft' if meta['category'].startswith('aircraft/') else 'satellite')
        display=meta.get('display',{})
        size=display.get('browser_measured_extent') or display.get('reference_extent_m') or (32 if kind=='aircraft' else 16)
        entry={'asset_id':meta['asset_id'],'kind':kind,
            'uri':'/visual-assets/'+model.relative_to(root).as_posix(),
            'metadata_uri':'/visual-assets/'+path.relative_to(root).as_posix(),
            'size_m':size,'temporary':False,'representative':True,
            'title':meta.get('title',meta['asset_id']),
            'attribution':'; '.join(str(rights.get(key,'')) for key in ('credit','label','url'))}
        # A flight-only rig never replaces the acquired library model. Source
        # bytes and original appearance remain available to other consumers.
        flight = meta.get('flight_visual') or {}
        if flight.get('path'):
            flight_path = safe(path.parent.relative_to(root) / flight['path'])
            if flight_path.is_file():
                # `size_m` is the size this cabin class is drawn at and
                # `measured_m` is what the rig's own geometry measures, so the
                # display can scale one shared body to each class. Without a
                # measurement nothing is scaled: the rig is drawn as authored.
                entry['flight_visual'] = {'uri': '/visual-assets/' + flight_path.relative_to(root).as_posix(),
                    'rotors': flight.get('rotors', {}), 'note': flight.get('note', ''),
                    'size_m': flight.get('display_extent_m', size)}
                if flight.get('measured_extent_m'):
                    entry['flight_visual']['measured_m'] = flight['measured_extent_m']
        cockpit=cockpit_profile(meta.get('cockpit'))
        if cockpit is not None:
            entry['cockpit']=cockpit
        # The picture the library already produced during review. Browsing the
        # inventory should not have to download and render every model.
        thumbnail=meta.get('thumbnail') or {}
        if thumbnail.get('path'):
            picture=safe(path.parent.relative_to(root)/thumbnail['path'])
            if picture.is_file():
                entry['thumbnail']='/visual-assets/'+picture.relative_to(root).as_posix()
        # Which parts of the airframe turn, for a renderer that can turn them.
        # Which node a propeller is, and which way round it goes, is a property
        # of the model; the display only spins what the library declares.
        rotors=meta.get('rotors') or {}
        if rotors.get('nodes'):
            entry['rotors']={'axis':rotors.get('axis','y'),
                'nodes':[{'name':node['name'],'turn':node.get('turn',1),
                          **({'stop_at_tilt_deg':node['stop_at_tilt_deg']}
                             if 'stop_at_tilt_deg' in node else {})}
                         for node in rotors['nodes'] if node.get('name')]}
            # A tiltrotor's ducts swing forward as it transitions. Which parts
            # swing, and about which axis, is the airframe's own geometry.
            tilt=rotors.get('tilt') or {}
            if tilt.get('nodes'):
                entry['rotors']['tilt']={'axis':tilt.get('axis','z'),
                    'sign':-1 if float(tilt.get('sign',1))<0 else 1,
                    'frame':tilt.get('frame','parent'),
                    'nodes':[name for name in tilt['nodes'] if name]}
        assets.append(entry)
    # Original fallback assets have their own procedural schema; do not overwrite
    # the acquired 86-asset inventory or pretend their metadata formats are equal.
    procedural=root/'procedural_catalog.json'
    if procedural.is_file():
        entries=json.loads(procedural.read_text(encoding='utf-8'))['assets']
        ids={a['asset_id'] for a in assets}
        assets.extend(a for a in entries if a['asset_id'] not in ids)
    return {'schema_version':1,'assets':assets}
