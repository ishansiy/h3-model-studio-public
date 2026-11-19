import type {GenerationCategory} from '../lib/model-catalog';
import Studio,{type StudioView} from './studio';
import {cookies} from 'next/headers';
import {ACCESS_COOKIE,hasAccessSession} from '../lib/access';
import {siteAccessConfig} from '../lib/access-runtime';
import AccessGate from './access-gate';
export default async function WorkspacePage({view,initialCategory='video'}:{view:StudioView;initialCategory?:GenerationCategory}){
 const paths={create:initialCategory==='image'?'/?category=image':'/',models:'/models',queue:'/queue',library:'/library',accounts:'/accounts',integrations:'/integrations',apiKeys:'/integrations/keys'};
 if(!(await hasAccessSession((await cookies()).get(ACCESS_COOKIE)?.value,siteAccessConfig())))return <AccessGate returnTo={paths[view]}/>;
 const publicOrigin=process.env.RENDER_EXTERNAL_URL||process.env.PUBLIC_BASE_URL;
 const publicOpenApiUrl=view==='integrations'&&publicOrigin?new URL('/api/v1/openapi.json',publicOrigin).href:undefined;
 return <Studio view={view} initialCategory={initialCategory} publicOpenApiUrl={publicOpenApiUrl}/>;
}
