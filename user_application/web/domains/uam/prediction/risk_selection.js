// UI-only selection routing. Passive detail telemetry must not retake a radar
// explicitly opened for another aircraft in the pilot/Prediction workspace.
export class RiskRadarSelection {
  constructor(radar){this.radar=radar;this.mapId=null;}
  map(entity,{selected=false,reopen=false}={}){
    const id=entity?.entity_id??null;
    // Opening a detail card is not a request to open or retarget a radar.
    if(!entity)this.radar.select(null);
    this.mapId=id;
  }
  open(entity){this.radar.select(entity);this.radar.open();}
}
