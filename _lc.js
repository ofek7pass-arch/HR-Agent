const axios=require('axios'),fs=require('fs');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
(async()=>{
  const all=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  for(const src of ['alljobs','linkedin']){
    const sample=all.filter(x=>x.source===src).slice(0,4);
    console.log(`\n=== ${src} ===`);
    for(const j of sample){
      try{
        const r=await axios.get(j.url,{headers:{'User-Agent':UA},timeout:25000,maxRedirects:5,validateStatus:()=>true});
        const finalUrl=r.request?.res?.responseUrl||j.url;
        const titleOnPage=(r.data.match(/<title[^>]*>([^<]*)/)||[])[1]||'';
        const redirected = finalUrl!==j.url;
        console.log(`  HTTP ${r.status}${redirected?' (הופנה)':''} — ${j.title.slice(0,40)}`);
        console.log(`     כותרת הדף: ${titleOnPage.trim().slice(0,70)}`);
      }catch(e){ console.log(`  ❌ ${e.message} — ${j.title.slice(0,40)}`); }
      await new Promise(r=>setTimeout(r,1200));
    }
  }
})();
