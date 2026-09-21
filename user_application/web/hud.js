// Small presentation-only event history, never a copy of Live Twin state.
export class NoticeFeed {
  constructor() {this.entries=[];this.states=new Map();}
  update(channel,status,message,time=Date.now()) {
    if(this.states.get(channel)===status)return false;
    this.states.set(channel,status);
    if(this.states.size>24)this.states.delete(this.states.keys().next().value);
    this.entries.unshift({channel,status,message,time});this.entries.length=Math.min(3,this.entries.length);
    return true;
  }
}
export function formatUtcClock(time=Date.now()) {
  return new Date(time).toISOString().slice(0,19).replace('T',' ')+' UTC';
}
