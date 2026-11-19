#!/usr/bin/env python3
"""影像工作室 API 示例，仅使用 Python 标准库。密钥通过隐藏输入读取。"""
import argparse, getpass, json, pathlib, time, urllib.request, urllib.error, uuid
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--base',required=True,help='工作室 HTTPS 地址')
p.add_argument('--account',required=True,help='GET /api/v1/accounts 返回的账户 UUID')
p.add_argument('--model',default='hyperflow-h3-flash',choices=['h3','hyperflow-h3-flash','z-image-turbo'])
p.add_argument('--prompt',required=True)
p.add_argument('--output',required=True)
p.add_argument('--request-id',default=None,help='超时后重试沿用已打印的小写UUID')
a=p.parse_args()
if not a.base.startswith('https://'):p.error('请使用 HTTPS，以免泄露 API 密钥。')
if pathlib.Path(a.output).exists():p.error('输出文件已存在，请换一个文件名。')
token=getpass.getpass('工作室 API 密钥（隐藏输入）：')
def call(path,body=None):
    data=None if body is None else json.dumps(body,ensure_ascii=False).encode()
    req=urllib.request.Request(a.base.rstrip('/')+'/api/v1/'+path,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:return urllib.request.urlopen(req,timeout=120)
    except urllib.error.HTTPError as e:
        if e.code==429:
            time.sleep(max(1,int(e.headers.get('Retry-After','60'))));return call(path,body)
        raise SystemExit('API 错误 '+str(e.code)+': '+e.read().decode('utf-8','replace')) from None
rid=a.request_id or str(uuid.uuid4());print('requestId =',rid,flush=True)
body={'requestId':rid,'accountId':a.account,'modelId':a.model,'prompt':a.prompt}
try:
    with call('jobs',body) as r:job=json.load(r)['job']
    while job['status'] not in ('completed','failed','cancelled'):
        print(job['status'],job['stage'],str(job['step'])+'/'+str(job['totalSteps']),flush=True)
        time.sleep(8)
        with call('jobs/'+rid) as r:job=json.load(r)['job']
    if job['status']!='completed':raise SystemExit(str(job.get('error') or job['status']))
    with call('jobs/'+rid+'/artifact?download=1') as r,open(a.output,'xb') as f:
        while True:
            chunk=r.read(1024*1024)
            if not chunk:break
            f.write(chunk)
    print('作品已保存：',a.output,'；实际参数：',json.dumps(job['params'],ensure_ascii=False))
except (TimeoutError,urllib.error.URLError) as e:
    raise SystemExit('连接中断；请保留 requestId='+rid+'，查询原任务或用 --request-id 重试，避免重复生成。') from None
