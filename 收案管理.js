
// ── 角色設定 ──
const ROLES = {
  mgr:{name:'林美惠',label:'個案管理師',av:'av-mgr',ch:'林'},
  doc:{name:'張宗達',label:'醫師',av:'av-doc',ch:'張'},
  nur:{name:'陳玉玲',label:'護理師',av:'av-nur',ch:'陳'},
  adm:{name:'蔡書明',label:'行政',av:'av-adm',ch:'蔡'},
};
// 個管師假資料清單（新增個案表單「負責個管師」下拉選單用，非登入角色切換）
const CASE_MANAGERS=['林美惠','陳淑芬','黃國華'];
// PAC 收案判斷「判斷者」下拉選單假資料（醫師＋個管師皆可能為判斷者）
const JUDGE_PERSONS=['張宗達 醫師','李文彬 醫師',...CASE_MANAGERS.map(m=>`${m} 個管師`)];
let currentRole='mgr';
let currentPage='list';
let currentCase=null;
let statusFilter=null; // 個案列表狀態篩選：統計卡與醫師／護理師視角佇列按鈕共用同一變數（預設進入時醫師／護理師鎖定「收案判斷中」，可自行切換查閱其他狀態）
let summaryEditMode=false; // 病摘卡片（住院診斷／出院診斷／病史）是否處於編輯狀態，個管師可切換
let summaryEditCaseId=null; // 記錄目前編輯狀態對應的個案 id，切換個案時自動重置編輯狀態
let bedAssignFormOpen=false; // 住院階段「登記已排床」表單是否展開
let bedAssignFormCaseId=null; // 記錄目前展開表單對應的個案 id，切換個案時自動重置為收合

// ── prototype 模擬的「今天」日期，各項編輯/狀態變更動作發生時用於更新 lastUpdated ──
const TODAY_STR='2026/07/09';
function touchCase(c){ if(c) c.lastUpdated=TODAY_STR; }

// ── 疾病別定義 ──
// PAC 四大疾病別（依員郭醫院實際收案範圍）
const PAC_DISEASE_TYPES=['腦中風','創傷性神經損傷','脆弱性骨折','衰弱高齡'];
// 一般（非PAC）住院常見分類，含「其他」開放手動輸入
const GENERAL_DISEASE_TYPES=['外科開刀（甲狀腺/脊椎/神經外科等）','一般復健（中風/脊椎損傷，非PAC專案）','安寧住院','內科住院（家醫科）','其他'];
// PAC 收案條件對照表：用於開案日/結案日自動推算（取週數下限）
const PAC_CARE_PERIOD={
  '腦中風':{minAge:0,weeksMin:6,weeksMax:12},
  '創傷性神經損傷':{minAge:18,weeksMin:6,weeksMax:12},
  '脆弱性骨折':{minAge:18,weeksMin:2,weeksMax:3},
  '衰弱高齡':{minAge:75,weeksMin:3,weeksMax:4},
};
// 折疊列快速編輯「來源」欄位固定選項（依實際轉介來源歸類，非自由輸入）
const HOSPITAL_SOURCES=['彰化基督','台中三總','台中榮總','雲林台大','自行聯繫','彰濱秀傳','亞東醫院','員榮醫院','門診自轉','常春醫院','中山附醫','成大附醫','院內自轉'];

