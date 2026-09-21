import test from 'node:test';import assert from 'node:assert/strict';
import {loadCockpitProfiles} from '../../../../user_application/web/domains/uam/cockpit/cockpit_profiles.js';
test('older catalog uses only bounded local UAM metadata; failed optional profile does not break startup',async()=>{
 const assets=[{asset_id:'joby_s4',metadata_uri:'/visual-assets/joby/asset.json'},{asset_id:'kp2a',metadata_uri:'https://external.test/x'},{asset_id:'airliner',metadata_uri:'/visual-assets/a.json'}];let calls=0;
 await loadCockpitProfiles({assets},async()=>{calls++;return {cockpit:{schema_version:1,eye:[1,2,3],forward:[1,0,0],up:[0,1,0],screens:[]}};});assert.equal(calls,1);assert.ok(assets[0].cockpit);assert.equal(assets[1].cockpit,undefined);
 await loadCockpitProfiles({assets:[{asset_id:'x_57',metadata_uri:'/visual-assets/x.json'}]},async()=>{throw new Error('offline');});
});

test('refined cabins refresh asset hash even when an older cockpit profile is present',async()=>{
 const profile={schema_version:1,eye:[1,2,3],forward:[1,0,0],up:[0,1,0],screens:[],viewpoints:[{}]};
 const asset={asset_id:'kp2a',metadata_uri:'/visual-assets/kp2a/asset.json',cockpit:profile,flight_visual:{uri:'/visual-assets/kp2a/flight_model.glb?v=old'}};
 const hash='a'.repeat(64);
 await loadCockpitProfiles({assets:[asset]},async()=>({cockpit:profile,flight_visual:{sha256:hash}}));
 assert.equal(asset.flight_visual.uri,'/visual-assets/kp2a/flight_model.glb?v='+hash);
});
