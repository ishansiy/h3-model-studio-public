import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sessionWorkerPrelude} from '../lib/session-worker';
import {guardedSessionSource} from '../lib/session-stop';
const src={prelude:sessionWorkerPrelude('https://fixture.invalid/worker','0'.repeat(64)),normal:guardedSessionSource('value=42\ntext="""line one\nline two\n"""'),skip:guardedSessionSource('raise AssertionError("model setup executed after stop")'),systemExit:guardedSessionSource('_SESSION_STOP.set()\nraise SystemExit("stopped")'),error:guardedSessionSource('raise RuntimeError("real failure")'),unexpectedExit:guardedSessionSource('raise SystemExit(3)')};
const result=spawnSync('python3',['-c',String.raw`
import sys,json,types,threading
s=json.load(sys.stdin)
class Response:
 def raise_for_status(self):pass
 def json(self):return {'stopSession':True,'job':None}
requests=types.SimpleNamespace(post=lambda *a,**k:Response(),put=lambda *a,**k:(_ for _ in ()).throw(AssertionError('probe after stop')))
sys.modules['requests']=requests

def fresh():
 g={};exec(s['prelude'].split('# Authenticate and claim')[0],g);return g
class Forced(BaseException):pass

def simulate(executing=False,finish=True):
 g=fresh();clock=[0];killed=[];interrupts=[]
 class ExitEvent:
  ended=False
  def set(self):self.ended=True
  def is_set(self):return self.ended
  def wait(self,seconds):
   clock[0]+=seconds
   if finish and clock[0]>=10:self.ended=True
   return self.ended
 normal=ExitEvent();g['_NORMAL_EXIT']=normal;g['time']=types.SimpleNamespace(monotonic=lambda:clock[0]);g['_SESSION_BORN']=0;g['_LAST_CONTACT']=0;g['_READY']=True;g['_EXECUTING']=executing
 g['_session_call']=lambda action,payload=None:{'stopSession':True}
 def kill(*args):killed.append(clock[0]);raise Forced()
 g['os']=types.SimpleNamespace(kill=kill,getpid=lambda:123)
 g['requests']=types.SimpleNamespace(post=lambda *a,**k:interrupts.append(1))
 try:g['_session_heartbeat']()
 except Forced:pass
 if finish:assert not killed and normal.ended
 else:assert killed and killed[0]>=35
 if executing:assert interrupts
 return g
simulate();simulate(True);simulate(finish=False);simulate(True,False)
# Full initialization: stopping before claim must not start a thread, probe or model.
g={};exec(s['prelude'],g);assert g['_SESSION_STOP'].is_set() and g['_NORMAL_EXIT'].is_set();exec(s['skip'],g)
# The cell wrapper preserves literal source bytes (including embedded Python).
g=fresh();exec(s['normal'],g);assert g['value']==42 and g['text']=='line one\nline two\n'
# Genuine errors and unrequested exits still propagate, rather than appearing successful.
try:exec(s['error'],g);raise AssertionError('swallowed failure')
except RuntimeError as e:assert str(e)=='real failure'
try:exec(s['unexpectedExit'],g);raise AssertionError('swallowed unexpected exit')
except SystemExit as e:assert e.code==3
calls=[];g['_session_call']=lambda a,p=None:calls.append((a,p));g['_QUEUE_JOB']={'id':'job','claimToken':'claim'}
exec(s['systemExit'],g);exec(s['skip'],g);assert g['_NORMAL_EXIT'].is_set();assert [p['status'] for a,p in calls if a=='finish']==['cancelled'];assert sum(a=='heartbeat' for a,p in calls)==1
print('graceful stop regression passed')
`],{input:JSON.stringify(src),encoding:'utf8'});
assert.equal(result.status,0,result.stderr);console.log('通过：心跳先于主线程停止的竞争、采样中断后正常退出、超时强制兜底、启动前停止跳过加载、真实错误保留、清理只执行一次、嵌入源码字节不变。');