function calcAge(birthDateStr){
  // 簡化版年齡計算，prototype 示意用，輸入格式 yyyy/mm/dd 或 yyyy-mm-dd
  const today=new Date('2026-06-30');
  const d=new Date(birthDateStr.replace(/\//g,'-'));
  let age=today.getFullYear()-d.getFullYear();
  const m=today.getMonth()-d.getMonth();
  if(m<0||(m===0&&today.getDate()<d.getDate())) age--;
  return age;
}

// ── 個案列表排序（依 listSortOrder，作用於目前篩選後的個案列表）──
function parseDateStr(str){
  if(!str||str==='—') return null;
  const t=new Date(str.replace(/\//g,'-')).getTime();
  return isNaN(t)?null:t;
}

// ── 全站日期顯示統一為兩位數年份（僅影響顯示，儲存資料仍維持 yyyy/mm/dd，供既有日期運算邏輯使用）──
// 支援純日期（yyyy/mm/dd）或「yyyy/mm/dd hh:mm」「yyyy-mm-dd hh:mm」等含時間的字串，僅縮短日期部分
function shortDate(str){
  if(!str||str==='—') return str;
  const m=str.match(/^(\d{4})([/-])(\d{2})([/-])(\d{2})(.*)$/);
  if(!m) return str;
  return `${m[1].slice(2)}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`;
}
// 排序欄位對照：建立日期(date)／發病日(onsetDate)／預計開始日(openDate)／最後更新時間(lastUpdated)，各自新到舊/舊到新
const SORT_FIELD_MAP={
  dateDesc:{field:'date',desc:true}, dateAsc:{field:'date',desc:false},
  onsetDateDesc:{field:'onsetDate',desc:true}, onsetDateAsc:{field:'onsetDate',desc:false},
  openDateDesc:{field:'openDate',desc:true}, openDateAsc:{field:'openDate',desc:false},
  lastUpdatedDesc:{field:'lastUpdated',desc:true}, lastUpdatedAsc:{field:'lastUpdated',desc:false},
};
function sortCases(arr){
  const sorted=[...arr];
  const cfg=SORT_FIELD_MAP[listSortOrder]||SORT_FIELD_MAP.dateDesc;
  sorted.sort((a,b)=>{
    const ad=parseDateStr(a[cfg.field]);
    const bd=parseDateStr(b[cfg.field]);
    if(ad===null&&bd===null) return 0;
    if(ad===null) return 1; // 無此欄位資料的個案排在最後
    if(bd===null) return -1;
    return cfg.desc?(bd-ad):(ad-bd);
  });
  return sorted;
}

// ── 個案資料 ──
// 精簡狀態（11組）：收案判斷中／待補件／確認收案／待排床／待聯絡／待開案／待評估／照護中／展延中／即將結案／封存
// 結案（成功/失敗）不再是獨立狀態，一律經由封存 Modal 直接轉為「封存」，類型記錄於 archiveType（正常結案／結案失敗）
// （移除「新轉介」：新增個案時即決定收案判斷中 or 待補件，無需中間暫存狀態）
// timelineStep：目前停在哪個時間軸節點（時間軸保留「新轉介」作為歷史事件節點）
// archiveType：封存類型（僅封存狀態使用，詳情頁漸進式揭露）
// birthDate：出生日期，用於即時換算年齡；upstreamContact：上游聯絡人資訊；familyRelation：家屬關係
// roomPref：房型偏好（null=無偏好，'single'=單人房，'double'=雙人房，'multi'=多人房）
const CASES=[
    {id:'t1',name:'李志明',birthDate:'1940/03/12',gender:'男',mode:'住院',modeType:'hosp',disease:'腦中風',source:'臺大醫院',date:'2026/06/24',lastUpdated:'2026/06/24',onsetDate:'2026/06/22',chiefComplaint:'Sudden right-sided weakness and slurred speech',familyConfirmStatus:'尚未決定',status:'收案判斷中',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'收案判斷中',upstreamStatus:'尚未回報',upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',roomPref:'single',address:'彰化縣彰化市中山路一段100號',admissionDiagnosis:'Acute right MCA infarction with left hemiparesis',dischargeDiagnosis:'Right MCA infarction, post-thrombolysis, neurologically stable, left hemiparesis improving',medicalHistory:'高血壓病史15年、糖尿病史8年，規則服藥控制中',referralDoc:{name:'轉診單.pdf',size:'1.1 MB',date:'2026/06/24'}},
    {id:'t2',name:'黃秋香',birthDate:'1948/11/02',gender:'男',mode:'居家',modeType:'home',disease:'脆弱性骨折',source:'彰化秀傳',date:'2026/06/22',lastUpdated:'2026/06/22',onsetDate:'2026/06/20',chiefComplaint:'Right hip pain and inability to bear weight after a fall at home',familyConfirmStatus:'尚未決定',status:'待補件',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待補件',upstreamStatus:'尚未回報',upstreamContact:{name:'王個管師',phone:'04-2222-3333',line:'cy_wang'},familyRelation:'女兒',roomPref:null,address:'彰化縣員林市中正路200號',admissionDiagnosis:'Closed fracture, right femoral neck, s/p fall',dischargeDiagnosis:'S/p right hip hemiarthroplasty, fracture healing well, weight-bearing as tolerated',medicalHistory:'骨質疏鬆症病史，未規則服藥'},
    {id:'t3',name:'吳金水',birthDate:'1945/07/20',gender:'男',mode:'日照',modeType:'day',disease:'腦中風',source:'台中榮總',date:'2026/06/20',lastUpdated:'2026/06/20',onsetDate:'2026/06/18',chiefComplaint:'Left-sided weakness and gait instability, acute onset',familyConfirmStatus:'尚未決定',status:'收案判斷中',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'收案判斷中',timelineSub:'醫師／護理師收案判斷',upstreamStatus:'尚未回報',upstreamContact:{name:'陳出院準備護理師',phone:'04-3333-4444',line:'tc_chen'},familyRelation:'配偶',roomPref:null,address:'彰化縣鹿港鎮中山路50號',admissionDiagnosis:'Acute lacunar infarction, right basal ganglia, with mild left-sided weakness',dischargeDiagnosis:'Lacunar infarct, right basal ganglia, stable, mild residual left hemiparesis',medicalHistory:'高血壓病史10年，未規則服藥'},
    {id:'t4',name:'鄭文雄',birthDate:'1952/01/15',gender:'男',mode:'住院',modeType:'hosp',disease:'脆弱性骨折',source:'門診自轉',date:'2026/06/18',lastUpdated:'2026/06/18',onsetDate:'2026/06/16',chiefComplaint:'Left thigh pain and deformity after a fall, unable to ambulate',familyConfirmStatus:'尚未決定',status:'待排床',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待排床',upstreamStatus:'已回報收案',upstreamContact:{name:'—',phone:'—',line:'—'},familyRelation:'兒子',roomPref:'double',address:'彰化縣和美鎮和平路88號',admissionDiagnosis:'Closed fracture, left intertrochanteric femur, s/p fall',dischargeDiagnosis:'S/p left proximal femoral nailing, fracture stable, partial weight-bearing',medicalHistory:'高血壓病史9年、骨質疏鬆症病史',nurseNotified:true},
    {id:'t5',name:'許美雲',birthDate:'1943/09/08',gender:'男',mode:'居家',modeType:'home',disease:'腦中風',source:'彰基醫院',date:'2026/06/19',lastUpdated:'2026/06/19',onsetDate:'2026/06/17',chiefComplaint:'Right visual field loss and mild confusion, acute onset',familyConfirmStatus:'尚未決定',status:'待聯絡',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待聯絡',timelineSub:'待個案／家屬確認',rehabReport:'可承接',upstreamStatus:'已回報收案',upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'女兒',roomPref:null,address:'彰化縣北斗鎮中華路15號',admissionDiagnosis:'Acute left PCA territory infarction with right visual field deficit',dischargeDiagnosis:'Left PCA infarction, stable, residual right homonymous hemianopia',medicalHistory:'心房顫動病史5年，服用抗凝血劑'},
    {id:'t6',name:'周大為',birthDate:'1947/04/30',gender:'男',mode:'住院',modeType:'hosp',disease:'腦中風',source:'臺大醫院',date:'2026/06/15',lastUpdated:'2026/06/15',onsetDate:'2026/06/13',chiefComplaint:'Left-sided weakness and dysarthria, acute onset',familyConfirmStatus:'尚未決定',status:'待聯絡',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待聯絡',upstreamStatus:'已回報收案',upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',roomPref:'multi',address:'彰化縣溪湖鎮西環路66號',admissionDiagnosis:'Acute right MCA infarction with left hemiparesis and dysarthria',dischargeDiagnosis:'Right MCA infarction, post-thrombectomy, stable, dysarthria improving',medicalHistory:'高血壓病史12年、高血脂病史6年',nurseNotified:true},
    // 居家臨時病歷示範：已完成①②，復健主管回覆可承接，已確認收案，進入待聯絡（與 t5 相同情境的另一筆示範）
    {id:'t10',name:'蔡秀琴',birthDate:'1946/02/14',gender:'男',mode:'居家',modeType:'home',disease:'腦中風',source:'彰基醫院',date:'2026/06/23',lastUpdated:'2026/06/23',onsetDate:'2026/06/21',chiefComplaint:'Transient left-sided weakness with largely resolved symptoms',familyConfirmStatus:'尚未決定',status:'待聯絡',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待聯絡',timelineSub:'待個案／家屬確認',rehabReport:'可承接',upstreamStatus:'已回報收案',upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'兒子',roomPref:null,address:'彰化縣溪湖鎮成功路8號',admissionDiagnosis:'Suspected mild lacunar infarction, symptoms largely resolved prior to referral',dischargeDiagnosis:'—',medicalHistory:'高血壓病史，輕度認知障礙病史'},
    // 居家臨時病歷示範：已完成①②，進入待聯絡（與 t5/t10 相同情境的另一筆示範）
    {id:'t11',name:'邱麗雲',birthDate:'1949/10/30',gender:'男',mode:'居家',modeType:'home',disease:'脆弱性骨折',source:'台中榮總',date:'2026/06/25',lastUpdated:'2026/06/25',onsetDate:'2026/06/23',chiefComplaint:'Left wrist pain and swelling after a fall at home',familyConfirmStatus:'尚未決定',status:'待聯絡',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待聯絡',timelineSub:'待個案／家屬確認',rehabReport:'可承接',upstreamStatus:'已回報收案',upstreamContact:{name:'陳出院準備護理師',phone:'04-3333-4444',line:'tc_chen'},familyRelation:'女兒',roomPref:null,address:'彰化縣田中鎮中州路45號',admissionDiagnosis:'Closed fracture, left distal radius, s/p fall at home',dischargeDiagnosis:'S/p closed reduction and casting, left distal radius fracture, stable alignment',medicalHistory:'骨質疏鬆症病史、退化性關節炎'},
    // 居家臨時病歷示範：已完成①②，進入待聯絡（與 t5/t10/t11 相同情境的另一筆示範）
    {id:'t15',name:'廖美惠',birthDate:'1945/12/03',gender:'男',mode:'居家',modeType:'home',disease:'腦中風',source:'台中榮總',date:'2026/06/28',lastUpdated:'2026/06/28',onsetDate:'2026/06/26',chiefComplaint:'Mild right-sided weakness following acute stroke, ambulatory with assistance',familyConfirmStatus:'尚未決定',status:'待聯絡',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待聯絡',timelineSub:'待個案／家屬確認',rehabReport:'可承接',upstreamStatus:'已回報收案',upstreamContact:{name:'陳出院準備護理師',phone:'04-3333-4444',line:'tc_chen'},familyRelation:'兒子',roomPref:null,address:'彰化縣二水鄉光復路6號',admissionDiagnosis:'Acute right MCA infarction with mild left hemiparesis',dischargeDiagnosis:'Right MCA infarction, stable, mild left-sided weakness improving',medicalHistory:'高血壓病史9年、糖尿病史3年'},
    // 居家臨時病歷示範：步驟①已交付，復健主管已回覆「可承接」，個管師尚未點擊確認收案
    {id:'t12',name:'許阿蘭',birthDate:'1944/08/17',gender:'男',mode:'居家',modeType:'home',disease:'腦中風',source:'臺大醫院',date:'2026/06/26',lastUpdated:'2026/06/26',onsetDate:'2026/06/24',chiefComplaint:'Mild left-sided weakness, ambulatory, referred for home-based PAC rehabilitation',familyConfirmStatus:'尚未決定',status:'待評估',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待評估',timelineSub:'待復健主管回覆是否收治居家復健',rehabReport:'可承接',upstreamStatus:'已回報收案',upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',roomPref:null,address:'彰化縣秀水鄉安東路22號',admissionDiagnosis:'Acute right MCA infarction with mild left-sided weakness',dischargeDiagnosis:'Right MCA infarction, stable, mild left hemiparesis, ambulatory',medicalHistory:'高血壓病史14年'},
    // 居家臨時病歷示範：步驟①已交付，復健主管已回覆「無法承接（量能不足）」，個管師尚未點擊封存
    {id:'t13',name:'江秀蓮',birthDate:'1950/05/09',gender:'男',mode:'居家',modeType:'home',disease:'脆弱性骨折',source:'彰化秀傳',date:'2026/06/27',lastUpdated:'2026/06/27',onsetDate:'2026/06/25',chiefComplaint:'Right hip pain after a fall at home, post-surgical recovery',familyConfirmStatus:'尚未決定',status:'待評估',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待評估',timelineSub:'待復健主管回覆是否收治居家復健',rehabReport:'無法承接',upstreamStatus:'已回報收案',upstreamContact:{name:'王個管師',phone:'04-2222-3333',line:'cy_wang'},familyRelation:'女兒',roomPref:null,address:'彰化縣員林市三民街11號',admissionDiagnosis:'Closed fracture, right femoral neck, s/p fall at home',dischargeDiagnosis:'S/p right hip hemiarthroplasty, fracture healing well',medicalHistory:'骨質疏鬆症病史、慢性腎臟病第二期'},
    {id:'t7',name:'蔡素珍',birthDate:'1950/12/25',gender:'男',mode:'日照',modeType:'day',disease:'脆弱性骨折',source:'台中榮總',date:'2026/06/12',lastUpdated:'2026/06/12',onsetDate:'2026/06/10',chiefComplaint:'Right wrist pain and limited range of motion after a fall',familyConfirmStatus:'尚未決定',status:'待開案',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'待開案',upstreamStatus:'已回報收案',upstreamContact:{name:'陳出院準備護理師',phone:'04-3333-4444',line:'tc_chen'},familyRelation:'媳婦',roomPref:null,address:'彰化縣田中鎮中州路120號',admissionDiagnosis:'Closed fracture, right distal radius, s/p fall',dischargeDiagnosis:'S/p closed reduction and casting, right distal radius fracture, stable alignment',medicalHistory:'骨質疏鬆症病史、輕度失智症'},
    {id:'t8',name:'謝國雄',birthDate:'1944/06/17',gender:'男',mode:'住院',modeType:'hosp',disease:'腦中風',source:'彰基醫院',date:'2026/06/08',lastUpdated:'2026/06/08',onsetDate:'2026/06/06',chiefComplaint:'Left-sided weakness and expressive aphasia, acute onset',familyConfirmStatus:'尚未決定',status:'封存',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:null,archiveType:'住院當日未報到',archiveDate:'2026/06/09',archiveOperator:'林美惠',archiveReason:'個案確認入院當日聯繫家屬後表示暫不入院，需重新評估時機。',upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'配偶',roomPref:null,address:'彰化縣二林鎮斗苑路300號',admissionDiagnosis:'Acute left MCA infarction with right hemiparesis and expressive aphasia',dischargeDiagnosis:'Left MCA infarction, stable, residual expressive aphasia',medicalHistory:'糖尿病史10年、慢性腎臟病第三期'},
    // 封存個案：與「杏翔匯入」Tab 範例查詢結果（姓名王建民、出生日期 1952/08/20）同名同生日，用於示範新增個案時的封存資料比對命中情境
    {id:'t9',name:'王建民',birthDate:'1952/08/20',gender:'男',mode:'住院',modeType:'hosp',disease:'脆弱性骨折',source:'門診自轉',date:'2025/11/02',lastUpdated:'2025/11/02',onsetDate:'2025/10/31',chiefComplaint:'Right wrist pain after a fall at home',familyConfirmStatus:'尚未決定',status:'封存',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:null,archiveType:'資料輸入錯誤',archiveDate:'2025/11/05',archiveOperator:'林美惠',archiveReason:'個案身分證字號登打錯誤，原個案資料作廢，需重新建立正確個案。',upstreamContact:{name:'—',phone:'—',line:'—'},familyRelation:'兒子',roomPref:null,address:'彰化縣員林市光明街20號',admissionDiagnosis:'Closed fracture, right distal radius, s/p fall',dischargeDiagnosis:'S/p closed reduction and casting, right distal radius fracture, stable alignment',medicalHistory:'高血壓病史6年'},
    // 測試個案：住院／腦中風，收案判斷中初始狀態
    {id:'t16',name:'住院測試',birthDate:'1955/09/10',gender:'男',mode:'住院',modeType:'hosp',disease:'腦中風',source:'臺大醫院',date:'2026/06/25',lastUpdated:'2026/06/25',onsetDate:'2026/06/23',chiefComplaint:'Left-sided weakness and dysarthria, acute onset, referred for PAC evaluation',familyConfirmStatus:'尚未決定',status:'收案判斷中',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'收案判斷中',upstreamStatus:'尚未回報',upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',familyPhone:'0921-345-678',roomPref:'single',address:'彰化縣員林市中山路二段20號',admissionDiagnosis:'Acute right MCA territory infarction with left hemiparesis and dysarthria',dischargeDiagnosis:'Right MCA infarction, post-thrombolysis, neurologically stable, ambulatory with assistance',medicalHistory:'高血壓病史12年、心房顫動病史4年，規則服藥控制中',referralDoc:{name:'轉診單.pdf',size:'1.0 MB',date:'2026/06/25'}},
    // 測試個案：日照／脆弱性骨折，收案判斷中初始狀態
    {id:'t17',name:'日照測試',birthDate:'1957/11/20',gender:'男',mode:'日照',modeType:'day',disease:'脆弱性骨折',source:'彰化基督教醫院',date:'2026/06/25',lastUpdated:'2026/06/25',onsetDate:'2026/06/23',chiefComplaint:'Right wrist pain and swelling after a fall at home',familyConfirmStatus:'尚未決定',status:'收案判斷中',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'收案判斷中',upstreamStatus:'尚未回報',upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'女兒',familyPhone:'0933-123-456',roomPref:null,address:'彰化縣鹿港鎮中山路80號',admissionDiagnosis:'Closed fracture, right distal radius, s/p fall at home',dischargeDiagnosis:'S/p closed reduction and casting, right distal radius fracture, stable alignment',medicalHistory:'骨質疏鬆症病史、退化性關節炎病史，長期服用鈣片補充劑',referralDoc:{name:'轉診單.pdf',size:'0.9 MB',date:'2026/06/25'}},
    // 測試個案：居家／衰弱高齡，收案判斷中初始狀態
    {id:'t18',name:'居家測試',birthDate:'1950/08/15',gender:'男',mode:'居家',modeType:'home',disease:'衰弱高齡',source:'彰化秀傳醫院',date:'2026/06/25',lastUpdated:'2026/06/25',onsetDate:'2026/06/15',chiefComplaint:'Recurrent falls and progressive decline in mobility and independence',familyConfirmStatus:'尚未決定',status:'收案判斷中',mgr:'林美惠',formal:false,countdown:null,week:null,timelineStep:'收案判斷中',upstreamStatus:'尚未回報',upstreamContact:{name:'王個管師',phone:'04-2222-3333',line:'cy_wang'},familyRelation:'配偶',familyPhone:'0987-654-321',roomPref:null,address:'彰化縣田尾鄉民族路15號',admissionDiagnosis:'General frailty syndrome with recurrent falls and progressive decline in mobility',dischargeDiagnosis:'Frailty syndrome, stable, discharged home with PAC rehabilitation plan',medicalHistory:'高血壓病史20年、輕度肌少症，近半年跌倒2次病史',referralDoc:{name:'轉診單.pdf',size:'1.1 MB',date:'2026/06/25'},homeRehabSchedule:[
      {dow:0,period:'午休',timeRange:'約 12:00-13:30',profession:'PT',therapist:'陳建成',duration:'40分鐘',tag:null,signStatus:null},
      {dow:1,period:'晚上',timeRange:'約 18:00-20:00',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,signStatus:null},
      {dow:2,period:'午休',timeRange:'約 12:00-13:30',profession:'ST',therapist:'林雅芳',duration:'40分鐘',tag:null,signStatus:null},
      {dow:3,period:'晚上',timeRange:'約 18:00-20:00',profession:'PT',therapist:'黃志豪',duration:'40分鐘',tag:null,signStatus:null},
      {dow:5,period:'午休',timeRange:'約 12:00-13:30',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,signStatus:null},
      {dow:6,period:'晚上',timeRange:'約 18:00-20:00',profession:'PT',therapist:'陳建成',duration:'40分鐘',tag:null,signStatus:null},
    ]},
];

// ── 常用上游聯絡人清單（新增個案時可快速選取帶入）──
const FREQUENT_UPSTREAM_CONTACTS=[
  {name:'李護理師',hospital:'臺大醫院',phone:'02-1234-5678',line:'taida_li'},
  {name:'劉個管師',hospital:'彰基醫院',phone:'04-4444-5555',line:'cb_liu'},
  {name:'陳出院準備護理師',hospital:'台中榮總',phone:'04-3333-4444',line:'tc_chen'},
  {name:'王個管師',hospital:'彰化秀傳',phone:'04-2222-3333',line:'cy_wang'},
];

// ── 13組精簡狀態的 badge 顏色 ──
const STATUS_COLOR={
  '收案判斷中':'badge-amber',
  '待補件':'badge-amber',
  '待排床':'badge-purple',
  '待評估':'badge-amber',
  '待聯絡':'badge-amber',
  '待開案':'badge-blue',
  '照護中':'badge-teal',
  '展延中':'badge-purple',
  '即將結案':'badge-amber',
  '封存':'badge-gray',
};
// 底層狀態值維持「封存」不變，僅顯示文字改為「PAC不收案紀錄」（本模組將「封存」概念改稱為「PAC不收案紀錄」）
function statusLabel(status){
  return status==='封存'?'PAC不收案紀錄':status;
}

// ── 階段欄專屬對照：住院＝待排床(黃)/已預約床位(綠)；居家＝待居家發佈(黃)/居家發佈中(黃)/居家可承接(綠)；日照一律「－」，不套用徽章顏色或點擊行為 ──
function stageDisplay(c){
  if(c.modeType==='hosp'){
    if(c.bedAssigned===true) return {text:'已預約床位',cls:'badge-green',clickable:true};
    return {text:'待排床',cls:'badge-amber',clickable:true};
  }
  if(c.modeType==='home'){
    if(c.rehabReport==='可承接') return {text:'居家可承接',cls:'badge-green',clickable:true};
    if(c.timelineSub==='待復健主管回覆是否收治居家復健') return {text:'居家發佈中',cls:'badge-amber',clickable:true};
    return {text:'待居家發佈',cls:'badge-amber',clickable:true};
  }
  // 日照與尚未設定照護模式（新增諮詢個案）：無對應階段彈窗，一律顯示「－」
  return {text:'－',cls:'',clickable:false};
}

// ── PAC不收案紀錄（原「封存」）類型清單：本模組僅臨時病歷階段，只有這一套 ──
// field：選擇該類型後顯示的必填文字欄位標籤；未設定表示不需額外說明
const ARCHIVE_TYPES_TEMP=[
  {type:'非PAC退案'},
  {type:'住院不收治'},
  {type:'日照不收治'},
  {type:'居家不收治'},
  {type:'轉復健病房'}, // PAC 判斷＝非PAC 且疾病別為腦中風時，可選擇直接轉復健病房，跳過匯入排床模組流程
  {type:'轉居家醫療'}, // PAC 判斷＝非PAC 時，可選擇直接轉居家醫療，跳過匯入排床模組流程
  {type:'一般（復健）'}, // 手動「結束收案」與 PAC 判斷流程皆可選取，選取後彈窗詢問是否匯入排床管理模組
  {type:'一般（開刀）'}, // 同上
  {type:'決定不報到／參加',field:'原因說明',hint:'例如：家屬拒絕、病情改變等'},
  {type:'住院當日未報到',field:'原因說明'},
  {type:'日照當日未報到',field:'原因說明'},
  {type:'居家未報到/未參加',field:'原因說明'},
  {type:'資料輸入錯誤'},
  {type:'重複建立個案'},
  {type:'其他',field:'原因說明'},
];

// ── 時間軸節點定義（本模組不顯示時間軸 UI，但 TIMELINE_TEMP_BY_MODE 仍作為「轉換模式」重置起始狀態時的資料來源，予以保留）──
const TIMELINE_TEMP_BY_MODE={
  hosp:[
    {label:'確認收案',sub:'住院'},
    {label:'待排床'},
    {label:'已預約床位',event:true},
    {label:'待聯絡',sub:'待個案／家屬確認'},
    {label:'待開案'},
  ],
  day:[
    {label:'確認收案',sub:'日照'},
    {label:'待聯絡',sub:'待個案／家屬確認'},
    {label:'待開案'},
  ],
  home:[
    {label:'待評估',sub:'待交付居家報名'},
    {label:'待評估',sub:'待復健主管回覆是否收治居家復健'},
    {label:'確認收案',sub:'居家'},
    {label:'待聯絡',sub:'待個案／家屬確認'},
    {label:'待開案'},
  ],
  general:[
    {label:'確認收案',sub:'一般復健'},
  ]
};


// ── 頁面渲染：本模組列表僅有單一表格，任何「detail」頁面請求一律轉譯為單純重新渲染列表，不強制展開/收合任何列 ──
function renderPage(page,caseId){
  currentPage='list';
  if(caseId) currentCase=caseId;
  renderList(document.getElementById('main-content'));
}

let currentListTab='temp'; // 'temp'（進行中） | 'archive'（已結束紀錄）
let archiveTypeFilter=''; // 已結束紀錄 Tab：類型篩選（空字串＝全部類型）
let archiveDateFrom=''; // 已結束紀錄 Tab：日期區間篩選（起，yyyy-mm-dd）
let archiveDateTo=''; // 已結束紀錄 Tab：日期區間篩選（訖，yyyy-mm-dd）
let listSortOrder='dateDesc'; // 個案列表排序：建立日期/發病日/預計開始日/最後更新時間 × 新到舊/舊到新，共8種

// ── 統計卡篩選（僅個管師/行政視角使用，與 statusFilter 各自獨立）：待提供病摘／待收案判斷／待決定報到／待回報上游／待行政建檔 ──
let metricFilter=null;
const METRIC_DEFS={
  noSummary:{label:'待提供病摘',sub:'尚無病摘資料',test:c=>!(c.chiefComplaint||c.admissionDiagnosis||c.dischargeDiagnosis||c.referralDoc)},
  noJudge:{label:'待收案判斷',sub:'尚未判斷 PAC',test:c=>!c.diseaseCategory},
  noFamilyDecision:{label:'待決定報到',sub:'家屬尚未決定',test:c=>c.familyConfirmStatus==='尚未決定'},
  noUpstreamReport:{label:'待回報上游',sub:'尚未回報上游單位',test:c=>c.upstreamStatus==='尚未回報'},
  pendingAdminHandoff:{label:'已交付建檔',sub:'已判斷PAC，待交付',test:c=>!!c.diseaseCategory},
};
function filterByMetric(key){
  metricFilter=(metricFilter===key)?null:key;
  renderList(document.getElementById('main-content'));
}

// ── 搜尋列：姓名／電話關鍵字 ＋ 疾病別／照護模式／負責人／來源醫院 四項 AND 篩選 ──
let searchQuery='';
let filterDisease='';
let filterMode='';
let filterMgr='';
let filterSource='';
function onSearchInput(val){
  searchQuery=val;
  renderList(document.getElementById('main-content'));
  // 整頁重繪會讓輸入框失焦，這裡重新聚焦並將游標移到結尾，維持連續輸入的操作體驗
  const input=document.querySelector('.search-wrap input[type="text"]');
  if(input){ input.focus(); const len=input.value.length; input.setSelectionRange(len,len); }
}
function onDiseaseFilterChange(val){ filterDisease=val; renderList(document.getElementById('main-content')); }
function onModeFilterChange(val){ filterMode=val; renderList(document.getElementById('main-content')); }
function onMgrFilterChange(val){ filterMgr=val; renderList(document.getElementById('main-content')); }
function onSourceFilterChange(val){ filterSource=val; renderList(document.getElementById('main-content')); }

// ── 表格列展開／編輯狀態：可多列同時展開，展開列不分 Tab，僅基本資訊＋備註合併編輯一種狀態 ──
let expandedRows=new Set(); // 目前展開中的個案 id 集合，可多筆同時存在
let basicEditRowId=null; // 展開列「基本資訊＋備註」合併編輯目前作用中的個案 id（僅同時允許一列進入編輯）

function renderList(container){
  document.getElementById('bc').textContent='收案管理';
  const isAdm=currentRole==='adm';
  const isMgr=currentRole==='mgr';
  const isDoc=currentRole==='doc';
  const isNur=currentRole==='nur';
  const isJudgeRole=isDoc||isNur;

  const allCases=CASES;
  const countBy=(status)=>allCases.filter(c=>c.status===status).length;
  const nurseNotifiedCases=allCases.filter(c=>c.nurseNotified);

  // 篩選：statusFilter 供醫師／護理師視角「待PAC判斷」佇列使用；metricFilter 供個管師/行政視角的統計卡使用，各自獨立
  const applyRoleFilter=(arr)=>{
    let out=arr;
    if(statusFilter) out=out.filter(c=>c.status===statusFilter);
    if(metricFilter) out=out.filter(METRIC_DEFS[metricFilter].test);
    return out;
  };
  const statFilterClass=(status)=>`stat-card${statusFilter===status?' active-filter':''}`;
  const metricFilterClass=(key)=>`stat-card${metricFilter===key?' active-filter':''}`;

  // 搜尋列：姓名／電話關鍵字＋疾病別／照護模式／負責人／來源醫院四項 AND 篩選，同時作用於「進行中」與「已結束紀錄」兩個 Tab
  const applySearchFilters=(arr)=>arr.filter(c=>{
    if(searchQuery){
      const q=searchQuery.trim();
      if(q&&!(c.name.includes(q)||(c.familyPhone&&c.familyPhone.includes(q)))) return false;
    }
    if(filterDisease){
      if(filterDisease==='一般（非PAC）'){ if(!c.disease||!c.disease.includes('一般')) return false; }
      else if(c.disease!==filterDisease) return false;
    }
    if(filterMode&&c.mode!==filterMode) return false;
    if(filterMgr&&c.mgr!==filterMgr) return false;
    if(filterSource&&c.source!==filterSource) return false;
    return true;
  });

  const tempActiveAll=sortCases(applyRoleFilter(CASES.filter(c=>c.status!=='封存')));
  const tempActive=applySearchFilters(tempActiveAll);
  const archiveCasesAll=allCases.filter(c=>c.status==='封存');
  // 已結束紀錄 Tab：類型／日期區間篩選同時作用（AND），篩選後依排序方式排列，最後再套用搜尋列的四項篩選
  const archiveCasesTyped=sortCases(archiveCasesAll.filter(c=>{
    if(archiveTypeFilter&&c.archiveType!==archiveTypeFilter) return false;
    if(archiveDateFrom||archiveDateTo){
      const d=c.archiveDate?new Date(c.archiveDate.replace(/\//g,'-')):null;
      if(!d||isNaN(d)) return false;
      if(archiveDateFrom&&d<new Date(archiveDateFrom)) return false;
      if(archiveDateTo&&d>new Date(archiveDateTo)) return false;
    }
    return true;
  }));
  const archiveCases=applySearchFilters(archiveCasesTyped);
  const tabCaseMap={temp:tempActive,archive:archiveCases};
  const currentTabCases=tabCaseMap[currentListTab];

  const tabBodyHtml = currentListTab==='archive'
    ? archiveFilterBar()+renderCaseTable(currentTabCases,archiveCasesAll.length?'沒有符合條件的紀錄':'目前沒有已結束紀錄')
    : renderCaseTable(currentTabCases,'目前沒有個案');

  const sourceOptions=[...new Set(CASES.map(c=>c.source).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-Hant'));

  container.innerHTML=`
    ${isJudgeRole?`
    <div style="background:var(--amber-light);border:1px solid #FDE68A;border-radius:10px;padding:12px 16px;margin-bottom:12px;font-size:13px;font-weight:600;color:var(--amber);cursor:pointer" onclick="filterByJudgeQueue()">
      ⚠️ ${countBy('收案判斷中')} 筆個案待您完成收案判斷
    </div>
    `:''}
    ${isNur?renderNurseSummaryQueue(nurseNotifiedCases):''}
    ${(isDoc||isNur)?`<button class="btn btn-ghost btn-sm" style="margin-bottom:16px" onclick="resetRoleFilters()">查看所有個案</button>`:''}
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:18px;font-weight:700">收案管理</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${isMgr?`<button class="btn btn-primary" onclick="openModal('modal-new')">＋ 新增諮詢</button>`:''}
      </div>
    </div>

    <!-- Tabs：進行中 / 已結束紀錄（currentListTab 內部狀態值仍為 'temp'／'archive'，僅顯示文字調整） -->
    <div class="tabs">
      <div class="tab ${currentListTab==='temp'?'active':''}" onclick="switchTab('temp')">進行中 <span class="badge badge-amber" style="margin-left:4px">${tempActiveAll.length}</span></div>
      <div class="tab ${currentListTab==='archive'?'active':''}" onclick="switchTab('archive')" style="color:var(--gray-400)">已結束紀錄 <span class="badge badge-gray" style="margin-left:4px">${archiveCasesAll.length}</span></div>
    </div>

    ${(!isDoc&&!isNur&&currentListTab==='temp')?`
    <!-- 統計卡：進行中 Tab 專屬指標，再點一次可取消篩選 -->
    <div class="stats-row">
      ${Object.keys(METRIC_DEFS).map(key=>{
        const def=METRIC_DEFS[key];
        const count=CASES.filter(c=>c.status!=='封存').filter(def.test).length;
        return `<div class="${metricFilterClass(key)}" onclick="filterByMetric('${key}')">
          <div class="stat-label">${def.label}</div>
          <div class="stat-value">${count}</div>
        </div>`;
      }).join('')}
    </div>
    `:''}

    <!-- 搜尋列 -->
    <div class="search-bar">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="搜尋姓名／電話" value="${searchQuery}" oninput="onSearchInput(this.value)">
      </div>
      <select class="filter-sel" onchange="onDiseaseFilterChange(this.value)">
        <option value="" ${filterDisease===''?'selected':''}>全部疾病別</option>
        <option ${filterDisease==='腦中風'?'selected':''}>腦中風</option>
        <option ${filterDisease==='創傷性神經損傷'?'selected':''}>創傷性神經損傷</option>
        <option ${filterDisease==='脆弱性骨折'?'selected':''}>脆弱性骨折</option>
        <option ${filterDisease==='衰弱高齡'?'selected':''}>衰弱高齡</option>
        <option ${filterDisease==='一般（非PAC）'?'selected':''}>一般（非PAC）</option>
      </select>
      <select class="filter-sel" onchange="onModeFilterChange(this.value)">
        <option value="" ${filterMode===''?'selected':''}>全部照護模式</option>
        <option ${filterMode==='住院'?'selected':''}>住院</option>
        <option ${filterMode==='日照'?'selected':''}>日照</option>
        <option ${filterMode==='居家'?'selected':''}>居家</option>
      </select>
      <select class="filter-sel" onchange="onMgrFilterChange(this.value)">
        <option value="" ${filterMgr===''?'selected':''}>全部負責人</option>
        ${CASE_MANAGERS.map(m=>`<option ${filterMgr===m?'selected':''}>${m}</option>`).join('')}
      </select>
      <select class="filter-sel" onchange="onSourceFilterChange(this.value)">
        <option value="" ${filterSource===''?'selected':''}>全部來源醫院</option>
        ${sourceOptions.map(s=>`<option ${filterSource===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>

    <!-- 排序 -->
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <select class="filter-sel" id="sort-order-select" onchange="onSortOrderChange(this.value)">
        <option value="dateDesc" ${listSortOrder==='dateDesc'?'selected':''}>建立日期（新→舊）</option>
        <option value="dateAsc" ${listSortOrder==='dateAsc'?'selected':''}>建立日期（舊→新）</option>
        <option value="onsetDateDesc" ${listSortOrder==='onsetDateDesc'?'selected':''}>發病日（新→舊）</option>
        <option value="onsetDateAsc" ${listSortOrder==='onsetDateAsc'?'selected':''}>發病日（舊→新）</option>
        <option value="openDateDesc" ${listSortOrder==='openDateDesc'?'selected':''}>預計開始日（新→舊）</option>
        <option value="openDateAsc" ${listSortOrder==='openDateAsc'?'selected':''}>預計開始日（舊→新）</option>
        <option value="lastUpdatedDesc" ${listSortOrder==='lastUpdatedDesc'?'selected':''}>最後更新時間（新→舊）</option>
        <option value="lastUpdatedAsc" ${listSortOrder==='lastUpdatedAsc'?'selected':''}>最後更新時間（舊→新）</option>
      </select>
    </div>

    ${tabBodyHtml}
  `;
}

// ── 個案列表表格：「進行中」與「已結束紀錄」兩個 Tab 欄位組合不同，依 currentListTab 切換 ──
function renderCaseTable(cases,emptyMsg){
  if(!cases.length){
    return `<div style="text-align:center;padding:40px 20px;color:var(--gray-400);font-size:13px;background:var(--white);border:1px solid var(--gray-200);border-radius:10px">${emptyMsg}</div>`;
  }
  const isArchiveTab=currentListTab==='archive';
  const headers=isArchiveTab
    ?['','姓名','來源','發病日','疾病別','預計模式','病摘','PAC判斷','回報上游','家屬確認','結束原因','負責人','建立日期','操作']
    :['','姓名','來源','發病日','疾病別','預計模式','病摘','PAC判斷','階段','預計開始日','回報上游','家屬確認','負責人','建立日期','交付建檔','操作'];
  return `
  <div style="overflow-x:auto;background:var(--white);border:1px solid var(--gray-200);border-radius:10px">
    <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:${isArchiveTab?1180:1340}px">
      <thead>
        <tr style="background:var(--gray-50)">
          ${headers.map(h=>`<th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--gray-200);font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${cases.map(c=>renderCaseRow(c)).join('')}
      </tbody>
    </table>
  </div>`;
}

// ── 折疊列「編輯」快速編輯：來源／發病日／疾病別／預計模式／預計開始日／負責人六欄；病摘／PAC判斷／階段／回報上游／家屬確認徽章不受此編輯影響，維持點擊開啟對應彈窗 ──
let quickEditRowId=null;
function toggleQuickEdit(caseId){
  quickEditRowId=caseId;
  renderList(document.getElementById('main-content'));
}
function cancelQuickEdit(caseId){
  quickEditRowId=null;
  renderList(document.getElementById('main-content'));
}
function saveQuickEdit(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(c){
    const g=id=>document.getElementById(id+'-'+caseId);
    const nameInput=g('qe-name'); if(nameInput&&nameInput.value.trim()) c.name=nameInput.value.trim();
    const ageInput=g('qe-age');
    if(ageInput&&ageInput.value){
      const ageVal=parseInt(ageInput.value,10);
      if(!isNaN(ageVal)) c.birthDate=`${2026-ageVal}/01/01`; // 僅收集年齡時，比照「新增諮詢」同一套換算方式估算出生日期
    }
    const source=g('qe-source'); if(source) c.source=source.value;
    const onsetDate=g('qe-onsetdate'); if(onsetDate&&onsetDate.value) c.onsetDate=onsetDate.value.replace(/-/g,'/');
    const diseaseSel=g('qe-disease'); if(diseaseSel) c.disease=diseaseSel.value;
    const modeSel=g('qe-mode'); if(modeSel&&modeSel.value!==c.mode){ c.mode=modeSel.value; c.modeType=MODE_TYPE_MAP[modeSel.value]; }
    const openDateInput=g('qe-opendate'); if(openDateInput&&openDateInput.value) c.openDate=openDateInput.value.replace(/-/g,'/');
    const mgrSel=g('qe-mgr'); if(mgrSel) c.mgr=mgrSel.value;
    touchCase(c);
  }
  quickEditRowId=null;
  renderList(document.getElementById('main-content'));
}

// ── 表格列：病摘／PAC判斷／回報上游／家屬確認／階段五個徽章皆可點擊，直接開啟對應彈窗，不需先展開列 ──
function renderCaseRow(c){
  const isExpanded=expandedRows.has(c.id);
  const isQuickEdit=quickEditRowId===c.id;
  const isArchiveTab=currentListTab==='archive';
  const td=(content,extra='')=>`<td style="padding:8px 10px;border-bottom:1px solid var(--gray-100);vertical-align:middle;${extra}">${content}</td>`;

  // 已結束紀錄列的徽章仍可點擊開啟對應彈窗查看內容；唯讀化改在各彈窗內部依 c.status==='封存' 處理（見 renderSummaryJudgeModalBody／renderUpstreamInfoModalBody）
  const summaryProvided=!!(c.referralDoc||c.chiefComplaint||c.admissionDiagnosis||c.dischargeDiagnosis||c.medicalHistory);
  const summaryBadge=`<span class="badge badge-clickable ${summaryProvided?'badge-green':'badge-amber'}" onclick="openSummaryJudgeModal('${c.id}','summary')">${summaryProvided?'已提供':'尚未提供'} ›</span>`;
  const pacBadge=`<span class="badge badge-clickable ${c.diseaseCategory?'badge-green':'badge-amber'}" onclick="openSummaryJudgeModal('${c.id}','judge')">${c.diseaseCategory?'是PAC':'待判斷'} ›</span>`;
  const stage=stageDisplay(c);
  const stageBadge=stage.clickable
    ?`<span class="badge badge-clickable ${stage.cls}" onclick="openStageModal('${c.id}')">${stage.text} ›</span>`
    :`<span style="color:var(--gray-400)">${stage.text}</span>`;
  const upstreamBadge=c.upstreamStatus==='已回報收案'
    ?`<span class="badge badge-clickable badge-green" onclick="openUpstreamInfoModal('${c.id}')">已回報 ›</span>`
    :c.upstreamStatus==='已回報退案'
      ?`<span class="badge badge-clickable badge-red" onclick="openUpstreamInfoModal('${c.id}')">已回報退案 ›</span>`
      :`<span class="badge badge-clickable badge-amber" onclick="openUpstreamInfoModal('${c.id}')">尚未回報 ›</span>`;
  const familyBadge=c.familyConfirmStatus==='決定報到'
    ?`<span class="badge badge-clickable badge-green" onclick="openFamilyContactModal('${c.id}')">決定報到 ›</span>`
    :c.familyConfirmStatus==='決定不報到'
      ?`<span class="badge badge-clickable badge-red" onclick="openFamilyContactModal('${c.id}')">決定不報到 ›</span>`
      :`<span class="badge badge-clickable badge-amber" onclick="openFamilyContactModal('${c.id}')">尚未決定 ›</span>`;

  const sourceCell=isQuickEdit
    ?`<select class="form-control" id="qe-source-${c.id}" style="font-size:12px;padding:4px 6px;min-width:100px">${HOSPITAL_SOURCES.map(s=>`<option ${s===c.source?'selected':''}>${s}</option>`).join('')}</select>`
    :(c.source||'—');
  const onsetDateCell=isQuickEdit
    ?`<input class="form-control" type="date" id="qe-onsetdate-${c.id}" style="font-size:12px;padding:4px 6px" value="${c.onsetDate?c.onsetDate.replace(/\//g,'-'):''}">`
    :shortDate(c.onsetDate||'—');
  const diseaseCell=isQuickEdit
    ?`<select class="form-control" id="qe-disease-${c.id}" style="font-size:12px;padding:4px 6px;min-width:110px">${PAC_DISEASE_TYPES.map(d=>`<option ${d===c.disease?'selected':''}>${d}</option>`).join('')}</select>`
    :(c.disease||'—');
  const modeCell=isQuickEdit
    ?`<select class="form-control" id="qe-mode-${c.id}" style="font-size:12px;padding:4px 6px">${['住院','日照','居家'].map(m=>`<option ${m===c.mode?'selected':''}>${m}</option>`).join('')}</select>`
    :(c.mode||'—');
  const openDateCell=isQuickEdit
    ?`<input class="form-control" type="date" id="qe-opendate-${c.id}" style="font-size:12px;padding:4px 6px" value="${c.openDate?c.openDate.replace(/\//g,'-'):''}">`
    :shortDate(c.openDate||'—');
  const mgrCell=(isQuickEdit&&!isArchiveTab)
    ?`<select class="form-control" id="qe-mgr-${c.id}" style="font-size:12px;padding:4px 6px">${CASE_MANAGERS.map(m=>`<option ${m===c.mgr?'selected':''}>${m}</option>`).join('')}</select>`
    :(c.mgr||'—');
  // 已結束紀錄列：唯讀，改用「🔄 回復資料」取代「編輯」／快速編輯切換
  const actionCell=isArchiveTab
    ?`<button class="btn btn-ghost btn-xs" onclick="openRestoreModal('${c.id}','${c.name}')">🔄 回復資料</button>`
    :(isQuickEdit
      ?`<div style="display:flex;gap:4px"><button class="btn btn-primary btn-xs" onclick="saveQuickEdit('${c.id}')">✓ 儲存</button><button class="btn btn-ghost btn-xs" onclick="cancelQuickEdit('${c.id}')">✕ 取消</button></div>`
      :`<button class="btn btn-ghost btn-xs" onclick="toggleQuickEdit('${c.id}')">編輯</button>`);

  const age=c.birthDate?calcAge(c.birthDate):null;
  const nameCell=isQuickEdit
    ?`<div style="display:flex;gap:4px;align-items:center">
        <input class="form-control" id="qe-name-${c.id}" style="font-size:12px;padding:4px 6px;width:76px" value="${c.name||''}">
        <input class="form-control" type="number" id="qe-age-${c.id}" style="font-size:12px;padding:4px 6px;width:52px" placeholder="年齡" value="${age!==null?age:''}">
      </div>`
    :`<strong>${c.name}</strong>${age!==null?`<span style="font-size:10px;color:var(--gray-400)">(${age})</span>`:''}`;

  const expandToggleCell=td(`<button class="btn btn-ghost btn-xs" style="padding:2px 7px" onclick="toggleRowExpand('${c.id}')">${isExpanded?'▴':'▾'}</button>`,'width:30px;text-align:center');
  const dateCell=td(shortDate(c.date));

  let mainRow;
  if(isArchiveTab){
    // 已結束紀錄：移除「階段」「預計開始日」，新增「結束原因」（沿用既有 PAC不收案紀錄類型 c.archiveType）於「家屬確認」與「負責人」之間
    mainRow=`<tr>
    ${expandToggleCell}
    ${td(nameCell)}
    ${td(sourceCell)}
    ${td(onsetDateCell)}
    ${td(diseaseCell)}
    ${td(modeCell)}
    ${td(summaryBadge)}
    ${td(pacBadge)}
    ${td(upstreamBadge)}
    ${td(familyBadge)}
    ${td(c.archiveType||'—')}
    ${td(mgrCell)}
    ${dateCell}
    ${td(actionCell)}
  </tr>`;
  } else {
    // 進行中：「交付行政建檔」自展開列標題移至此欄（操作欄左邊）。門檻：病摘已上傳＋PAC判斷已完成，住院另需已排床、居家另需復健主管回覆可承接
    const isAdm=currentRole==='adm';
    const hasSummary=!!(c.chiefComplaint||c.admissionDiagnosis||c.dischargeDiagnosis||c.referralDoc);
    const hasJudgment=!!c.diseaseCategory;
    let canConvertToFormal=hasSummary&&hasJudgment;
    if(c.modeType==='hosp') canConvertToFormal=canConvertToFormal&&c.bedAssigned===true;
    else if(c.modeType==='home') canConvertToFormal=canConvertToFormal&&c.rehabReport==='可承接';
    let deliverCell;
    if(c.deliveredToAdmin){
      deliverCell=`<span class="badge badge-green">已交付建檔</span>`+(isAdm?`<div style="margin-top:4px"><button class="btn btn-primary btn-xs" onclick="confirmAdminFinalize('${c.id}')">✅ 確認建檔完成</button></div>`:'');
    } else if(canConvertToFormal){
      deliverCell=`<button class="btn btn-amber btn-xs" onclick="openConvertModal('${c.id}')">🏥 交付行政建檔</button>`;
    } else {
      deliverCell=`<button class="btn btn-secondary btn-xs" disabled style="opacity:.45;cursor:not-allowed" title="請先完成病摘上傳、PAC判斷，住院需完成排床、居家需復健主管回覆可承接">🏥 交付行政建檔</button>`;
    }
    mainRow=`<tr>
    ${expandToggleCell}
    ${td(nameCell)}
    ${td(sourceCell)}
    ${td(onsetDateCell)}
    ${td(diseaseCell)}
    ${td(modeCell)}
    ${td(summaryBadge)}
    ${td(pacBadge)}
    ${td(stageBadge)}
    ${td(openDateCell)}
    ${td(upstreamBadge)}
    ${td(familyBadge)}
    ${td(mgrCell)}
    ${dateCell}
    ${td(deliverCell)}
    ${td(actionCell)}
  </tr>`;
  }

  const colspan=isArchiveTab?14:16;
  const expandedRowHtml=isExpanded?`<tr><td colspan="${colspan}" style="padding:16px;background:var(--gray-50);border-bottom:1px solid var(--gray-200)">${renderExpandedContent(c)}</td></tr>`:'';

  return mainRow+expandedRowHtml;
}

function toggleRowExpand(caseId){
  if(expandedRows.has(caseId)) expandedRows.delete(caseId);
  else expandedRows.add(caseId);
  if(quickEditRowId===caseId) quickEditRowId=null;
  if(basicEditRowId===caseId) basicEditRowId=null;
  renderList(document.getElementById('main-content'));
}

// ── 展開列：基本資訊區＋備註區合併編輯，單一「✏️ 編輯」按鈕切換 ──
function toggleBasicEdit(caseId){
  basicEditRowId=caseId;
  renderList(document.getElementById('main-content'));
}
function cancelBasicEdit(caseId){
  basicEditRowId=null;
  renderList(document.getElementById('main-content'));
}
// 展開列「預計開始日」編輯中即時調整時，同步重算「預計結案日」預設值（依疾病別週數），可再手動覆蓋
function updateBasicEditCloseDate(caseId){
  const c=CASES.find(x=>x.id===caseId);
  const openVal=document.getElementById('be-opendate-'+caseId)?.value;
  const closeInput=document.getElementById('be-closedate-'+caseId);
  if(!openVal||!c||!closeInput) return;
  closeInput.value=calcCloseDateFromOpen(openVal,c.diseaseCategory||c.disease);
}
function saveBasicEdit(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(!c){ basicEditRowId=null; renderList(document.getElementById('main-content')); return; }
  const g=id=>document.getElementById(id+'-'+caseId);
  const openDate=g('be-opendate');
  const closeDate=g('be-closedate');
  const origOpen=c.openDate?c.openDate.replace(/\//g,'-'):'';
  const origClose=c.closeDate?c.closeDate.replace(/\//g,'-'):'';
  const newOpenVal=openDate?openDate.value:'';
  const newCloseVal=closeDate?closeDate.value:'';
  const dateChanged=(newOpenVal&&newOpenVal!==origOpen)||(newCloseVal&&newCloseVal!==origClose);
  // 住院模式且已排床者，異動日期改用自訂彈窗詢問是否一併清除床位預約，兩個選項都會完成日期儲存（見 resolveBedDateChange）
  if(dateChanged&&c.modeType==='hosp'&&c.bedAssigned){
    bedDateChangeCtx={source:'basicEdit',caseId};
    openModal('modal-bed-date-change');
    return;
  }
  // 已完成居家報名交付者，異動預計開始日／結案日需再次確認後續已同步處理，取消則維持原日期不變且不儲存本次編輯
  if(dateChanged&&c.homeStep1Delivered){
    if(!confirm('⚠️ 修改日期後，居家復健報名需要重新交付、排床登記也需要對應改期，請確認後續已同步處理。')){
      if(openDate) openDate.value=origOpen;
      if(closeDate) closeDate.value=origClose;
      return;
    }
  }
  finalizeBasicEditSave(caseId);
}
// 實際寫入基本資訊區＋備註區的欄位值並結束編輯狀態；由 saveBasicEdit 直接呼叫，或在 resolveBedDateChange 決定床位去留後呼叫
function finalizeBasicEditSave(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(c){
    const g=id=>document.getElementById(id+'-'+caseId);
    const genderSel=g('be-gender'); if(genderSel) c.gender=genderSel.value;
    const familyName=g('be-familyname'); if(familyName) c.familyName=familyName.value;
    const familyRelation=g('be-familyrelation'); if(familyRelation) c.familyRelation=familyRelation.value;
    const familyPhone=g('be-familyphone'); if(familyPhone) c.familyPhone=familyPhone.value;
    const address=g('be-address'); if(address) c.address=address.value;
    const tubes=g('be-tubes'); if(tubes) c.tubes=tubes.value;
    const openDate=g('be-opendate'); if(openDate&&openDate.value) c.openDate=openDate.value.replace(/-/g,'/');
    const closeDate=g('be-closedate'); if(closeDate&&closeDate.value) c.closeDate=closeDate.value.replace(/-/g,'/');
    const remark=g('be-remark'); if(remark) c.remark=remark.value;
    touchCase(c);
  }
  basicEditRowId=null;
  renderList(document.getElementById('main-content'));
}
// 「床位預約異動確認」彈窗：clearBed=true 清除床位預約資料，false 則保留；兩種情況都會關閉彈窗並完成日期儲存
// 共用於兩個觸發點：展開列「✏️ 編輯」基本資訊區（source:'basicEdit'）與「交付行政建檔」Modal（source:'convert'）
let bedDateChangeCtx=null;
function resolveBedDateChange(clearBed){
  if(!bedDateChangeCtx){ closeModal('modal-bed-date-change'); return; }
  const ctx=bedDateChangeCtx;
  const c=CASES.find(x=>x.id===ctx.caseId);
  if(c&&clearBed){
    c.bedAssigned=false;
    delete c.assignedBedNo;
    c.bedModuleImported=false;
  }
  bedDateChangeCtx=null;
  closeModal('modal-bed-date-change');
  if(ctx.source==='convert'){
    if(c) finalizeConvertToFormal(c,ctx.openVal,ctx.closeVal);
    return;
  }
  finalizeBasicEditSave(ctx.caseId);
}

// ── 回復資料 Modal（PAC不收案紀錄個案回復為臨時病歷）──
function openRestoreModal(caseId, caseName){
  let m=document.getElementById('modal-restore');
  if(!m){
    m=document.createElement('div');
    m.id='modal-restore';
    m.className='modal-overlay hidden';
    m.innerHTML=`<div class="modal" style="max-width:440px">
      <div class="modal-header">
        <div class="modal-title">🔄 回復資料</div>
        <button class="modal-close" onclick="closeModal('modal-restore')">✕</button>
      </div>
      <div class="modal-body">
        <div class="info-note amber" style="margin-bottom:14px">回復後個案將重新進入臨時病歷列表，請選擇回復後的初始狀態。</div>
        <div style="font-size:14px;font-weight:600;margin-bottom:12px" id="restore-name"></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--gray-200);border-radius:7px;cursor:pointer">
            <input type="radio" name="restore-status" value="收案判斷中" checked style="accent-color:var(--blue)">
            <div><div style="font-size:13px;font-weight:600">收案判斷中</div><div style="font-size:11px;color:var(--gray-400)">資料齊全，需重新進行 PAC 收案判斷</div></div>
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--gray-200);border-radius:7px;cursor:pointer">
            <input type="radio" name="restore-status" value="待補件" style="accent-color:var(--blue)">
            <div><div style="font-size:13px;font-weight:600">待補件</div><div style="font-size:11px;color:var(--gray-400)">資料尚不完整，需等待上游補件後再判斷</div></div>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('modal-restore')">取消</button>
        <button class="btn btn-primary" onclick="confirmRestore()">確認回復</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click',function(e){if(e.target===this)this.classList.add('hidden');});
  }
  document.getElementById('restore-name').textContent=`個案：${caseName}`;
  m.dataset.caseId=caseId;
  openModal('modal-restore');
}

function confirmRestore(){
  const m=document.getElementById('modal-restore');
  const caseId=m.dataset.caseId;
  const sel=m.querySelector('input[name="restore-status"]:checked');
  const status=sel?sel.value:'收案判斷中';
  closeModal('modal-restore');
  alert(`個案已回復！狀態更新為「${status}」，已移回臨時病歷列表。`);
}

// ── 已結束紀錄：永久刪除此筆資料（不可復原），僅個管師可操作 ──
function deleteArchivedCase(caseId){
  if(!confirm('確定要永久刪除此筆資料嗎？此動作無法復原')) return;
  const idx=CASES.findIndex(x=>x.id===caseId);
  if(idx>-1) CASES.splice(idx,1);
  expandedRows.delete(caseId);
  renderList(document.getElementById('main-content'));
}

function switchTab(tabKey){
  currentListTab=tabKey;
  renderList(document.getElementById('main-content'));
}
function onSortOrderChange(val){
  listSortOrder=val;
  renderList(document.getElementById('main-content'));
}

// ── PAC不收案紀錄 Tab：篩選區（類型 + 日期區間，皆同時作用）──
function archiveFilterBar(){
  return `
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    <select class="filter-sel" onchange="onArchiveTypeFilterChange(this.value)">
      <option value="" ${archiveTypeFilter===''?'selected':''}>全部類型</option>
      ${ARCHIVE_TYPES_TEMP.map(o=>`<option value="${o.type}" ${archiveTypeFilter===o.type?'selected':''}>${o.type}</option>`).join('')}
    </select>
    <div style="display:flex;align-items:center;gap:6px">
      <input type="date" class="form-control" style="width:150px" value="${archiveDateFrom}" onchange="onArchiveDateFilterChange('from',this.value)">
      <span style="font-size:12px;color:var(--gray-400)">至</span>
      <input type="date" class="form-control" style="width:150px" value="${archiveDateTo}" onchange="onArchiveDateFilterChange('to',this.value)">
    </div>
  </div>`;
}
function onArchiveTypeFilterChange(val){
  archiveTypeFilter=val;
  renderList(document.getElementById('main-content'));
}
function onArchiveDateFilterChange(which,val){
  if(which==='from') archiveDateFrom=val;
  else archiveDateTo=val;
  renderList(document.getElementById('main-content'));
}

// 醫師／護理師共用：「待PAC判斷」佇列
function filterByJudgeQueue(){
  if(currentRole!=='doc'&&currentRole!=='nur') return;
  statusFilter='收案判斷中';
  currentListTab='temp';
  renderList(document.getElementById('main-content'));
}
// 醫師／護理師：清空所有佇列篩選，恢復顯示完整個案清單
function resetRoleFilters(){
  if(currentRole!=='doc'&&currentRole!=='nur') return;
  statusFilter=null;
  renderList(document.getElementById('main-content'));
}

// 護理師視角：「待查看病摘」佇列，點擊直接開啟「病摘與PAC判斷」彈窗並定位到病摘區
function renderNurseSummaryQueue(cases){
  return `
  <div style="background:var(--blue-light);border:1px solid var(--blue-mid);border-radius:10px;padding:12px 16px;margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;color:var(--blue);${cases.length?'margin-bottom:8px':''}">📋 ${cases.length} 筆個案待您查看病摘</div>
    ${cases.length?`<div style="display:flex;flex-direction:column;gap:4px">
      ${cases.map(c=>`
      <div style="background:var(--white);border-radius:6px;padding:6px 10px;cursor:pointer" onclick="openSummaryJudgeModal('${c.id}','summary')">
        <span style="font-size:12px;color:var(--gray-700)">${c.name}（${c.mode}・${c.disease}）</span>
      </div>`).join('')}
    </div>`:''}
  </div>`;
}

// ── 展開列內容：不分 Tab，由上到下依序為基本資訊區、備註區；其餘功能一律改為表格徽章觸發的彈窗 ──
function renderExpandedContent(c){
  const isMgr=currentRole==='mgr';
  const isDoc=currentRole==='doc';
  const isNur=currentRole==='nur';
  const isAdm=currentRole==='adm';
  const caseId=c.id;
  const isEditing=basicEditRowId===caseId;

  const isArchived=c.status==='封存';
  const editControls=isEditing
    ?`<button class="btn btn-primary btn-xs" onclick="saveBasicEdit('${caseId}')">✓ 儲存</button><button class="btn btn-ghost btn-xs" onclick="cancelBasicEdit('${caseId}')">✕ 取消</button>`
    :`<button class="btn btn-ghost btn-xs" ${isArchived?'disabled style="opacity:.45;cursor:not-allowed"':''} onclick="toggleBasicEdit('${caseId}')">✏️ 編輯</button>`;
  const headerActions=isMgr?`
    <button class="btn btn-secondary btn-xs" ${isArchived?'disabled style="opacity:.45;cursor:not-allowed"':''} onclick="openArchiveModal({})">結束收案</button>
    ${editControls}
  `:(isDoc?`<span class="badge badge-amber" style="font-size:11px">醫師視角</span>`
     :isNur?`<span class="badge badge-teal" style="font-size:11px">護理師視角</span>`
     :`<span class="badge badge-gray" style="font-size:11px">行政視角・唯讀</span>`);

  const archiveBanner=c.status==='封存'?`
  <div style="background:var(--gray-100);border:1px solid var(--gray-300);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:var(--gray-600)">
    <strong style="color:var(--gray-700)">📦 PAC不收案紀錄：</strong>${c.archiveType||'—'}・${shortDate(c.archiveDate)||'—'}${c.archiveReason?`<div style="margin-top:4px">${c.archiveReason}</div>`:''}
    ${isMgr?`<div style="margin-top:6px"><button class="btn btn-danger btn-xs" onclick="deleteArchivedCase('${c.id}')">🗑️ 刪除此筆資料</button></div>`:''}
  </div>`:'';

  return `
  <div id="expand-${caseId}">
    ${archiveBanner}

    ${renderBasicInfoBlock(c,isEditing)}
    ${renderRemarkBlock(c,isEditing)}

    <div style="display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;margin-top:10px">${headerActions}</div>
  </div>`;
}

// 依疾病別自動帶入週數，唯讀顯示比照「26/10/25（5週）」格式（兩位數年＋月＋日）
function formatCloseDateWithWeeks(c){
  if(!c.closeDate||c.closeDate==='—') return '—';
  const period=PAC_CARE_PERIOD[c.diseaseCategory||c.disease];
  return period?`${shortDate(c.closeDate)}（${period.weeksMax}週）`:shortDate(c.closeDate);
}

// ── 展開列基本資訊區：三組分類——①性別／管路／地址　②家屬姓名／關係／電話　③預計開始日／預計結案日（依疾病別自動帶入週數，可調整）；全部欄位皆隨展開列的單一「✏️ 編輯」按鈕一起切換 ──
const TUBE_QUICK_OPTIONS=['無','foley','Tr','Cystostomy','十二指腸管'];
function renderBasicInfoBlock(c,isEditing){
  const caseId=c.id;
  const text=(label,value,id)=>isEditing
    ?`<div class="info-item"><label>${label}</label><input class="form-control" id="${id}" value="${value||''}"></div>`
    :`<div class="info-item"><label>${label}</label><span>${value||'—'}</span></div>`;
  // 管路欄位編輯模式：比照「新增諮詢」彈窗的管路快選，點擊即以頓號串接寫入輸入框（重複點擊可取消）
  const tubesField=isEditing
    ?`<div class="info-item" style="grid-column:1/-1">
        <label>管路</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          ${TUBE_QUICK_OPTIONS.map(t=>`<button type="button" class="btn btn-secondary btn-xs" onclick="toggleBasicEditTubeBadge('${caseId}','${t}')">${t}</button>`).join('')}
        </div>
        <input class="form-control" id="be-tubes-${caseId}" value="${c.tubes||''}">
      </div>`
    :`<div class="info-item"><label>管路</label><span>${c.tubes||'—'}</span></div>`;

  const genderField=isEditing
    ?`<div class="info-item"><label>性別</label><select class="form-control" id="be-gender-${caseId}"><option ${(c.gender||'男')==='男'?'selected':''}>男</option><option ${c.gender==='女'?'selected':''}>女</option></select></div>`
    :`<div class="info-item"><label>性別</label><span>${c.gender||'男'}</span></div>`;
  const openDateField=isEditing
    ?`<div class="info-item"><label>預計開始日</label><input class="form-control" type="date" id="be-opendate-${caseId}" value="${c.openDate?c.openDate.replace(/\//g,'-'):''}" oninput="updateBasicEditCloseDate('${caseId}')"></div>`
    :`<div class="info-item"><label>預計開始日</label><span>${shortDate(c.openDate||'—')}</span></div>`;
  const closeDateField=isEditing
    ?`<div class="info-item"><label>預計結案日</label><input class="form-control" type="date" id="be-closedate-${caseId}" value="${c.closeDate?c.closeDate.replace(/\//g,'-'):''}"></div>`
    :`<div class="info-item"><label>預計結案日</label><span>${formatCloseDateWithWeeks(c)}</span></div>`;

  return `
  <div class="section-card">
    <div class="sc-body">
      <div class="info-grid">
        ${genderField}
        ${text('地址',c.address,'be-address-'+caseId)}
        ${tubesField}
      </div>
      <div class="divider"></div>
      <div class="info-grid">
        ${text('家屬姓名',c.familyName||'陳小明','be-familyname-'+caseId)}
        ${text('關係',c.familyRelation,'be-familyrelation-'+caseId)}
        ${text('電話',c.familyPhone||'0912-345-678','be-familyphone-'+caseId)}
      </div>
      <div class="divider"></div>
      <div class="info-grid">
        ${openDateField}
        ${closeDateField}
      </div>
      ${renderRecordBedInfoFields(c)}
    </div>
  </div>`;
}

// ── 展開列第四組：病歷號／預計床位（限住院），系統資料展示性質，不受本區塊「✏️ 編輯」按鈕影響，永遠唯讀 ──
function renderRecordBedInfoFields(c){
  const bedText=(c.modeType==='hosp'&&c.bedAssigned&&c.assignedBedNo)?c.assignedBedNo:'無';
  return `
      <div class="divider"></div>
      <div class="info-grid">
        <div class="info-item"><label>病歷號</label><span style="color:var(--gray-400)">無</span></div>
        <div class="info-item"><label>預計床位（限住院）</label><span style="${bedText==='無'?'color:var(--gray-400)':''}">${bedText}</span></div>
      </div>`;
}

// ── 備註區：與基本資訊區共用展開列同一個「✏️ 編輯」開關，不再有獨立的編輯按鈕 ──
function renderRemarkBlock(c,isEditing){
  return `
  <div class="section-card">
    <div class="sc-body">
      ${isEditing
        ?`<textarea class="form-control" id="be-remark-${c.id}" rows="4" style="width:100%" placeholder="輸入備註內容…">${c.remark||''}</textarea>`
        :`<div style="width:100%;font-size:13px;color:${c.remark?'var(--gray-700)':'var(--gray-400)'};white-space:pre-wrap">${c.remark||'尚無備註'}</div>`}
    </div>
  </div>`;
}

// ══════════════════════════════
// 表格徽章觸發的彈窗：病摘與PAC判斷／家屬聯絡／上游聯絡／住院排床／居家收案流程
// ══════════════════════════════

// ── 病摘與PAC判斷（合併彈窗，依點擊來源自動捲動至對應區塊）──
// summaryJudgeView：彈窗目前顯示的內容視圖：'main'（病摘＋PAC判斷）｜'translate'（輔助翻譯）｜'handoff'（轉交判斷），後兩者取代整個彈窗內容，並顯示標題旁「← 返回」按鈕
let summaryJudgeView='main';
// showNonPacOptions：送出判斷結果為「非 PAC」後，是否在 PAC 判斷區塊下方內嵌顯示 5 個後續處理選項
let showNonPacOptions=false;

function renderSummaryJudgeModalBody(c){
  if(summaryJudgeView==='translate') return renderSummaryTranslateView();
  if(summaryJudgeView==='handoff') return renderJudgeHandoffView();
  // 已結束紀錄（c.status==='封存'）唯讀化：個管師視角不再顯示 OCR／編輯功能，PAC判斷區塊比照行政視角唯讀渲染
  const isMgr=currentRole==='mgr'&&c.status!=='封存';
  const isDoc=currentRole==='doc';
  const isNur=currentRole==='nur';
  const isAdm=currentRole==='adm';
  return (isMgr?renderOcrImportSection(c):'')+renderDigestSection(c,isMgr,isDoc,isNur)+renderJudgeSection(c,isAdm||c.status==='封存');
}
// ── 病摘彈窗最上方：OCR 辨識（上傳PDF／上傳圖片／串接Line）與杏翔匯入，模擬「辨識中→成功/失敗」三段流程，僅個管師可用 ──
let ocrState={}; // caseId -> {phase:'loading'|'success'|'fail', message}
const OCR_DEMO_CONTENT={
  chiefComplaint:'Sudden onset of right-sided weakness and slurred speech, witnessed by family this morning.',
  medicalHistory:'Hypertension for 10 years, type 2 diabetes mellitus, no prior stroke history.',
  admissionDiagnosis:'Acute ischemic stroke, left MCA territory, with right hemiparesis.',
  dischargeDiagnosis:'Ischemic stroke, stable, transferred for PAC rehabilitation program.'
};
function renderOcrImportSection(c){
  const caseId=c.id;
  const state=ocrState[caseId]||{phase:'idle'};
  const loading=state.phase==='loading';
  const statusBox=state.phase==='loading'
    ?`<div class="info-note blue" style="margin-top:12px;margin-bottom:0">⏳ 辨識中，請稍候…</div>`
    :state.phase==='success'
    ?`<div class="info-note green" style="margin-top:12px;margin-bottom:0">${state.message}</div>`
    :state.phase==='fail'
    ?`<div class="info-note red" style="margin-top:12px;margin-bottom:0">${state.message}</div>`
    :'';
  return `
  <div class="section-card">
    <div class="sc-header">
      <div class="sc-title">🔎 OCR 辨識 / 杏翔匯入</div>
    </div>
    <div class="sc-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-secondary btn-sm" ${loading?'disabled':''} onclick="triggerOcrUpload('${caseId}','pdf')">📄 上傳文件（Word、PDF）</button>
        <button class="btn btn-secondary btn-sm" ${loading?'disabled':''} onclick="triggerOcrUpload('${caseId}','image')">🖼 上傳圖片（JPG、PNG）</button>
        <button class="btn btn-secondary btn-sm" onclick="alert('此功能開發中，敬請期待')">💬 串接 Line</button>
      </div>
      <input type="file" id="ocr-file-pdf-${caseId}" accept=".pdf,.doc,.docx" class="hidden" onchange="handleOcrFileSelected('${caseId}',this,'pdf')">
      <input type="file" id="ocr-file-img-${caseId}" accept=".jpg,.jpeg,.png" class="hidden" onchange="handleOcrFileSelected('${caseId}',this,'image')">
      <div class="form-group" style="margin-bottom:0">
        <label>杏翔匯入</label>
        <input class="form-control" id="his-import-input-${caseId}" placeholder="請輸入病歷號" ${loading?'disabled':''} onkeydown="handleHisImportKeydown(event,'${caseId}')">
      </div>
      ${statusBox}
    </div>
  </div>`;
}
function triggerOcrUpload(caseId,kind){
  const input=document.getElementById(kind==='pdf'?'ocr-file-pdf-'+caseId:'ocr-file-img-'+caseId);
  if(input) input.click();
}
function handleOcrFileSelected(caseId,inputEl,kind){
  const file=inputEl.files&&inputEl.files[0];
  inputEl.value=''; // 清空以便下次可重新選取同一個檔案
  if(!file) return;
  runOcrRecognition(caseId,file.name,kind==='pdf'?'PDF':'圖片');
}
function handleHisImportKeydown(evt,caseId){
  if(evt.key!=='Enter') return;
  const no=(evt.target.value||'').trim();
  if(!no) return;
  runHisImport(caseId,no);
}
function fillOcrDemoContent(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(!c) return;
  c.chiefComplaint=OCR_DEMO_CONTENT.chiefComplaint;
  c.medicalHistory=OCR_DEMO_CONTENT.medicalHistory;
  c.admissionDiagnosis=OCR_DEMO_CONTENT.admissionDiagnosis;
  c.dischargeDiagnosis=OCR_DEMO_CONTENT.dischargeDiagnosis;
  touchCase(c);
}
// 上傳 PDF／上傳圖片：辨識中 1.5 秒 → 依檔名是否含 fail/error 決定成功或失敗
function runOcrRecognition(caseId,fileName,sourceLabel){
  ocrState[caseId]={phase:'loading'};
  refreshSummaryJudgeModal(caseId);
  setTimeout(()=>{
    const failed=/fail|error/i.test(fileName);
    if(failed){
      ocrState[caseId]={phase:'fail',message:`✕ 辨識失敗（${sourceLabel}：${fileName}），請改用其他方式上傳，或直接於下方欄位手動輸入`};
    } else {
      fillOcrDemoContent(caseId);
      ocrState[caseId]={phase:'success',message:`✓ 辨識成功，已自動帶入以下欄位，請核對後可手動修正（來源：${sourceLabel}・${fileName}）`};
    }
    refreshSummaryJudgeModal(caseId);
    renderList(document.getElementById('main-content'));
  },1500);
}
// 杏翔匯入：辨識中 1.5 秒 → 固定模擬成功
function runHisImport(caseId,recordNo){
  ocrState[caseId]={phase:'loading'};
  refreshSummaryJudgeModal(caseId);
  setTimeout(()=>{
    fillOcrDemoContent(caseId);
    ocrState[caseId]={phase:'success',message:`✓ 已從杏翔匯入病摘資料（病歷號：${recordNo}），請核對後可手動修正`};
    refreshSummaryJudgeModal(caseId);
    renderList(document.getElementById('main-content'));
  },1500);
}
function renderDigestSection(c,isMgr,isDoc,isNur){
  const caseId=c.id;
  const editing=isMgr&&summaryEditMode&&summaryEditCaseId===caseId;
  return `
  <div class="section-card" id="sj-summary-section-${caseId}">
    <div class="sc-header">
      <div class="sc-title">📄 病摘</div>
      ${isMgr?`<div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-xs" onclick="openSummaryTranslateView()">輔助翻譯</button>
        <button class="btn btn-ghost btn-xs" onclick="toggleSummaryEdit('${caseId}')">${editing?'💾 儲存':'✏️ 編輯'}</button>
      </div>`:''}
    </div>
    <div class="sc-body">
      <div class="form-row" style="margin-bottom:12px">
        <div class="form-group"><label>主訴</label><textarea class="form-control" id="summary-chief-complaint-${caseId}" rows="2" ${editing?'':'readonly'}>${c.chiefComplaint||''}</textarea></div>
        <div class="form-group"><label>病史</label><textarea class="form-control" id="summary-medical-history-${caseId}" rows="2" ${editing?'':'readonly'}>${c.medicalHistory||''}</textarea></div>
      </div>
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group"><label>入院診斷</label><textarea class="form-control" id="summary-admission-dx-${caseId}" rows="2" ${editing?'':'readonly'}>${c.admissionDiagnosis||''}</textarea></div>
        <div class="form-group"><label>出院診斷</label><textarea class="form-control" id="summary-discharge-dx-${caseId}" rows="2" ${editing?'':'readonly'}>${c.dischargeDiagnosis||''}</textarea></div>
      </div>
      <div style="font-size:11px;color:var(--gray-400);margin-bottom:8px">附件檔案</div>
      <div class="attachment-list" style="margin-bottom:10px">
        <div class="attachment-item">
          <span class="attachment-icon">📄</span>
          <div style="flex:1"><div class="attachment-name">病摘原文.pdf</div><div class="attachment-meta">2.3 MB・${shortDate('2026/06/10')} 上傳</div></div>
          <button class="btn btn-ghost btn-xs" onclick="alert('預覽附件：病摘原文.pdf')">預覽</button>
        </div>
        <div class="attachment-item">
          <span class="attachment-icon">🎬</span>
          <div style="flex:1"><div class="attachment-name">家屬提供影片.mp4</div><div class="attachment-meta">15.8 MB・${shortDate('2026/06/11')} 上傳</div></div>
          <button class="btn btn-ghost btn-xs" onclick="alert('預覽附件：家屬提供影片.mp4')">預覽</button>
        </div>
      </div>
      ${(isDoc||isNur)?`<div style="font-size:11px;color:var(--gray-500);background:var(--gray-50);padding:8px 10px;border-radius:6px">此為個案病摘資料，僅供查閱，如需修改請聯繫負責個管師。</div>`:''}
      ${(isNur&&c.nurseNotified)?`<div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="confirmNurseReceived('${caseId}')">✓ 已確定接收</button></div>`:''}
      ${isMgr?`<div class="upload-zone" style="padding:14px" onclick="alert('選擇檔案上傳（PDF / Word / JPG / 影片）')"><div style="font-size:12px">📎 點擊或拖曳上傳附件（PDF / Word / JPG / 影片）</div></div>`:''}
    </div>
  </div>`;
}
function renderJudgeSection(c,isAdm){
  const caseId=c.id;
  return `
  <div class="section-card" id="sj-judge-section-${caseId}" style="margin-top:14px">
    <div class="sc-header">
      <div class="sc-title">🩺 PAC 收案判斷</div>
      ${!isAdm?`<button class="btn btn-ghost btn-xs" onclick="openJudgeHandoffView()">🔁 轉交判斷</button>`:''}
    </div>
    <div class="sc-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        ${judgeOption('是 PAC',true,isAdm,caseId)}
        ${judgeOption('非 PAC',false,isAdm,caseId)}
        ${judgeOption('需再評估',false,isAdm,caseId)}
      </div>
      ${showNonPacOptions?renderNonPacOptionsInline(caseId):''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>判斷 PAC 疾病別</label>
          <select class="form-control" id="pac-disease-category-${caseId}" ${isAdm?'disabled':''}>
            <option value="">請選擇</option>
            ${['腦中風','脆弱性骨折','衰弱高齡','創傷性神經損傷'].map(d=>`<option ${((c.diseaseCategory||c.disease)===d)?'selected':''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>判斷者</label>
          <select class="form-control" id="pac-judged-by-${caseId}" ${isAdm?'disabled':''}>
            ${JUDGE_PERSONS.map(p=>`<option ${((c.judgedBy||'張宗達 醫師')===p)?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1"><label>判斷原因</label><textarea class="form-control" rows="2" ${isAdm?'readonly':''}>個案符合 ${c.disease} PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。</textarea></div>
        <div class="form-group" style="grid-column:1/-1"><label>補充建議</label><textarea class="form-control" rows="2" ${isAdm?'readonly':''}>建議優先安排物理及職能治療，語言治療視評估結果決定頻率。</textarea></div>
      </div>
      ${!isAdm?`
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="submitPacJudgment('${caseId}')">送出判斷</button>
      </div>
      `:''}
    </div>
  </div>`;
}
// 判斷結果為「非 PAC」後內嵌顯示的 5 個後續處理選項：居家醫療／復健病房（僅腦中風）／一般（復健）／一般（開刀）／其他服務不收案
// 這裡只負責記錄使用者勾選了哪一個（selectedNonPacOption，手動控制單選，不用瀏覽器 radio），實際動作留到「送出判斷」才執行（見 submitPacJudgment）
let selectedNonPacOption=null;
const NON_PAC_OPTIONS=[
  {key:'home',label:'居家醫療'},
  {key:'rehabward',label:'復健病房',strokeOnly:true},
  {key:'general_rehab',label:'一般（復健）'},
  {key:'general_surgery',label:'一般（開刀）'},
  {key:'archive',label:'其他服務／不收案'},
];
function renderNonPacOptionsInline(caseId){
  const isStroke=nonPacSelectedDisease==='腦中風';
  const options=NON_PAC_OPTIONS.filter(o=>!o.strokeOnly||isStroke);
  return `
  <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gray-100)">
    <div style="font-size:12px;color:var(--gray-500);margin-bottom:8px">已判斷為非PAC，請選擇後續處理方式：</div>
    <div class="checklist" style="margin:0">
      ${options.map(o=>`<div class="check-item" onclick="selectNonPacOption('${o.key}','${caseId}')"><input type="checkbox" ${selectedNonPacOption===o.key?'checked':''} onclick="event.preventDefault()"><span>${o.label}</span></div>`).join('')}
    </div>
  </div>`;
}
// 勾選後續處理方式：只更新畫面上的勾選狀態（單選，勾選新的會取消前一個），不立即執行對應動作
function selectNonPacOption(key,caseId){
  selectedNonPacOption=(selectedNonPacOption===key)?null:key;
  refreshSummaryJudgeModal(caseId);
}

// ── 輔助翻譯：同一彈窗內容切換視圖，不開第二層彈窗，「← 返回」切回主畫面 ──
function renderSummaryTranslateView(){
  return `
  <div class="info-note blue">系統輔助翻譯僅供參考，請結合臨床判斷。翻譯結果不會自動留存。</div>
  <div style="font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:6px;margin-top:12px">主訴</div>
  <div class="trans-panel" style="margin-bottom:16px">
    <div class="trans-box"><div class="trans-box-header">英文原文</div><div class="trans-box-body">Sudden right-sided weakness and slurred speech</div></div>
    <div class="trans-box"><div class="trans-box-header">中文翻譯</div><div class="trans-box-body">突發右側肢體無力及言語不清</div></div>
  </div>
  <div style="font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:6px">入院診斷</div>
  <div class="trans-panel" style="margin-bottom:16px">
    <div class="trans-box"><div class="trans-box-header">英文原文</div><div class="trans-box-body">Acute left MCA territory infarction with right hemiparesis and aphasia</div></div>
    <div class="trans-box"><div class="trans-box-header">中文翻譯</div><div class="trans-box-body">急性左側大腦中動脈區域梗塞，合併右側偏癱及失語症</div></div>
  </div>
  <div style="font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:6px">出院診斷</div>
  <div class="trans-panel" style="margin-bottom:16px">
    <div class="trans-box"><div class="trans-box-header">英文原文</div><div class="trans-box-body">Left MCA infarction, post-thrombolysis, neurologically stable for PAC rehabilitation</div></div>
    <div class="trans-box"><div class="trans-box-header">中文翻譯</div><div class="trans-box-body">左側大腦中動脈梗塞，接受溶栓治療後，神經學狀況穩定，適合接受 PAC 復健療程</div></div>
  </div>
  <div style="font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:6px">病史</div>
  <div class="trans-panel">
    <div class="trans-box"><div class="trans-box-header">英文原文</div><div class="trans-box-body">高血壓病史10年、第二型糖尿病病史5年</div></div>
    <div class="trans-box"><div class="trans-box-header">中文翻譯</div><div class="trans-box-body">高血壓病史10年、第二型糖尿病病史5年</div></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:12px">
    <button class="btn btn-ghost btn-sm" onclick="alert('翻譯對照已下載')">⬇ 下載對照</button>
  </div>`;
}
function openSummaryTranslateView(){
  summaryJudgeView='translate';
  refreshSummaryJudgeModal(currentCase);
}

// ── 轉交判斷：同一彈窗內容切換視圖，不開第二層彈窗，「← 返回」切回主畫面 ──
function renderJudgeHandoffView(){
  return `
  <div class="info-note blue">選擇要委託判斷的人員，系統將發送通知。</div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
    <div class="form-group"><label>委託對象</label><select class="form-control" id="sj-handoff-target"><option>張宗達醫師（復健科）</option><option>陳玉玲護理師</option></select></div>
    <div class="form-group"><label>判斷事項說明</label><textarea class="form-control" rows="3" id="sj-handoff-note" placeholder="說明需要判斷的重點，例如：開刀位置是否符合收案條件..."></textarea></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:14px">
    <button class="btn btn-primary btn-sm" onclick="submitJudgeHandoff()">送出委託</button>
  </div>`;
}
function openJudgeHandoffView(){
  summaryJudgeView='handoff';
  refreshSummaryJudgeModal(currentCase);
}
function submitJudgeHandoff(){
  closeModal('modal-summary-judge');
  summaryJudgeView='main';
  alert('已送出委託，對方將收到通知');
}

function summaryJudgeGoBack(){
  summaryJudgeView='main';
  refreshSummaryJudgeModal(currentCase);
}

function openSummaryJudgeModal(caseId,focusKey){
  currentCase=caseId;
  summaryJudgeView='main';
  showNonPacOptions=false;
  selectedNonPacOption=null;
  delete judgeSelectedOption[caseId];
  delete ocrState[caseId];
  refreshSummaryJudgeModal(caseId);
  openModal('modal-summary-judge');
  setTimeout(()=>{
    const target=document.getElementById((focusKey==='judge'?'sj-judge-section-':'sj-summary-section-')+caseId);
    if(target) target.scrollIntoView({block:'start',behavior:'smooth'});
  },0);
}
function refreshSummaryJudgeModal(caseId){
  const body=document.getElementById('summary-judge-modal-body');
  const c=CASES.find(x=>x.id===caseId);
  if(body&&c) body.innerHTML=renderSummaryJudgeModalBody(c);
  const backBtn=document.getElementById('summary-judge-back-btn');
  if(backBtn) backBtn.classList.toggle('hidden', summaryJudgeView==='main');
}

// ── 家屬確認彈窗 ──
let familyNoteEditCaseId=null;
let familyInfoEditCaseId=null; // 家屬姓名／關係／聯絡電話三欄的編輯狀態，與下方筆記區的編輯狀態各自獨立（比照上游聯絡彈窗做法）
function renderFamilyContactModalBody(c){
  const isMgr=currentRole==='mgr';
  const caseId=c.id;
  const infoEditing=isMgr&&familyInfoEditCaseId===caseId;
  const noteEditing=isMgr&&familyNoteEditCaseId===caseId;
  const infoField=(label,value,id)=>infoEditing
    ?`<div class="info-item"><label>${label}</label><input class="form-control" id="${id}" value="${value||''}"></div>`
    :`<div class="info-item"><label>${label}</label><span>${value||'—'}</span></div>`;
  return `
  <div class="section-card">
    <div class="sc-body">
      ${isMgr?`
      <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
        ${infoEditing
          ?`<button class="btn btn-primary btn-xs" onclick="saveFamilyInfoEdit('${caseId}')">✓ 儲存</button>`
          :`<button class="btn btn-ghost btn-xs" onclick="toggleFamilyInfoEdit('${caseId}')">✏️ 編輯</button>`}
      </div>`:''}
      <div class="info-grid-2" style="margin-bottom:14px">
        ${infoField('家屬姓名',c.familyName,'fc-name-'+caseId)}
        ${infoField('關係',c.familyRelation,'fc-relation-'+caseId)}
        ${infoField('聯絡電話',c.familyPhone,'fc-phone-'+caseId)}
      </div>
      ${isMgr?`
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button class="btn btn-secondary btn-sm" onclick="confirmArrival('${caseId}')">確定報到</button>
        <button class="btn btn-secondary btn-sm" onclick="openNoShowArchive()">確定不報到</button>
      </div>
      `:''}

      <div style="border-top:1px solid var(--gray-100);padding-top:12px">
        <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
          ${isMgr?(noteEditing
            ?`<button class="btn btn-primary btn-xs" onclick="saveFamilyNote('${caseId}')">✓ 儲存</button>`
            :`<button class="btn btn-ghost btn-xs" onclick="toggleFamilyNoteEdit('${caseId}')">✏️ 編輯</button>`):''}
        </div>
        ${noteEditing
          ?`<input class="form-control" id="fc-note-${caseId}" style="width:100%" value="${c.familyNote||''}">`
          :`<div style="font-size:13px;color:${c.familyNote?'var(--gray-700)':'var(--gray-400)'}">${c.familyNote||'尚無筆記'}</div>`}
      </div>
    </div>
  </div>`;
}
function openFamilyContactModal(caseId){
  currentCase=caseId;
  familyNoteEditCaseId=null;
  familyInfoEditCaseId=null;
  refreshFamilyContactModal(caseId);
  openModal('modal-family-contact');
}
function toggleFamilyInfoEdit(caseId){
  familyInfoEditCaseId=caseId;
  refreshFamilyContactModal(caseId);
}
function saveFamilyInfoEdit(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(c){
    const name=document.getElementById('fc-name-'+caseId);
    const relation=document.getElementById('fc-relation-'+caseId);
    const phone=document.getElementById('fc-phone-'+caseId);
    if(name) c.familyName=name.value;
    if(relation) c.familyRelation=relation.value;
    if(phone) c.familyPhone=phone.value;
    touchCase(c);
  }
  familyInfoEditCaseId=null;
  refreshFamilyContactModal(caseId);
  renderList(document.getElementById('main-content'));
}
function toggleFamilyNoteEdit(caseId){
  familyNoteEditCaseId=caseId;
  refreshFamilyContactModal(caseId);
}
function saveFamilyNote(caseId){
  const c=CASES.find(x=>x.id===caseId);
  const noteInput=document.getElementById('fc-note-'+caseId);
  if(c&&noteInput){
    c.familyNote=noteInput.value;
    touchCase(c);
  }
  familyNoteEditCaseId=null;
  refreshFamilyContactModal(caseId);
}
function refreshFamilyContactModal(caseId){
  const body=document.getElementById('family-contact-modal-body');
  const c=CASES.find(x=>x.id===caseId);
  if(body&&c) body.innerHTML=renderFamilyContactModalBody(c);
}

// ── 上游聯絡彈窗（不提供「新增」，聯絡資訊三項行內編輯＋獨立筆記區）──
let upstreamEditCaseId=null;
let upstreamNoteEditCaseId=null;
function renderUpstreamInfoModalBody(c){
  const isMgr=currentRole==='mgr'&&c.status!=='封存'; // 已結束紀錄唯讀化：編輯／設常用／確認回報等按鈕自動隱藏
  const caseId=c.id;
  const editing=isMgr&&upstreamEditCaseId===caseId;
  const noteEditing=isMgr&&upstreamNoteEditCaseId===caseId;
  const infoField=(label,value,id)=>editing
    ?`<div class="info-item"><label>${label}</label><input class="form-control" id="${id}" value="${value||''}"></div>`
    :`<div class="info-item"><label>${label}</label><span>${value||'—'}</span></div>`;
  const statusBadgeCls=c.upstreamStatus==='已回報收案'?'badge-green':c.upstreamStatus==='已回報退案'?'badge-red':'badge-amber';
  const statusBadgeText=c.upstreamStatus==='已回報收案'?'已回報收案':c.upstreamStatus==='已回報退案'?'已回報退案':'尚未回報';
  return `
  <div class="section-card">
    <div class="sc-body">
      ${isMgr?`
      <div class="form-group" style="margin-bottom:12px">
        <label>從常用聯絡人選擇</label>
        <select class="form-control" onchange="applyFrequentUpstreamContact('${caseId}',this.value)">
          <option value="">選擇以帶入聯絡人資料（可選）</option>
          ${FREQUENT_UPSTREAM_CONTACTS.map((p,i)=>`<option value="${i}">${p.name}・${p.hospital}</option>`).join('')}
        </select>
      </div>
      `:''}
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:6px">
        ${isMgr?`<button class="btn btn-secondary btn-xs" onclick="openUpstreamContactModal()">✅ 確認回報</button>`:''}
        ${isMgr?(editing
          ?`<button class="btn btn-primary btn-xs" onclick="saveUpstreamEdit('${caseId}')">✓ 儲存</button>`
          :`<button class="btn btn-ghost btn-xs" onclick="toggleUpstreamEdit('${caseId}')">✏️ 編輯</button>`):''}
      </div>
      <div class="info-grid-2" style="margin-bottom:12px">
        ${infoField('上游醫院',c.source,'ue-source-'+caseId)}
        ${infoField('轉介窗口',c.upstreamContact?.name,'ue-name-'+caseId)}
        ${editing
          ?`<div class="info-item"><label>聯絡電話</label><input class="form-control" id="ue-phone-${caseId}" value="${c.upstreamContact?.phone||''}"></div>
             <div class="info-item"><label>Line</label><input class="form-control" id="ue-line-${caseId}" value="${c.upstreamContact?.line||''}"></div>`
          :`<div class="info-item"><label>聯絡電話 / Line</label><span>${c.upstreamContact?.phone||'—'} ／ ${c.upstreamContact?.line||'—'}</span></div>`}
        <div class="info-item">
          <label>聯繫狀態</label>
          <span class="badge ${statusBadgeCls}">${statusBadgeText}</span>
        </div>
      </div>
      ${isMgr?`<div style="margin-bottom:14px"><a href="javascript:void(0)" style="font-size:11px;color:var(--blue);text-decoration:none;cursor:pointer" onclick="setUpstreamContactAsFrequent('${caseId}')">☆ 設為常用</a></div>`:''}

      <div style="border-top:1px solid var(--gray-100);padding-top:12px">
        <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
          ${isMgr?(noteEditing
            ?`<button class="btn btn-primary btn-xs" onclick="saveUpstreamNote('${caseId}')">✓ 儲存</button>`
            :`<button class="btn btn-ghost btn-xs" onclick="toggleUpstreamNoteEdit('${caseId}')">✏️ 編輯</button>`):''}
        </div>
        ${noteEditing
          ?`<input class="form-control" id="ue-note-${caseId}" style="width:100%" value="${c.upstreamNote||''}">`
          :`<div style="font-size:13px;color:${c.upstreamNote?'var(--gray-700)':'var(--gray-400)'}">${c.upstreamNote||'尚無筆記'}</div>`}
      </div>
    </div>
  </div>`;
}
function openUpstreamInfoModal(caseId){
  currentCase=caseId;
  upstreamEditCaseId=null;
  upstreamNoteEditCaseId=null;
  refreshUpstreamInfoModal(caseId);
  openModal('modal-upstream-info');
}
function toggleUpstreamEdit(caseId){
  upstreamEditCaseId=caseId;
  refreshUpstreamInfoModal(caseId);
}
function saveUpstreamEdit(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(c){
    if(!c.upstreamContact) c.upstreamContact={name:'',phone:'',line:''};
    const source=document.getElementById('ue-source-'+caseId);
    const name=document.getElementById('ue-name-'+caseId);
    const phone=document.getElementById('ue-phone-'+caseId);
    const line=document.getElementById('ue-line-'+caseId);
    if(source) c.source=source.value;
    if(name) c.upstreamContact.name=name.value;
    if(phone) c.upstreamContact.phone=phone.value;
    if(line) c.upstreamContact.line=line.value;
    touchCase(c);
  }
  upstreamEditCaseId=null;
  refreshUpstreamInfoModal(caseId);
}
function toggleUpstreamNoteEdit(caseId){
  upstreamNoteEditCaseId=caseId;
  refreshUpstreamInfoModal(caseId);
}
function saveUpstreamNote(caseId){
  const c=CASES.find(x=>x.id===caseId);
  const noteInput=document.getElementById('ue-note-'+caseId);
  if(c&&noteInput){
    c.upstreamNote=noteInput.value;
    touchCase(c);
  }
  upstreamNoteEditCaseId=null;
  refreshUpstreamInfoModal(caseId);
}
function refreshUpstreamInfoModal(caseId){
  const body=document.getElementById('upstream-info-modal-body');
  const c=CASES.find(x=>x.id===caseId);
  if(body&&c) body.innerHTML=renderUpstreamInfoModalBody(c);
}
function applyFrequentUpstreamContact(caseId,idx){
  if(idx===''||idx===null||idx===undefined) return;
  const c=CASES.find(x=>x.id===caseId);
  const p=FREQUENT_UPSTREAM_CONTACTS[idx];
  if(c&&p){
    c.upstreamContact={name:p.name,phone:p.phone,line:p.line};
    touchCase(c);
    refreshUpstreamInfoModal(caseId);
    renderList(document.getElementById('main-content'));
  }
}

// ── 住院排床彈窗（沿用既有床位安排業務邏輯，房型偏好一併移入此處）──
function renderHospBedModalBody(c){
  const isMgr=currentRole==='mgr';
  const isAdm=currentRole==='adm';
  const caseId=c.id;
  const bedFormHtml=(bedAssignFormOpen&&bedAssignFormCaseId===caseId)?(()=>{
    const defaultOpen=c.openDate?c.openDate.replace(/\//g,'-'):'2026-07-09';
    const defaultClose=c.closeDate?c.closeDate.replace(/\//g,'-'):calcCloseDateFromOpen(defaultOpen,c.diseaseCategory||c.disease);
    return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">
      <div class="form-group"><label>預計開案日期</label><input class="form-control" type="date" id="bed-assign-opendate-${caseId}" value="${defaultOpen}" oninput="updateBedAssignCloseDate('${caseId}')"></div>
      <div class="form-group"><label>預計結案日期</label><input class="form-control" type="date" id="bed-assign-closedate-${caseId}" value="${defaultClose}"></div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-primary btn-xs" onclick="confirmBedAssign('${caseId}')">確認</button>
      <button class="btn btn-ghost btn-xs" onclick="cancelBedAssignForm()">取消</button>
    </div>
    `;
  })():(c.bedAssigned?`
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:12px;color:var(--green);font-weight:600">✓ 已排床，預計開案日期：${shortDate(c.openDate)||'—'}，預計結案日期：${shortDate(c.closeDate)||'—'}</div>
      ${isMgr?`<a href="javascript:void(0)" style="font-size:10px;color:var(--gray-400);text-decoration:none;cursor:pointer" onclick="openBedAssignForm('${caseId}')">✏️ 修改</a>`:''}
    </div>
  `:(c.bedModuleImported?`
    <div style="display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:12px;color:var(--gray-400)">尚未排床</span>
      ${isMgr?`<button class="btn btn-secondary btn-xs" onclick="openBedAssignForm('${caseId}')">登記已排床</button>`:''}
    </div>
  `:''));
  const roomPrefBlock=`
  <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gray-100)">
    <div style="font-size:11px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">住院房型偏好（與排床模組同步）</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${['無偏好','單人房','雙人房','多人房（3人以上）'].map(opt=>{
        const prefMap={single:'單人房',double:'雙人房',multi:'多人房（3人以上）'};
        const currentPref=prefMap[c.roomPref]||'無偏好';
        const isSelected=opt===currentPref;
        return `<button class="btn ${isSelected?'btn-primary':'btn-secondary'} btn-xs" ${isAdm?'disabled':''} onclick="${isMgr?`alert('房型偏好已更新為「${opt}」，已同步至排床模組')`:''}">
          ${isSelected?'✓ ':''} ${opt}
        </button>`;
      }).join('')}
    </div>
    ${c.roomPref&&c.roomPref!==null?`<div style="font-size:11px;color:var(--blue);margin-top:6px">目前偏好已同步至排床模組，安排床位時將優先配對</div>`:''}
  </div>`;
  const importSectionHtml=isMgr?((bedImportFormOpen&&bedImportFormCaseId===caseId)?(()=>{
    const defaultImportOpen=c.openDate?c.openDate.replace(/\//g,'-'):'2026-07-09';
    return `
    <div style="margin-top:8px">
      <div class="form-group" style="margin-bottom:8px"><label>預計開案日期</label><input class="form-control" type="date" id="bed-import-opendate-${caseId}" value="${defaultImportOpen}"></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-xs" onclick="confirmBedImport('${caseId}')">確認匯入</button>
        <button class="btn btn-ghost btn-xs" onclick="cancelBedImportForm()">取消</button>
      </div>
    </div>`;
  })():(c.bedModuleImported
    ?`<div style="margin-top:8px;font-size:12px;color:var(--green);font-weight:600">✓ 已匯入排床模組</div>`
    :`<div style="margin-top:8px"><button class="btn btn-secondary btn-xs" onclick="openBedImportForm('${caseId}')">📤 匯入排床模組</button></div>`)):'';
  return `
  <div class="section-card">
    <div class="sc-body">
      ${bedFormHtml}
      <div style="font-size:10px;color:var(--gray-400);margin-top:8px">＊排床作業實際將於排床管理模組進行，此處為暫時性登記，待兩模組整合後串接</div>
      ${importSectionHtml}
      ${roomPrefBlock}
    </div>
  </div>`;
}
// 匯入排床模組：展開小表單輸入預計開案日期，確認後才真正寫入 c.openDate 並標記 c.bedModuleImported=true（本 prototype「收案管理」與「排床管理」為兩個獨立檔案、資料不互通，不做實際跨檔案資料傳遞）
let bedImportFormOpen=false;
let bedImportFormCaseId=null;
function openBedImportForm(caseId){
  bedImportFormOpen=true;
  bedImportFormCaseId=caseId;
  refreshHospBedModal(caseId);
}
function cancelBedImportForm(){
  bedImportFormOpen=false;
  bedImportFormCaseId=null;
  refreshHospBedModal(currentCase);
}
function confirmBedImport(caseId){
  const c=CASES.find(x=>x.id===caseId);
  const dateInput=document.getElementById('bed-import-opendate-'+caseId);
  if(c){
    if(dateInput&&dateInput.value) c.openDate=dateInput.value.replace(/-/g,'/');
    c.bedModuleImported=true;
    touchCase(c);
  }
  bedImportFormOpen=false;
  bedImportFormCaseId=null;
  alert(`已匯入排床管理模組，預計開案日期：${dateInput?dateInput.value:''}。＊此 prototype 中「收案管理」與「排床管理」是兩個獨立檔案、資料不互通，實際串接後將自動把此個案資料匯入排床管理模組。`);
  refreshHospBedModal(caseId);
}
function openHospBedModal(caseId){
  currentCase=caseId;
  refreshHospBedModal(caseId);
  openModal('modal-hosp-bed');
}
function refreshHospBedModal(caseId){
  const body=document.getElementById('hosp-bed-modal-body');
  const c=CASES.find(x=>x.id===caseId);
  if(body&&c) body.innerHTML=renderHospBedModalBody(c);
}

// ── 居家收案流程彈窗（沿用既有①②步驟業務邏輯 renderModeFlowBlock，未修改）──
function openHomeFlowModal(caseId){
  currentCase=caseId;
  refreshHomeFlowModal(caseId);
  openModal('modal-home-flow');
}
function refreshHomeFlowModal(caseId){
  const body=document.getElementById('home-flow-modal-body');
  const c=CASES.find(x=>x.id===caseId);
  if(body&&c) body.innerHTML=renderModeFlowBlock(c,currentRole==='mgr');
}

// ── 階段徽章：依照護模式分流至住院排床／居家收案流程彈窗；日照無獨立流程，僅提示 ──
function openStageModal(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(!c) return;
  if(c.modeType==='hosp') openHospBedModal(caseId);
  else if(c.modeType==='home') openHomeFlowModal(caseId);
  else alert('日照模式無獨立流程彈窗，請至「病摘與PAC判斷」或「家屬聯絡」查看進度。');
}

// ── 上游聯絡人：設為常用（沿用既有「從常用清單選擇」設計，儲存後供下次新增個案或其他個案快速帶入）──
function setUpstreamContactAsFrequent(caseId){
  const c=CASES.find(x=>x.id===caseId);
  if(!c||!c.upstreamContact||!c.upstreamContact.name||c.upstreamContact.name==='—'){
    alert('此個案尚無上游聯絡人資料可設為常用');
    return;
  }
  const exists=FREQUENT_UPSTREAM_CONTACTS.some(p=>p.name===c.upstreamContact.name&&p.phone===c.upstreamContact.phone);
  if(exists){ alert('此聯絡人已在常用清單中'); return; }
  FREQUENT_UPSTREAM_CONTACTS.push({name:c.upstreamContact.name,hospital:c.source,phone:c.upstreamContact.phone,line:c.upstreamContact.line});
  refreshUpstreamInfoModal(caseId);
  alert(`已將「${c.upstreamContact.name}」加入常用聯絡人清單，下次新增個案時可從清單快速選取。`);
}

// judgeSelectedOption：追蹤各個案目前選取中的判斷結果（caseId -> label），未選取時預設「是 PAC」，
// 讓選取「非 PAC」當下能立即重新渲染顯示後續選項，且重新渲染時不會遺失使用者剛選的選項
let judgeSelectedOption={};
function judgeOption(label,selectedDefault,disabled,caseId){
  const selected=(judgeSelectedOption[caseId]||'是 PAC')===label;
  return `<div class="judge-option ${selected?'selected':''} ${disabled?'':''}" style="${disabled?'cursor:default;opacity:.85':''}" onclick="${disabled?'':`onJudgeOptionSelect('${caseId}','${label}')`}">
    <input type="radio" name="judge-result-${caseId}" ${selected?'checked':''} ${disabled?'disabled':''}><span>${label}</span>
  </div>`;
}
// 點擊判斷結果選項：選「非 PAC」時立即帶出下方 5 個後續處理選項（不用等按送出判斷），選其他選項則收起
function onJudgeOptionSelect(caseId,label){
  judgeSelectedOption[caseId]=label;
  if(label==='非 PAC'){
    const categorySel=document.getElementById('pac-disease-category-'+caseId);
    const c=CASES.find(x=>x.id===caseId);
    nonPacSelectedDisease=(categorySel&&categorySel.value)?categorySel.value:(c?c.disease:null);
    showNonPacOptions=true;
    selectedNonPacOption=null;
  }else{
    showNonPacOptions=false;
    selectedNonPacOption=null;
  }
  refreshSummaryJudgeModal(caseId);
}

function submitPacJudgment(caseId){
  currentCase=caseId;
  const selected=document.querySelector('input[name="judge-result-'+caseId+'"]:checked');
  const result=selected?selected.nextElementSibling.textContent:'是 PAC';
  const c=getCurrentCaseObj();
  const judgedBySel=document.getElementById('pac-judged-by-'+caseId);
  if(c&&judgedBySel) c.judgedBy=judgedBySel.value;
  touchCase(c);
  if(result==='是 PAC'){
    const categorySel=document.getElementById('pac-disease-category-'+caseId);
    if(!categorySel||!categorySel.value){alert('請選擇 PAC 疾病別分類');return;}
    if(c) c.diseaseCategory=categorySel.value;
    closeModal('modal-summary-judge');
    // 是PAC判斷送出後直接套用「確定收案」的邏輯（原本 confirmCollection 對應 variant 的處理），不再另外跳「是否確定收案？」彈窗
    if(c&&c.modeType==='hosp'){
      c.nurseNotified=true;
      c.status='待排床';
      c.timelineStep='待排床';
      c.bedImportIsPac=true;
      delete c.timelineSub;
      touchCase(c);
      alert(`已通知專科護理師：${c.name} 已確定收案，請留意`);
      renderPage('detail',currentCase);
    } else if(c&&c.modeType==='day'){
      const defaultOpenDate='2026-07-09';
      const defaultCloseDate=calcCloseDateFromOpen(defaultOpenDate,c.diseaseCategory||c.disease);
      c.nurseNotified=true;
      c.status='待聯絡';
      c.timelineStep='待聯絡';
      c.timelineSub='待個案／家屬確認';
      c.openDate=defaultOpenDate.replace(/-/g,'/');
      c.closeDate=defaultCloseDate.replace(/-/g,'/');
      touchCase(c);
      alert('已確認日照收案，狀態更新為「待聯絡」');
      renderPage('detail',currentCase);
    } else {
      if(c){
        c.status='待評估';
        c.timelineStep='待評估';
        c.timelineSub='待交付居家報名';
      }
      alert('判斷結果：是 PAC\n\n請點擊列表中該個案的「階段」徽章開啟「居家收案流程」，完成①交付復健主管居家報名，待復健主管確認可承接，才會進入「確認收案」。');
      renderPage('detail',currentCase);
    }
  } else if(result==='非 PAC'){
    const categorySel=document.getElementById('pac-disease-category-'+caseId);
    nonPacSelectedDisease=(categorySel&&categorySel.value)?categorySel.value:(c?c.disease:null);
    showNonPacOptions=true;
    if(!selectedNonPacOption){
      refreshSummaryJudgeModal(caseId);
      alert('請先選擇後續處理方式');
      return;
    }
    const nonPacActions={
      home:()=>nonPacGoHomeCare(),
      rehabward:()=>nonPacGoRehabWard(),
      general_rehab:()=>nonPacGoGeneral('一般（復健）'),
      general_surgery:()=>nonPacGoGeneral('一般（開刀）'),
      archive:()=>nonPacGoArchive(),
    };
    const action=nonPacActions[selectedNonPacOption];
    if(action) action();
  } else {
    closeModal('modal-summary-judge');
    alert('判斷結果：需再評估\n\n狀態維持不變，已記錄本次判斷意見供後續參考');
    renderPage('detail',currentCase);
  }
}

function renderModeFlowBlock(c,isMgr){
  // 住院／日照收案流程已整合進「PAC 收案判斷」送出動作（見 submitPacJudgment → openCollectionConfirmModal），此處不再顯示對應卡片
  if(c.modeType==='home'){
    const step1Delivered=c.timelineSub==='待復健主管回覆是否收治居家復健';

    const step1Html=step1Delivered?`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--gray-200);border-radius:7px">
        <div style="font-size:12px"><strong>① 交付復健主管居家報名</strong><div style="font-size:11px;color:var(--green);margin-top:2px;font-weight:600">✓ 已交付復健主管，等待回覆</div></div>
      </div>`:`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--gray-200);border-radius:7px">
        <div style="font-size:12px"><strong>① 交付復健主管居家報名</strong><div style="font-size:11px;color:var(--gray-400);margin-top:2px">傳送時間／個案基本資料／病摘／住址給復健主管</div></div>
        ${isMgr?`<button class="btn btn-secondary btn-xs" onclick="openHomeStep1DeliverModal('${c.id}')">交付</button>`:''}
      </div>`;

    let step2Html;
    // 來源標籤：目前僅有個管師代填一種路徑；rehabReportBy==='rehab'（復健主管本人回報）為未來擴充，尚未串接
    const rehabSourceBadge=(c.rehabReportBy==='rehab'
      ?''
      :'<span class="badge badge-gray" style="margin-left:6px">🔖 個管師代填</span>')
      +(isMgr?`<a href="javascript:void(0)" style="font-size:10px;color:var(--gray-400);text-decoration:none;cursor:pointer;margin-left:6px" onclick="editRehabReport('${c.id}')">✏️ 修改</a>`:'');
    if(c.rehabReport==='可承接'){
      step2Html=`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--blue-mid);border-radius:7px;background:var(--blue-light)">
        <div style="font-size:12px"><strong>② 確認復健受理</strong><div style="font-size:11px;color:var(--blue);margin-top:2px;font-weight:600">✓ 復健主管已回覆：可承接${rehabSourceBadge}</div></div>
        ${isMgr?`<button class="btn btn-green btn-xs" onclick="confirmRehabAccepted('${c.id}')">確認收案</button>`:''}
      </div>`;
    } else if(c.rehabReport==='無法承接'){
      step2Html=`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid #FECACA;border-radius:7px;background:var(--red-light)">
        <div style="font-size:12px"><strong>② 確認復健受理</strong><div style="font-size:11px;color:var(--red);margin-top:2px;font-weight:600">✕ 復健主管已回覆：無法承接（量能不足）${rehabSourceBadge}</div></div>
        ${isMgr?`<button class="btn btn-danger btn-xs" onclick="openArchiveModal({presetType:'居家不收治',locked:true})">PAC不收案紀錄</button>`:''}
      </div>`;
    } else {
      step2Html=`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--gray-200);border-radius:7px">
        <div style="font-size:12px"><strong>② 確認復健受理</strong>
          <div style="font-size:11px;color:var(--gray-400);margin-top:2px">復健主管回報承接後，個管師點選確認記錄（不影響主要時間軸節點）</div>
          <div style="font-size:10px;color:var(--gray-400);margin-top:2px">＊復健主管本人回報功能將於居家排班管理模組上線，此處暫由個管師代為登記</div>
        </div>
        ${isMgr?`<div style="display:flex;gap:6px"><button class="btn btn-secondary btn-xs" onclick="registerRehabReport('${c.id}','可承接')">登記回覆：可承接</button><button class="btn btn-danger btn-xs" onclick="registerRehabReport('${c.id}','無法承接')">登記回覆：無法承接</button></div>`:''}
      </div>`;
    }

    return `
    <div class="section-card">
      <div class="sc-body">
        <div style="display:flex;flex-direction:column;gap:8px">
          ${step1Html}
          ${step2Html}
        </div>
      </div>
    </div>`;
  }
  return '';
}

// ── 工具函式 ──
// ── 新增諮詢：管路快選 Badge（可複選，與下方自由輸入欄位以頓號串接，重複點擊同一項可取消）──
function toggleNewCaseTubeBadge(label){
  const input=document.getElementById('new-manual-tubes');
  if(!input) return;
  const current=input.value.split('、').map(s=>s.trim()).filter(Boolean);
  const idx=current.indexOf(label);
  if(idx>-1) current.splice(idx,1); else current.push(label);
  input.value=current.join('、');
}
// 展開列基本資訊區「管路」快選：邏輯與 toggleNewCaseTubeBadge 相同，改為操作 be-tubes-${caseId} 這個動態 id 的輸入框
function toggleBasicEditTubeBadge(caseId,label){
  const input=document.getElementById('be-tubes-'+caseId);
  if(!input) return;
  const current=input.value.split('、').map(s=>s.trim()).filter(Boolean);
  const idx=current.indexOf(label);
  if(idx>-1) current.splice(idx,1); else current.push(label);
  input.value=current.join('、');
}
function resetNewCaseForm(){
  ['new-manual-name','new-manual-age','new-manual-location','new-manual-onsetdate','new-manual-address','new-manual-familyphone','new-manual-tubes','new-manual-disease','new-manual-mode'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
}
// ── 新增諮詢：僅收集 7 項基本資訊，建立一筆狀態為「收案判斷中」的個案，其餘欄位（疾病別／病摘／照護模式等）留待展開列逐步補齊 ──
function saveNewCase(){
  const name=(document.getElementById('new-manual-name').value||'').trim();
  if(!name){ alert('請輸入姓名'); return; }
  const ageVal=document.getElementById('new-manual-age').value;
  const age=ageVal?parseInt(ageVal,10):null;
  const birthDate=(age!==null&&!isNaN(age))?`${2026-age}/01/01`:null; // 僅收集年齡，以固定月/日換算出可供 calcAge() 使用的估計出生日期
  const location=(document.getElementById('new-manual-location').value||'').trim();
  const onsetDateVal=document.getElementById('new-manual-onsetdate').value;
  const onsetDate=onsetDateVal?onsetDateVal.replace(/-/g,'/'):null;
  const address=(document.getElementById('new-manual-address').value||'').trim();
  const familyPhone=(document.getElementById('new-manual-familyphone').value||'').trim();
  const tubes=(document.getElementById('new-manual-tubes').value||'').trim();
  const diseaseVal=document.getElementById('new-manual-disease').value;
  const modeVal=document.getElementById('new-manual-mode').value;

  const newCase={
    id:'c'+Date.now(),
    name,
    birthDate,
    gender:'男',
    mode:modeVal||'',
    modeType:modeVal?MODE_TYPE_MAP[modeVal]:null,
    disease:diseaseVal||'',
    source:location||'—',
    date:TODAY_STR,
    lastUpdated:TODAY_STR,
    onsetDate,
    familyConfirmStatus:'尚未決定',
    status:'收案判斷中',
    mgr:ROLES.mgr.name,
    timelineStep:'收案判斷中',
    upstreamStatus:'尚未回報',
    address:address||null,
    familyPhone:familyPhone||null,
    tubes:tubes||null,
  };
  CASES.push(newCase);
  closeModal('modal-new');
  resetNewCaseForm();
  alert(`已建立新諮詢個案：${name}，狀態為「收案判斷中」。請至列表展開該筆個案，逐步補齊疾病別／病摘／照護模式等資料。`);
  renderPage('list');
}

function openModal(id){document.getElementById(id).classList.remove('hidden')}
function closeModal(id){document.getElementById(id).classList.add('hidden')}
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',function(e){if(e.target===this)this.classList.add('hidden')}));

function getCurrentCaseObj(){
  return CASES.find(x=>x.id===currentCase)||null;
}

// ── 預估出院動向（總覽 Tab，僅正式病歷個案，個管師可編輯）──
function updateDischargeDest(caseId,value){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  if(c){
    c.dischargeDest=value;
    if(value!=='其他') delete c.dischargeDestNote;
  }
  renderPage('detail',currentCase);
}
function updateDischargeDestNote(value){
  const c=getCurrentCaseObj();
  if(c) c.dischargeDestNote=value;
}

// ── 病摘 Tab：護理師確認已接收查看通知（原儀表板佇列上的「✕」按鈕移至此處）──
function confirmNurseReceived(caseId){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  if(c) c.nurseNotified=false;
  alert('已確認接收，請至杏翔系統完成病摘登打。');
  if(c){
    refreshSummaryJudgeModal(caseId);
    renderPage('detail',currentCase);
  }
}

// ── 病摘卡片：住院診斷／出院診斷／病史 編輯 → 儲存（僅臨時病歷階段個管師可用）──
function toggleSummaryEdit(caseId){
  currentCase=caseId;
  if(summaryEditMode){
    const c=CASES.find(x=>x.id===caseId);
    if(c){
      const cc=document.getElementById('summary-chief-complaint-'+caseId);
      const adm=document.getElementById('summary-admission-dx-'+caseId);
      const dis=document.getElementById('summary-discharge-dx-'+caseId);
      const mh=document.getElementById('summary-medical-history-'+caseId);
      if(cc) c.chiefComplaint=cc.value;
      if(adm) c.admissionDiagnosis=adm.value;
      if(dis) c.dischargeDiagnosis=dis.value;
      if(mh) c.medicalHistory=mh.value;
      touchCase(c);
    }
    summaryEditMode=false;
    refreshSummaryJudgeModal(caseId);
    renderList(document.getElementById('main-content'));
    alert('病摘已更新，若英文原文有變動，建議重新點擊「輔助翻譯」核對中文對照內容');
  } else {
    summaryEditMode=true;
    summaryEditCaseId=caseId;
    refreshSummaryJudgeModal(caseId);
  }
}

// ── 居家收案流程 步驟①：交付復健主管居家報名，比照日照確認收案 Modal 做法，先確認預計開案／結案日期再正式交付 ──
function openHomeStep1DeliverModal(caseId){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  const defaultOpenDate='2026-07-09';
  closeModal('modal-home-flow');
  document.getElementById('home-step1-opendate').value=defaultOpenDate;
  document.getElementById('home-step1-closedate').value=calcCloseDateFromOpen(defaultOpenDate,c?(c.diseaseCategory||c.disease):null);
  openModal('modal-home-step1');
}
function updateHomeStep1CloseDate(){
  const c=getCurrentCaseObj();
  const openVal=document.getElementById('home-step1-opendate')?.value;
  if(!openVal||!c) return;
  document.getElementById('home-step1-closedate').value=calcCloseDateFromOpen(openVal,c.diseaseCategory||c.disease);
}
function confirmHomeStep1Deliver(){
  const c=getCurrentCaseObj();
  const openVal=document.getElementById('home-step1-opendate')?.value;
  const closeVal=document.getElementById('home-step1-closedate')?.value;
  if(c){
    c.status='待評估';
    c.timelineStep='待評估';
    c.timelineSub='待復健主管回覆是否收治居家復健';
    c.homeStep1Delivered=true;
    if(openVal) c.openDate=openVal.replace(/-/g,'/');
    if(closeVal) c.closeDate=closeVal.replace(/-/g,'/');
    touchCase(c);
  }
  closeModal('modal-home-step1');
  alert('已傳送個案資料給復健主管，等待復健主管回覆是否收治居家復健。');
  if(c) renderPage('detail',currentCase);
}

// ── 住院／臨時病歷階段：床位安排暫時性手動登記（排床管理模組上線後改由該模組串接）──
function openBedAssignForm(caseId){
  currentCase=caseId;
  bedAssignFormOpen=true;
  bedAssignFormCaseId=caseId;
  refreshHospBedModal(caseId);
}
function cancelBedAssignForm(){
  bedAssignFormOpen=false;
  refreshHospBedModal(currentCase);
}
function updateBedAssignCloseDate(caseId){
  const c=CASES.find(x=>x.id===caseId);
  const openVal=document.getElementById('bed-assign-opendate-'+caseId)?.value;
  if(!openVal||!c) return;
  document.getElementById('bed-assign-closedate-'+caseId).value=calcCloseDateFromOpen(openVal,c.diseaseCategory||c.disease);
}
// 排床登記完成時，模擬帶入排床模組的實際床位號（依 caseId 決定固定的示範床位，同一個案重複「修改」不會變動床位）
const DEMO_BED_POOL=['601-B','302-D','508-C','606-A','512-B','307-E'];
function pickDemoBedNo(caseId){
  let hash=0;
  for(let i=0;i<caseId.length;i++) hash+=caseId.charCodeAt(i);
  return DEMO_BED_POOL[hash%DEMO_BED_POOL.length];
}
function confirmBedAssign(caseId){
  currentCase=caseId;
  const c=CASES.find(x=>x.id===caseId);
  const openVal=document.getElementById('bed-assign-opendate-'+caseId)?.value;
  const closeVal=document.getElementById('bed-assign-closedate-'+caseId)?.value;
  if(c){
    if(openVal) c.openDate=openVal.replace(/-/g,'/');
    if(closeVal) c.closeDate=closeVal.replace(/-/g,'/');
    c.bedAssigned=true;
    if(!c.assignedBedNo) c.assignedBedNo=pickDemoBedNo(caseId);
    c.timelineStep='待聯絡';
    c.timelineSub='待個案／家屬確認';
    touchCase(c);
  }
  bedAssignFormOpen=false;
  if(c){
    refreshHospBedModal(caseId);
    renderPage('detail',currentCase);
  }
}

// 居家收案流程 步驟②：復健主管回覆「可承接」後，個管師點擊確認，比照住院/日照直接視為確認收案，跳過中間步驟直接進入「待聯絡」
function confirmRehabAccepted(caseId){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  if(c){
    c.status='待聯絡';
    c.timelineStep='待聯絡';
    c.timelineSub='待個案／家屬確認';
    c.nurseNotified=true;
    touchCase(c);
  }
  alert('已確認收案，已通知專科護理師查看病摘');
  if(c){
    refreshHomeFlowModal(caseId);
    renderPage('detail',currentCase);
  }
}
// 居家收案流程 步驟②：復健主管本人回報功能尚未上線，此處暫由個管師代為電話聯繫後登記回覆結果
function registerRehabReport(caseId,result){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  if(c){
    c.rehabReport=result;
    c.rehabReportBy='mgr';
    touchCase(c);
  }
  alert(result==='可承接'?'已登記復健主管回覆：可承接。':'已登記復健主管回覆：無法承接。');
  if(c){
    refreshHomeFlowModal(caseId);
    renderPage('detail',currentCase);
  }
}
// 居家收案流程 步驟②：訂正先前登記的復健主管回覆，清空後回到「登記回覆」按鈕狀態重新登記
function editRehabReport(caseId){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  if(c){
    delete c.rehabReport;
    delete c.rehabReportBy;
    touchCase(c);
    refreshHomeFlowModal(caseId);
  }
  if(c) renderPage('detail',currentCase);
}
// ── PAC 收案判斷「是 PAC」→ 確定收案（住院／日照／居家醫師已回報PAC 共用）──
// variant: 'hosp'（僅提示文字）| 'day' | 'homePac'（提示文字＋預計開案日期＋自動算出的結案日期，沿用 PAC_CARE_PERIOD weeksMax 算法）
let collectionConfirmCtx=null;
function calcCloseDateFromOpen(openDateStr,disease){
  const period=PAC_CARE_PERIOD[disease];
  const weeks=period?period.weeksMax:12;
  const d=new Date(openDateStr);
  d.setDate(d.getDate()+weeks*7);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function updateCollectionConfirmCloseDate(){
  const c=getCurrentCaseObj();
  const openVal=document.getElementById('collection-confirm-opendate')?.value;
  if(!openVal||!c) return;
  document.getElementById('collection-confirm-closedate').value=calcCloseDateFromOpen(openVal,c.diseaseCategory||c.disease);
}
function openCollectionConfirmModal(caseId,variant){
  currentCase=caseId;
  collectionConfirmCtx={caseId,variant};
  const c=getCurrentCaseObj();
  const withDate=variant==='day'||variant==='homePac';
  if(withDate){
    const defaultOpenDate='2026-07-09';
    const defaultCloseDate=calcCloseDateFromOpen(defaultOpenDate,c?(c.diseaseCategory||c.disease):null);
    document.getElementById('collection-confirm-body').innerHTML=`
      <div class="info-note blue">是否確定收案？</div>
      <div class="form-group" style="margin-top:12px;margin-bottom:12px">
        <label>預計開案日期</label>
        <input class="form-control" type="date" id="collection-confirm-opendate" value="${defaultOpenDate}" oninput="updateCollectionConfirmCloseDate()">
      </div>
      <div class="form-group">
        <label>結案日期（預估）</label>
        <input class="form-control" type="date" id="collection-confirm-closedate" readonly value="${defaultCloseDate}">
      </div>
    `;
  } else {
    document.getElementById('collection-confirm-body').innerHTML=`<div class="info-note blue">是否確定收案？確認後將自動通知專科護理師查看病摘</div>`;
  }
  openModal('modal-collection-confirm');
}
function confirmCollection(){
  const {variant}=collectionConfirmCtx||{};
  const c=getCurrentCaseObj();
  if(!c){closeModal('modal-collection-confirm');return;}
  c.nurseNotified=true;
  if(variant==='hosp'){
    c.status='待排床';
    c.timelineStep='待排床';
    c.bedImportIsPac=true;
    delete c.timelineSub;
    closeModal('modal-collection-confirm');
    alert(`已通知專科護理師：${c.name} 已確定收案，請留意`);
  } else {
    const openVal=document.getElementById('collection-confirm-opendate')?.value;
    const closeVal=document.getElementById('collection-confirm-closedate')?.value;
    c.status='待聯絡';
    c.timelineStep='待聯絡';
    c.timelineSub='待個案／家屬確認';
    if(variant==='day'&&openVal) c.openDate=openVal.replace(/-/g,'/');
    if(closeVal) c.closeDate=closeVal.replace(/-/g,'/');
    closeModal('modal-collection-confirm');
    alert(variant==='day'?'已確認日照收案，狀態更新為「待聯絡」':'已確認居家收案，狀態更新為「待聯絡」');
  }
  touchCase(c);
  renderPage('detail',currentCase);
}

// 家屬聯繫紀錄「個案確定報到」：狀態與時間軸推進為「待開案」
function confirmArrival(caseId){
  currentCase=caseId;
  const c=getCurrentCaseObj();
  if(c){
    c.status='待開案';
    c.timelineStep='待開案';
    c.familyConfirmStatus='決定報到';
    delete c.timelineSub;
    touchCase(c);
  }
  closeModal('modal-family-contact');
  alert('已確認個案確定報到，狀態更新為「待開案」');
  if(c) renderPage('detail',currentCase);
}
// 家屬聯繫紀錄「確定不報到」：依個案照護模式自動預選對應PAC不收案紀錄類型，理由欄必填
function openNoShowArchive(){
  const c=getCurrentCaseObj();
  if(c){ c.familyConfirmStatus='決定不報到'; touchCase(c); }
  closeModal('modal-family-contact');
  const presetMap={hosp:'決定不報到／參加',day:'決定不報到／參加',home:'決定不報到／參加'};
  openArchiveModal({presetType:(c&&presetMap[c.modeType])||'決定不報到／參加',locked:true});
}

// ── 交付行政建檔（由折疊列新增的「交付建檔」欄按鈕觸發）：帶入既有預計開案／結案日，未填過則留空讓使用者直接輸入 ──
function openConvertModal(caseId){
  currentCase=caseId;
  const c=CASES.find(x=>x.id===caseId);
  if(!c) return;
  document.getElementById('convert-opendate').value=c.openDate?c.openDate.replace(/\//g,'-'):'';
  document.getElementById('convert-closedate').value=c.closeDate?c.closeDate.replace(/\//g,'-'):'';
  openModal('modal-convert');
}
// ── 交付行政建檔：不再從 CASES 移除，改為標記 c.deliveredToAdmin=true，待行政角色另外「確認建檔完成」才真正移除（見 confirmAdminFinalize）──
function confirmConvertToFormal(){
  const c=getCurrentCaseObj();
  if(!c){ closeModal('modal-convert'); return; }
  const openInput=document.getElementById('convert-opendate');
  const closeInput=document.getElementById('convert-closedate');
  const openVal=openInput?openInput.value:'';
  const closeVal=closeInput?closeInput.value:'';
  if(!openVal||!closeVal){ alert('請填寫預計開案日與預計結案日'); return; }
  const origOpen=c.openDate?c.openDate.replace(/\//g,'-'):'';
  const origClose=c.closeDate?c.closeDate.replace(/\//g,'-'):'';
  const dateChanged=(openVal!==origOpen)||(closeVal!==origClose);
  // 住院模式且已排床者，異動日期改用自訂彈窗詢問是否一併清除床位預約，兩個選項都會完成日期儲存（見 resolveBedDateChange）
  if(dateChanged&&c.modeType==='hosp'&&c.bedAssigned){
    bedDateChangeCtx={source:'convert',caseId:c.id,openVal,closeVal};
    closeModal('modal-convert');
    openModal('modal-bed-date-change');
    return;
  }
  // 已完成居家報名交付者，異動日期需再次確認後續已同步處理，取消則維持原日期不變
  if(dateChanged&&c.homeStep1Delivered){
    if(!confirm('⚠️ 修改日期後，居家復健報名需要重新交付、排床登記也需要對應改期，請確認後續已同步處理。')){
      openInput.value=origOpen;
      closeInput.value=origClose;
      return;
    }
  }
  finalizeConvertToFormal(c,openVal,closeVal);
}
function finalizeConvertToFormal(c,openVal,closeVal){
  c.openDate=openVal.replace(/-/g,'/');
  c.closeDate=closeVal.replace(/-/g,'/');
  c.deliveredToAdmin=true;
  c.deliveredToAdminDate=TODAY_STR;
  touchCase(c);
  closeModal('modal-convert');
  alert('已交付行政建檔，個案資料已保留，待行政人員確認建檔完成後才會從收案管理列表移除。');
  renderPage('list');
}
// 行政角色「確認建檔完成」：先要求輸入病歷號，確認後才真正把個案從收案管理的 CASES 移除，模擬移交「個案管理」模組（本 prototype 兩模組資料不互通，不做實際跨檔案資料傳遞）
let adminFinalizeCaseId=null;
function confirmAdminFinalize(caseId){
  adminFinalizeCaseId=caseId;
  const input=document.getElementById('admin-finalize-mrn');
  if(input) input.value='';
  openModal('modal-admin-finalize');
}
function submitAdminFinalize(){
  const caseId=adminFinalizeCaseId;
  const c=CASES.find(x=>x.id===caseId);
  if(!c){ closeModal('modal-admin-finalize'); return; }
  const input=document.getElementById('admin-finalize-mrn');
  const mrn=(input?input.value:'').trim();
  if(!mrn){ alert('請輸入病歷號'); return; }
  c.medicalRecordNo=mrn;
  const idx=CASES.indexOf(c);
  if(idx>-1) CASES.splice(idx,1);
  closeModal('modal-admin-finalize');
  adminFinalizeCaseId=null;
  alert(`已完成建檔（病歷號：${mrn}），個案已移交個案管理模組`);
  renderPage('list');
}


// ── PAC 判斷＝非PAC：依疾病別決定選項（居家醫療／一般（復健）／一般（開刀）／其他服務・不收案，腦中風額外多一個復健病房）
// 5 個選項內嵌顯示於「病摘與PAC判斷」彈窗（見 renderNonPacOptionsInline），點擊後維持既有的「關閉目前彈窗、開啟下一個」做法──
let nonPacSelectedDisease=null;
// 居家醫療：收案判斷階段當下即可分流的非PAC情境（與正式病歷階段醫師到宅評估後才發現非PAC，屬另一獨立情境），直接列為「PAC不收案紀錄」，類型鎖定「轉居家醫療」，不需匯入排床模組
function nonPacGoHomeCare(){
  showNonPacOptions=false;
  selectedNonPacOption=null;
  closeModal('modal-summary-judge');
  openArchiveModal({presetType:'轉居家醫療',locked:true});
}
// 疾病別為腦中風時的選項：直接列為「PAC不收案紀錄」，類型鎖定「轉復健病房」，跳過匯入排床模組流程
function nonPacGoRehabWard(){
  showNonPacOptions=false;
  selectedNonPacOption=null;
  closeModal('modal-summary-judge');
  openArchiveModal({presetType:'轉復健病房',locked:true});
}
function nonPacGoArchive(){
  showNonPacOptions=false;
  selectedNonPacOption=null;
  closeModal('modal-summary-judge');
  openArchiveModal({presetType:'非PAC退案',locked:true});
}
// 一般（復健）／一般（開刀）：住院／日照個案選擇「是PAC」或「非PAC→一般」後，皆彈窗詢問是否匯入排床模組，匯入時標記 bedImportIsPac=false 供排床模組區分使用
function nonPacGoGeneral(type){
  const c=getCurrentCaseObj();
  const importBed=confirm(`已選擇「${type}」。是否將個案資料匯入排床管理模組？`);
  if(c){
    c.modeType='general';
    c.mode='一般';
    c.disease=type;
    c.status='封存';
    c.archiveType=type;
    c.archiveReason=`收案判斷確認為非PAC個案，選擇類型：${type}${importBed?'，個案資料已移交排床管理模組':''}。`;
    c.archiveDate='2026/07/09';
    c.archiveOperator='林美惠';
    c.bedImportIsPac=false;
    c.timelineStep=null;
    delete c.timelineSub;
    touchCase(c);
  }
  showNonPacOptions=false;
  selectedNonPacOption=null;
  closeModal('modal-summary-judge');
  alert(importBed
    ?`已選擇「${type}」。個案資料已移交排床管理模組，可於排床模組「個案管理匯入」Tab 中選取此個案進行排床。收案管理模組中本個案狀態更新為「PAC不收案紀錄」。`
    :`已選擇「${type}」。收案管理模組中本個案狀態更新為「PAC不收案紀錄」。`);
  if(c) renderPage('detail',currentCase);
}

// ── 轉換照護模式（本模組僅臨時病歷階段：選模式→填日期備註→送出即重置為新模式的起始進度，其餘資料保留）──
const MODE_TYPE_MAP={'住院':'hosp','日照':'day','居家':'home'};
let convertModeCtx=null;
function openConvertModeModal(caseId){
  currentCase=caseId;
  convertModeCtx={step:'pick',newMode:null};
  renderConvertModeModal();
  openModal('modal-convert-mode');
}
function convertModeNext(){
  const checked=document.querySelector('input[name="convert-mode-radio"]:checked');
  if(!checked){alert('請選擇要轉換的照護模式');return;}
  convertModeCtx.newMode=checked.value;
  convertModeCtx.step='details';
  renderConvertModeModal();
}
function convertModeBack(){
  convertModeCtx.step='pick';
  renderConvertModeModal();
}
function renderConvertModeModal(){
  const c=getCurrentCaseObj();
  document.getElementById('convert-mode-title').textContent='轉換照護模式';
  if(convertModeCtx.step==='pick'){
    const options=['住院','日照','居家'].filter(m=>!c||m!==c.mode);
    document.getElementById('convert-mode-body').innerHTML=`
      <div class="info-note blue" style="margin-bottom:12px">轉換後將保留現有所有紀錄，療程週數不重新計算。</div>
      <div class="retire-list">
        ${options.map(m=>`
          <label class="retire-opt">
            <input type="radio" name="convert-mode-radio" value="${m}" ${convertModeCtx.newMode===m?'checked':''}>
            <span style="font-size:13px">${m}</span>
          </label>`).join('')}
      </div>
    `;
    document.getElementById('convert-mode-footer').innerHTML=`
      <button class="btn btn-secondary" onclick="closeModal('modal-convert-mode')">取消</button>
      <button class="btn btn-primary" onclick="convertModeNext()">下一步</button>
    `;
    return;
  }
  document.getElementById('convert-mode-body').innerHTML=`
    <div class="info-note blue" style="margin-bottom:12px">轉換後將重置為新模式時間軸的起始進度，其餘個案資料（病摘、家屬聯絡等）維持不變。</div>
    <div class="form-group" style="margin-bottom:10px"><label>轉換日期</label><input class="form-control" type="date" id="convert-mode-date" value="2026-07-09"></div>
    <div class="form-group"><label>備註（選填）</label><textarea class="form-control" rows="2" id="convert-mode-note" placeholder="補充說明..."></textarea></div>
  `;
  document.getElementById('convert-mode-footer').innerHTML=`
    <button class="btn btn-secondary" onclick="convertModeBack()">上一步</button>
    <button class="btn btn-primary" onclick="confirmConvertMode()">確認轉換</button>
  `;
}
function confirmConvertMode(){
  const c=getCurrentCaseObj();
  if(!c){ closeModal('modal-convert-mode'); return; }
  const {newMode}=convertModeCtx;
  const dateVal=document.getElementById('convert-mode-date')?.value;
  const noteVal=(document.getElementById('convert-mode-note')?.value||'').trim();
  const dateStr=dateVal?dateVal.replace(/-/g,'/'):'2026/07/09';
  if(!c.modeHistory) c.modeHistory=[];
  c.modeHistory.push({from:c.mode,to:newMode,date:dateStr,note:noteVal});
  c.mode=newMode;
  c.modeType=MODE_TYPE_MAP[newMode];
  const firstNode=TIMELINE_TEMP_BY_MODE[c.modeType][0];
  c.timelineStep=firstNode.label;
  c.status=firstNode.label;
  if(firstNode.sub) c.timelineSub=firstNode.sub; else delete c.timelineSub;
  touchCase(c);
  closeModal('modal-convert-mode');
  alert(`照護模式已轉換為 ${newMode}`);
  renderPage('detail',currentCase);
}
// ── PAC不收案紀錄 Modal（統一入口，可鎖定單一類型；本模組僅臨時病歷一套清單）──
// opts: {presetType, locked}
let archiveCtx=null;
function openArchiveModal(opts){
  archiveCtx={presetType:null,locked:false,...opts};
  renderArchiveModalBody();
  openModal('modal-archive');
}

function selectArchiveType(type){
  archiveCtx.presetType=type;
  renderArchiveModalBody();
}

function archiveTypeDef(type){
  return ARCHIVE_TYPES_TEMP.find(o=>o.type===type)||null;
}

function renderArchiveModalBody(){
  const {presetType,locked}=archiveCtx;
  document.getElementById('archive-modal-title').textContent=locked&&presetType?`PAC不收案紀錄確認：${presetType}`:'PAC不收案紀錄';

  const optsHtml=locked
    ? `<div class="retire-list"><div class="retire-opt selected" style="cursor:default;opacity:.85"><input type="radio" checked disabled><span style="font-size:13px">${presetType}</span></div></div>`
    : `<div class="retire-list">${ARCHIVE_TYPES_TEMP.map(o=>`
        <div class="retire-opt ${o.type===presetType?'selected':''}" onclick="selectArchiveType('${o.type}')">
          <input type="radio" name="archive-type" ${o.type===presetType?'checked':''}><span style="font-size:13px">${o.type}</span>
        </div>`).join('')}</div>`;

  const def=presetType?archiveTypeDef(presetType):null;
  const fieldHtml=def&&def.field?`
    <div class="form-group" style="margin-bottom:10px">
      <label>${def.field} <span class="required">*</span></label>
      <textarea class="form-control" rows="2" id="archive-field-input" placeholder="${def.hint||''}"></textarea>
    </div>`:'';

  const note=`<div class="info-note amber">個案將列為「PAC不收案紀錄」，並記錄以下類型供後續統計。</div>`;

  document.getElementById('archive-modal-body').innerHTML=note+optsHtml+fieldHtml;
}

function confirmArchive(){
  const {locked}=archiveCtx;
  let type=archiveCtx.presetType;
  if(!locked){
    const checked=document.querySelector('input[name="archive-type"]:checked');
    if(!checked){alert('請選擇PAC不收案紀錄類型');return;}
  }
  if(!type){alert('請選擇PAC不收案紀錄類型');return;}
  const def=archiveTypeDef(type);
  let reasonText='';
  if(def&&def.field){
    const input=document.getElementById('archive-field-input');
    reasonText=input?input.value.trim():'';
    if(!reasonText){alert(`請填寫「${def.field}」`);return;}
  }
  const c=getCurrentCaseObj();
  // 「一般（復健）」／「一般（開刀）」為手動補選的非PAC個案類型，與 PAC 判斷流程的 nonPacGoGeneral 共用同一套彈窗詢問＋匯入標記邏輯
  const isGeneralType=(type==='一般（復健）'||type==='一般（開刀）');
  let importBed=false;
  if(isGeneralType){
    importBed=confirm(`已選擇「${type}」。是否將個案資料匯入排床管理模組？`);
  }
  if(c){
    c.status='封存';
    c.archiveType=type;
    c.archiveReason=isGeneralType
      ?`收案判斷確認為非PAC個案，選擇類型：${type}${importBed?'，個案資料已移交排床管理模組':''}。`
      :reasonText;
    c.archiveDate='2026/07/09';
    c.archiveOperator='林美惠';
    if(isGeneralType){
      c.modeType='general';
      c.mode='一般';
      c.disease=type;
      c.bedImportIsPac=false;
    }
    touchCase(c);
  }
  closeModal('modal-archive');
  alert(isGeneralType&&importBed
    ?`已選擇「${type}」。個案資料已移交排床管理模組，可於排床模組「個案管理匯入」Tab 中選取此個案進行排床。收案管理模組中本個案狀態更新為「PAC不收案紀錄」。`
    :'個案已列為「PAC不收案紀錄」');
  if(c) renderPage('detail',currentCase);
}

// ── 家屬聯繫紀錄：新增（「確定報到」已獨立成按鈕，此彈窗僅記錄「尚未確定／確定不報到」兩種結果）──
function openAddContactModal(caseId){
  currentCase=caseId;
  closeModal('modal-family-contact');
  document.getElementById('add-contact-body').innerHTML=`
    <div class="form-group" style="margin-bottom:12px">
      <label>聯繫日期與時間</label>
      <input class="form-control" type="datetime-local" id="fc-datetime" value="2026-07-09T09:30">
    </div>
    <div class="form-group" style="margin-bottom:12px">
      <label>聯繫方式</label>
      <select class="form-control" id="fc-method">
        <option>電話</option><option>其他</option>
      </select>
    </div>
    <div class="form-group" style="margin-bottom:12px">
      <label>聯繫內容</label>
      <textarea class="form-control" rows="3" id="fc-note" placeholder="記錄本次聯繫討論內容…"></textarea>
    </div>
    <div class="form-group">
      <label>本次聯繫結果</label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="radio" name="fc-result" value="尚未確定" checked style="accent-color:var(--blue)"> 尚未確定
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="radio" name="fc-result" value="確定不報到" style="accent-color:var(--blue)"> 確定不報到
        </label>
      </div>
    </div>
  `;
  openModal('modal-add-contact');
}
function confirmAddContact(){
  const c=getCurrentCaseObj();
  if(!c){ closeModal('modal-add-contact'); return; }
  const datetimeVal=document.getElementById('fc-datetime').value;
  const method=document.getElementById('fc-method').value;
  const note=(document.getElementById('fc-note').value||'').trim();
  const result=document.querySelector('input[name="fc-result"]:checked')?.value||'尚未確定';
  if(!c.familyContacts) c.familyContacts=[];
  c.familyContacts.push({
    datetime:datetimeVal?datetimeVal.replace('T',' '):'2026-07-09 09:30',
    method,
    note,
    result,
  });
  touchCase(c);
  closeModal('modal-add-contact');
  if(result==='確定不報到') openNoShowArchive();
  else {
    alert('已新增聯繫紀錄');
    openFamilyContactModal(c.id);
    renderList(document.getElementById('main-content'));
  }
}

// ── 上游聯繫紀錄：新增 ──
function openUpstreamContactModal(){
  closeModal('modal-upstream-info');
  document.getElementById('uc-datetime').value='2026-07-09T09:30';
  document.querySelector('input[name="uc-method"][value="電話"]').checked=true;
  ['uc-status-hosp','uc-status-day','uc-status-home','uc-status-decline'].forEach(id=>document.getElementById(id).checked=false);
  document.getElementById('uc-opendate').value='2026-07-09';
  document.getElementById('uc-opendate-wrap').classList.add('hidden');
  document.getElementById('uc-note').value='';
  openModal('modal-upstream-contact');
}

function toggleUpstreamOpenDate(){
  const anyAdmit=['uc-status-hosp','uc-status-day','uc-status-home'].some(id=>document.getElementById(id).checked);
  document.getElementById('uc-opendate-wrap').classList.toggle('hidden',!anyAdmit);
}

function submitUpstreamContact(){
  const c=getCurrentCaseObj();
  if(!c){closeModal('modal-upstream-contact');return;}
  const datetime=document.getElementById('uc-datetime').value;
  const method=document.querySelector('input[name="uc-method"]:checked').value;
  const statusBoxes=['uc-status-hosp','uc-status-day','uc-status-home','uc-status-decline'].map(id=>document.getElementById(id));
  const statuses=statusBoxes.filter(b=>b.checked).map(b=>b.value);
  const admitSelected=statuses.some(s=>s!=='已回報退案');
  const declineSelected=statuses.includes('已回報退案');
  const openDate=admitSelected?document.getElementById('uc-opendate').value:'';
  const note=document.getElementById('uc-note').value.trim();

  const entry={
    datetime:datetime.replace('T',' '),
    method,
    result:statuses.join('、')||null,
    openDate:openDate?openDate.replace(/-/g,'/'):'',
    note,
  };
  if(!c.upstreamLog) c.upstreamLog=[];
  c.upstreamLog.push(entry);
  if(admitSelected) c.upstreamStatus='已回報收案';
  else if(declineSelected) c.upstreamStatus='已回報退案';
  touchCase(c);

  closeModal('modal-upstream-contact');
  alert('已新增上游聯繫紀錄');
  openUpstreamInfoModal(c.id);
  renderList(document.getElementById('main-content'));
}

function switchRole(role){
  currentRole=role;
  const cfg=ROLES[role];
  document.getElementById('user-av').textContent=cfg.ch;
  document.getElementById('user-av').className='user-avatar '+cfg.av;
  document.getElementById('user-name').textContent=cfg.name;
  document.getElementById('user-role-label').textContent=cfg.label;

  if(role==='doc'||role==='nur'){
    // 醫師／護理師：預設停在收案中 Tab，並自動套用「收案判斷中」篩選，只顯示待判斷個案
    currentPage='list';
    currentListTab='temp';
    statusFilter='收案判斷中';
  }
  // 個管師（mgr）：維持現有行為，無變化

  // 重新渲染目前頁面
  if(currentPage==='list') renderPage('list');
  else if(currentPage==='detail'&&currentCase) renderPage('detail',currentCase);
}

// Init
renderPage('list');
