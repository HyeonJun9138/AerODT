// Hold a prepared camera flight until the chooser has actually closed.
export function prepareDomainEntry(start){
  let readyResolve,readyReject,reveal;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const visible=new Promise(resolve=>{reveal=resolve;});
  const flight=Promise.resolve().then(()=>start(()=>{readyResolve();return visible;}));
  // Also propagate preparation failure to the still-visible chooser for retry.
  void flight.catch(readyReject);
  return {ready,flight,reveal};
}
