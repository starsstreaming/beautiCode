/** Read-only renderer evidence, restricted to the host's known backdrop contract. */
export function buildMediaHealthProbe(backdropSelectors: readonly string[]): string {
  return `(() => {
    const stage=document.getElementById('beauticode-bg-stage');
    const node=stage&&stage.querySelector('img.bc-media,video.bc-media,iframe.bc-media');
    const selected=!!node;
    const media=!!node&&(node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.tagName==='VIDEO'?node.readyState>=2&&node.videoWidth>0:false);
    const visible=(el)=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>0&&r.height>0};
    const alpha=(value)=>{
      if(value==='transparent')return 0;
      const slash=value.match(/\\/\\s*([\\d.]+)(%)?\\s*\\)$/);
      if(slash)return Number(slash[1])/(slash[2]?100:1);
      const legacy=value.match(/^rgba?\\(([^)]+)\\)$/);
      if(legacy){const p=legacy[1].split(',').map(x=>x.trim());return p.length===4?parseFloat(p[3])/(p[3].endsWith('%')?100:1):1}
      return /^(?:color|hsl|hsla|lab|lch|oklab|oklch)\\(/.test(value)?1:null;
    };
    const opaqueSelectors=${JSON.stringify(backdropSelectors)}.filter(selector=>[...document.querySelectorAll(selector)].some(el=>{
      if(!visible(el))return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      const area=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
      // Images and gradients alone do not establish opacity. Unknown paint stays unverified.
      return area>=innerWidth*innerHeight*.2&&Number(s.opacity)>=.95&&alpha(s.backgroundColor)>=.95;
    }));
    return {selected,media,unverifiable:!!node&&node.tagName==='IFRAME',mediaVisible:!!node&&visible(node),occluded:opaqueSelectors.length>0,opaqueSelectors:opaqueSelectors.slice(0,8)};
  })()`;
}

export interface MediaHealthEvidence {
  selected?: boolean;
  unverifiable?: boolean;
  media?: boolean;
  mediaVisible?: boolean;
  occluded?: boolean;
  opaqueSelectors?: string[];
}

/** No DOM heuristic can prove arbitrary host content is visually unobstructed. */
export function mediaHealthState(evidence: MediaHealthEvidence): 'no-background' | 'media-not-ready' | 'injected-but-occluded' | 'presentation-unverified' {
  if (evidence.selected === false) return 'no-background';
  if (evidence.unverifiable) return !evidence.mediaVisible || evidence.occluded ? 'injected-but-occluded' : 'presentation-unverified';
  if (!evidence.media) return 'media-not-ready';
  if (!evidence.mediaVisible || evidence.occluded) return 'injected-but-occluded';
  return 'presentation-unverified';
}
