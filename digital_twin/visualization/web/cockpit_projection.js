// A projective map keeps HTML instruments on their actual GLB screen corners.
const finiteVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const positive=v=>Number.isFinite(v)&&v>0;
export function screenCorners(s){
 if(!s||!finiteVector(s.center,3)||!positive(s.width)||!positive(s.height))return null;
 const r=s.right??[0,0,1],u=s.up??[0,1,0];
 if(!finiteVector(r,3)||!finiteVector(u,3)||Math.abs(Math.hypot(...r)-1)>1e-5||
  Math.abs(Math.hypot(...u)-1)>1e-5||Math.abs(r.reduce((n,v,i)=>n+v*u[i],0))>1e-5)return null;
 const corners=[[-1,1],[1,1],[1,-1],[-1,-1]].map(([a,b])=>s.center.map((v,i)=>v+a*r[i]*s.width/2+b*u[i]*s.height/2));
 return corners.every(p=>finiteVector(p,3))?corners:null;
}
export function screenTransform(points,width,height){
 if(!Array.isArray(points)||points.length!==4||!points.every(p=>finiteVector(p,2))||
  !positive(width)||!positive(height))return null;
 // A clipped/behind-camera quad must be rejected by the caller before this
 // 2D step. Here reject folds and subpixel edge-on surfaces, not their winding:
 // the world-space screen normal (not CSS winding) decides front/back visibility.
 const edges=points.map((p,i)=>[points[(i+1)%4][0]-p[0],points[(i+1)%4][1]-p[1]]);
 const lengths=edges.map(e=>Math.hypot(...e));
 if(lengths.some(n=>!Number.isFinite(n)||n<0.5))return null;
 const turns=edges.map((e,i)=>e[0]*edges[(i+1)%4][1]-e[1]*edges[(i+1)%4][0]);
 if(turns.some(t=>!Number.isFinite(t)||Math.abs(t)<1e-7)||
  !turns.every(t=>Math.sign(t)===Math.sign(turns[0])))return null;
 const local=points.map(p=>[p[0]-points[0][0],p[1]-points[0][1]]);
 const area=Math.abs(local.reduce((a,p,i)=>a+p[0]*local[(i+1)%4][1]-p[1]*local[(i+1)%4][0],0))/2;
 if(!Number.isFinite(area)||area<1||area/Math.max(...lengths)<0.25)return null;
 const source=[[0,0],[width,0],[width,height],[0,height]],a=[];
 for(let i=0;i<4;i++){const [x,y]=source[i],[u,v]=points[i];a.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);}
 for(let col=0;col<8;col++){
  let row=col;for(let j=col+1;j<8;j++)if(Math.abs(a[j][col])>Math.abs(a[row][col]))row=j;
  if(Math.abs(a[row][col])<1e-9)return null;
  [a[col],a[row]]=[a[row],a[col]];const n=a[col][col];for(let j=col;j<9;j++)a[col][j]/=n;
  for(let k=0;k<8;k++)if(k!==col){const m=a[k][col];for(let j=col;j<9;j++)a[k][j]-=m*a[col][j];}
 }
 const h=a.map(row=>row[8]);
 if(!h.every(Number.isFinite))return null;
 // The denominator is affine, so positive values at every rectangle corner
 // guarantee that no point inside the HTML plane crosses projective infinity.
 if(source.some(([x,y])=>{const w=h[6]*x+h[7]*y+1;return !Number.isFinite(w)||w<=1e-7;}))return null;
 return [h[0],h[3],0,h[6],h[1],h[4],0,h[7],0,0,1,0,h[2],h[5],0,1];
}
