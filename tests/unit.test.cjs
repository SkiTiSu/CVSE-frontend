const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const video = (bvid, extra = {}) => ({ bvid, avid: `av${bvid.slice(2)}`, title: `视频 ${bvid}`, uploader: 'UP', desc: '简介', tags: [], ranks: ['domestic'], is_examined: false, is_republish: false, staff_info: '原Staff', cover: '', ...extra });
const initial = [video('BV1'), video('BV2', { is_republish: true }), video('BV3', { ranks: ['sv'] })];
const clean = value => JSON.parse(JSON.stringify(value));
async function setup(t) {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
    const w=dom.window, requests=[]; let pending = new Map();
    w.scrollTo=()=>{}; w.alert=()=>{}; w.confirm=()=>true;
    w.fetch = async (url, options={}) => {
        requests.push({url, options});
        if (url.startsWith('/api/video/')) {
            const bvid=url.split('/').pop();
            if(pending.has(bvid)) return pending.get(bvid);
            return {ok:true,json:async()=>({success:true,data:video(bvid)})};
        }
        if (url.startsWith('/api/ranking-preview')) return {ok:true,json:async()=>({success:true,data:{entries:[],stat:{count:2},total:0}})};
        return {ok:true,json:async()=>({success:true,data:clean(initial),total:3,stats:{}})};
    };
    for(const file of ['utils.js','api.js','renderers.js','app.js']) {
        let source=fs.readFileSync(path.join(root,'static/js',file),'utf8').replace(/^import[\s\S]*?from ['"].*?['"];\n/gm,'').replace(/^export /gm,'');
        if(file==='api.js') source+='\nwindow.calculateRankingsRequest=calculateRankings; window.submitChangesRequest=submitChanges; window.sendDebugRequestApi=sendDebugRequest;';
        w.eval(source);
    }
    await new Promise(resolve=>setTimeout(resolve,0));
    t.after(()=>w.close());
    return {w, app:w.app, doc:w.document, requests, defer(bvid){let resolve; const promise=new Promise(r=>resolve=r);pending.set(bvid,promise);return ()=>resolve({ok:true,json:async()=>({success:true,data:video(bvid)})});}};
}
const click=(doc,selector)=>doc.querySelector(selector).click();
function changeCheckbox(w,selector,checked){const el=w.document.querySelector(selector);el.checked=checked;el.dispatchEvent(new w.Event('change',{bubbles:true}));}

test('outside click cancels rank and staff draft without modifying original or submitting', async t=>{
 const {w,app,doc,requests}=await setup(t); app.openEditPanel('BV1');
 changeCheckbox(w,'#rank-domestic input',false);doc.querySelector('#staffInfo').value='discard';click(doc,'.card-title');
 assert.equal(doc.querySelector('#editPanel'),null);assert.deepEqual(clean(app.videos),initial);assert.equal(app.changes.size,0);assert.ok(requests.every(r=>!r.options.method||r.options.method==='GET'));
});
test('opening another or same edit keeps exactly one panel and cancels former rank draft',async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);app.openEditPanel('BV2');app.openEditPanel('BV2');
 assert.equal(doc.querySelectorAll('#editPanel').length,1);assert.equal(app.currentEditingBvid,'BV2');assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
 doc.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(doc.querySelector('#editPanel'),null);
});
test('clicking blank inside panel does not dismiss; cancel restores original arrays', async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');click(doc,'.edit-panel-body');assert.ok(doc.querySelector('#editPanel'));
 changeCheckbox(w,'#rank-sv input',true);app.closeEditPanel();assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
});
test('cancel preserves previous saved changes and clearing restores initial ranks',async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);app.saveChange('BV1');
 app.openEditPanel('BV1');changeCheckbox(w,'#rank-domestic input',false);app.closeEditPanel();
 assert.deepEqual(clean(app.changes.get('BV1').ranks),['domestic','sv']);app.clearChanges();assert.deepEqual(clean(app.videos),initial);
});
test('batch rejection only stages selected items, preserving republish and staff; undo works',async t=>{
 const {app,doc,requests}=await setup(t);assert.equal(doc.querySelector('#batchRejectBtn').disabled,true);
 app.toggleVideoSelection('BV1',true);app.toggleVideoSelection('BV2',true);click(doc,'#batchRejectBtn');
 assert.equal(app.changes.size,2);for(const v of app.changes.values()){assert.deepEqual(clean(v.ranks),[]);assert.equal(v.is_examined,true);assert.equal(v.staff_info,'原Staff');}
 assert.equal(app.changes.get('BV2').is_republish,true);assert.equal(app.videos[2].is_examined,false);assert.equal(app.selectedVideos.size,0);assert.ok(requests.every(r=>!r.options.method));
 app.clearChanges();assert.deepEqual(clean(app.videos),initial);
});
test('exclusion from card or editor stages correct state and has no false included label',async t=>{
 const {app,doc}=await setup(t);await app.excludeVideo('BV1');assert.equal(app.changes.get('BV1').is_examined,true);assert.equal(doc.querySelector('[data-bvid="BV1"] .tag-examined'),null);
 app.openEditPanel('BV2');doc.querySelector('#staffInfo').value='新Staff';app.excludeEditingVideo();assert.equal(app.changes.get('BV2').staff_info,'新Staff');assert.deepEqual(clean(app.changes.get('BV2').ranks),[]);assert.equal(doc.querySelector('#editPanel'),null);
});
test('preview-only single exclusion loads video and enters same pending queue',async t=>{
 const {app,requests}=await setup(t);await app.excludeVideo('BV8');assert.equal(app.changes.get('BV8').is_examined,true);assert.deepEqual(clean(app.changes.get('BV8').ranks),[]);assert.ok(requests.every(r=>!r.options.method));
});
test('republish filter includes true/false/all in local results and server request',async t=>{
 const {app,doc,requests}=await setup(t);for(const [value,count] of [['true',1],['false',2],['',3]]){
 doc.querySelector('#republishFilter').value=value;await app.loadVideos({force:true});assert.equal(app.getVisibleVideos().length,count);assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.get('is_republish'),value);}
});
test('preview defaults to hiding special rankings and keeps zero total authoritative',async t=>{
 const {app,doc,requests}=await setup(t);assert.equal(doc.querySelector('#previewShowSpecial').checked,false);await app.getPreview();assert.equal(app.previewTotal,0);assert.match(requests.at(-1).url,/show_special=false/);
 doc.querySelector('#previewShowSpecial').checked=true;await app.getPreview();assert.match(requests.at(-1).url,/show_special=true/);
});
test('preview renders seven data labels, special rank labels, escaped values, and 新投稿',async t=>{
 const {w}=await setup(t);const html=w.createPreviewCard({...video('BV8'),rank:0,specialRank:'hot',title:'<script>alert(1)</script>',isNew:true,view:1,like:2,share:3,coin:4,favorite:5,reply:6,danmaku:7});
 for(const label of ['播放','点赞','分享','硬币','收藏','评论','弹幕','新投稿','HOT']) assert.ok(html.includes(label));assert.ok(!html.includes('新上榜'));assert.ok(!html.includes('<script>alert'));assert.ok(html.includes('ranking-row'));
});
test('late asynchronous edit cannot replace newer edit or reopen cancelled panel',async t=>{
 const {app,doc,defer}=await setup(t);const finish=defer('BV8');const old=app.openEditPanelByBvid('BV8');app.openEditPanel('BV1');finish();await old;assert.equal(app.currentEditingBvid,'BV1');
 const finish2=defer('BV9');const cancelled=app.openEditPanelByBvid('BV9');app.closeEditPanel();finish2();await cancelled;assert.equal(doc.querySelector('#editPanel'),null);
});
test('navigation cancels current edit, saved local changes survive refresh',async t=>{
 const {w,app,doc}=await setup(t);app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);click(doc,'[data-page="preview"]');assert.equal(doc.querySelector('#editPanel'),null);assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
 await app.excludeVideo('BV1');await app.loadVideos({force:true});assert.deepEqual(clean(app.videos[0].ranks),[]);assert.equal(app.videos[0].is_examined,true);app.clearChanges();assert.deepEqual(clean(app.videos[0].ranks),['domestic']);
});

