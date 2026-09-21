import {buildSvg} from '../../../dom_builder.js';

// Reuse bounded instrument glyph pools instead of destroying/recreating SVG
// text and paths every 100 ms. No cached flight data, only presentation nodes.
export function paintCockpitMarks(document,parent,marks){
 const pools=parent.cockpitMarkPools??=new Map(),counts=new Map(),nodes=[];
 for(const [tag,attributes] of marks){
  const index=counts.get(tag)??0;counts.set(tag,index+1);
  let pool=pools.get(tag);if(!pool){pool=[];pools.set(tag,pool);}
  const node=pool[index]??(pool[index]=buildSvg(document,tag,{}));
  for(const [key,value] of Object.entries(attributes)){
   if(key==='text'){if(node.textContent!==String(value))node.textContent=String(value);}
   else if(node.getAttribute(key)!==String(value))node.setAttribute(key,String(value));
  }
  nodes.push(node);
 }
 if(parent.children.length!==nodes.length||nodes.some((node,i)=>parent.children[i]!==node))parent.replaceChildren(...nodes);
 // Retain only a small spare allowance after a large route/traffic change.
 for(const [tag,pool] of pools)pool.length=Math.min(pool.length,(counts.get(tag)??0)+8);
}
