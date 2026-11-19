import WorkspacePage from './workspace-page';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{category?:string}>}){const q=await searchParams;return <WorkspacePage view="create" initialCategory={q.category==='image'?'image':'video'}/>;}