test('late preview response cannot overwrite newer HOT/SH visibility or page request',async t=>{
 const {w,app,doc}=await setup(t);const pending=[];
 w.fetch=url=>new Promise(resolve=>pending.push({url,resolve}));
 doc.querySelector('#previewShowSpecial').checked=true;const old=app.getPreview();
 doc.querySelector('#previewShowSpecial').checked=false;const latest=app.getPreview();
 const answer=entries=>({ok:true,json:async()=>({success:true,data:{entries,stat:{count:entries.length},total:entries.length}})});
 pending[1].resolve(answer([{...video('BV1'),rank:1,specialRank:'normal'}]));await latest;
 pending[0].resolve(answer([{...video('BV8'),rank:0,specialRank:'hot'}]));await old;
 assert.equal(app.previewData.entries[0].bvid,'BV1');assert.equal(app.previewShowSpecial,false);assert.ok(!doc.querySelector('#rankingPreview').textContent.includes('HOT'));
 app.previewTotal=40;app.previewPageSize=20;app.previewChangePage(1);
 const newest=app.getPreview();pending[3].resolve(answer([{...video('BV2'),rank:2}]));await newest;
 pending[2].resolve(answer([{...video('BV3'),rank:3}]));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(app.previewData.entries[0].bvid,'BV2');
});

