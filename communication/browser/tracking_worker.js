import {TrackingWorkerSession} from './tracking_worker_session.js?v=20260911-epoch';

const session=new TrackingWorkerSession({postMessage:(message,transfer)=>self.postMessage(message,transfer??[])});
self.onmessage=event=>session.handle(event.data);
