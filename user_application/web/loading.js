// Adapted from ICDCDT's work-reported loading phases; never invent completion.
export class LoadingPhases {
  constructor(keys,weights={}) { this.keys = keys; this.weights=weights; this.done = new Set(); this.error = null; }
  complete(key) { if (this.keys.includes(key)) this.done.add(key); }
  fail(key, message) { this.done.delete(key); this.error = message; }
  get percent() { return Math.round(this.keys.reduce((sum,key)=>sum+(this.done.has(key)?this.weights[key]??1:0),0)/this.keys.reduce((sum,key)=>sum+(this.weights[key]??1),0)*100); }
  get ready() { return !this.error && this.done.size === this.keys.length; }
}
export function smoothProgress(shown,target,dtMs) {
  return shown+(target-shown)*(1-Math.exp(-Math.max(0,dtMs)/220));
}
