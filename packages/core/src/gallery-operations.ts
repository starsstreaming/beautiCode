import { randomUUID } from 'node:crypto';

type Result = { ok: boolean; error?: string; [key: string]: unknown };
type Entry = { id: string; skinId: string; phase: string; result?: Result; updatedAt: number; controller: AbortController };

/** Session-local operation receipts survive renderer disconnects, but never claim durability across a host restart. */
export function createGalleryOperations({timeoutMs=30*60*1000,ttlMs=15*60*1000,maxEntries=32}={}) {
  const entries=new Map<string,Entry>();
  function prune(){for(const [id,entry]of entries)if(entry.result&&Date.now()-entry.updatedAt>ttlMs)entries.delete(id);}
  function status(id:string){prune();const entry=entries.get(id);return entry?{ok:true,id,skinId:entry.skinId,phase:entry.phase,...(entry.result?{result:entry.result}:{})}:{ok:false,error:'操作记录不存在或已过期，请检查当前背景后重试。',code:'operation_unknown'};}
  return {
    status,
    start(skinId:string,task:(context:{signal:AbortSignal;progress(phase:string):void;beginApply():void})=>Promise<Result>, requestedId?: string) {
      prune();
      if(requestedId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestedId))return {ok:false,error:'无效的操作编号。'};
      if(requestedId && entries.has(requestedId)){const existing=entries.get(requestedId)!;return existing.skinId===skinId?status(requestedId):{ok:false,error:'操作编号已用于其他皮肤。'};}
      const active=[...entries.values()].find(e=>!e.result);
      if(active)return active.skinId===skinId?status(active.id):{ok:false,error:'已有皮肤操作正在进行，请等待或取消。'};
      while(entries.size>=maxEntries)entries.delete(entries.keys().next().value!);
      const entry:Entry={id:requestedId||randomUUID(),skinId,phase:'download',updatedAt:Date.now(),controller:new AbortController()};
      entries.set(entry.id,entry);
      const timer=setTimeout(()=>{if(entry.phase!=='apply')entry.controller.abort();},timeoutMs);
      timer.unref?.();
      const update=(phase:string)=>{entry.phase=phase;entry.updatedAt=Date.now();};
      void Promise.resolve().then(()=>task({signal:entry.controller.signal,progress:update,beginApply(){entry.controller.signal.throwIfAborted();update('apply');}})).then(result=>{
        entry.result=result;update(result.ok?'done':entry.controller.signal.aborted?'cancelled':'failed');
      },error=>{entry.result={ok:false,error:entry.controller.signal.aborted?'下载已取消或超时。':error instanceof Error?error.message:String(error)};update(entry.controller.signal.aborted?'cancelled':'failed');}).finally(()=>clearTimeout(timer));
      return status(entry.id);
    },
    cancel(id:string){const entry=entries.get(id);if(!entry)return status(id);if(entry.result)return status(id);if(entry.phase==='apply')return {...status(id),cancellable:false,message:'正在提交背景，无法中断；可关闭后重新打开查询结果。'};entry.controller.abort();return {...status(id),cancellable:true};},
  };
}
