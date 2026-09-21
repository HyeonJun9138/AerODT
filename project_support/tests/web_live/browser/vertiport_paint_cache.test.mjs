import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PAINT,paintApron,rotateLayout,apronSignature,cachedApron,APRON_CACHE_LIMIT} from '../../../../digital_twin/visualization/web/vertiport_paint.js';

const layout={
 schema_version:2,pattern:'row',frame:{latitude:37.5,longitude:127,altitude_m:null,heading_deg:0},
 dimensions:{vehicle_d_m:12,fato_radius_m:9,gate_radius_m:7.2,taxiway_width_m:8.4,charger_size_m:2.376,charger_height_m:2.64},
 platform:{corners_m:[[-40,-30],[40,-30],[40,30],[-40,30]],height_m:1,size_m:[80,60]},
 name_area:{center_m:[0,26],along:'x',length_m:70,height_m:4.8,strip_m:7.8},
 fatos:[{id:'F1',role:'takeoff',marking:'F',center_m:[-18,15],radius_m:9,tlof_radius_m:4.98},{id:'F2',role:'landing',marking:'F',center_m:[18,15],radius_m:9,tlof_radius_m:4.98}],
 gates:[{id:'G1',marking:'G1',center_m:[-10,-15],radius_m:7.2},{id:'G2',marking:'G2',center_m:[10,-15],radius_m:7.2}],
 chargers:[{id:'C1',gate:'G1',center_m:[-10,-26.38],radius_m:1.68}],
 edges:[{id:'E1',from:'G1',to:'J1',kind:'stand',width_m:8.4,points_m:[[-10,-15],[-10,0]]}],
 boarding_points:[{id:'B1',gate:'G1',charger:'C1',center_m:[-4.5,-26.38],size_m:[3.6,2.6],height_m:2.8,along:'x'}],
};
// A recording 2D context, like the one the vertiport tests use, plus the
// pattern API a browser canvas has. `patterns` counts what was tiled.
class RecordingContext {
 constructor({patterns=true}={}){this.ops=[];this.fillStyle='';this.strokeStyle='';this.lineWidth=1;this.font='';this.dash=[];this.patterned=0;if(!patterns)this.createPattern=undefined;}
 record(op,...args){this.ops.push({op,args,fill:this.fillStyle,stroke:this.strokeStyle,width:this.lineWidth});}
 fillRect(...a){this.record('fillRect',...a);} strokeRect(...a){this.record('strokeRect',...a);}
 beginPath(){} closePath(){} moveTo(...a){this.record('moveTo',...a);} lineTo(...a){this.record('lineTo',...a);}
 arc(...a){this.record('arc',...a);} stroke(){this.record('stroke');} fill(){this.record('fill');}
 setLineDash(d){this.dash=d;} fillText(...a){this.record('fillText',...a);}
 measureText(t){return {width:t.length*6};}
 save(){} restore(){} translate(){} rotate(){} setTransform(){} clearRect(){} clip(){} drawImage(...a){this.record('drawImage',...a);}
 createPattern(image,repeat){this.patterned++;return {pattern:true,image,repeat};}
}
const canvasFactory=options=>(width,height)=>{const ctx=new RecordingContext(options);return {width,height,ctx,getContext:()=>ctx};};

test('the signature names the design, not the object or the heading it happens to be turned to',()=>{
 const base=apronSignature(layout,'허브');
 assert.equal(apronSignature(rotateLayout(layout,37),'허브'),base,'a heading is a display transform of the same paint');
 assert.equal(apronSignature(JSON.parse(JSON.stringify(layout)),'허브'),base,'a server answer with the same design is the same paint');
 assert.notEqual(apronSignature(layout,'다른 이름'),base,'the name is painted on the strip');
 const moved={...layout,gates:[{...layout.gates[0],center_m:[-12,-15]},layout.gates[1]]};
 assert.notEqual(apronSignature(moved,'허브'),base);
 assert.notEqual(apronSignature({...layout,platform:{...layout.platform,corner_radius_m:30}},'허브'),base,'the rounded edge is painted');
 assert.notEqual(apronSignature({...layout,frame:{...layout.frame,latitude:38}},'허브'),undefined);
 assert.equal(apronSignature({...layout,frame:{...layout.frame,latitude:38}},'허브'),base,'where it stands is not what it looks like');
});

