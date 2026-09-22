// The flown track is fetched whole every few seconds; the points already
// converted under the same surface references are kept, and only the new tail
// is converted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {FlightTrackLayer} from '../../../../digital_twin/visualization/web/flight_track_layer.js';

function fixture({maximumPoints=900}={}){
 const converted=[];
 const offsets=[];
 const C={
  PolylineCollection:class{constructor(){this.items=[];}add(p){this.items.push(p);return p;}remove(){return true;}},
  Cartesian3:{fromDegrees:(lon,lat,alt)=>{const p={lon,lat,alt};converted.push(p);return p;}},
  Cartographic:{fromDegrees:(lon,lat,alt)=>({longitude:lon,latitude:lat,height:alt})},
  Color:{fromCssColorString:()=>({withAlpha(){return {};}}),BLACK:{withAlpha(){return {};}}},
  Material:{fromType:()=>({})},
 };
 const viewer={scene:{primitives:{add:p=>p,remove:()=>true},requestRender(){}}};
 const layer=new FlightTrackLayer(C,viewer,{load:async()=>null,maximumPoints,surfaceOffset:(reference,cartographic)=>{offsets.push(reference.vertiport_id);return reference.altitude_m*.001;}});
 return {layer,converted,offsets};
}
const rows=(n,start=0)=>Array.from({length:n},(_,i)=>[127+(start+i)*1e-4,37.5+(start+i)*1e-4,300+(start+i),start+i]);

test('a longer answer with the same beginning converts only what was added',()=>{
 const f=fixture();
 const references={origin:{vertiport_id:'VP1',altitude_m:12}};
 const first=f.layer.positions(rows(500),references);
 assert.equal(first.length,500);
 assert.equal(f.converted.length,500);
 const second=f.layer.positions(rows(520),references);
 assert.equal(second.length,520);
 assert.equal(f.converted.length,520,'twenty new points were converted, not 520');
 for(let i=0;i<500;i++)assert.equal(second[i],first[i],'the same Cartesian objects as before');
 assert.equal(f.offsets.length,520,'one surface correction per point per reference, as before');
 assert.notEqual(second,first,'a new array each time');
});

test('a changed point, a changed reference or a thinned track is converted afresh',()=>{
 const f=fixture();
 const references={origin:{vertiport_id:'VP1',altitude_m:12}};
 f.layer.positions(rows(100),references);
 const edited=rows(100);edited[40][2]+=1;
 const again=f.layer.positions(edited,references);
 assert.equal(f.converted.length,160,'the forty points before the edit were kept; the rest were made again');
 assert.ok(Math.abs(again[39].alt-(339+.012))<1e-9,'the kept point carries its surface correction: '+again[39].alt);
 assert.ok(Math.abs(again[40].alt-(341+.012))<1e-9,'the edited point was converted afresh: '+again[40].alt);
 f.layer.positions(rows(100),{origin:{vertiport_id:'VP1',altitude_m:13}});
 assert.equal(f.converted.length,260,'another reference is another conversion of every point');
 const thin=fixture({maximumPoints:50});
 thin.layer.positions(rows(120),null);
 const before=thin.converted.length;
 thin.layer.positions(rows(120),null);
 assert.equal(thin.converted.length,before*2,'a thinned track is not kept: its indices move with its length');
});

test('an invalid row still fails the whole answer, whatever was kept',()=>{
 const f=fixture();
 f.layer.positions(rows(10),null);
 const broken=rows(12);broken[11]=[127,'x',3,11];
 assert.equal(f.layer.positions(broken,null),null);
 const nan=rows(12);nan[11][1]=NaN;
 assert.equal(f.layer.positions(nan,null),null);
 assert.equal(f.layer.positions(rows(12),null).length,12);
});
