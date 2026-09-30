// Local-only UI fixture server: no production imports, credentials, or network forwarding.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const videos = ['BV1', 'BV2', 'BV3'].map((bvid, i) => ({ bvid, avid: `av${i+1}`, title: `测试稿件 ${i+1}`, uploader: '测试UP', desc: '本地测试，无线上数据', tags: [], ranks: ['domestic'], is_examined: false, is_republish: i===1, staff_info: '原Staff', cover: '' }));
const entries = videos.map((v,i) => ({ ...v, rank: i+1, view:101, like:102, share:103, coin:104, favorite:105, reply:106, danmaku:107, totalScore:500, isNew:true, specialRank:'normal' }));
entries.push({...entries[0],bvid:'BV8',rank:0,specialRank:'hot'}, {...entries[0],bvid:'BV9',rank:0,specialRank:'sh'});
http.createServer(async (req,res) => {
 const url=new URL(req.url,'http://localhost');
 res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
 if(url.pathname.startsWith('/api/')) {
   let data;
   if(url.pathname==='/api/videos') {
     const r=url.searchParams.get('is_republish'); const filtered=videos.filter(v=>!['true','false'].includes(r)||v.is_republish===(r==='true'));
     data={success:true,data:filtered,total:filtered.length,stats:{total:filtered.length}};
   } else if(url.pathname==='/api/ranking-preview') {
     const filtered=entries.filter(v=>url.searchParams.get('show_special')==='true'||v.specialRank==='normal');
     data={success:true,data:{entries:filtered,stat:{count:entries.length,totalNew:3},total:filtered.length}};
   } else if(url.pathname.startsWith('/api/video/')) data={success:true,data:{...videos[0],bvid:url.pathname.split('/').pop()}};
   else {res.writeHead(405);return res.end('Disabled in fixture server');}
   res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(data));
 }
 try {
   const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);
   if(!file.startsWith(root+path.sep)) throw Error('Bad path');
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));
 } catch {res.writeHead(404);res.end();}
}).listen(25124,'127.0.0.1',()=>console.log('Fixture UI: http://127.0.0.1:25124'));
