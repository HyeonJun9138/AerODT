// Browser-local form preferences, never a saved simulation or server state.
const KEY='aerodt.uam.demand_preferences.v1';
const fields=['scope','excluded','broken','demand','weights','operating','seed','fleet','manual','schedule_planning'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function selected(state){return Object.fromEntries(fields.filter(k=>state[k]!==undefined).map(k=>[k,state[k]]));}
export function installDemandPreferences(panel,defaults,storage){
 try{storage??=globalThis.localStorage;}catch{}
 let state=defaults;
 try{
  const saved=JSON.parse(storage?.getItem(KEY)??'null');
  if(saved?.version===1&&object(saved.values)){
   for(const key of fields){
    const value=saved.values[key];
    if(['scope','excluded','broken'].includes(key)){
     if(Array.isArray(value)&&value.every(x=>typeof x==='string'))state={...state,[key]:value};
    }else if(object(value))state={...state,[key]:{...(defaults[key]??{}),...value}};
   }
  }
 }catch{/* Malformed/blocked storage must not prevent opening the planner. */}
 let previous=JSON.stringify(selected(state));
 Object.defineProperty(panel,'state',{configurable:true,enumerable:true,get:()=>state,set:next=>{
  state=next;
  try{
   const values=selected(next),serialized=JSON.stringify(values);
   if(serialized===previous)return;
   storage?.setItem(KEY,JSON.stringify({version:1,values}));previous=serialized;
  }catch{/* The current form remains usable when storage is unavailable. */}
 }});
}