test('filter pruning prevents batch rejection of invisible previously selected items',async t=>{
 const {app,doc}=await setup(t);app.toggleVideoSelection('BV1',true);app.toggleVideoSelection('BV2',true);
 doc.querySelector('#republishFilter').value='true';app.applyRecordingFilters();app.batchReject();assert.deepEqual([...app.changes.keys()],['BV2']);
});

test('saved changes survive refresh/cancel and per-item removal restores original',async t=>{
 const {w,app}=await setup(t);await app.excludeVideo('BV1');await app.loadVideos({force:true});app.openEditPanel('BV1');changeCheckbox(w,'#rank-sv input',true);app.closeEditPanel();
 assert.deepEqual(clean(app.changes.get('BV1').ranks),[]);app.removeChange('BV1');assert.deepEqual(clean(app.videos[0]),initial[0]);assert.equal(app.changes.size,0);
});

test('mock submit carries exact exclusion state and unchanged metadata',async t=>{
 const {app,requests}=await setup(t);app.toggleVideoSelection('BV2',true);app.batchReject();await app.submitChanges();
 const submitted=requests.find(r=>r.url==='/api/submit-changes');assert.ok(submitted);assert.equal(submitted.options.method,'POST');
 assert.deepEqual(JSON.parse(submitted.options.body),{changes:[{avid:'av2',bvid:'BV2',ranks:[],is_examined:true,is_republish:true,staff_info:'原Staff'}]});assert.equal(app.changes.size,0);
});

test('changing preview criteria dismisses stale loading and ignores pending response',async t=>{
 const {w,app,doc}=await setup(t);let finish;w.fetch=()=>new Promise(resolve=>finish=resolve);const old=app.getPreview();
 doc.querySelector('#previewRank').value='sv';doc.querySelector('#previewRank').dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.ok(doc.querySelector('#rankingPreview').textContent.includes('预览参数已更改'));finish({ok:true,json:async()=>({success:true,data:{entries:[{...video('BV1'),rank:1}],stat:{count:1},total:1}})});await old;
 assert.equal(app.previewData,null);assert.ok(doc.querySelector('#rankingPreview').textContent.includes('预览参数已更改'));
});
