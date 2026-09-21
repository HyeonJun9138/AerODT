// A display-only, sparse high cloud layer. This is not a weather observation.
// One screen pass, no ray marching or reflection probes. Shadows are bounded
// to the first 220 metres and restored when leaving the cockpit.
// Coordinates are earth-fixed, so clouds do not turn with the pilot's head.
export const CLOUD_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float field(vec2 p){float n=0.0,a=.54;mat2 m=mat2(1.6,1.2,-1.2,1.6);
 for(int i=0;i<5;i++){n+=a*noise(p);p=m*p+vec2(13.7,9.2);a*=.48;}return n;}
void main(){
 vec4 base=texture(colorTexture,v_textureCoordinates);out_FragColor=base;
 // Opaque aircraft, signs and ground must never acquire a cloud overlay.
 float depth=czm_readDepth(depthTexture,v_textureCoordinates);
 if(depth<.9999999)return;
 vec4 eye=czm_inverseProjection*vec4(v_textureCoordinates*2.0-1.0,1.0,1.0);
 vec3 ray=normalize(czm_inverseViewRotation*(eye.xyz));
 vec3 origin=czm_viewerPositionWC;
 vec3 radii=vec3(6378137.0,6378137.0,6356752.314);
 vec3 scaled=origin/radii,scaledRay=ray/radii;
 vec3 up=normalize(scaled/radii);
 float altitude=(length(scaled)-1.0)*6378137.0,elevation=dot(ray,up);
 // A thin spherical shell gives a stable horizon, including at polar views.
 float cloudRadius=1.0+4200.0/6378137.0;
 float a=dot(scaledRay,scaledRay),b=dot(scaled,scaledRay),c=dot(scaled,scaled)-cloudRadius*cloudRadius;
 float t=(-b+sqrt(max(0.0,b*b-a*c)))/a;
 float visible=smoothstep(.015,.16,elevation)*(1.0-smoothstep(3000.0,4200.0,altitude));
 if(visible<.001||t<=0.0)return;
 vec3 p=normalize(origin+ray*t);
 // Seoul and other low-latitude flight regions avoid equirectangular seams.
 // Periodicity at the date line is provided by the 3D earth-fixed projection.
 vec2 uv=(p.xy+vec2(p.z*.37,p.z*.21))*1800.0;
 float density=smoothstep(.48,.73,field(uv*vec2(.65,1.5)));
 float veil=smoothstep(.60,.82,field(uv*vec2(.18,2.8)+23.0))*.16;
 float daylight=smoothstep(-.12,.15,dot(normalize(czm_sunDirectionWC),up));
 // Sun-off is an inspection daylight view; use the same convention as sky.
 float light=max(daylight,inspectionDay);
 vec3 lit=mix(vec3(.055,.075,.11),vec3(.91,.93,.94),light);
 lit-=vec3(.12,.115,.10)*density*light;
 out_FragColor=vec4(mix(base.rgb,lit,(density*.72+veil)*visible),base.a);
}`;

const SKY_KEYS=['perFragmentAtmosphere','saturationShift','brightnessShift','atmosphereMieAnisotropy'];
const SHADOW_KEYS=['enabled','size','maximumDistance','softShadows','darkness'];
export class CockpitEnvironment {
 constructor(C,scene){this.C=C;this.scene=scene;this.active=false;this.stage=null;}
 update(active,{economy=false}={}){
  active=Boolean(active&&this.scene.skyAtmosphere);
  // Once a busy cockpit sheds decorative passes, keep them off until exit.
  // Restoring shaders every time FPS recovers causes the next hitch itself.
  economy=active&&Boolean(economy||(this.active&&this.economy));
  if(active===this.active&&economy===Boolean(this.economy))return;
  const wasActive=this.active;this.economy=economy;
  const sky=this.scene.skyAtmosphere;this.active=active;
  if(active){
   if(!wasActive)this.saved=Object.fromEntries(SKY_KEYS.map(key=>[key,sky[key]]));
   sky.perFragmentAtmosphere=economy?this.saved.perFragmentAtmosphere:true;sky.saturationShift=-.16;
   sky.brightnessShift=-.025;sky.atmosphereMieAnisotropy=.86;
   const shadow=this.scene.shadowMap;
   if(shadow){
    if(!wasActive)this.savedShadow=Object.fromEntries(SHADOW_KEYS.map(key=>[key,shadow[key]]));
    if(economy)Object.assign(shadow,this.savedShadow);
    else Object.assign(shadow,{enabled:true,size:1024,maximumDistance:220,softShadows:true,darkness:.48});
   }
   if(!economy&&!this.stage&&this.C.PostProcessStage&&this.scene.postProcessStages){
    this.stage=this.scene.postProcessStages.add(new this.C.PostProcessStage({
     name:'aerodt_cockpit_high_clouds',fragmentShader:'uniform float inspectionDay;\n'+CLOUD_SHADER,
     uniforms:{inspectionDay:()=>this.scene.globe.enableLighting?0:1}}));
   }
   if(this.stage)this.stage.enabled=!economy;
  }else{
   if(sky&&this.saved)Object.assign(sky,this.saved);
   if(this.scene.shadowMap&&this.savedShadow)Object.assign(this.scene.shadowMap,this.savedShadow);
   this.savedShadow=null;
   if(this.stage)this.stage.enabled=false;this.saved=null;
  }
 }
 destroy(){this.update(false);if(this.stage)this.scene.postProcessStages.remove(this.stage);this.stage=null;}
}
