// Browser-worker transport projection only. The server's immutable wire v1 is
// unchanged; this cache never predicts, owns or modifies authoritative state.
const FIELDS = [
  ['position_ecef_m',0,3],['velocity_ecef_mps',3,3],
  ['latitude_deg',6,1],['longitude_deg',7,1],['altitude_m',8,1],
  ['heading_deg',9,1],['state_time',10,1],['observation_time',11,1],
  ['received_time',12,1],['orbit_epoch',13,1],['valid_until',14,1],
  ['discontinuity',15,1],['continuity_id',16,1],
  ['pitch_deg',17,1],['roll_deg',18,1],['tilt_deg',19,1],['rotor_radps',20,1],
];
const NUMERIC_NAMES = new Set(FIELDS.map(([name])=>name));
const STATIC_NAMES = ['entity_id','name','kind','derivation','quality','source',
  'model_id','visual_asset_id','provenance','orientation_source','visual_match','flight_phase'];
export const SNAPSHOT_STRIDE = 21;

function metadataOf(entity) {
  const metadata={};
  for(const name of Object.keys(entity)) if(!NUMERIC_NAMES.has(name)) {
    if(name==='__proto__')Object.defineProperty(metadata,name,{value:entity[name],enumerable:true,writable:true,configurable:true});
    else metadata[name]=entity[name];
  }
  return metadata;
}
function sameMetadata(record,entity) {
  const metadata=record.metadata;let count=0;
  for(const key of Object.keys(entity))if(!NUMERIC_NAMES.has(key)) {
    count++;
    if(!Object.hasOwn(metadata,key) || !(metadata[key]===entity[key] ||
      (typeof metadata[key]==='object' && typeof entity[key]==='object' && JSON.stringify(metadata[key])===JSON.stringify(entity[key]))))return false;
  }
  return count===record.keyCount;
}

export class SnapshotEncoder {
  constructor() {this.entries=new Map();this.nextHandle=1;}
  encode(snapshot) {
    const values=new Float64Array(snapshot.entities.length*SNAPSHOT_STRIDE);
    const handles=new Uint32Array(snapshot.entities.length);
    const metadata=[],nextEntries=new Map();let nextHandle=this.nextHandle,complete=true;
    for(let index=0;index<snapshot.entities.length;index++) {
      const entity=snapshot.entities[index],id=entity.entity_id,base=index*SNAPSHOT_STRIDE;
      if(typeof id!=='string' || nextEntries.has(id))throw new Error('Invalid or duplicate entity id');
      const old=this.entries.get(id);let record=old;
      if(!old || !sameMetadata(old,entity)) {
        const nextMetadata=metadataOf(entity),keyCount=Object.keys(nextMetadata).length;
        record={handle:old?.handle??nextHandle++,metadata:nextMetadata,keyCount,
          complete:keyCount===STATIC_NAMES.length+(Object.hasOwn(nextMetadata,'surface_reference')?1:0)
            && STATIC_NAMES.every(key=>Object.hasOwn(nextMetadata,key))};
      }
      if(record.handle>0xffffffff)throw new Error('Transport entity handle limit exceeded');
      if(record!==old)metadata.push([record.handle,record.metadata]);
      nextEntries.set(id,record);handles[index]=record.handle;complete &&= record.complete;
      for(const [name,offset,width] of FIELDS) {
        const value=entity[name];
        // JSON has neither NaN nor Infinity. Distinct sentinels retain null and
        // missing fields without losing the precision of any finite value.
        if(value===undefined || value===null) {
          values.fill(value===null?NaN:Infinity,base+offset,base+offset+width);
          if(value===undefined)complete=false;
        } else if(width===3) {
          if(!Array.isArray(value) || value.length!==3 || !value.every(Number.isFinite))throw new Error('Invalid numeric vector');
          values[base+offset]=value[0];values[base+offset+1]=value[1];values[base+offset+2]=value[2];
        } else if(name==='discontinuity') {
          if(typeof value!=='boolean')throw new Error('Invalid discontinuity flag');
          values[base+offset]=value?1:0;
        } else {
          if(!Number.isFinite(value))throw new Error('Invalid numeric field');
          values[base+offset]=value;
        }
      }
    }
    const removed=[];for(const [id,record] of this.entries)if(!nextEntries.has(id))removed.push(record.handle);
    const header={...snapshot};delete header.entities;
    // Commit only after the entire input validated. A bad packet must not make
    // the next valid frame omit metadata that was never delivered.
    this.entries=nextEntries;this.nextHandle=nextHandle;
    return {transport_version:1,header,values,handles,metadata,removed:Uint32Array.from(removed),complete};
  }
}

