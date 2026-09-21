// Perceptual sonification, NOT an acoustic/noise certification model. Timbre
// presets describe the visual family, not measured blade counts or motor specs.
const finite=Number.isFinite;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const ground=new Set(['parked','charge','gate_in','gate_out','arrived','complete']);
const cruisePhases=new Set(['cruise','fixed_wing','fixed-wing']);
const silent=()=>({level:0,frequency:100,cruise:0,speed:0,timbre:'electric',estimated:false,cutoff:1600,pulse:12,
  roll:0,servo:0,servoRate:0});

// `motion` carries what a single observation cannot say. A tilt angle tells you
// where the nacelles are; only its rate tells you whether anything is driving
// them, and that takes two observations, so the caller measures it and this
// decides what it sounds like.
export function entitySoundProfile(entity,distance,motion={}) {
  if(!entity||!['uam','aircraft','satellite'].includes(entity.kind)||!finite(distance)||distance<0)return silent();
  if(['stale','invalid','unavailable'].includes(entity.quality))return silent();
  if(entity.kind==='uam'&&entity.rotor_radps!=null&&(!finite(entity.rotor_radps)||entity.rotor_radps<0))return silent();
  const velocity=entity.velocity_ecef_mps;
  const speed=finite(entity.speed_mps)?Math.max(0,entity.speed_mps):Array.isArray(velocity)&&velocity.length===3&&velocity.every(finite)?Math.hypot(...velocity):0;
  const satellite=entity.kind==='satellite',uam=entity.kind==='uam';
  const reference=satellite?150000:uam?180:550,limit=reference*70;
  const attenuation=(1/(1+(distance/reference)**1.5))*clamp((limit-distance)/(limit*.3),0,1);
  const phase=entity.flight_phase??entity.stage;
  const cruise=finite(entity.tilt_deg)?clamp(entity.tilt_deg/90,0,1):cruisePhases.has(phase)?1:0;
  const asset=String(entity.visual_asset_id??'').toLowerCase();
  const type=String(entity.aircraft_type??entity.typecode??entity.icao_type??'').toUpperCase();
  const propeller=/^(C1[578]2|C208|C210|PC12|AT4[25]|AT7[26]|DH8[A-D]|DHC6|BE20|B350|PA28|SR22)$/.test(type)
    || /cessna|turboprop|atr[_-]|dash[_-]?8/.test(asset);
  const timbre=satellite?'space':uam?'electric':propeller?'propeller':'jet';
  if(satellite)return {level:attenuation*.65,frequency:68,cruise:0,speed:0,timbre,estimated:true,cutoff:500,pulse:.18,
    roll:0,servo:0,servoRate:0};
  const measured=finite(entity.rotor_radps)&&entity.rotor_radps>=0;
  const stopped=['off','shutdown'].includes(entity.motor_state)||phase==='charge';
  const assumed=ground.has(phase)||entity.grounded===true?0:cruise?.82:1;
  // Missing Physical actuator observations must not invent a running motor.
  const rpm=uam?(measured?clamp(entity.rotor_radps,0,1000):entity.source==='physical_uam'?0:300*assumed):0;
  const load=uam?clamp(rpm/400,0,1):entity.grounded===true?.25:clamp(.4+speed/300,.4,1);
  const running=!stopped&&(!uam||rpm>0);
  const character=/x[_-]?57/.test(asset)?4.1:/joby/.test(asset)?3.2:/lilium/.test(asset)?6:2.7;
  const frequency=uam?clamp(rpm/(2*Math.PI)*character,25,700):propeller?65+load*55:48+load*40;
  // Wheels on a deck. An aircraft taxiing under its own rotors at idle made no
  // sound at all before this -- `running` is false at zero rpm, so moving across
  // a vertiport was silent -- and rolling is the one thing that is obviously
  // happening. It is about ground speed and nothing else: taxi is a few metres a
  // second, so the curve has to be steep at the bottom or all of it lives in the
  // first tenth. Stationary is silent, which is what makes it read as rolling.
  const onDeck=entity.grounded===true||entity.airborne===false||ground.has(phase);
  const roll=onDeck?attenuation*clamp((speed-.25)/5.5,0,1):0;
  // The tilt actuators. Heard while they move, not while they are somewhere: a
  // nacelle held at 45 degrees is silent, sweeping through it is not. `mode`
  // says 'transition' for any intermediate angle, held or not, so the rate is
  // what this is built on.
  //
  // Two regimes have to be audible at once and they are an order of magnitude
  // apart. A scheduled flight tilts 0->90 across the whole climb stage, minutes
  // of it, so under a degree a second; a pilot changing mode by hand has the
  // SimpleFlight controller blend through in seconds. A straight divisor serves
  // one and loses the other, so this saturates softly: half a degree a second is
  // clearly there, and thirty is louder without everything above five pinning to
  // the same value. The deadband below it is measurement noise -- a held angle
  // arrives rounded and would otherwise whine faintly forever.
  const driven=Math.abs(finite(motion.tiltRate)?motion.tiltRate:0)-.15;
  const servoRate=driven<=0?0:clamp(driven/(driven+1.1),0,1);
  return {level:running?attenuation*(uam?Math.pow(load,.8):load):0,frequency,cruise,
    roll,servo:attenuation*servoRate,servoRate,
    speed:clamp(speed/(uam?80:260),0,1),timbre,estimated:uam?!measured:true,
    cutoff:clamp((timbre==='jet'?2200:1800)/(1+distance/(reference*3)),220,2400),
    pulse:uam?clamp(rpm/(2*Math.PI)*.28,2,24):propeller?18:3};
}
