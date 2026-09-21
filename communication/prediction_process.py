"""Bounded JSON-lines adapter for one application-owned prediction subprocess.

Protocol v1: one {schema_version:1,...} request / {result:...} or {error:...}
response. Never accepts a command from HTTP or uses a shell.
"""
import json
import queue
import subprocess
import threading


class PredictionProcess:
    def __init__(self,command,*,cwd,timeout=30):
        self.command=list(command);self.cwd=cwd;self.timeout=timeout;self.process=None;self.lock=threading.Lock()
    def _start(self):
        if self.process is not None and self.process.poll() is None:return
        self.close();self.responses=queue.Queue(maxsize=2)
        self.process=subprocess.Popen(self.command,cwd=self.cwd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,text=True,encoding='utf-8',bufsize=1,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        process=self.process;responses=self.responses
        def read():
            try:
                while True:
                    line=process.stdout.readline(8*1024*1024)
                    if not line or not line.endswith('\n'):responses.put_nowait(None);return
                    responses.put_nowait(line)
            except (OSError,ValueError,queue.Full):pass
        self.reader=threading.Thread(target=read,daemon=True,name='prediction-json-reader');self.reader.start()
    def request(self,payload):
        with self.lock:
            try:
                encoded=json.dumps(payload,allow_nan=False,separators=(',',':'))
                if len(encoded)>4*1024*1024:raise ValueError('request too large')
                self._start();process=self.process;responses=self.responses
                def send():
                    try:process.stdin.write(encoded+'\n');process.stdin.flush()
                    except (OSError,ValueError):
                        try:responses.put_nowait(None)
                        except queue.Full:pass
                # The deadline also covers a worker stuck before reading a large pipe.
                threading.Thread(target=send,daemon=True,name='prediction-json-writer').start()
                line=self.responses.get(timeout=self.timeout)
                if not line:raise RuntimeError('prediction worker exited')
                reply=json.loads(line)
                if not isinstance(reply,dict) or 'result' not in reply:raise RuntimeError('prediction worker rejected input')
                return reply['result']
            except (OSError,ValueError,RuntimeError,queue.Empty):
                self.close();raise RuntimeError('prediction worker unavailable') from None
    def close(self):
        process=self.process;self.process=None
        if process is None:return
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=2)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
        for stream in (process.stdin,process.stdout):
            try:stream.close()
            except (OSError,ValueError):pass
