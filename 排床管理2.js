const BED_ROLES={mgr:{n:'林美惠',l:'個案管理師',av:'av-m',ch:'林'},nur:{n:'陳玉玲',l:'護理師',av:'av-n',ch:'陳'},adm:{n:'蔡書明',l:'行政',av:'av-a',ch:'蔡'}};

function switchRole(r){
  const c=BED_ROLES[r];
  const ua=document.getElementById('ua');
  const uname=document.getElementById('uname');
  const urole=document.getElementById('urole');
  if(ua){ua.textContent=c.ch;ua.className='uav '+c.av;}
  if(uname) uname.textContent=c.n;
  if(urole) urole.textContent=c.l;
  const ro=r!=='mgr';
  const banner=document.getElementById('ro-banner');
  const btnNew=document.getElementById('btn-new');
  if(banner) banner.classList.toggle('show',ro);
  if(btnNew) btnNew.classList.toggle('hidden',ro);
}

function switchMain(el,id){
  document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['tc-case','tc-bed'].forEach(i=>{
    const e=document.getElementById(i);
    if(e) e.classList.toggle('hidden',i!==id);
  });
}

function switchFloor(el,id){
  document.querySelectorAll('.ftabs .ft').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['f3','f5','f6'].forEach(i=>{
    const e=document.getElementById(i);
    if(e) e.classList.toggle('hidden',i!==id);
  });
}

function switchView(v){
  const grid=document.getElementById('vgrid');
  const list=document.getElementById('vlist');
  const vbg=document.getElementById('vbg');
  const vbl=document.getElementById('vbl');
  if(grid) grid.classList.toggle('hidden',v!=='grid');
  if(list) list.classList.toggle('hidden',v!=='list');
  if(vbg) vbg.classList.toggle('active',v==='grid');
  if(vbl) vbl.classList.toggle('active',v==='list');
}

function toggleX(id){
  const row=document.getElementById(id);
  const btn=document.getElementById('xb'+id.replace('x',''));
  const h=row.classList.contains('hidden');
  row.classList.toggle('hidden',!h);
  if(btn) btn.textContent=h?'▼':'▶';
}

function onCS(val){
  const cp=document.getElementById('cprev');
  const box=document.getElementById('cprev-box');
  const warn=document.getElementById('rwarn');
  const dis=document.getElementById('disdate');
  if(!val){
    if(cp) cp.classList.add('hidden');
    return;
  }
  if(cp) cp.classList.remove('hidden');
  const d={
    p1:{t:'陳志明・68歲男・腦中風・房型偏好：單人房',w:42,warn:true},
    p2:{t:'蔡美玲・72歲女・脆弱性骨折・房型偏好：無偏好',w:14,warn:false},
    p3:{t:'黃建國・55歲男・創傷性神經損傷・房型偏好：雙人房',w:42,warn:false},
    h1:{t:'王大明・76歲男・末期癌症（胃癌）',w:null,warn:false},
    g1:{t:'張惠美・64歲女・一般復健',w:null,warn:false},
    g2:{t:'林志偉・45歲男・外科開刀',w:null,warn:false}
  }[val]||{t:'個案資料',w:null,warn:false};
  if(box) box.innerHTML='個案：<strong>'+d.t+'</strong>';
  if(d.w){
    const dt=new Date('2026-06-27');
    dt.setDate(dt.getDate()+d.w);
    const y=dt.getFullYear(),m=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0');
    if(dis) dis.value=y+'-'+m+'-'+dd;
    if(box) box.innerHTML+='<br><span style="font-size:11px;color:var(--blue)">預計出院日依疾病別（'+d.w/7+'週療程）自動帶入，可手動調整。</span>';
  }else if(dis){
    dis.value='';
  }
  if(warn) warn.classList.toggle('hidden',!d.warn);
}

function selBed(el,bed,type){
  document.querySelectorAll('.bpc.pk').forEach(c=>c.classList.remove('pk'));
  el.classList.add('pk');
  const selb=document.getElementById('selb');
  if(selb) selb.textContent=bed+'（'+type+'）';
}

function switchNcTab(el,id){
  el.closest('.mb').querySelectorAll('.mtab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['nc-m','nc-o','nc-h','nc-i'].forEach(i=>{
    const e=document.getElementById(i);
    if(e) e.classList.toggle('hidden',i!==id);
  });
}

function onNcT(v){
  const pd=document.getElementById('nc-pd');
  const gd=document.getElementById('nc-gd');
  if(pd) pd.style.display=v==='p'?'flex':'none';
  if(gd) gd.style.display=v==='g'?'flex':'none';
}

function showHis(){
  const res=document.getElementById('hisres');
  if(res) res.classList.remove('hidden');
}

function openModal(id){
  const modal=document.getElementById(id);
  if(modal) modal.classList.remove('hidden');
}

function closeModal(id){
  const modal=document.getElementById(id);
  if(modal) modal.classList.add('hidden');
}

document.querySelectorAll('.mo').forEach(o=>o.addEventListener('click',function(e){if(e.target===this)this.classList.add('hidden')}));