// The painter also asks for small tiles for its patterns; a deck is the canvas
// larger than a tile.
const deckCounter=()=>{const state={paints:0};state.createCanvas=(w,h)=>{if(w>256||h>256)state.paints++;return canvasFactory()(w,h);};return state;};

test('a painting is made once per design and handed back for every turned or re-received copy',()=>{
 const counter=deckCounter(),createCanvas=counter.createCanvas;
 const first=cachedApron(layout,'허브',createCanvas);
 assert.ok(first?.canvas,'painted');
 assert.equal(cachedApron(rotateLayout(layout,90),'허브',createCanvas),first,'the heading slider does not repaint');
 assert.equal(cachedApron(JSON.parse(JSON.stringify(layout)),'허브',createCanvas),first,'a fresh layout object does not repaint');
 assert.equal(counter.paints,1);
 const renamed=cachedApron(layout,'새 이름',createCanvas);
 assert.notEqual(renamed,first);assert.equal(counter.paints,2);
 assert.notEqual(cachedApron(layout,'허브',createCanvas,{maxPixels:640}),first,'the thumbnail size is its own painting');
 assert.equal(cachedApron(layout,'허브',canvasFactory()),first,'the cache is shared by every layer that paints with a browser canvas');
});

test('the cache is bounded and the oldest design goes first',()=>{
 const counter=deckCounter(),createCanvas=counter.createCanvas;
 const named=index=>cachedApron(layout,`bound-${index}`,createCanvas);
 const oldest=named(0);
 for(let index=1;index<=APRON_CACHE_LIMIT;index++)named(index);
 const before=counter.paints;
 assert.notEqual(named(0),oldest,'pushed out by the ones after it');
 assert.equal(counter.paints,before+1);
 assert.ok(APRON_CACHE_LIMIT>=24,'every deck of a metropolitan network stays painted');
});

test('speckle and asphalt grain are tiled patterns where a canvas can tile, and the old dots where it cannot',()=>{
 const tiled=paintApron(layout,'허브',canvasFactory());
 const ctx=tiled.canvas.ctx;
 assert.ok(ctx.patterned>=2,'one pattern for the concrete, one for the aggregate');
 const rects=ctx.ops.filter(o=>o.op==='fillRect');
 assert.ok(rects.length<2000,`a few hundred rects, not seventy thousand: ${rects.length}`);
 assert.equal(rects[0].fill,PAINT.deck,'the deck is still painted first');
 assert.ok(rects.some(o=>o.fill?.pattern),'the concrete pattern is laid over it');
 const plain=paintApron(layout,'허브',canvasFactory({patterns:false}));
 assert.ok(plain.canvas.ctx.ops.filter(o=>o.op==='fillRect').length>10000,'without createPattern the dots are painted one by one as before');
});

test('the layer and the thumbnail paint through the shared cache',()=>{
 const layer=readFileSync(new URL('../../../../digital_twin/visualization/web/vertiport_layer.js',import.meta.url),'utf8');
 assert.match(layer,/cachedApron\(layout,\s*record\.name\s*\?\?\s*'',\s*this\.createCanvas\)/);
 const thumbnail=readFileSync(new URL('../../../../digital_twin/visualization/web/vertiport_thumbnail.js',import.meta.url),'utf8');
 assert.match(thumbnail,/cachedApron\(layout,\s*name\s*\?\?\s*'',\s*createCanvas,\s*\{maxPixels:\s*DECK_PIXELS\}\)/);
});
