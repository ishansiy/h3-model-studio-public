import {spawn} from 'node:child_process';
import {initializeStorage,validateEnvironment,closeStorage} from '../lib/node-runtime';
try{validateEnvironment();await initializeStorage();await closeStorage();}catch{console.error('启动检查未通过：请检查数据库连接、H3_MASTER_KEY和访问密码。数据库及主密钥必须持久保留。');process.exit(1);}
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname',process.env.H3_BIND_ADDRESS||'0.0.0.0','--port',process.env.PORT||'3000'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
