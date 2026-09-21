// Display only. Passenger events and time come from the operation's schedule.
export function cabinAt(record,walk,carry=0){
 const b=walk?.walk,t=Number(walk?.elapsed_s)+carry;
 if(!b?.release_s)return {seats:Array.from({length:Math.max(0,record?.on_board??0)},(_,i)=>i),open:0,side:1};
 const seats=b.release_s.flatMap((release,i)=>(walk.phase==='alighting'?t<release:t>=release+b.walk_s+b.enter_s)?[i]:[]);
 const open=Math.max(0,Math.min(1,t/2,(b.duration_s-t)/2));
 return {seats,open,side:b.door_side??1};
}

const cabinCache=new WeakMap();
export function showCabin(C,model,profile,seats,{ownSeat=null,preview=false}={}){
 if(!model?.ready||model.isDestroyed?.()||!profile?.occupant_nodes)return;
 model.aerodtCabinSeats=seats;
 const selected=new Set(seats??[]);ownSeat??=model.aerodtOwnSeat;preview=preview||model.aerodtPreview;
 let cached=cabinCache.get(model);
 if(!cached||cached.profile!==profile){cached={profile,nodes:profile.occupant_nodes.map(name=>model.getNode(name))};cabinCache.set(model,cached);}
 for(const [i,name] of profile.occupant_nodes.entries()){
  const node=cached.nodes[i];if(!node)continue;
  const shown=(preview||selected.has(i))&&name!==ownSeat;
  if(shown&&!node.aerodtSized){const scale=1/(profile.occupant_default_scale??.0001);
   node.matrix=C.Matrix4.multiplyByScale(node.originalMatrix,new C.Cartesian3(scale,scale,scale),new C.Matrix4());node.aerodtSized=true;}
  if(node.show!==shown)node.show=shown;
 }
}

export function showDoors(C,model,profile,state){
 const spec=profile?.ground_door;if(!model?.ready||!spec||model.isDestroyed?.())return;
 const key=`${state.side}:${state.open.toFixed(3)}`;if(model.aerodtDoorKey===key)return;model.aerodtDoorKey=key;
 // Index 0 is the starboard hatch. The panel hangs aft of a pivot at its
 // forward edge, so about the node's own up axis a positive angle swings that
 // free edge toward +z: outward for the starboard door, inward for the port
 // one. Hence +1 for index 0 and -1 for index 1, and why this sign has to move
 // whenever the index stops meaning the side it means here.
 for(const [i,side] of ['right','left'].entries()){
  const node=model.getNode(spec.nodes[side]);if(!node)continue;
  const angle=(state.side>0?i===0:i===1)?state.open*spec.open_deg*Math.PI/180*(i===0?1:-1):0;
  node.matrix=C.Matrix4.multiply(node.originalMatrix,C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationY(angle)),new C.Matrix4());
 }
}
