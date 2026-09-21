import json
from pathlib import Path
from digital_twin.live_twin.model_setup import load_definitions, select_model

def test_real_aircraft_asset_is_selected_instead_of_placeholder():
    _, asset_id = select_model('aircraft', load_definitions())
    assert asset_id == 'amvlab_a320'
    root = Path(__file__).resolve().parents[3] / 'digital_twin/model_library/visual_assets'
    from digital_twin.model_library.visual_catalog import read_visual_catalog
    catalog = read_visual_catalog(root)
    entry = next(a for a in catalog['assets'] if a['asset_id'] == asset_id)
    assert (root / entry['uri'].removeprefix('/visual-assets/')).is_file()
    assert 'CC-BY-4.0' in entry['attribution']
    assert entry['representative'] is True
