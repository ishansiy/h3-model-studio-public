import assert from 'node:assert/strict';
import {RESOLUTION_OPTIONS,validateSiteParams,siteMaxSeconds} from '../lib/site-options';
const base={prompt:'海边',mode:'quality',width:608,height:352,duration:5,steps:50,seed:1};
const pixels=RESOLUTION_OPTIONS.map(x=>x.value.split('x').map(Number).reduce((a,b)=>a*b));
assert.deepEqual([...pixels].sort((a,b)=>a-b),pixels);
assert.equal(RESOLUTION_OPTIONS.at(-1)?.value,'1024x768');
for(const x of RESOLUTION_OPTIONS){const [width,height]=x.value.split('x').map(Number);assert.equal(validateSiteParams({...base,width,height,duration:4.46}).width,width);}
assert.equal(siteMaxSeconds(1024,768),4.46);
for(const bad of [{width:1344,height:768},{width:768,height:1344},{width:1536,height:672},{width:1024,height:768,duration:4.47},{width:1024,height:768,duration:5},{steps:51}])assert.throws(()=>validateSiteParams({...base,...bad}));
assert.equal(validateSiteParams({...base,mode:'turbo',steps:8,duration:15}).duration,15);
console.log('网站档位及最高档时长边界通过');