const nullable = value => Number.isNaN(value)?null:value;
const vector = (values,offset) => Number.isNaN(values[offset])?null:[values[offset],values[offset+1],values[offset+2]];
function fullEntity(m,v,o) {
  // A stable object shape avoids repeatedly spreading ten fields and adding
  // thirteen properties on the main thread for every entity, every second.
  const entity={entity_id:m.entity_id,name:m.name,kind:m.kind,
    position_ecef_m:vector(v,o),velocity_ecef_mps:vector(v,o+3),
    latitude_deg:nullable(v[o+6]),longitude_deg:nullable(v[o+7]),altitude_m:nullable(v[o+8]),
    heading_deg:nullable(v[o+9]),state_time:nullable(v[o+10]),observation_time:nullable(v[o+11]),
    received_time:nullable(v[o+12]),orbit_epoch:nullable(v[o+13]),
    derivation:m.derivation,quality:m.quality,source:m.source,model_id:m.model_id,
    visual_asset_id:m.visual_asset_id,provenance:m.provenance,orientation_source:m.orientation_source,
    visual_match:m.visual_match,flight_phase:m.flight_phase,
    pitch_deg:nullable(v[o+17]),roll_deg:nullable(v[o+18]),tilt_deg:nullable(v[o+19]),rotor_radps:nullable(v[o+20]),
    valid_until:nullable(v[o+14]),discontinuity:Number.isNaN(v[o+15])?null:Boolean(v[o+15]),continuity_id:nullable(v[o+16])};
  // Optional v1 datum; retain the fast path for both old and new senders.
  // Never discard it, and never turn the entire frame into the generic spread
  // path just because current senders include null for non-scenario objects.
  if(Object.hasOwn(m,'surface_reference'))entity.surface_reference=m.surface_reference;
  return entity;
}
export class SnapshotDecoder {
  constructor() {this.metadata=new Map();}
  decode(frame) {
    const {values,handles}=frame;
    if(frame.transport_version!==1 || !(values instanceof Float64Array) || !(handles instanceof Uint32Array) ||
      values.length!==handles.length*SNAPSHOT_STRIDE)throw new Error('Invalid worker snapshot frame');
    for(const handle of frame.removed)this.metadata.delete(handle);
    for(const [handle,metadata] of frame.metadata)this.metadata.set(handle,metadata);
    const entities=new Array(handles.length);
    for(let index=0;index<handles.length;index++) {
      const metadata=this.metadata.get(handles[index]),base=index*SNAPSHOT_STRIDE;
      if(!metadata)throw new Error('Missing entity metadata');
      if(frame.complete)entities[index]=fullEntity(metadata,values,base);
      else {
        const entity={...metadata};
        for(const [name,offset,width] of FIELDS) {
          const value=values[base+offset];if(value===Infinity)continue;
          entity[name]=width===3?vector(values,base+offset):Number.isNaN(value)?null:name==='discontinuity'?Boolean(value):value;
        }
        entities[index]=entity;
      }
    }
    // Fresh entities and vectors are deliberate: DisplaySamples still reads the
    // preceding snapshot while calculating interpolation and continuity resets.
    return {...frame.header,entities};
  }
}
export function snapshotTransferables(frame) {return [frame.values.buffer,frame.handles.buffer,frame.removed.buffer];}
