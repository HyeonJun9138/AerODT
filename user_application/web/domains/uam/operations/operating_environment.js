// View the reported infrastructure without changing the saved Simulation files.
export class OperatingEnvironment {
  constructor({readRevision,read,globe,onChange=()=>{}}){Object.assign(this,{readRevision,read,globe,onChange});this.source=null;this.revision=null;this.pending=false;this.closed=false;}
  async refresh(){
    if(this.closed||this.pending||!this.globe())return;
    this.pending=true;
    try{
      const stamp=await this.readRevision();if(this.closed||stamp.revision===this.revision)return;
      const value=await this.read();if(this.closed)return;
      this.source=value.source;this.revision=value.revision;this.value=value;
      await this.globe()?.showVertiports(value.vertiports||[]);
      if(this.closed)return;
      await this.globe()?.showRoutes(value.network,value.segments);
      this.globe()?.setScenarioPassengers?.(true);
      this.onChange(value);
    }catch{this.revision=null;}finally{this.pending=false;}
  }
  close(){this.closed=true;}
}
