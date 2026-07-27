
// ── 角色設定 ──
const ROLES = {
  mgr:{name:'林美惠',label:'個案管理師',av:'av-mgr',ch:'林'},
  doc:{name:'張宗達',label:'醫師',av:'av-doc',ch:'張'},
  nur:{name:'陳玉玲',label:'護理師',av:'av-nur',ch:'陳'},
  adm:{name:'蔡書明',label:'行政',av:'av-adm',ch:'蔡'},
};
let currentRole='mgr';
let currentPage='list';
let currentCase=null;
let currentForm=null;
let statusFilter=null; // 個案列表狀態篩選：統計卡點擊套用
let extraCardFilter=null; // 統計卡「展延倒數7天／結案倒數14天／結案倒數7天」篩選：null｜'extDeadline'｜'closeSoon14'｜'closeSoon7'，與 statusFilter 互斥
let detailActiveTab='overview'; // 個案詳情頁目前開啟的 Tab，預設「總覽」
let detailActiveTabCaseId=null; // 記錄目前 Tab 狀態對應的個案 id，切換個案時自動重置為「總覽」
let rehabWeekIndex=1; // 居家復健排班目前檢視的週次（1-based）
let rehabWeekCaseId=null; // 記錄目前週次對應的個案 id，切換個案時自動重置為第1週

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
function calcAge(birthDateStr){
  // 簡化版年齡計算，prototype 示意用，輸入格式 yyyy/mm/dd 或 yyyy-mm-dd
  const today=new Date('2026-06-30');
  const d=new Date(birthDateStr.replace(/\//g,'-'));
  let age=today.getFullYear()-d.getFullYear();
  const m=today.getMonth()-d.getMonth();
  if(m<0||(m===0&&today.getDate()<d.getDate())) age--;
  return age;
}
// 個案是否曾經處於某照護模式（含目前模式），依 c.modeHistory 的 from／to 判斷，供轉換模式後「舊模式資料保留、唯讀顯示」使用
function wasEverMode(c,modeLabel){
  if(c.mode===modeLabel) return true;
  return (c.modeHistory||[]).some(h=>h.from===modeLabel||h.to===modeLabel);
}
// 轉換模式時若原本是居家：尚未發生（日期晚於或等於今日）的居家復健班次一律標記取消，已發生的班次維持原樣（比照轉居家醫療封存時的做法）
function cancelFutureHomeRehab(c){
  if(!c.homeRehabSchedule||!c.homeRehabSchedule.length) return;
  const today=new Date('2026-07-09');
  c.homeRehabSchedule.forEach(item=>{
    if(!item.date) return;
    const itemDate=new Date(item.date.replace(/\//g,'-'));
    if(!isNaN(itemDate)&&itemDate>=today) item.cancelled=true;
  });
}

// ── 個案列表排序（依 listSortOrder，作用於目前篩選後的個案列表）──
function parseDateStr(str){
  if(!str||str==='—') return null;
  const t=new Date(str.replace(/\//g,'-')).getTime();
  return isNaN(t)?null:t;
}
// listSortOrder → [排序依據欄位, 是否為「近→遠／舊→新」正序]；「建立日期」＝c.date（沿用原「收案日期」欄位，僅改名）、「最後更新時間」查無 c.updatedAt 時退回 c.date
const SORT_FIELD_MAP={
  dateDesc:['date',false], dateAsc:['date',true],
  openDateAsc:['openDate',true], openDateDesc:['openDate',false],
  closeDateAsc:['closeDate',true], closeDateDesc:['closeDate',false],
  updatedDesc:['updatedAt',false], updatedAsc:['updatedAt',true],
};
function sortCases(arr){
  const sorted=[...arr];
  if(listSortOrder==='nameAsc'){
    // 結案管理 Tab 排序選單沿用的舊選項（本次調整範圍僅限正式病歷 Tab，維持不變）
    sorted.sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant'));
    return sorted;
  }
  const cfg=SORT_FIELD_MAP[listSortOrder];
  if(cfg){
    const [field,asc]=cfg;
    sorted.sort((a,b)=>{
      const av=field==='updatedAt'?(a.updatedAt||a.date):a[field];
      const bv=field==='updatedAt'?(b.updatedAt||b.date):b[field];
      const ad=parseDateStr(av);
      const bd=parseDateStr(bv);
      if(ad===null&&bd===null) return 0;
      if(ad===null) return 1; // 無日期者排在最後
      if(bd===null) return -1;
      return asc?ad-bd:bd-ad;
    });
  }
  return sorted;
}

// ── 個案資料 ──
// 正式病歷階段狀態：照護中／展延中／即將結案／封存（顯示為「結案管理」）
// 結案（成功/失敗）不是獨立狀態，一律經由結案管理 Modal 直接轉為「封存」，類型記錄於 archiveType（正常結案／結案失敗）
// timelineStep：目前停在哪個時間軸節點
// archiveType：結案類型（僅封存狀態使用，詳情頁漸進式揭露）
// birthDate：出生日期，用於即時換算年齡；upstreamContact：上游聯絡人資訊；familyRelation：家屬關係
// roomPref：房型偏好（null=無偏好，'single'=單人房，'double'=雙人房，'multi'=多人房）
const CASES={
  formal:[
    {id:'f1',medicalRecordNo:'00073450',idNumber:'A123456789',name:'陳建國',birthDate:'1954/02/10',mode:'住院',modeType:'hosp',disease:'腦中風',source:'臺大醫院',date:'2026/06/10',updatedAt:'2026/06/24',status:'展延中',mgr:'林美惠',formal:true,countdown:2,week:2,timelineStep:'展延中',timelineSub:'待展延申請',assessmentStatus:'待填寫',assessments:{initial:true,f1:false,f2:false,f3:false,close:false},referral:{status:'待轉介',note:''},upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',openDate:'2026/06/10',closeDate:'2026/07/22',roomPref:'double',address:'彰化縣社頭鄉中山路33號',department:'神經內科',admissionDiagnosis:'Acute left MCA territory infarction with right hemiparesis and aphasia',dischargeDiagnosis:'Left MCA infarction, post-thrombolysis, neurologically stable for PAC rehabilitation',medicalHistory:'高血壓病史10年、第二型糖尿病病史5年',admissionTubes:'NG, Foley',onsetDate:'2026/06/08',icdCode:'I639',overviewNote:'',dischargeDest2:'',patientDest:'',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/06/12',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/26',week:'第3週',stage:'複評',status:'已逾期',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/07/20',week:'第6週',stage:'結案評估',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'腦中風',judgedBy:'張宗達 醫師',reason:'個案符合 腦中風 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},referralDoc:{name:'轉診單.pdf',size:'1.1 MB',date:'2026/06/10'}},
    {id:'f2',medicalRecordNo:'00073521',idNumber:'B234567891',name:'王淑芬',birthDate:'1958/08/03',mode:'住院',modeType:'hosp',disease:'脆弱性骨折',source:'彰基醫院',date:'2026/05/28',updatedAt:'2026/07/05',status:'展延中',mgr:'林美惠',formal:true,countdown:3,week:4,timelineStep:'展延中',timelineSub:'審核中',assessmentStatus:'待填寫',assessments:{initial:true,f1:true,f2:false,f3:false,close:false},referral:{status:'待轉介',note:''},upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'女兒',openDate:'2026/05/28',closeDate:'2026/06/11',roomPref:null,address:'彰化縣永靖鄉中山路77號',department:'骨科',admissionDiagnosis:'Closed fracture, left femoral neck, s/p fall',dischargeDiagnosis:'S/p left hip hemiarthroplasty, fracture healing well, ambulatory with walker',medicalHistory:'骨質疏鬆症病史，服用抗骨鬆藥物',admissionTubes:'Foley',onsetDate:'2026/05/26',icdCode:'S72002',overviewNote:'',dischargeDest2:'',patientDest:'',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/05/30',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/13',week:'第3週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/20',week:'第4週',stage:'結案評估',status:'已逾期',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'脆弱性骨折',judgedBy:'張宗達 醫師',reason:'個案符合 脆弱性骨折 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'}},
    {id:'f3',medicalRecordNo:'00073602',idNumber:'C198765432',name:'劉家豪',birthDate:'1949/05/22',mode:'居家',modeType:'home',disease:'腦中風',source:'台中榮總',date:'2026/06/05',updatedAt:'2026/07/08',status:'照護中',mgr:'林美惠',formal:true,countdown:null,week:3,timelineStep:'照護中',timelineSub:'展延後',assessmentStatus:'已填寫',assessments:{initial:true,f1:true,f2:true,f3:false,close:false},referral:{status:'待轉介',note:''},upstreamContact:{name:'陳出院準備護理師',phone:'04-3333-4444',line:'tc_chen'},familyRelation:'兒子',openDate:'2026/06/05',closeDate:'2026/07/17',roomPref:null,address:'彰化縣埔心鄉義民路22號',department:'神經內科',admissionDiagnosis:'Acute right MCA infarction with left hemiparesis',dischargeDiagnosis:'Right MCA infarction, stable, left hemiparesis, ambulatory with assistance',medicalHistory:'高血壓病史8年，無其他重大病史',admissionTubes:'無',onsetDate:'2026/06/02',icdCode:'I639',overviewNote:'',dischargeDest2:'',patientDest:'',homeVisitDate:'2026/06/20',homeVisitStaff:'李煜明（營養師）',dispositionNote:'',assessmentRecords:[{date:'2026/06/07',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/21',week:'第3週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/07/19',week:'第6週',stage:'結案評估',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'腦中風',judgedBy:'張宗達 醫師',reason:'個案符合 腦中風 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},homeRehabSchedule:[
      {dow:0,period:'午休',timeRange:'約 12:00-13:30',profession:'PT',therapist:'黃志豪',duration:'40分鐘',tag:null,signStatus:'已簽到'},
      {dow:1,period:'晚上',timeRange:'約 18:00-20:00',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,signStatus:'已簽到'},
      {dow:2,period:'午休',timeRange:'約 12:00-13:30',profession:'PT',therapist:'陳建成',duration:'40分鐘',tag:'複評',signStatus:'未簽到'},
      {dow:3,period:'晚上',timeRange:'約 18:00-20:00',profession:'ST',therapist:'林雅芳',duration:'40分鐘',tag:null,signStatus:'已簽到'},
      {dow:5,period:'午休',timeRange:'約 12:00-13:30',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,signStatus:null},
      {dow:6,period:'晚上',timeRange:'約 18:00-20:00',profession:'PT',therapist:'黃志豪',duration:'40分鐘',tag:null,signStatus:null},
    ]},
    {id:'f4',medicalRecordNo:'00073688',idNumber:'D287654321',name:'林翠娟',birthDate:'1946/10/11',mode:'住院',modeType:'hosp',disease:'脆弱性骨折',source:'台中榮總',date:'2026/04/15',updatedAt:'2026/06/20',status:'即將結案',mgr:'林美惠',formal:true,countdown:null,week:11,timelineStep:'即將結案',assessmentStatus:'已填寫',assessments:{initial:true,f1:true,f2:true,f3:true,close:false},referral:{status:'已轉介',target:'居家醫療',note:'已轉介居家照護服務，聯絡窗口已確認'},upstreamContact:{name:'陳出院準備護理師',phone:'04-3333-4444',line:'tc_chen'},familyRelation:'配偶',openDate:'2026/04/15',closeDate:'2026/04/29',roomPref:'single',address:'彰化縣溪州鄉中央路45號',department:'骨科',admissionDiagnosis:'Closed fracture, right intertrochanteric femur, s/p fall',dischargeDiagnosis:'S/p right proximal femoral nailing, fracture stable, weight-bearing as tolerated',medicalHistory:'骨質疏鬆症病史、高血壓病史7年',admissionTubes:'無',onsetDate:'2026/04/13',icdCode:'S72141',overviewNote:'',dischargeDest2:'門診復健',patientDest:'居家醫療',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/04/17',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/04/22',week:'第2週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/04/28',week:'第3週',stage:'結案評估',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'脆弱性骨折',judgedBy:'張宗達 醫師',reason:'個案符合 脆弱性骨折 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},dischargeDest:'返家＋居家照護服務'},
    {id:'f5',medicalRecordNo:'00073741',idNumber:'E176543210',name:'張明輝',birthDate:'1951/03/28',mode:'日照',modeType:'day',disease:'腦中風',source:'臺大醫院',date:'2026/05/01',updatedAt:'2026/06/15',status:'即將結案',mgr:'林美惠',formal:true,countdown:null,week:10,timelineStep:'即將結案',assessmentStatus:'已填寫',assessments:{initial:true,f1:true,f2:true,f3:true,close:false},referral:{status:'待轉介',note:'轉介長照服務，已聯繫長照管理中心'},upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',openDate:'2026/05/01',closeDate:'2026/06/12',roomPref:null,address:'彰化縣大村鄉村上路18號',department:'神經內科',admissionDiagnosis:'Acute left basal ganglia hemorrhage with right hemiparesis',dischargeDiagnosis:'Left basal ganglia ICH, stable post-conservative management, right hemiparesis improving',medicalHistory:'高血壓病史20年、心房顫動病史3年',admissionTubes:'無',onsetDate:'2026/04/29',icdCode:'I619',overviewNote:'',dischargeDest2:'門診復健',patientDest:'',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/05/03',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/05/24',week:'第4週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/11',week:'第10週',stage:'結案評估',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'腦中風',judgedBy:'張宗達 醫師',reason:'個案符合 腦中風 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},dischargeDest:'轉長照機構'},
    {id:'f6',medicalRecordNo:'00073809',idNumber:'F265432109',name:'吳建宏',birthDate:'1948/12/05',mode:'居家',modeType:'home',disease:'腦中風',source:'彰基醫院',date:'2026/03/01',updatedAt:'2026/07/01',status:'照護中',mgr:'林美惠',formal:true,countdown:null,week:7,timelineStep:'照護中',timelineSub:'展延後',hadExtensionFail:true,assessmentStatus:'待填寫',assessments:{initial:true,f1:true,f2:false,f3:false,close:false},referral:{status:'待轉介',note:''},upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'兒子',openDate:'2026/03/01',closeDate:'2026/05/24',roomPref:null,address:'彰化縣埔鹽鄉南新路9號',department:'神經內科',admissionDiagnosis:'Acute right MCA infarction with left hemiparesis and dysphagia',dischargeDiagnosis:'Right MCA infarction, stable, dysphagia improved, NG tube removed',medicalHistory:'糖尿病史15年、高血壓病史10年',admissionTubes:'NG',onsetDate:'2026/02/27',icdCode:'I639',overviewNote:'',dischargeDest2:'',patientDest:'',homeVisitDate:'2026/06/15',homeVisitStaff:'陳雅琪（社工師）',dispositionNote:'',assessmentRecords:[{date:'2026/03/03',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/03/24',week:'第4週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/05/20',week:'第7週',stage:'結案評估',status:'已逾期',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'腦中風',judgedBy:'張宗達 醫師',reason:'個案符合 腦中風 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},homeRehabSchedule:[
      {dow:0,period:'晚上',timeRange:'約 18:00-20:00',profession:'PT',therapist:'黃志豪',duration:'40分鐘',tag:null,signStatus:'已簽到'},
      {dow:1,period:'午休',timeRange:'約 12:00-13:30',profession:'ST',therapist:'林雅芳',duration:'40分鐘',tag:null,signStatus:'已簽到'},
      {dow:2,period:'晚上',timeRange:'約 18:00-20:00',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,signStatus:'已簽到'},
      {dow:3,period:'午休',timeRange:'約 12:00-13:30',profession:'PT',therapist:'陳建成',duration:'40分鐘',tag:null,signStatus:'未簽到'},
      {dow:5,period:'晚上',timeRange:'約 18:00-20:00',profession:'ST',therapist:'林雅芳',duration:'40分鐘',tag:'結案評估',signStatus:'已簽到'},
      {dow:6,period:'午休',timeRange:'約 12:00-13:30',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,signStatus:'已簽到'},
    ]},
    {id:'f7',medicalRecordNo:'00072215',idNumber:'G154321098',name:'王秀美',birthDate:'1942/09/14',mode:'住院',modeType:'hosp',disease:'腦中風',source:'臺大醫院',date:'2026/02/01',updatedAt:'2026/04/26',status:'封存',mgr:'林美惠',formal:true,countdown:null,week:12,timelineStep:null,extensionResult:'success',assessments:{initial:true,f1:true,f2:true,f3:true,close:true},referral:{status:'已轉介',target:'長照服務',note:'已轉介長照管理中心，後續由長照服務接續追蹤'},archiveType:'正常結案',archiveDate:'2026/04/26',archiveOperator:'林美惠',upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'女兒',openDate:'2026/02/01',closeDate:'2026/04/26',roomPref:'double',address:'彰化縣秀水鄉安東路60號',department:'神經內科',admissionDiagnosis:'Acute left MCA infarction with right hemiparesis',dischargeDiagnosis:'Left MCA infarction, stable, ambulatory with quad cane, discharged home',medicalHistory:'高血壓病史18年、陳舊性腦梗塞病史',admissionTubes:'Foley',onsetDate:'2026/01/30',icdCode:'I639',overviewNote:'',dischargeDest2:'門診復健',patientDest:'長照服務',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/02/03',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/03/07',week:'第5週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/04/25',week:'第12週',stage:'結案評估',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'腦中風',judgedBy:'張宗達 醫師',reason:'個案符合 腦中風 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'}},
    {id:'f8',medicalRecordNo:'00072960',idNumber:'H243210987',name:'郭志強',birthDate:'1956/04/27',mode:'居家',modeType:'home',disease:'脆弱性骨折',source:'彰化秀傳',date:'2026/01/10',updatedAt:'2026/07/09',status:'封存',mgr:'林美惠',formal:true,countdown:null,week:null,timelineStep:null,archiveType:'轉居家醫療',archiveDate:'2026/07/09',archiveOperator:'林美惠',extensionResult:null,assessments:{initial:true,f1:true,f2:false,f3:false,close:true},archiveReason:'醫師電話通知個管師，個案已轉為居家醫療計畫接續復健，PAC 系統追蹤至此結束。',upstreamContact:{name:'王個管師',phone:'04-2222-3333',line:'cy_wang'},familyRelation:'兒子',openDate:'2026/01/10',closeDate:'2026/01/24',roomPref:null,address:'彰化縣花壇鄉中山路150號',department:'骨科',admissionDiagnosis:'Closed fracture, left femoral neck, s/p fall at home',dischargeDiagnosis:'S/p left hip hemiarthroplasty, fracture healing well, discharged for home PAC rehabilitation',medicalHistory:'骨質疏鬆症病史、退化性關節炎',admissionTubes:'無',onsetDate:'2026/01/08',icdCode:'S72002',overviewNote:'',dischargeDest2:'其他',patientDest:'居家醫療',homeVisitDate:'2026/01/20',homeVisitStaff:'王建宏（職能治療師）',dispositionNote:'',assessmentRecords:[{date:'2026/01/12',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/01/19',week:'第2週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/01/23',week:'第3週',stage:'結案評估',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'脆弱性骨折',judgedBy:'張宗達 醫師',reason:'個案符合 脆弱性骨折 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},referral:{status:'已轉介',target:'居家醫療',note:'已轉介居家醫療團隊接續照護，聯絡窗口：陳個管師 04-XXXX-XXXX。'},homeRehabSchedule:[
      {dow:0,date:'2026/06/29',period:'午休',timeRange:'約 12:00-13:30',profession:'PT',therapist:'陳建成',duration:'40分鐘',tag:'初評'},
      {dow:1,date:'2026/06/30',period:'晚上',timeRange:'約 18:00-20:00',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null},
      {dow:2,date:'2026/07/01',period:'午休',timeRange:'約 12:00-13:30',profession:'ST',therapist:'林雅芳',duration:'40分鐘',tag:null},
      {dow:3,date:'2026/07/09',period:'晚上',timeRange:'約 18:00-20:00',profession:'PT',therapist:'黃志豪',duration:'40分鐘',tag:null,cancelled:true},
      {dow:5,date:'2026/07/11',period:'午休',timeRange:'約 12:00-13:30',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null,cancelled:true},
      {dow:6,date:'2026/07/12',period:'晚上',timeRange:'約 18:00-20:00',profession:'PT',therapist:'陳建成',duration:'40分鐘',tag:null,cancelled:true},
    ]},
    // 封存：正式病歷非PAC個案（PAC判斷後確認為非PAC，移交病床管理並封存於此模組）
    {id:'f9',medicalRecordNo:'00074011',idNumber:'J132109876',name:'陳淑真',birthDate:'1955/07/19',mode:'一般',modeType:'general',disease:'一般復健（中風/脊椎損傷，非PAC專案）',source:'門診',date:'2026/06/01',updatedAt:'2026/06/03',status:'封存',mgr:'林美惠',formal:true,countdown:null,week:null,timelineStep:null,extensionResult:null,archiveType:'非PAC個案',archiveDate:'2026/06/03',archiveOperator:'林美惠',assessments:{initial:true,f1:false,f2:false,f3:false,close:false},archiveReason:'收案判斷確認為非PAC個案，個案資料已移交病床管理模組統一管轄。',upstreamContact:{name:'—',phone:'—',line:'—'},familyRelation:'女兒',openDate:'2026/06/01',closeDate:'—',roomPref:null,address:'彰化縣芬園鄉彰南路5號',department:'復健科',admissionDiagnosis:'Post-surgical status, lumbar spine decompression, non-PAC rehabilitation',dischargeDiagnosis:'S/p lumbar spine surgery, stable, general rehabilitation continuing',medicalHistory:'退化性脊椎病史多年，長期下背痛',admissionTubes:'Foley',onsetDate:'2026/05/28',icdCode:'M4806',overviewNote:'',dischargeDest2:'其他',patientDest:'其他',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/06/03',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'—',week:'—',stage:'複評',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'—',week:'—',stage:'結案評估',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'非PAC',diseaseCategory:null,judgedBy:'張宗達 醫師',reason:'個案為腰椎手術後一般復健，不符合PAC收案條件（非腦中風／創傷性神經損傷／脆弱性骨折／衰弱高齡四大類別），建議轉一般復健追蹤。',suggestion:'轉介一般復健科門診追蹤，不需PAC團隊介入。'}},
    {id:'f13',medicalRecordNo:'00074233',idNumber:'K221098765',name:'許福來',birthDate:'1950/02/18',mode:'日照',modeType:'day',disease:'脆弱性骨折',source:'彰基醫院',date:'2026/03/10',updatedAt:'2026/04/07',status:'封存',mgr:'林美惠',formal:true,countdown:null,week:3,timelineStep:null,extensionResult:'fail',assessments:{initial:true,f1:true,f2:true,f3:false,close:true},referral:{status:'已轉介',target:'社工服務',note:'已轉介社工協助評估經濟補助資源'},archiveType:'結案失敗',archiveDate:'2026/04/07',archiveOperator:'林美惠',archiveReason:'展延申請未獲健保署核准，個案功能改善幅度未達展延標準，依規定結案。',upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'兒子',openDate:'2026/03/10',closeDate:'2026/04/07',roomPref:null,address:'彰化縣田中鎮中州路12號',department:'骨科',admissionDiagnosis:'Closed fracture, right distal radius, s/p fall',dischargeDiagnosis:'S/p closed reduction and casting, right distal radius fracture, stable alignment',medicalHistory:'骨質疏鬆症病史、退化性關節炎病史',admissionTubes:'無',onsetDate:'2026/03/08',icdCode:'S52501',overviewNote:'',dischargeDest2:'其他',patientDest:'社工服務',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/03/12',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/03/31',week:'第3週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/04/07',week:'第4週',stage:'結案評估',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'脆弱性骨折',judgedBy:'張宗達 醫師',reason:'個案符合 脆弱性骨折 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'}},
    // 測試個案：正式病歷／住院，專門用於測試「轉換模式」功能
    {id:'f10',medicalRecordNo:'00074102',idNumber:'L310987654',name:'住院轉模式',birthDate:'1955/03/12',mode:'住院',modeType:'hosp',disease:'脆弱性骨折',source:'彰化秀傳',date:'2026/05/28',updatedAt:'2026/06/22',status:'照護中',mgr:'林美惠',formal:true,countdown:null,week:2,timelineStep:'照護中',assessmentStatus:'待填寫',assessments:{initial:true,f1:false,f2:false,f3:false,close:false},referral:{status:'無需轉介',note:''},upstreamContact:{name:'王個管師',phone:'04-2222-3333',line:'cy_wang'},familyRelation:'女兒',familyPhone:'0922-111-222',openDate:'2026/06/01',closeDate:'2026/06/22',roomPref:'single',address:'彰化縣彰化市中正路50號',department:'骨科',admissionDiagnosis:'Closed fracture, right femoral neck, s/p fall at home',dischargeDiagnosis:'S/p right hip hemiarthroplasty, fracture healing well, weight-bearing as tolerated',medicalHistory:'骨質疏鬆症病史、高血壓病史8年',admissionTubes:'Foley',onsetDate:'2026/05/26',icdCode:'S72002',overviewNote:'',dischargeDest2:'',patientDest:'回家',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/06/03',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/22',week:'第3週',stage:'複評',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'—',week:'—',stage:'結案評估',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'脆弱性骨折',judgedBy:'張宗達 醫師',reason:'個案符合 脆弱性骨折 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'}},
    // 測試個案：正式病歷／日照，專門用於測試「轉換模式」功能
    {id:'f11',medicalRecordNo:'00074155',idNumber:'M209876543',name:'日照轉模式',birthDate:'1953/08/20',mode:'日照',modeType:'day',disease:'腦中風',source:'臺大醫院',date:'2026/05/03',updatedAt:'2026/06/30',status:'照護中',mgr:'林美惠',formal:true,countdown:null,week:7,timelineStep:'照護中',assessmentStatus:'已填寫',assessments:{initial:true,f1:true,f2:true,f3:false,close:false},referral:{status:'待轉介',note:''},upstreamContact:{name:'李護理師',phone:'02-1234-5678',line:'taida_li'},familyRelation:'兒子',familyPhone:'0933-222-333',openDate:'2026/05/10',closeDate:'2026/08/02',roomPref:null,address:'彰化縣員林市中山路一段66號',department:'神經內科',admissionDiagnosis:'Acute right MCA territory infarction with left hemiparesis',dischargeDiagnosis:'Right MCA infarction, stable, left hemiparesis improving, ambulatory with assistance',medicalHistory:'高血壓病史15年、心房顫動病史2年',admissionTubes:'無',onsetDate:'2026/05/01',icdCode:'I639',overviewNote:'',dischargeDest2:'',patientDest:'',homeVisitDate:'',homeVisitStaff:'',dispositionNote:'',assessmentRecords:[{date:'2026/05/12',week:'第1週',stage:'初評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/06/02',week:'第4週',stage:'複評',status:'已完成',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'2026/07/28',week:'第12週',stage:'結案評估',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'腦中風',judgedBy:'張宗達 醫師',reason:'個案符合 腦中風 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'}},
    // 測試個案：正式病歷／居家，專門用於測試「轉換模式」功能
    {id:'f12',medicalRecordNo:'00074198',idNumber:'N198765440',name:'居家轉模式',birthDate:'1948/11/05',mode:'居家',modeType:'home',disease:'衰弱高齡',source:'彰基醫院',date:'2026/06/08',updatedAt:'2026/06/28',status:'照護中',mgr:'林美惠',formal:true,countdown:null,week:2,timelineStep:'照護中',assessmentStatus:'待填寫',assessments:{initial:false,f1:false,f2:false,f3:false,close:false},referral:{status:'待轉介',note:''},upstreamContact:{name:'劉個管師',phone:'04-4444-5555',line:'cb_liu'},familyRelation:'配偶',familyPhone:'0955-333-444',openDate:'2026/06/15',closeDate:'2026/07/13',roomPref:null,address:'彰化縣和美鎮彰美路20號',department:'復健科',admissionDiagnosis:'General frailty syndrome with recurrent falls and decreased functional mobility',dischargeDiagnosis:'Frailty syndrome, stable, discharged home with PAC rehabilitation plan',medicalHistory:'高血壓病史18年、輕度肌少症',admissionTubes:'無',onsetDate:'2026/06/05',icdCode:'R54',overviewNote:'',dischargeDest2:'',patientDest:'',homeVisitDate:'2026/06/25',homeVisitStaff:'李煜明（營養師）',dispositionNote:'',assessmentRecords:[{date:'2026/06/17',week:'第1週',stage:'初評',status:'已逾期',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'—',week:'—',stage:'複評',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']},{date:'—',week:'—',stage:'結案評估',status:'尚未開始',therapists:['李大熊(PT)','陳姍姍(OT)','林怡如(ST)']}],judgeRecord:{result:'是PAC',diseaseCategory:'衰弱高齡',judgedBy:'張宗達 醫師',reason:'個案符合 衰弱高齡 PAC 收案條件，開刀位置及病摘內容確認無誤，建議收案。',suggestion:'建議優先安排物理及職能治療，語言治療視評估結果決定頻率。'},homeRehabSchedule:[
      {dow:1,period:'午休',timeRange:'約 12:00-13:30',profession:'PT',therapist:'黃志豪',duration:'40分鐘',tag:null},
      {dow:3,period:'晚上',timeRange:'約 18:00-20:00',profession:'OT',therapist:'李佳穎',duration:'40分鐘',tag:null},
      {dow:5,period:'午休',timeRange:'約 12:00-13:30',profession:'ST',therapist:'林雅芳',duration:'40分鐘',tag:null},
    ]},
  ]
};

// ── 通知鈴鐺（假資料）── 行政完成建檔後通知負責個管師
const NOTIFICATIONS=[
  {id:1,text:'陳志明 已成功轉為正式病歷，病歷號：00073450（行政 蔡書明 建檔，2026/06/25 14:20）',read:false},
  {id:2,text:'王淑芬 已成功轉為正式病歷，病歷號：00073521（行政 蔡書明 建檔，2026/06/24 11:05）',read:false},
];
let notifDropdownOpen=false;

// ── 預估出院動向選項（正式病歷個案基本資料／成功結案・不成功結案 Modal 共用）──
const DISCHARGE_DEST_OPTIONS=['','返家','返家＋居家照護服務','轉長照機構','轉其他醫院','死亡','其他'];

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
// 狀態顯示文字：底層狀態值仍為「封存」，僅顯示文字改為「結案管理」
function statusLabel(status){
  return status==='封存'?'結案管理':status;
}

// ── 距預計結案日的天數（prototype 假設今日為 2026/07/09）；查無有效日期則回傳 null ──
function daysUntilClose(closeDateStr){
  if(!closeDateStr||closeDateStr==='—') return null;
  const today=new Date('2026-07-09');
  const close=new Date(closeDateStr.replace(/\//g,'-'));
  if(isNaN(close)) return null;
  return Math.round((close-today)/(24*3600*1000));
}
// ── 剩餘天數（距預計結案日）：小於兩週（14天，含已逾期）視為緊急 ──
function remainingDaysInfo(closeDateStr){
  const days=daysUntilClose(closeDateStr);
  if(days===null) return {text:'—',urgent:false};
  if(days<0) return {text:`已逾期 ${Math.abs(days)} 天`,urgent:true};
  return {text:`${days} 天`,urgent:days<14};
}
// ── 照護進度：第 X/Y 週，Y 依疾病別 PAC_CARE_PERIOD 的 weeksMax（查無對照時預設 12 週）──
function careProgressText(c){
  if(!c.week) return '—';
  const period=PAC_CARE_PERIOD[c.diseaseCategory||c.disease];
  const total=period?period.weeksMax:12;
  return `第 ${c.week}/${total} 週`;
}
// ── 展延狀態徽章：無需展延（灰）／待送件（黃，附倒數天數）／審核中（黃）／已核准（綠）／未核准（紅）──
// 註：markNoExtension（不展延）與 confirmExtensionSuccess（展延成功）在現有資料模型中都會寫回相同的 status/timelineSub，
// 兩者無法單純由欄位區分，此處以「尚未觸及展延決策點」視為無需展延，「已到達決策點」則依 hadExtensionFail 分成已核准／未核准。
function extensionBadge(c){
  if(c.status==='展延中'&&c.timelineSub==='待展延申請'){
    const countdown=c.countdown!=null?`（剩餘${c.countdown}天）`:'';
    return {text:`待申請${countdown}`,cls:'badge-amber'};
  }
  if(c.status==='展延中'&&c.timelineSub==='審核中') return {text:'審核中',cls:'badge-amber'};
  if(c.timelineSub==='展延後'){
    if(c.hadExtensionFail) return {text:'不同意展延',cls:'badge-red'};
    const period=PAC_CARE_PERIOD[c.diseaseCategory||c.disease];
    const base=period?period.weeksMin:c.week;
    const extra=Math.max(0,c.week-base);
    return {text:`同意展延（展延${extra}週）`,cls:'badge-green'};
  }
  return {text:'不需展延',cls:'badge-gray'};
}
// ── 評估量表徽章（5格獨立顯示：初評／複評1-3／結案評估）：假資料欄位 c.assessments 撐著顯示，模組尚未建置，逾期變紅先不實作 ──
const ASSESSMENT_STAGES=[['initial','初'],['f1','複1'],['f2','複2'],['f3','複3'],['close','結案']];
function assessmentBadges(c){
  const a=c.assessments||{};
  const badges=ASSESSMENT_STAGES.map(([key,label])=>`<span class="badge ${a[key]?'badge-green':'badge-gray'}" style="font-size:10px;padding:1px 5px">${label}</span>`).join('');
  return `<div style="display:flex;gap:3px;cursor:pointer" onclick="event.stopPropagation();alert('評估量表模組尚未建置，敬請期待')">${badges}</div>`;
}
// ── 轉介徽章：改讀「後續處置」Tab 的病人去向欄位 c.patientDest（取代原本 c.referral.target 判斷邏輯）──
// 居家醫療／長照服務／社工服務／護理之家＝綠；回家／其他＝無需轉介（灰）；尚未選擇＝待轉介（黃）
function referralBadge(c){
  const dest=c.patientDest;
  if(!dest) return {text:'待轉介',cls:'badge-amber'};
  if(dest==='居家醫療') return {text:'居家醫療',cls:'badge-green'};
  if(dest==='長照服務') return {text:'長照服務',cls:'badge-green'};
  if(dest==='社工服務') return {text:'社工服務',cls:'badge-green'};
  if(dest==='護理之家') return {text:'護理之家',cls:'badge-green'};
  return {text:'無需轉介',cls:'badge-gray'}; // 回家／其他
}

// ── 結案管理專用徽章／文字：封存後 timelineStep/timelineSub 已清空，改用下列獨立欄位判斷 ──
// 展延徽章（結案管理版）：展延成功（綠）／展延失敗（紅）／無需展延（灰），依 c.extensionResult 判斷
function archiveExtensionBadge(c){
  if(c.extensionResult==='success') return {text:'展延成功',cls:'badge-green'};
  if(c.extensionResult==='fail') return {text:'展延失敗',cls:'badge-red'};
  return {text:'無需展延',cls:'badge-gray'};
}
// 照護天數（結案管理版）：顯示「基礎週數+展延週數」，例如「6+6週」；未展延則單純顯示總週數
function archiveCareDurationText(c){
  if(!c.week) return '—';
  const period=PAC_CARE_PERIOD[c.diseaseCategory||c.disease];
  const base=period?period.weeksMin:c.week;
  const extra=c.week-base;
  if(c.extensionResult==='success'&&extra>0) return `${base}+${extra}週`;
  return `${c.week}週`;
}
// 轉介徽章（結案管理版）：與 referralBadge 改用同一套 c.patientDest 判斷邏輯，直接沿用
function archiveReferralBadge(c){
  return referralBadge(c);
}
// 結案徽章：結案成功（綠）／結案失敗（紅）／其他（灰，涵蓋非PAC個案、轉居家醫療、資料輸入錯誤等其餘封存類型）
function archiveCloseBadge(c){
  if(c.archiveType==='正常結案') return {text:'結案成功',cls:'badge-green'};
  if(c.archiveType==='結案失敗') return {text:'結案失敗',cls:'badge-red'};
  return {text:'其他',cls:'badge-gray'};
}

// ── 結案管理類型清單：資料性錯誤兩項＋轉居家醫療；「非PAC」「正常結案」「結案失敗」皆走各自獨立流程（鎖定 preset 觸發 openArchiveModal，不出現在此清單）
// field：選擇該類型後顯示的必填文字欄位標籤；未設定表示不需額外說明
const ARCHIVE_TYPES_FORMAL=[
  {type:'資料輸入錯誤'},
  {type:'重複建立個案'},
  {type:'轉居家醫療'}, // 醫師電話通知個管師個案已轉居家醫療計畫，個管師手動封存，非系統鎖定觸發
];

// ── 時間軸節點定義 ──
// 正式病歷階段：共用節點
const TIMELINE_FORMAL_COMMON=[
  {label:'照護中'},
  {label:'展延中',sub:'待展延申請'},
  {label:'展延中',sub:'審核中'},
  {label:'展延結果',event:true,sub:'成功 / 失敗'},
  {label:'照護中',sub:'展延後'},
  {label:'即將結案',sub:'結案兩週前提醒'},
];



// ── 表單清單（依照護模式）──
// type:'link' 表示點擊後跳轉提示彈窗，不開內部填寫頁（評估總表→評估量表模組、復健排班→復健排班模組）
const FORMS={
  hosp:{
    common:[
      {icon:'📋',name:'個案綜合評估報告書（評估總表）',meta:'自動帶入評估週數與日期',status:'done',type:'link',linkTarget:'評估量表模組'},
      {icon:'📄',name:'PAC 照護模式記錄表',meta:'個管師建立',status:'required'},
      {icon:'📝',name:'PAC 會議記錄',meta:'空白表單，填上個案資料',status:'pending'},
      {icon:'💬',name:'醫病溝通會議記錄',meta:'空白表單，填上個案資料',status:'pending'},
      {icon:'📃',name:'專審表',meta:'送展延需要',status:'required'},
      {icon:'🏥',name:'出院準備資料',meta:'住院個案適用',status:'pending'},
    ],
    post:[
      {icon:'😊',name:'PAC 個案滿意度調查表',meta:'結案後建立',status:'pending'},
      {icon:'📊',name:'PAC 個案出院追蹤記錄表',meta:'結案後建立',status:'pending'},
    ]
  },
  day:{
    common:[
      {icon:'📋',name:'個案綜合評估報告書（評估總表）',meta:'自動帶入評估週數與日期',status:'done',type:'link',linkTarget:'評估量表模組'},
      {icon:'📄',name:'PAC 照護模式記錄表',meta:'個管師建立',status:'required'},
      {icon:'📝',name:'PAC 會議記錄',meta:'空白表單',status:'pending'},
      {icon:'💬',name:'醫病溝通會議記錄',meta:'空白表單',status:'pending'},
      {icon:'📃',name:'專審表',meta:'送展延需要',status:'required'},
      {icon:'📅',name:'日照執行記錄表',meta:'人員安排串接復健排班',status:'pending'},
      {icon:'💰',name:'患者門診費用明細（日照）',meta:'人員安排串接復健排班',status:'pending'},
    ],
    post:[
      {icon:'😊',name:'PAC 個案滿意度調查表',meta:'結案後建立',status:'pending'},
      {icon:'📊',name:'PAC 個案出院追蹤記錄表',meta:'結案後建立',status:'pending'},
    ]
  },
  home:{
    common:[
      {icon:'📋',name:'個案綜合評估報告書（評估總表）',meta:'自動帶入評估週數與日期',status:'done',type:'link',linkTarget:'評估量表模組'},
      {icon:'📄',name:'PAC 照護模式記錄表',meta:'個管師建立',status:'required'},
      {icon:'📝',name:'PAC 會議記錄',meta:'空白表單',status:'pending'},
      {icon:'💬',name:'醫病溝通會議記錄',meta:'空白表單',status:'pending'},
      {icon:'📃',name:'專審表',meta:'送展延需要',status:'required'},
      {icon:'💰',name:'患者門診費用明細（居家）',meta:'人員安排串接居家排班',status:'required'},
      {icon:'📋',name:'PAC 居家復健治療紀錄',meta:'人員安排串接居家排班',status:'pending'},
      {icon:'🏠',name:'居家環境評估暨危險因子檢核表',meta:'初次居家訪視',status:'pending'},
      {icon:'📅',name:'居家復健排班表',meta:'人員安排串接居家排班',status:'pending'},
    ],
    post:[
      {icon:'😊',name:'PAC 個案滿意度調查表',meta:'結案後建立',status:'pending'},
      {icon:'📊',name:'PAC 個案出院追蹤記錄表',meta:'結案後建立',status:'pending'},
      {icon:'🏥',name:'PAC 居家訪視護理記錄表',meta:'結案後建立・僅居家個案適用',status:'pending'},
    ]
  },
  general:{
    common:[
      {icon:'📋',name:'復健評估記錄（一般）',meta:'非PAC標準表單',status:'pending'},
      {icon:'📝',name:'家屬聯繫紀錄',meta:'',status:'done'},
    ],
    post:[]
  }
};

// ── 表單填寫內容 ──
const FORM_FILL_CONTENT={
  '個案綜合評估報告書（評估總表）':{
    sections:[
      {title:'個案基本資料（自動帶入）',fields:[
        {label:'個案姓名',value:'陳建國',readonly:true,type:'text'},
        {label:'病歷號',value:'00073450',readonly:true,type:'text'},
        {label:'照護模式',value:'住院',readonly:true,type:'text'},
        {label:'PAC 疾病別',value:'CVA（腦中風）',readonly:true,type:'text'},
        {label:'上游醫院',value:'臺大醫院',readonly:true,type:'text'},
        {label:'主治醫師',value:'張宗達 醫師',readonly:true,type:'text'},
        {label:'入院日期',value:'2026/06/10',readonly:true,type:'text'},
        {label:'預計出院日期',value:'2026/09/02',readonly:true,type:'text'},
        {label:'療程週期',value:'12 週',readonly:true,type:'text'},
      ]},
      {title:'評估次別總覽',table:true,rows:[
        {label:'初評',date:'2026/06/11',week:'第1週',pt:'Br.III',ot:'30分',st:'輕度',status:'done'},
        {label:'複評1',date:'2026/06/25',week:'第3週',pt:'待填',ot:'待填',st:'完成',status:'pending'},
        {label:'複評2',date:'2026/07/16',week:'第6週',pt:'—',ot:'—',st:'—',status:'future'},
        {label:'結案',date:'2026/09/01',week:'第12週',pt:'—',ot:'—',st:'—',status:'future'},
      ]},
    ]
  },
  'PAC 照護模式記錄表':{
    sections:[
      {title:'基本資料',fields:[
        {label:'個案姓名',value:'陳建國',readonly:true,type:'text'},
        {label:'病歷號',value:'00073450',readonly:true,type:'text'},
        {label:'照護模式',value:'住院',type:'select',options:['住院','日照','居家']},
        {label:'收案日期',value:'2026/06/10',type:'text'},
      ]},
      {title:'照護模式紀錄',fields:[
        {label:'模式說明',value:'住院 PAC，CVA 復健療程，預計 12 週',type:'textarea'},
        {label:'特殊注意事項',value:'右側偏癱，需輪椅輔助，家屬已告知注意事項',type:'textarea'},
        {label:'記錄人員',value:'林美惠',type:'text'},
        {label:'記錄日期',value:'2026/06/10',type:'text'},
      ]}
    ]
  },
  'PAC 會議記錄':{
    sections:[
      {title:'會議基本資料',fields:[
        {label:'個案姓名',value:'陳建國',readonly:true,type:'text'},
        {label:'會議日期',value:'2026/06/10',type:'text'},
        {label:'會議地點',value:'5樓會議室',type:'text'},
        {label:'主持人',value:'林美惠',type:'text'},
      ]},
      {title:'出席人員',fields:[
        {label:'個管師',value:'林美惠',type:'text'},
        {label:'醫師',value:'張宗達',type:'text'},
        {label:'復健治療師',value:'黃志豪（PT）、李佳穎（OT）',type:'text'},
        {label:'護理師',value:'陳玉玲',type:'text'},
      ]},
      {title:'會議記錄',fields:[
        {label:'個案狀況摘要',value:'72歲男性，CVA 發作後右側偏癱，符合 PAC 收案條件，預計住院 12 週復健療程。',type:'textarea'},
        {label:'治療目標',value:'改善右側肢體功能，提升 ADL 獨立性，目標 Barthel Index 由 30 分提升至 60 分以上。',type:'textarea'},
        {label:'其他決議',value:'',type:'textarea'},
      ]}
    ]
  },
  '出院準備資料':{
    sections:[
      {title:'出院基本資料',fields:[
        {label:'預計出院日期',value:'2026/09/02',type:'text'},
        {label:'出院去向',value:'',type:'select',options:['返家','轉長照機構','轉其他醫院','其他']},
        {label:'出院方式',value:'',type:'select',options:['步行','輪椅','擔架']},
      ]},
      {title:'出院後安排',fields:[
        {label:'後續復健計畫',value:'門診復健，每週 2 次',type:'textarea'},
        {label:'轉介服務',value:'長照服務評估中',type:'textarea'},
        {label:'衛教事項',value:'',type:'textarea'},
        {label:'回診安排',value:'2026/09/09 復健科門診',type:'text'},
      ]}
    ]
  },
  '居家環境評估暨危險因子檢核表':{
    sections:[
      {title:'居家環境評估',fields:[
        {label:'居住地址',value:'台北市大安區',type:'text'},
        {label:'居住型態',value:'',type:'select',options:['公寓（無電梯）','公寓（有電梯）','透天厝','社區大樓']},
        {label:'樓層',value:'3',type:'text'},
      ]},
      {title:'危險因子檢核',checklist:true,items:[
        '地板是否有防滑處理',
        '浴室是否有扶手',
        '通道是否有足夠寬度（輪椅可通行）',
        '床高是否適當',
        '照明是否充足',
        '是否有門檻需克服',
      ]},
      {title:'評估結論',fields:[
        {label:'環境危險等級',value:'',type:'select',options:['低風險','中風險','高風險']},
        {label:'建議改善事項',value:'',type:'textarea'},
        {label:'評估人員',value:'黃志豪',type:'text'},
        {label:'評估日期',value:'2026/06/20',type:'text'},
      ]}
    ]
  },
};

// ── 頁面渲染 ──
function renderPage(page,caseId,formName){
  currentPage=page;
  const content=document.getElementById('main-content');
  if(page==='list') renderList(content);
  else if(page==='detail') renderDetail(content,caseId);
  else if(page==='form') renderFormFill(content,caseId,formName);
  else if(page==='his-record') renderHisRecord(content,caseId);
}

let currentListTab='formal'; // 'formal' | 'archive'
let tabView={formal:'list',archive:'list'}; // 各 Tab 各自的視圖狀態：'card' or 'list'；正式病歷 Tab 預設「列表」（表格檢視）
let listSelection={temp:null,formal:null,archive:null}; // 列表視圖（左右分割）時，各 Tab 目前選中的個案 id
let dualPaneMode=false; // 雙欄瀏覽模式（獨立於卡片／表格檢視的另一種切換）：開啟後不論目前是卡片或表格檢視，一律改為左側精簡清單＋右側完整詳情頁

// 雙欄瀏覽模式：切換圖示 SVG（沿用既有雙欄圖示樣式，改用 currentColor 以配合按鈕 active 狀態變色）
const DUAL_PANE_ICON=`<svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><rect x="6.4" y="11.11" width="35.2" height="25.79" rx="2" stroke="currentColor" stroke-width="3.5"/><line x1="17.18" y1="11.11" x2="17.18" y2="36.89" stroke="currentColor" stroke-width="3.5"/></svg>`;
let archiveTypeFilter=''; // 封存 Tab：封存類型篩選（空字串＝全部封存類型）
let archiveDateFrom=''; // 封存 Tab：封存日期區間篩選（起，yyyy-mm-dd）
let archiveDateTo=''; // 封存 Tab：封存日期區間篩選（訖，yyyy-mm-dd）
let listSortOrder='dateDesc'; // 個案列表排序：'dateDesc'(收案日期新→舊，預設) | 'dateAsc' | 'nameAsc' | 'closeDateAsc'

function renderList(container){
  document.getElementById('bc').textContent='個案管理';
  const isDoc=currentRole==='doc';
  const isNur=currentRole==='nur';

  const allCases=CASES.formal;
  const countBy=(status)=>allCases.filter(c=>c.status===status&&c.status!=='封存').length;
  const urgentExtend=allCases.filter(c=>c.countdown!==null&&c.countdown<=3).length;
  const warnExtend=allCases.filter(c=>c.countdown!==null&&c.countdown>3&&c.countdown<=7).length;
  const closingSoon=allCases.filter(c=>c.status==='即將結案');
  const modeCount={hosp:0,day:0,home:0,general:0};
  allCases.forEach(c=>{if(c.modeType)modeCount[c.modeType]++});
  // 統計卡「結案倒數 14/7 天」：排除已封存個案，依 daysUntilClose 篩出對應天數內（含已逾期）的個案數
  const closeSoon14=allCases.filter(c=>c.status!=='封存'&&daysUntilClose(c.closeDate)!==null&&daysUntilClose(c.closeDate)<=14).length;
  const closeSoon7=allCases.filter(c=>c.status!=='封存'&&daysUntilClose(c.closeDate)!==null&&daysUntilClose(c.closeDate)<=7).length;
  // 搜尋／篩選列「全部負責人」「全部來源醫院」：依 CASES.formal 現有資料動態產生不重複清單
  const mgrOptions=[...new Set(CASES.formal.map(c=>c.mgr).filter(Boolean))];
  const sourceOptions=[...new Set(CASES.formal.map(c=>c.source).filter(Boolean))];

  // 狀態篩選：統計卡共用同一個變數 statusFilter；extraCardFilter 為展延倒數/結案倒數三張卡專用，與 statusFilter 互斥
  const applyRoleFilter=(arr)=>{
    if(statusFilter) return arr.filter(c=>c.status===statusFilter);
    if(extraCardFilter==='extDeadline') return arr.filter(c=>c.countdown!=null&&c.countdown<=7);
    if(extraCardFilter==='closeSoon14') return arr.filter(c=>c.status!=='封存'&&daysUntilClose(c.closeDate)!==null&&daysUntilClose(c.closeDate)<=14);
    if(extraCardFilter==='closeSoon7') return arr.filter(c=>c.status!=='封存'&&daysUntilClose(c.closeDate)!==null&&daysUntilClose(c.closeDate)<=7);
    return arr;
  };
  const statFilterClass=(status)=>`stat-card${statusFilter===status?' active-filter':''}`;
  const extraCardFilterClass=(type)=>`stat-card${extraCardFilter===type?' active-filter':''}`;

  const formalActive=sortCases(applyRoleFilter(CASES.formal.filter(c=>c.status!=='封存')));
  const archiveCasesAll=allCases.filter(c=>c.status==='封存');
  // 封存 Tab：封存類型／封存日期區間篩選同時作用（AND），篩選後再依排序方式排列
  const archiveCases=sortCases(archiveCasesAll.filter(c=>{
    if(archiveTypeFilter&&c.archiveType!==archiveTypeFilter) return false;
    if(archiveDateFrom||archiveDateTo){
      const d=c.archiveDate?new Date(c.archiveDate.replace(/\//g,'-')):null;
      if(!d||isNaN(d)) return false;
      if(archiveDateFrom&&d<new Date(archiveDateFrom)) return false;
      if(archiveDateTo&&d>new Date(archiveDateTo)) return false;
    }
    return true;
  }));
  const tabCaseMap={formal:formalActive,archive:archiveCases};
  const currentTabCases=tabCaseMap[currentListTab];

  // 雙欄瀏覽模式：先確定選中個案，讓側邊欄 highlight 與右側詳情頁一致（正式病歷／結案管理共用同一套雙欄邏輯）
  if(dualPaneMode){
    let sel=listSelection[currentListTab];
    if(!sel||!currentTabCases.find(c=>c.id===sel)) sel=currentTabCases.length?currentTabCases[0].id:null;
    listSelection[currentListTab]=sel;
  }

  let tabBodyHtml='';
  if(dualPaneMode){
    const dualPaneEmptyMsg=currentListTab==='archive'
      ?(archiveCasesAll.length?'沒有符合條件的結案紀錄':'目前沒有結案紀錄')
      :'目前沒有個案';
    tabBodyHtml=`
      ${currentListTab==='archive'?archiveFilterBar():''}
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div style="width:168px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;background:var(--white);border:1px solid var(--gray-200);border-radius:10px;padding:10px;max-height:calc(100vh - 300px);overflow-y:auto">
          ${currentTabCases.length?currentTabCases.map(c=>dualPaneListItem(c,currentListTab)).join(''):`<div style="text-align:center;padding:20px 6px;color:var(--gray-400);font-size:11px">${dualPaneEmptyMsg}</div>`}
        </div>
        <div id="dual-pane-detail-panel" style="flex:1;min-width:0"></div>
      </div>
    `;
  } else if(currentListTab==='archive'&&tabView.archive==='card'){
    tabBodyHtml=`
      ${archiveFilterBar()}
      <div class="case-grid">${archiveCases.length?archiveCases.map(c=>caseCard(c)).join(''):`<div style="text-align:center;padding:20px 8px;color:var(--gray-400);font-size:12px">${archiveCasesAll.length?'沒有符合條件的結案紀錄':'目前沒有結案紀錄'}</div>`}</div>
    `;
  } else if(currentListTab==='archive'){
    tabBodyHtml=`
      ${archiveFilterBar()}
      ${renderArchiveTable(archiveCases,archiveCasesAll.length?'沒有符合條件的結案紀錄':'目前沒有結案紀錄')}
    `;
  } else if(tabView[currentListTab]==='card'){
    tabBodyHtml=`<div class="case-grid">${currentTabCases.map(c=>caseCard(c)).join('')}</div>`;
  } else {
    tabBodyHtml=renderCaseTable(currentTabCases,'目前沒有個案');
  }

  // 搜尋／篩選列＋排序／檢視切換列：僅正式病歷 Tab 套用新版設計，結案管理 Tab 維持原樣（本次調整範圍僅限正式病歷 Tab）
  const isFormalTab=currentListTab==='formal';
  const searchBarHtml=isFormalTab?`
    <div class="search-bar">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="搜尋姓名／電話／病歷號／身分證">
      </div>
      <select class="filter-sel">
        <option>全部疾病別</option>
        <option>腦中風</option><option>創傷性神經損傷</option><option>脆弱性骨折</option><option>衰弱高齡</option><option>一般（非PAC）</option>
      </select>
      <select class="filter-sel">
        <option>全部照護模式</option>
        <option>住院</option><option>日照</option><option>居家</option>
      </select>
      <select class="filter-sel">
        <option>全部負責人</option>
        ${mgrOptions.map(m=>`<option>${m}</option>`).join('')}
      </select>
      <select class="filter-sel">
        <option>全部來源醫院</option>
        ${sourceOptions.map(s=>`<option>${s}</option>`).join('')}
      </select>
    </div>
  `:`
    <div class="search-bar">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="搜尋姓名、病歷號…">
      </div>
      <select class="filter-sel"><option>全部類型</option><option>住院PAC</option><option>日照PAC</option><option>居家PAC</option><option>一般</option></select>
      <select class="filter-sel">
        <option>全部疾病別</option>
        <option>腦中風</option><option>創傷性神經損傷</option><option>脆弱性骨折</option><option>衰弱高齡</option><option>一般（非PAC）</option>
      </select>
    </div>
  `;
  const sortToggleHtml=isFormalTab?`
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <select class="filter-sel" id="sort-order-select" onchange="onSortOrderChange(this.value)">
        <option value="dateDesc" ${listSortOrder==='dateDesc'?'selected':''}>建立日期（新→舊）</option>
        <option value="dateAsc" ${listSortOrder==='dateAsc'?'selected':''}>建立日期（舊→新）</option>
        <option value="openDateAsc" ${listSortOrder==='openDateAsc'?'selected':''}>預計開始日（近→遠）</option>
        <option value="openDateDesc" ${listSortOrder==='openDateDesc'?'selected':''}>預計開始日（遠→近）</option>
        <option value="closeDateAsc" ${listSortOrder==='closeDateAsc'?'selected':''}>預計結案日（近→遠）</option>
        <option value="closeDateDesc" ${listSortOrder==='closeDateDesc'?'selected':''}>預計結案日（遠→近）</option>
        <option value="updatedDesc" ${listSortOrder==='updatedDesc'?'selected':''}>最後更新時間（新→舊）</option>
        <option value="updatedAsc" ${listSortOrder==='updatedAsc'?'selected':''}>最後更新時間（舊→新）</option>
      </select>
      <div class="view-toggle">
        <button class="view-toggle-btn ${(!dualPaneMode&&tabView[currentListTab]==='card')?'active':''}" onclick="switchView('card')">▦ 卡片</button>
        <button class="view-toggle-btn ${(!dualPaneMode&&tabView[currentListTab]==='list')?'active':''}" onclick="switchView('list')">☰ 列表</button>
        <button class="view-toggle-btn ${dualPaneMode?'active':''}" onclick="toggleDualPane()">${DUAL_PANE_ICON} 雙欄</button>
      </div>
    </div>
  `:`
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <select class="filter-sel" id="sort-order-select" onchange="onSortOrderChange(this.value)">
        <option value="dateDesc" ${listSortOrder==='dateDesc'?'selected':''}>收案日期（新→舊）</option>
        <option value="dateAsc" ${listSortOrder==='dateAsc'?'selected':''}>收案日期（舊→新）</option>
        <option value="nameAsc" ${listSortOrder==='nameAsc'?'selected':''}>姓名筆畫排序</option>
        <option value="closeDateAsc" ${listSortOrder==='closeDateAsc'?'selected':''}>預估出院日期（近→遠）</option>
      </select>
      <div class="view-toggle">
        <button class="view-toggle-btn ${tabView[currentListTab]==='card'?'active':''}" onclick="switchView('card')">▦ 卡片</button>
        <button class="view-toggle-btn ${tabView[currentListTab]==='list'?'active':''}" onclick="switchView('list')">☰ 列表</button>
      </div>
      <div class="view-toggle" title="雙欄瀏覽模式">
        <button class="view-toggle-btn ${dualPaneMode?'active':''}" onclick="toggleDualPane()">${DUAL_PANE_ICON} 雙欄</button>
      </div>
    </div>
  `;

  container.innerHTML=`
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:18px;font-weight:700">個案管理</div>
        <div style="font-size:12px;color:var(--gray-500);margin-top:3px">共 ${allCases.length} 位個案・住院 ${modeCount.hosp}・日照 ${modeCount.day}・居家 ${modeCount.home}</div>
      </div>
    </div>

    <!-- Tabs：正式病歷 / 結案管理 -->
    <div class="tabs">
      <div class="tab ${currentListTab==='formal'?'active':''}" onclick="switchTab('formal')">正式病歷 <span class="badge badge-blue" style="margin-left:4px">${formalActive.length}</span></div>
      <div class="tab ${currentListTab==='archive'?'active':''}" onclick="switchTab('archive')" style="color:var(--gray-400)">結案管理 <span class="badge badge-gray" style="margin-left:4px">${archiveCasesAll.length}</span></div>
    </div>

    ${(!isDoc&&!isNur&&currentListTab==='formal')?`
    <!-- 統計卡：單一列 4 張等寬卡片，僅正式病歷 Tab 顯示 -->
    <div class="stats-row">
      <div class="${statFilterClass('展延中')}" onclick="filterByStatus('展延中')">
        <div class="stat-label">展延申請中</div>
        <div class="stat-value">${countBy('展延中')}</div>
      </div>
      <div class="${extraCardFilterClass('extDeadline')} urgent" onclick="filterByExtraCard('extDeadline')">
        <div class="stat-label">展延申請倒數 7天</div>
        <div class="stat-value">${urgentExtend+warnExtend}</div>
      </div>
      <div class="${extraCardFilterClass('closeSoon14')}" onclick="filterByExtraCard('closeSoon14')">
        <div class="stat-label">結案倒數 14天</div>
        <div class="stat-value">${closeSoon14}</div>
      </div>
      <div class="${extraCardFilterClass('closeSoon7')}" onclick="filterByExtraCard('closeSoon7')">
        <div class="stat-label">結案倒數 7天</div>
        <div class="stat-value">${closeSoon7}</div>
      </div>
    </div>
    `:''}

    ${searchBarHtml}

    ${sortToggleHtml}

    ${tabBodyHtml}
  `;

  // 雙欄瀏覽模式：於右側面板渲染選中個案的完整詳情頁
  if(dualPaneMode){
    const panel=document.getElementById('dual-pane-detail-panel');
    const sel=listSelection[currentListTab];
    if(panel){
      if(sel) renderDetail(panel,sel);
      else panel.innerHTML=`<div style="text-align:center;padding:60px 20px;color:var(--gray-400);font-size:13px">請從左側選擇個案</div>`;
    }
  }
}

// 雙欄瀏覽模式：切換開關
function toggleDualPane(){
  dualPaneMode=!dualPaneMode;
  renderList(document.getElementById('main-content'));
}

// 雙欄瀏覽模式：左側精簡個案清單項目（姓名＋病歷號＋關鍵狀態，不含完整表格欄位）
function dualPaneListItem(c,tabKey){
  const selected=listSelection[tabKey]===c.id;
  const statusBadge=tabKey==='archive'
    ? `<span class="badge badge-gray" style="font-size:10px">${c.archiveType||'結案'}</span>`
    : `<span class="badge ${STATUS_COLOR[c.status]||'badge-gray'}" style="font-size:10px">${statusLabel(c.status)}</span>`;
  return `<div onclick="selectListCase('${tabKey}','${c.id}')" style="padding:8px 9px;border-radius:6px;cursor:pointer;${selected?'background:var(--blue-light);border:1px solid var(--blue-mid)':'border:1px solid transparent'}">
    <div style="font-size:12.5px;font-weight:600;color:${selected?'var(--blue)':'var(--gray-800)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}</div>
    <div style="font-size:10.5px;color:var(--gray-500);margin-top:2px">${c.medicalRecordNo||'—'}</div>
    <div style="margin-top:4px">${statusBadge}</div>
  </div>`;
}

// ── 列表（左右分割）視圖：左側個案迷你列表項目 ──
function caseListSidebarItem(c,tabKey){
  const age=c.birthDate?calcAge(c.birthDate):null;
  const selected=listSelection[tabKey]===c.id;
  const statusBadge=tabKey==='archive'
    ? `<span class="badge badge-gray">結案管理</span><span style="font-size:10px;color:var(--gray-400);margin-left:4px">・${c.archiveType||''}</span>`
    : `<span class="badge ${STATUS_COLOR[c.status]||'badge-gray'}">${c.status}</span>`;
  return `<div style="padding:10px 10px;border-radius:7px;cursor:pointer;${selected?'background:var(--blue-light);border:1px solid var(--blue-mid)':'border:1px solid transparent'}">
    <div onclick="selectListCase('${tabKey}','${c.id}')">
      <div style="font-size:13px;font-weight:600;color:${selected?'var(--blue)':'var(--gray-800)'}">${c.name}${age!==null?`<span style="font-size:11px;color:var(--gray-400);font-weight:500">(${age})</span>`:''}</div>
      <div style="font-size:11px;color:var(--gray-500);margin-top:2px">${c.mode}・${c.disease}</div>
      <div style="margin-top:5px">${statusBadge}</div>
    </div>
  </div>`;
}

function switchTab(tabKey){
  currentListTab=tabKey;
  renderList(document.getElementById('main-content'));
}
function onSortOrderChange(val){
  listSortOrder=val;
  renderList(document.getElementById('main-content'));
}
function switchView(view){
  tabView[currentListTab]=view;
  dualPaneMode=false; // 與雙欄瀏覽模式互斥，切到卡片/列表時確保雙欄旗標同步關閉
  renderList(document.getElementById('main-content'));
}
function selectListCase(tabKey,caseId){
  listSelection[tabKey]=caseId;
  renderList(document.getElementById('main-content'));
}

// ── 結案管理 Tab：篩選區（結案類型 + 病歷類型 + 結案日期區間，皆同時作用）──
function archiveFilterBar(){
  const formalPresetTypes=['非PAC個案','正常結案','結案失敗']; // 不在 ARCHIVE_TYPES_FORMAL 內，走各自獨立流程觸發，但仍為結案類型篩選選項
  return `
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    <select class="filter-sel" onchange="onArchiveTypeFilterChange(this.value)">
      <option value="" ${archiveTypeFilter===''?'selected':''}>全部結案類型</option>
      ${formalPresetTypes.map(t=>`<option value="${t}" ${archiveTypeFilter===t?'selected':''}>${t}</option>`).join('')}
      ${ARCHIVE_TYPES_FORMAL.map(o=>`<option value="${o.type}" ${archiveTypeFilter===o.type?'selected':''}>${o.type}</option>`).join('')}
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

// 狀態篩選：統計卡共用同一個 statusFilter 變數，再次點擊目前已套用的同一狀態會清除篩選
function filterByStatus(status){
  statusFilter=(statusFilter===status)?null:status;
  extraCardFilter=null;
  renderList(document.getElementById('main-content'));
}
// 統計卡第二／三／四張（展延倒數7天、結案倒數14/7天）：與 statusFilter 互斥的日期區間篩選，再點一次已套用的同一張卡會清除篩選
function filterByExtraCard(type){
  extraCardFilter=(extraCardFilter===type)?null:type;
  statusFilter=null;
  renderList(document.getElementById('main-content'));
}

function caseCard(c){
  const modeClass={hosp:'ms-hosp',day:'ms-day',home:'ms-home',general:'ms-general'}[c.modeType]||'ms-general';
  const statusBadge=`<span class="badge ${STATUS_COLOR[c.status]||'badge-gray'}">${statusLabel(c.status)}</span>`;
  const isClosingSoon=c.status==='即將結案';
  const modeLabel={hosp:'🏥 住院 PAC',day:'☀️ 日照 PAC',home:'🏡 居家 PAC',general:'🏋️ 一般'}[c.modeType]||c.mode;
  const cardBorder=isClosingSoon?'border-color:#DDD6FE;':'';
  const age=c.birthDate?calcAge(c.birthDate):null;
  const nameWithAge=`${c.name}${age!==null?`<span style="font-size:12px;color:var(--gray-400);font-weight:500">(${age})</span>`:''}`;
  const detailOnclick=`renderPage('detail','${c.id}')`;

  if(currentRole==='adm'){
    return `<div class="case-card" style="${cardBorder}" onclick="${detailOnclick}">
      <div class="mode-stripe ${modeClass}"></div>
      <div class="case-card-header"><div><div class="case-name">${nameWithAge}</div><div class="case-id">${c.mode}・${c.disease}</div></div>${statusBadge}</div>
      <div class="admin-key-field"><label>身分證字號</label><span>A123456789</span></div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:7px">
        <div class="case-field"><label>入院日期</label><span>${c.date}</span></div>
        <div class="case-field"><label>床位</label><span>A301</span></div>
      </div>
    </div>`;
  }

  const ext=c.status==='封存'?archiveExtensionBadge(c):extensionBadge(c);
  const isArchived=c.status==='封存';
  return `<div class="case-card" style="${cardBorder}" onclick="${detailOnclick}">
    <div class="mode-stripe ${modeClass}"></div>
    ${isClosingSoon?`<div style="font-size:11px;color:var(--purple);font-weight:600;background:var(--purple-light);padding:5px 10px;margin:-3px -3px 10px;border-radius:3px">🏁 療程即將結束・請準備結案評估</div>`:''}
    <div class="case-card-header"><div><div class="case-name">${nameWithAge}</div><div class="case-id">${modeLabel}・${c.disease}</div></div>${statusBadge}</div>
    <div class="case-card-body">
      <div class="case-field"><label>病歷號</label><span>${c.medicalRecordNo||'—'}</span></div>
      <div class="case-field"><label>疾病別</label><span>${c.disease}</span></div>
      <div class="case-field"><label>模式</label><span>${c.mode}</span></div>
      <div class="case-field"><label>開案日</label><span>${c.openDate||'—'}</span></div>
      <div class="case-field"><label>預計結案</label><span>${c.closeDate||'—'}</span></div>
      <div class="case-field"><label>照護進度</label><span>${isArchived?archiveCareDurationText(c):careProgressText(c)}</span></div>
    </div>
    <div class="case-card-footer">
      <div class="case-manager"><div class="mini-av">林</div>${c.mgr}</div>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <span class="badge ${ext.cls}">${ext.text}</span>
        ${isArchived?(()=>{const ref=archiveReferralBadge(c);const cl=archiveCloseBadge(c);return `<span class="badge ${ref.cls}">${ref.text}</span><span class="badge ${cl.cls}">${cl.text}</span>`;})():''}
      </div>
    </div>
  </div>`;
}

// ── 個案表格（正式病歷 Tab 預設檢視）：姓名／病歷號碼／身分證／PAC疾病別／照護模式／開案日／預計結案日／照護進度／展延／評估量表／轉介／負責人 ──
function renderCaseTable(cases,emptyMsg){
  if(!cases.length){
    return `<div style="text-align:center;padding:40px 20px;color:var(--gray-400);font-size:13px;background:var(--white);border:1px solid var(--gray-200);border-radius:10px">${emptyMsg}</div>`;
  }
  const headers=['姓名','病歷號碼','身分證','PAC疾病別','照護模式','開案日','預計結案日','照護進度','展延','評估量表','轉介','負責人'];
  return `
  <div style="overflow-x:auto">
    <table class="case-list-table" style="min-width:1080px">
      <thead>
        <tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${cases.map(c=>renderCaseRow(c)).join('')}
      </tbody>
    </table>
  </div>`;
}
function renderCaseRow(c){
  const age=c.birthDate?calcAge(c.birthDate):null;
  const nameCell=`${c.name}${age!==null?`<span style="font-size:11px;color:var(--gray-400);margin-left:3px">(${age})</span>`:''}`;
  const ext=extensionBadge(c);
  const ref=referralBadge(c);
  return `<tr style="cursor:pointer" onclick="renderPage('detail','${c.id}')">
    <td><strong>${nameCell}</strong></td>
    <td>${c.medicalRecordNo||'—'}</td>
    <td>${c.idNumber||'—'}</td>
    <td>${c.disease}</td>
    <td>${c.mode}</td>
    <td>${c.openDate||'—'}</td>
    <td>${c.closeDate||'—'}</td>
    <td>${careProgressText(c)}</td>
    <td><span class="badge ${ext.cls}">${ext.text}</span></td>
    <td>${assessmentBadges(c)}</td>
    <td><span class="badge ${ref.cls}">${ref.text}</span></td>
    <td>${c.mgr||'—'}</td>
  </tr>`;
}

// ── 結案管理表格：姓名／病歷號／疾病別／模式／開案日／預計結案日／照護天數／展延／轉介／結案／負責人 ──
// 與正式病歷表格的差異：不顯示剩餘天數與評估量表；照護天數改用「基礎+展延」週數格式；展延／轉介／結案改用結案管理專屬的徽章判斷邏輯
function renderArchiveTable(cases,emptyMsg){
  if(!cases.length){
    return `<div style="text-align:center;padding:40px 20px;color:var(--gray-400);font-size:13px;background:var(--white);border:1px solid var(--gray-200);border-radius:10px">${emptyMsg}</div>`;
  }
  const headers=['姓名','病歷號','疾病別','模式','開案日','預計結案日','照護天數','展延','轉介','結案','負責人'];
  return `
  <div style="overflow-x:auto">
    <table class="case-list-table" style="min-width:980px">
      <thead>
        <tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${cases.map(c=>renderArchiveRow(c)).join('')}
      </tbody>
    </table>
  </div>`;
}
function renderArchiveRow(c){
  const age=c.birthDate?calcAge(c.birthDate):null;
  const nameCell=`${c.name}${age!==null?`<span style="font-size:11px;color:var(--gray-400);margin-left:3px">(${age})</span>`:''}`;
  const ext=archiveExtensionBadge(c);
  const ref=archiveReferralBadge(c);
  const cl=archiveCloseBadge(c);
  return `<tr style="cursor:pointer" onclick="renderPage('detail','${c.id}')">
    <td><strong>${nameCell}</strong></td>
    <td>${c.medicalRecordNo||'—'}</td>
    <td>${c.disease}</td>
    <td>${c.mode}</td>
    <td>${c.openDate||'—'}</td>
    <td>${c.closeDate||'—'}</td>
    <td>${archiveCareDurationText(c)}</td>
    <td><span class="badge ${ext.cls}">${ext.text}</span></td>
    <td><span class="badge ${ref.cls}">${ref.text}</span></td>
    <td><span class="badge ${cl.cls}">${cl.text}</span></td>
    <td>${c.mgr||'—'}</td>
  </tr>`;
}

function renderDetail(container,caseId){
  currentCase=caseId;
  if(detailActiveTabCaseId!==caseId){ detailActiveTab='overview'; detailActiveTabCaseId=caseId; }
  const c=CASES.formal.find(x=>x.id===caseId)||CASES.formal[0];
  document.getElementById('bc').textContent=`個案管理 › ${c.name}`;

  const isMgr=currentRole==='mgr';
  const isDoc=currentRole==='doc';
  const isNur=currentRole==='nur';
  const isAdm=currentRole==='adm';
  const isFormal=c.formal;

  // 動態組裝完整時間軸
  const steps=buildTimeline(c);

  // 行政視角：重點欄位放大顯示
  const adminKeyFields=isAdm?`
    <div class="info-note amber" style="margin-bottom:12px">⚠️ 以下欄位請仔細核對後登打至杏翔系統，身分證字號打錯將影響所有健保申報。</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
      <div class="admin-key-field"><label>👤 姓名</label><span>${c.name}</span></div>
      <div class="admin-key-field"><label>🪪 身分證字號</label><span>A123456789</span></div>
      <div class="admin-key-field"><label>📅 出生日期</label><span>1952/08/20</span></div>
      <div class="admin-key-field"><label>🏥 照護模式</label><span>${c.mode}</span></div>
      <div class="admin-key-field"><label>🛏 床號</label><span>A301</span></div>
      <div class="admin-key-field"><label>📋 病歷號</label><span>00073450</span></div>
    </div>
  `:'';

  // 操作按鈕
  let actions='';
  if(isMgr) actions=`
      <button class="btn btn-ghost btn-sm" onclick="openConvertModeModal()">🔁 轉換模式</button>
      <button class="btn btn-secondary btn-sm" onclick="openArchiveModal({formal:true})">結案管理</button>
      <button class="btn btn-green btn-sm" onclick="openArchiveModal({formal:true,presetType:'正常結案',locked:true,showCloseDate:true,showDischargeDest:true,successMsg:()=>'已成功結案，個案移至結案管理'})">✓ 成功結案</button>
      <button class="btn btn-danger btn-sm" onclick="openArchiveModal({formal:true,presetType:'結案失敗',locked:true,showCloseDate:true,showDischargeDest:true,successMsg:()=>'已標記結案失敗，個案移至結案管理'})">不成功結案</button>
    `;
  else if(isDoc) actions=`<span class="badge badge-amber" style="font-size:12px">醫師視角・可填寫 PAC 判斷與醫囑</span>`;
  else if(isNur) actions=`<span class="badge badge-teal" style="font-size:12px">護理師視角・可填寫護理相關欄位</span>`;
  else if(isAdm) actions=`<span class="badge badge-gray" style="font-size:12px">行政視角・唯讀模式</span>`;

  // 表單清單
  const modeKey=c.modeType||'hosp';
  const formData=FORMS[modeKey]||FORMS.hosp;
  const fsLabel={'done':'fs-done','required':'fs-required','pending':'fs-pending'};
  const fsText={'done':'已完成','required':'待填寫','pending':'未到期'};

  const formsList=(forms,title,showTitle=true)=>`
    ${showTitle?`<div style="font-size:11px;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">${title}</div>`:''}
    <div class="forms-grid">
      ${forms.map(f=>`
        <div class="form-item" onclick="${f.type==='link'?`showLinkTip('${f.name}','${f.linkTarget}')`:`renderPage('form','${caseId}','${f.name}')`}">
          <div class="form-item-left">
            <div class="form-icon">${f.icon}</div>
            <div><div class="form-name">${f.name}</div><div class="form-meta">${f.meta}</div></div>
          </div>
          <span class="form-status ${f.type==='link'?'fs-pending':fsLabel[f.status]}">${f.type==='link'?'前往 →':fsText[f.status]}</span>
        </div>
      `).join('')}
    </div>
  `;

  // Tab 結構：總覽／評估量表／文件／居家排班／後續處置皆不分組；病摘與PAC判斷／聯繫紀錄屬「流程面」分組（group:'flow'，會觸發左邊分隔線）
  const detailTabs=[
    {key:'overview',label:'總覽'},
    {key:'assessment',label:'評估量表'},
    {key:'docs',label:'文件'},
    {key:'rehab',label:'居家排班'},
    {key:'disposition',label:'後續處置'},
    {key:'judge',label:'病摘與PAC判斷',group:'flow'},
    {key:'contact',label:'聯繫紀錄',group:'flow'},
  ];
  if(!detailTabs.find(t=>t.key===detailActiveTab)) detailActiveTab='overview';
  const tabPanelStyle=(key)=>`display:${detailActiveTab===key?'':'none'}`;

  // Tab 標籤下方小字狀態提示：統一樣式——未完成＝🔴（灰階文字），已完成＝✓（綠色文字），不加其他強調樣式
  // 除「聯繫紀錄」外其餘 Tab 不需提示，但保留同樣高度的佔位空間，避免整排 Tab 高度參差不齊
  const tabHint=(key)=>{
    if(key==='contact'){
      const lastResult=(c.familyContacts&&c.familyContacts.length)?c.familyContacts[c.familyContacts.length-1].result:null;
      return (!lastResult||lastResult==='尚未確定')
        ?{text:'🔴 待聯絡家屬',color:'var(--gray-400)'}
        :{text:'✓ 已聯絡家屬',color:'var(--green)'};
    }
    return null;
  };

  container.innerHTML=`
    <div class="back-link" onclick="renderPage('list')">← 返回個案列表</div>

    <!-- 詳情 header -->
    <div class="detail-header">
      <div class="detail-top">
        <div class="patient-name">
          ${c.name}${c.birthDate?`<span style="font-size:14px;color:var(--gray-400);font-weight:500">(${calcAge(c.birthDate)}歲)</span>`:''}
          <span class="badge ${STATUS_COLOR[c.status]||'badge-gray'}">${statusLabel(c.status)}</span>
          <span class="badge badge-blue">${c.mode}</span>
          <span class="badge badge-gray">${c.disease}</span>
          ${(c.modeHistory&&c.modeHistory.length)?`<span class="badge badge-purple">${c.modeHistory[c.modeHistory.length-1].from}轉${c.modeHistory[c.modeHistory.length-1].to}</span>`:''}
        </div>
        <div class="detail-actions">
          ${actions}
        </div>
      </div>
      <div class="detail-meta">
        <div class="meta-item"><strong>轉介來源：</strong>${c.source}</div>
        <div class="meta-item"><strong>轉介日期：</strong>${c.date}</div>
        ${isFormal?`<div class="meta-item"><strong>病歷號：</strong>00073450</div>`:''}
        ${isFormal&&c.mode==='住院'?`<div class="meta-item"><strong>床位：</strong>A301</div>`:''}
        <div class="meta-item"><strong>負責個管師：</strong>${c.mgr||'—'}</div>
        ${c.countdown?`<div class="meta-item" style="color:var(--red);font-weight:600">⚠️ 展延倒數 ${c.countdown} 天</div>`:''}
      </div>
    </div>

    ${adminKeyFields}

    <!-- 即將結案提醒 -->
    ${c.status==='即將結案'?`
    <div style="background:var(--purple-light);border:1px solid #DDD6FE;border-radius:10px;padding:14px 18px;margin-bottom:12px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--purple);margin-bottom:4px">🏁 療程即將結束</div>
        <div style="font-size:12px;color:var(--purple);line-height:1.6">目前為第 ${c.week} 週（共 12 週），系統偵測到療程進入最後階段。<br>請確認以下待辦事項，並與家屬討論後續安排。</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:5px;${c.week>=11?'background:var(--red-light);color:var(--red)':'background:#FEF3C7;color:var(--amber)'}">
            ${c.week>=11?'⚠ 結案評估應於本週完成':'結案評估應於下週完成'}
          </span>
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:5px;background:var(--gray-100);color:var(--gray-600)">出院準備資料待填寫</span>
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:5px;background:var(--gray-100);color:var(--gray-600)">家屬後續安排討論中</span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        <button class="btn btn-green btn-sm" onclick="openArchiveModal({formal:true,presetType:'正常結案',locked:true,showCloseDate:true,showDischargeDest:true,successMsg:()=>'已成功結案，個案移至結案管理'})">✓ 成功結案</button>
        <button class="btn btn-danger btn-sm" onclick="openArchiveModal({formal:true,presetType:'結案失敗',locked:true,showCloseDate:true,showDischargeDest:true,successMsg:()=>'已標記結案失敗，個案移至結案管理'})">不成功結案</button>
      </div>
    </div>
    `:''}

    <!-- 結案管理說明 banner -->
    ${c.status==='封存'?`
    <div style="background:var(--gray-100);border:1px solid var(--gray-300);border-radius:10px;padding:14px 18px;margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;color:var(--gray-700);margin-bottom:6px">📦 結案管理說明</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--gray-600)">
        <div><strong style="color:var(--gray-800)">結案類型：</strong>${c.archiveType||'—'}</div>
        <div><strong style="color:var(--gray-800)">結案日期：</strong>${c.archiveDate||'—'}</div>
        <div><strong style="color:var(--gray-800)">操作人員：</strong>${c.archiveOperator||'—'}</div>
      </div>
      ${c.archiveReason?`<div style="margin-top:8px;font-size:12px;color:var(--gray-600);background:var(--white);padding:10px;border-radius:6px">${c.archiveReason}</div>`:''}
    </div>
    `:''}

    <!-- 轉換申請中：固定顯示於個案基本資訊列下方、個案進度時間軸之上，不隨 Tab 切換而隱藏 -->
    ${c.modeConvertPending?renderModeConvertPendingCard(c):''}

    <!-- 個案進度（時間軸）：固定顯示，不隨 Tab 切換而隱藏 -->
    <div class="timeline-card">
      <div class="tc-header">
        <div class="tc-title">個案進度</div>
        <div style="display:flex;gap:10px;font-size:10px;color:var(--gray-400)">
          <span>${c.mode}路徑</span>
        </div>
      </div>
      <div class="timeline-body">
        <div class="timeline-track">
          ${steps.map(s=>`<div class="t-step ${s.done?'done':''} ${s.active?'active':''} ${s.event?'event':''}">
            <div class="t-dot">${s.done?'✓':''}</div>
            <div class="t-label">${s.label}</div>
            ${s.sub?`<div class="t-sub">${s.sub}</div>`:''}
            ${s.active?`<div style="font-size:9px;color:var(--blue);font-weight:700;margin-top:2px">${(s.label==='收案判斷中'&&c.diseaseCategory)?'已判斷':'進行中'}</div>`:''}
          </div>`).join('')}
        </div>
      </div>
    </div>

    <!-- 展延狀態人工切換器：固定釘在個案進度時間軸下方，不隨 Tab 切換而消失（健保署審核為紙本流程，需個管師手動切換；僅正式病歷有展延機制）-->
    ${isFormal&&(c.status==='照護中'||c.status==='展延中')?`
    <div class="section-card">
      <div class="sc-header">
        <div class="sc-title">📨 展延狀態</div>
        <span style="font-size:10px;color:var(--gray-400)">人工紙本流程，請依實際進度手動更新</span>
      </div>
      <div class="sc-body">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="markNoExtension('${c.id}')">① 不展延</button>
          <button class="btn ${c.status==='照護中'?'btn-secondary':'btn-ghost'} btn-sm" onclick="markExtensionPending('${c.id}')">② 待送出展延</button>
          <button class="btn ${c.status==='展延中'?'btn-amber':'btn-ghost'} btn-sm" onclick="markExtensionSubmitted('${c.id}')">③ 已送出展延（審核中）</button>
          <button class="btn btn-green btn-sm" onclick="openExtensionSuccessModal('${c.id}')">④ 展延成功</button>
          <button class="btn btn-danger btn-sm" onclick="markExtensionFailed('${c.id}')">⑤ 展延失敗</button>
        </div>
        <div style="margin-top:10px;font-size:11px;color:var(--gray-400)">目前狀態：<strong style="color:var(--gray-700)">${c.status}${c.timelineSub?'・'+c.timelineSub:''}</strong></div>
      </div>
    </div>
    `:''}

    <!-- Tab 導覽列 -->
    <div class="tabs detail-tabs">
      ${detailTabs.map((t,i)=>{
        const hint=tabHint(t.key);
        const prevGroup=i>0?detailTabs[i-1].group:null;
        const isGroupStart=!!t.group&&t.group!==prevGroup;
        return `<div class="tab ${detailActiveTab===t.key?'active':''}" data-tab-key="${t.key}" style="${isGroupStart?'margin-left:10px;padding-left:14px;border-left:1px solid var(--gray-200)':''}" onclick="switchDetailTab('${t.key}')">
          <div>${t.label}</div>
          <div style="font-size:10px;margin-top:2px;${hint?`color:${hint.color}`:'visibility:hidden'}">${hint?hint.text:'—'}</div>
        </div>`;
      }).join('')}
    </div>

    <!-- 總覽：個案基本資料 -->
    <div class="detail-tab-panel" data-tab-key="overview" style="${tabPanelStyle('overview')}">
      <div style="margin-bottom:10px">
        <a href="javascript:void(0)" style="font-size:12px;color:var(--blue);text-decoration:none;cursor:pointer" onclick="showCollectionHistoryTip()">📋 查看收案歷程</a>
      </div>
      <!-- 個案基本資料 -->
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">👤 個案基本資料</div>${isMgr?`<button class="btn btn-ghost btn-xs" onclick="alert('編輯個案資料')">✏️ 編輯</button>`:''}</div>
        <div class="sc-body">
          <div class="info-grid">
            <div class="info-item"><label>姓名</label><span>${c.name}</span></div>
            <div class="info-item"><label>身分證</label><span>A123456789</span></div>
            <div class="info-item"><label>出生日期</label><span>${c.birthDate||'—'}${c.birthDate?`（${calcAge(c.birthDate)}歲）`:''}</span></div>
            <div class="info-item"><label>性別</label><span>男</span></div>
            <div class="info-item"><label>${c.modeType==='general'?'一般疾病類型':'PAC 疾病別'}</label><span>${c.disease}</span></div>
            <div class="info-item"><label>照護模式</label><span>${c.mode}</span></div>
            <div class="info-item"><label>病歷號</label><span>00073450</span></div>
            ${c.mode==='住院'?`<div class="info-item"><label>床位</label><span>A301</span></div><div class="info-item"><label>主治醫師</label><span>張宗達 醫師</span><div style="font-size:10px;color:var(--gray-400);margin-top:2px">由杏翔系統匯入</div></div><div class="info-item"><label>科別</label><span>${c.department||'—'}</span><div style="font-size:10px;color:var(--gray-400);margin-top:2px">由杏翔系統匯入</div></div>`:`<div class="info-item"><label>科別</label><span>${c.department||'—'}</span><div style="font-size:10px;color:var(--gray-400);margin-top:2px">由杏翔系統匯入</div></div>`}
            ${(c.openDate||c.closeDate)?`<div class="info-item"><label>開案日</label><span>${c.openDate||'—'}</span></div><div class="info-item"><label>結案日（預估）</label><span>${c.closeDate||'—'}</span></div>`:''}
          </div>
          <div class="divider"></div>
          <div class="info-grid">
            <div class="info-item"><label>家屬姓名</label><span>陳小明${c.familyRelation?`（${c.familyRelation}）`:''}</span></div>
            <div class="info-item"><label>家屬電話</label><span>${c.familyPhone||'0912-345-678'}</span></div>
            <div class="info-item"><label>地址</label><span>${c.address||'—'}</span></div>
            <div class="info-item"><label>關係</label><span>${c.familyRelation||'—'}</span></div>
          </div>
          <div class="divider"></div>
          <div style="font-size:11px;color:var(--gray-400);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">上游聯絡人資料</div>
          <div class="info-grid">
            <div class="info-item"><label>聯絡人姓名</label><span>${c.upstreamContact?.name||'—'}</span></div>
            <div class="info-item"><label>聯絡電話</label><span>${c.upstreamContact?.phone||'—'}</span></div>
            <div class="info-item"><label>Line ID</label><span>${c.upstreamContact?.line||'—'}</span></div>
          </div>
          ${(c.modeHistory&&c.modeHistory.length)?`
          <div class="divider"></div>
          <div style="font-size:11px;color:var(--gray-400)">
            ${c.modeHistory.map(h=>`曾為${h.from}個案，於 ${h.date} 轉換為${h.to}${h.note?`（備註：${h.note}）`:''}`).join('；')}
          </div>
          `:''}
        </div>
      </div>
    </div>

    <!-- 聯繫紀錄：家屬聯繫紀錄＋上游聯繫紀錄 -->
    <div class="detail-tab-panel" data-tab-key="contact" style="${tabPanelStyle('contact')}">
      <!-- 家屬聯繫紀錄 -->
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">📞 家屬聯繫紀錄</div>${isMgr?`<button class="btn btn-ghost btn-xs" onclick="openAddContactModal('${c.id}')">＋ 新增</button>`:''}</div>
        <div class="sc-body">
          ${c.familyContacts&&c.familyContacts.length?`
          <div class="contact-log">
            ${[...c.familyContacts].reverse().map(log=>`
              <div class="contact-entry ${log.result==='確定不報到'?'':'done'}">
                <div>
                  <div class="contact-label">${log.result}</div>
                  <div class="contact-meta">${log.datetime}・${log.method}</div>
                  ${log.note?`<div class="contact-note">${log.note}</div>`:''}
                </div>
              </div>`).join('')}
          </div>
          `:`<div style="font-size:12px;color:var(--gray-400);padding:8px 0">尚無聯繫紀錄</div>`}
          ${c.modeType==='hosp'?`
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--gray-100)">
            <div style="font-size:11px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">住院房型偏好（與排床模組同步）</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${['無偏好','單人房','雙人房','多人房（3人以上）'].map(opt=>{
                const prefMap={'single':'單人房','double':'雙人房','multi':'多人房（3人以上）'};
                const currentPref=prefMap[c.roomPref]||'無偏好';
                const isSelected=opt===currentPref;
                return `<button class="btn ${isSelected?'btn-primary':'btn-secondary'} btn-xs" ${isAdm?'disabled':''} onclick="${isMgr?`alert('房型偏好已更新為「${opt}」，已同步至排床模組')`:''}">
                  ${isSelected?'✓ ':''} ${opt}
                </button>`;
              }).join('')}
            </div>
            ${c.roomPref&&c.roomPref!==null?`<div style="font-size:11px;color:var(--blue);margin-top:6px">目前偏好已同步至排床模組，安排床位時將優先配對</div>`:''}
          </div>
          `:''}
        </div>
      </div>

      <!-- 上游聯繫紀錄 -->
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">🏥 上游聯繫紀錄</div>${isMgr?`<button class="btn btn-ghost btn-xs" onclick="openUpstreamContactModal()">＋ 新增</button>`:''}</div>
        <div class="sc-body">
          <div class="info-grid-2" style="margin-bottom:12px">
            <div class="info-item"><label>上游醫院</label><span>${c.source}</span></div>
            <div class="info-item"><label>轉介窗口</label><span>${c.upstreamContact?.name||'—'}</span></div>
            <div class="info-item"><label>聯絡電話 / Line</label><span>${c.upstreamContact?.phone||'—'} ／ ${c.upstreamContact?.line||'—'}</span></div>
            <div class="info-item">
              <label>聯繫狀態</label>
              <span style="color:${c.upstreamStatus==='已回報收案'?'var(--green)':c.upstreamStatus==='已回報退案'?'var(--red)':'var(--gray-500)'};font-weight:600">
                ${c.upstreamStatus==='已回報收案'?'✓ 已回報收案':c.upstreamStatus==='已回報退案'?'✕ 已回報退案':'尚未回報'}
              </span>
            </div>
          </div>
          ${c.upstreamLog&&c.upstreamLog.length?`
          <div style="padding-top:12px;border-top:1px solid var(--gray-100)">
            <div class="contact-log">
              ${[...c.upstreamLog].reverse().map(log=>`
                <div class="contact-entry ${log.result==='已回報退案'?'':'done'}">
                  <div>
                    <div class="contact-label">${log.result||'已聯繫，尚無結果'}</div>
                    <div class="contact-meta">${log.datetime}・${log.method}</div>
                    ${log.openDate?`<div class="contact-note">預計開案日：${log.openDate}</div>`:''}
                    ${log.note?`<div class="contact-note">${log.note}</div>`:''}
                  </div>
                </div>`).join('')}
            </div>
          </div>
          `:`<div style="font-size:12px;color:var(--gray-400);padding-top:8px;border-top:1px solid var(--gray-100)">尚無聯繫紀錄，點擊「＋ 新增」開始記錄</div>`}
        </div>
      </div>
    </div>


    <!-- 居家復健排班查看（目前是居家或曾經是居家皆顯示；非目前模式時整體唯讀）-->
    ${wasEverMode(c,'居家')?`
    <div class="detail-tab-panel" data-tab-key="rehab" style="${tabPanelStyle('rehab')}">
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">📅 居家復健排班</div><span style="font-size:10px;color:var(--gray-400)">${c.modeType==='home'?'本週':'僅居家期間資料，唯讀'}</span></div>
        <div class="sc-body" style="${c.modeType!=='home'?'opacity:.65':''}">
          <div class="info-note blue" style="margin-bottom:12px">${c.modeType==='home'?'排班資料同步自復健排班管理模組，如需異動請至該模組操作':'個案目前非居家模式，以下為居家期間留存的排班資料，僅供查看'}</div>
          ${renderHomeRehabSchedule(c)}
        </div>
      </div>
    </div>
    `:''}

    <!-- 文件查看：匯出展延/結案＋轉診單＋醫療紀錄查看＋相關表單 -->
    <div class="detail-tab-panel" data-tab-key="docs" style="${tabPanelStyle('docs')}">
      ${isMgr?`
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button class="btn btn-ghost btn-sm" onclick="openExportExtendModal()">📤 匯出展延</button>
        <button class="btn btn-ghost btn-sm" onclick="openExportCloseModal()">📤 匯出結案</button>
      </div>
      `:''}
      <!-- 轉診單（選填附件，唯讀查看） -->
      <div class="section-card">
        <div class="sc-header">
          <div class="sc-title">📋 轉診單</div>
        </div>
        <div class="sc-body">
          ${c.referralDoc?`
          <div class="attachment-list">
            <div class="attachment-item">
              <span class="attachment-icon">📄</span>
              <div style="flex:1"><div class="attachment-name">${c.referralDoc.name}</div><div class="attachment-meta">${c.referralDoc.size}・${c.referralDoc.date} 上傳</div></div>
              <button class="btn btn-ghost btn-xs" onclick="alert('預覽附件：${c.referralDoc.name}')">預覽</button>
            </div>
          </div>
          `:`
          <div style="text-align:center;padding:16px;color:var(--gray-400);font-size:12px">未提供轉診單</div>
          `}
        </div>
      </div>

      <!-- 醫療紀錄查看（目前是住院，或曾經是住院皆顯示；非目前模式時整體唯讀）-->
      ${wasEverMode(c,'住院')?`
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">🩺 醫療紀錄查看</div><span style="font-size:10px;color:var(--gray-400)">${c.modeType==='hosp'?'僅限住院個案':'僅住院期間資料，唯讀'}</span></div>
        <div class="sc-body" style="${c.modeType!=='hosp'?'opacity:.65':''}">
          <div class="forms-grid">
            <div class="form-item" onclick="alert('將串接杏翔系統查看護理紀錄')">
              <div class="form-item-left"><div class="form-icon">📋</div><div><div class="form-name">護理紀錄</div><div class="form-meta">*杏翔</div></div></div>
              <span class="form-status fs-pending">查看</span>
            </div>
            <div class="form-item" onclick="alert('將串接杏翔系統查看病程記錄')">
              <div class="form-item-left"><div class="form-icon">📈</div><div><div class="form-name">病程記錄</div><div class="form-meta">*杏翔</div></div></div>
              <span class="form-status fs-pending">查看</span>
            </div>
            <div class="form-item" onclick="alert('將串接杏翔系統查看生命徵象')">
              <div class="form-item-left"><div class="form-icon">💓</div><div><div class="form-name">生命徵象</div><div class="form-meta">*杏翔</div></div></div>
              <span class="form-status fs-pending">查看</span>
            </div>
            <div class="form-item" onclick="renderPage('his-record','${caseId}')">
              <div class="form-item-left"><div class="form-icon">🏥</div><div><div class="form-name">正式病歷</div><div class="form-meta">*杏翔</div></div></div>
              <span class="form-status fs-pending">查看</span>
            </div>
          </div>
        </div>
      </div>
      `:''}

      <!-- 醫療紀錄查看（僅日照／居家個案，僅含正式病歷入口）-->
      ${(c.modeType==='day'||c.modeType==='home')?`
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">🩺 醫療紀錄查看</div><span style="font-size:11px;color:var(--gray-400)">僅限正式病歷個案</span></div>
        <div class="sc-body">
          <div class="forms-grid">
            <div class="form-item" onclick="renderPage('his-record','${caseId}')">
              <div class="form-item-left"><div class="form-icon">🏥</div><div><div class="form-name">正式病歷</div><div class="form-meta">*杏翔</div></div></div>
              <span class="form-status fs-pending">查看</span>
            </div>
          </div>
        </div>
      </div>
      `:''}

      <!-- 相關表單 -->
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">📑 相關表單</div></div>
        <div class="sc-body">
          ${formsList(formData.common,'在院期間表單')}
          ${formData.post.length?`<div class="divider"></div>${formsList(formData.post,'結案後表單')}`:''}
        </div>
      </div>
    </div>

    <!-- 轉介：轉介安排（常駐顯示，不限即將結案才出現；結案管理後轉為唯讀查看）-->
    <div class="detail-tab-panel" data-tab-key="referral" style="${tabPanelStyle('referral')}">
      ${c.referral?(()=>{
        const referralReadonly=(!isMgr)||c.status==='封存';
        const referralTarget=c.referral.target||'無需轉介';
        const refBadge=referralBadge(c);
        return `
      <div class="section-card">
        <div class="sc-header">
          <div class="sc-title">🔄 轉介安排</div>
          <span class="badge ${refBadge.cls}">${refBadge.text}</span>
        </div>
        <div class="sc-body">
          <div style="font-size:11px;color:var(--gray-400);margin-bottom:10px">個管師可隨時安排轉介，不限結案前才處理。常見轉介去向：居家醫療／長照／社工。</div>
          <div class="form-group" style="margin-bottom:10px">
            <label>轉介去向</label>
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <select class="form-control" id="referral-target-select" style="flex:1;min-width:160px" ${referralReadonly?'disabled':''} onchange="updateReferralConfirmedAvailability()">
                <option ${referralTarget==='無需轉介'?'selected':''}>無需轉介</option>
                <option ${referralTarget==='轉介居家醫療'?'selected':''}>轉介居家醫療</option>
                <option ${referralTarget==='轉介長照服務'?'selected':''}>轉介長照服務</option>
                <option ${referralTarget==='轉介社工服務'?'selected':''}>轉介社工服務</option>
              </select>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap">
                <input type="checkbox" id="referral-confirmed" style="accent-color:var(--blue)" ${(referralReadonly||referralTarget==='無需轉介')?'disabled':''} ${c.referral.status==='已轉介'?'checked':''}>
                ✓ 已完成轉介
              </label>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label>轉介備註</label>
            <textarea class="form-control" id="referral-note" rows="2" ${referralReadonly?'readonly':''} placeholder="轉介服務說明、聯絡窗口等…">${c.referral.note||''}</textarea>
          </div>
          <div class="form-group">
            <label>預估出院動向</label>
            ${!referralReadonly?`<select class="form-control" onchange="updateDischargeDest('${caseId}',this.value)">${DISCHARGE_DEST_OPTIONS.map(o=>`<option value="${o}" ${c.dischargeDest===o?'selected':''}>${o||'請選擇'}</option>`).join('')}</select>`:`<input class="form-control" value="${c.dischargeDest||'—'}" readonly>`}
          </div>
          ${c.dischargeDest==='其他'?`<div class="form-group" style="margin-top:10px">
            <label>其他說明${!referralReadonly?' <span class="required">*</span>':''}</label>
            ${!referralReadonly?`<input class="form-control" value="${c.dischargeDestNote||''}" oninput="updateDischargeDestNote(this.value)" placeholder="請說明出院後去向">`:`<input class="form-control" value="${c.dischargeDestNote||'—'}" readonly>`}
          </div>`:''}
          ${!referralReadonly?`<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" onclick="saveReferral('${c.id}')">儲存</button></div>`:''}
        </div>
      </div>
      `;})():''}
    </div>

    <!-- 筆記：所有角色皆可新增，純累加不可編輯／刪除，固定排在所有 Tab 最後 -->
    <div class="detail-tab-panel" data-tab-key="notes" style="${tabPanelStyle('notes')}">
      <div class="section-card">
        <div class="sc-header"><div class="sc-title">📝 筆記</div></div>
        <div class="sc-body">
          <div class="form-group" style="margin-bottom:10px">
            <textarea class="form-control" id="new-note-input" rows="3" placeholder="輸入筆記內容…"></textarea>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
            <button class="btn btn-primary btn-sm" onclick="addCaseNote('${c.id}')">新增筆記</button>
          </div>
          <div class="divider"></div>
          ${(c.notes&&c.notes.length)?`
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
            ${c.notes.map(n=>`
            <div style="border:1px solid var(--gray-200);border-radius:8px;padding:10px 12px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <span style="font-size:12px;font-weight:600;color:var(--gray-700)">${noteRoleIcon(n.role)} ${n.author}（${n.role}）</span>
                <span style="font-size:10px;color:var(--gray-400)">${n.timestamp}</span>
              </div>
              <div style="font-size:13px;color:var(--gray-700);margin-top:6px;white-space:pre-wrap">${n.text}</div>
            </div>`).join('')}
          </div>
          `:`<div style="text-align:center;padding:24px 16px;color:var(--gray-400);font-size:12px;margin-top:12px">尚無筆記</div>`}
        </div>
      </div>
    </div>
  `;
}

// 回看收案歷史：此 prototype 中兩模組資料各自獨立，暫無法直接跳轉，僅以提示連結標示未來的串接入口
function showCollectionHistoryTip(){
  alert('請至「收案管理」模組查看此個案的病摘、PAC判斷依據、收案聯繫紀錄。＊此 prototype 中兩個模組資料各自獨立，無法直接跳轉查看，正式串接後可改為真的連結。');
}

// ── 個案詳情頁 Tab 切換：僅顯示/隱藏對應區塊，不重新呼叫 renderDetail，避免破壞其他互動狀態 ──
function switchDetailTab(tabKey){
  detailActiveTab=tabKey;
  document.querySelectorAll('.detail-tab-panel').forEach(el=>{
    el.style.display = el.dataset.tabKey===tabKey ? '' : 'none';
  });
  document.querySelectorAll('.detail-tabs .tab').forEach(el=>{
    el.classList.toggle('active', el.dataset.tabKey===tabKey);
  });
}

// ── 動態組裝時間軸 ──
// 回傳節點陣列，每個節點含 label / sub / event(是否為紅標關鍵分岔節點，依參考圖統一用主題藍色強調) / done / active
function buildTimeline(c){
  const allNodes=TIMELINE_FORMAL_COMMON.map(n=>({...n}));

  // 找出目前所在節點的 index（依 c.timelineStep + c.timelineSub 比對 label/sub）
  let currentIdx=-1;
  if(c.timelineStep){
    currentIdx=allNodes.findIndex(n=>{
      if(n.label!==c.timelineStep) return false;
      if(c.timelineSub) return n.sub===c.timelineSub || (n.sub&&n.sub.includes(c.timelineSub));
      return true;
    });
    // 找不到精確匹配時，退而求其次比對 label
    if(currentIdx===-1) currentIdx=allNodes.findIndex(n=>n.label===c.timelineStep);
  }
  // 若曾經展延失敗過，補上"展延結果"節點視為已完成（用於照護中展延後情境）
  if(c.hadExtensionFail&&currentIdx===-1){
    currentIdx=allNodes.findIndex(n=>n.label==='照護中'&&n.sub==='展延後');
  }
  return allNodes.map((n,i)=>({
    label:n.label,
    sub:n.sub||'',
    event:!!n.event,
    done:currentIdx>=0&&i<currentIdx,
    active:i===currentIdx,
  }));
}

// ── 居家復健排班：週次計算（依開案日＆預估結案日推算總週數，第1週起算於開案日當週的週一）──
function getHomeRehabTotalWeeks(c){
  if(!c.openDate||!c.closeDate||c.closeDate==='—') return 1;
  const open=new Date(c.openDate.replace(/\//g,'-'));
  const close=new Date(c.closeDate.replace(/\//g,'-'));
  const diffDays=Math.round((close-open)/(24*3600*1000));
  if(isNaN(diffDays)) return 1;
  return Math.max(1,Math.ceil((diffDays+1)/7));
}
function getHomeRehabWeekMonday(c,weekIndex){
  const open=new Date(c.openDate.replace(/\//g,'-'));
  const openDow=(open.getDay()+6)%7; // 轉換為 0=一...6=日
  const week1Monday=new Date(open);
  week1Monday.setDate(open.getDate()-openDow);
  const monday=new Date(week1Monday);
  monday.setDate(week1Monday.getDate()+(weekIndex-1)*7);
  return monday;
}
function fmtRehabDate(d,withDow){
  const base=`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  if(!withDow) return base;
  const dowChar=['一','二','三','四','五','六','日'][(d.getDay()+6)%7];
  return `${base}（${dowChar}）`;
}
function switchRehabWeek(caseId,weekIndex){
  rehabWeekIndex=parseInt(weekIndex,10)||1;
  rehabWeekCaseId=caseId;
  renderPage('detail',currentCase);
}

// ── 居家復健排班（唯讀週視圖，可切換週次）：初評／複評／結案評估以不同顏色標籤與一般例行治療區隔 ──
function renderHomeRehabSchedule(c){
  const schedule=c.homeRehabSchedule;
  if(!schedule||!schedule.length){
    return `<div style="text-align:center;padding:30px 16px;color:var(--gray-400);font-size:12px">尚未安排班表，請至居家排班管理模組安排</div>`;
  }
  const totalWeeks=getHomeRehabTotalWeeks(c);
  if(rehabWeekCaseId!==c.id){ rehabWeekIndex=1; rehabWeekCaseId=c.id; }
  if(rehabWeekIndex<1) rehabWeekIndex=1;
  if(rehabWeekIndex>totalWeeks) rehabWeekIndex=totalWeeks;
  const midWeek=Math.min(totalWeeks,Math.max(1,Math.ceil(totalWeeks/2)));
  const monday=getHomeRehabWeekMonday(c,rehabWeekIndex);
  const sunday=new Date(monday); sunday.setDate(monday.getDate()+6);

  const profStyle={PT:{color:'var(--blue)',bg:'var(--blue-light)'},OT:{color:'#9D174D',bg:'#FCE7F3'},ST:{color:'var(--green)',bg:'var(--green-light)'}};
  const tagBadge={'初評':'badge-blue','複評':'badge-purple','結案評估':'badge-amber'};
  const dowLabel=['一','二','三','四','五','六','日'];

  const byDow={};
  schedule.forEach(item=>{ (byDow[item.dow]=byDow[item.dow]||[]).push(item); });

  const today=new Date('2026-07-17'); // prototype 假設今日，用於標示「今天」欄位
  const todayKey=fmtRehabDate(today);

  const dayCells=dowLabel.map((label,dow)=>{
    const d=new Date(monday); d.setDate(monday.getDate()+dow);
    const isWeekend=dow>=5;
    const isToday=fmtRehabDate(d)===todayKey;
    const items=byDow[dow]||[];
    const eventCards=items.map(item=>{
      if(item.cancelled){
        return `
      <div style="padding:6px 7px;border-radius:6px;background:var(--gray-100);border:1px solid var(--gray-200)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:3px">
          <span style="font-size:10px;font-weight:700;color:var(--gray-400);text-decoration:line-through">${item.profession}</span>
          <span class="badge badge-gray" style="font-size:9px;padding:1px 5px">已取消（轉居家醫療）</span>
        </div>
        <div style="font-size:10px;font-weight:600;color:var(--gray-400);text-decoration:line-through">${item.period}</div>
        <div style="font-size:9px;color:var(--gray-300);text-decoration:line-through">${item.timeRange}</div>
        <div style="font-size:10px;color:var(--gray-400);margin-top:3px;text-decoration:line-through">${item.therapist}・${item.duration}</div>
      </div>`;
      }
      const showTag=item.tag&&(
        (item.tag==='初評'&&rehabWeekIndex===1)||
        (item.tag==='複評'&&rehabWeekIndex===midWeek)||
        (item.tag==='結案評估'&&rehabWeekIndex===totalWeeks)
      );
      const ps=profStyle[item.profession]||profStyle.PT;
      const signBadge=item.signStatus==='已簽到'
        ?`<span class="badge badge-green" style="font-size:9px;padding:1px 5px">✓ 已簽到</span>`
        :item.signStatus==='未簽到'
          ?`<span class="badge badge-red" style="font-size:9px;padding:1px 5px">✕ 未簽到</span>`
          :'';
      return `
      <div style="padding:6px 7px;border-radius:6px;background:${showTag?'var(--purple-light)':ps.bg};border:1px solid ${showTag?'#DDD6FE':'transparent'}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:3px">
          <span style="font-size:10px;font-weight:700;color:${ps.color}">${item.profession}</span>
          ${showTag?`<span class="badge ${tagBadge[item.tag]||'badge-purple'}" style="font-size:9px;padding:1px 5px">${item.tag}</span>`:''}
        </div>
        <div style="font-size:10px;font-weight:600;color:var(--gray-700)">${item.period}</div>
        <div style="font-size:9px;color:var(--gray-400)">${item.timeRange}</div>
        <div style="font-size:10px;color:var(--gray-600);margin-top:3px">${item.therapist}・${item.duration}</div>
        ${signBadge?`<div style="margin-top:4px">${signBadge}</div>`:''}
      </div>`;
    }).join('');
    return `
    <div style="border:1px solid ${isToday?'var(--blue)':'var(--gray-200)'};border-radius:8px;min-height:118px;background:${isWeekend?'var(--gray-50)':'var(--white)'};display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:6px 8px;border-bottom:1px solid var(--gray-100);text-align:center;background:${isToday?'var(--blue-light)':'transparent'}">
        <div style="font-size:10px;color:${isToday?'var(--blue)':'var(--gray-400)'};font-weight:600">週${label}</div>
        <div style="font-size:13px;font-weight:700;color:${isToday?'var(--blue)':'var(--gray-800)'}">${d.getDate()}</div>
      </div>
      <div style="flex:1;padding:5px;display:flex;flex-direction:column;gap:4px">
        ${eventCards||`<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--gray-300)">－</div>`}
      </div>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="font-size:12px;color:var(--gray-500)">${fmtRehabDate(monday)} － ${fmtRehabDate(sunday)}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <button class="btn btn-ghost btn-xs" ${rehabWeekIndex<=1?'disabled':''} onclick="switchRehabWeek('${c.id}',${rehabWeekIndex-1})">‹ 上一週</button>
        <select class="form-control" style="font-size:12px;padding:5px 8px;width:auto" onchange="switchRehabWeek('${c.id}',this.value)">
          ${Array.from({length:totalWeeks},(_,i)=>i+1).map(w=>`<option value="${w}" ${w===rehabWeekIndex?'selected':''}>第 ${w} 週</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-xs" ${rehabWeekIndex>=totalWeeks?'disabled':''} onclick="switchRehabWeek('${c.id}',${rehabWeekIndex+1})">下一週 ›</button>
      </div>
    </div>
    <div style="overflow-x:auto">
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;min-width:700px">${dayCells}</div>
    </div>
  `;
}


function renderFormFill(container,caseId,formName){
  currentForm=formName;
  const c=CASES.formal.find(x=>x.id===caseId)||CASES.formal[0];
  document.getElementById('bc').textContent=`個案管理 › ${c.name} › ${formName}`;

  const fillData=FORM_FILL_CONTENT[formName];
  const isMgr=currentRole==='mgr';

  let sectionsHTML='';
  if(fillData){
    sectionsHTML=fillData.sections.map(sec=>{
      if(sec.table){
        return `<div class="form-section">
          <div class="fs-header"><div class="fs-title">${sec.title}</div></div>
          <div class="fs-body" style="padding:0">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:var(--gray-50)">
                <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">次別</th>
                <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">日期</th>
                <th style="padding:8px 12px;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">病程週數</th>
                <th style="padding:8px 12px;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">PT</th>
                <th style="padding:8px 12px;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">OT</th>
                <th style="padding:8px 12px;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">ST</th>
                <th style="padding:8px 12px;border-bottom:1px solid var(--gray-200);font-size:11px;color:var(--gray-500)">狀態</th>
              </tr></thead>
              <tbody>
                ${sec.rows.map((r,i)=>`<tr style="${i===1?'background:var(--blue-light)':''} ${r.status==='future'?'opacity:.5':''}">
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100);font-weight:600">${r.label}</td>
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100)">${r.date}</td>
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100);text-align:center">${r.week}</td>
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100);color:var(--blue);font-weight:600">${r.pt}</td>
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100);color:#9D174D;font-weight:600">${r.ot}</td>
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100);color:var(--green);font-weight:600">${r.st}</td>
                  <td style="padding:9px 12px;border-bottom:1px solid var(--gray-100)">
                    ${r.status==='done'?'<span class="badge badge-green">✓ 完成</span>':r.status==='pending'?'<span class="badge badge-amber">待填</span>':'<span class="badge badge-gray">未到期</span>'}
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
      }
      if(sec.checklist){
        return `<div class="form-section">
          <div class="fs-header"><div class="fs-title">${sec.title}</div></div>
          <div class="fs-body">
            <div class="checklist">
              ${sec.items.map(item=>`<div class="check-item"><input type="checkbox"><span>${item}</span></div>`).join('')}
            </div>
          </div>
        </div>`;
      }
      const fieldsHTML=sec.fields.map(f=>{
        if(f.type==='textarea') return `<div class="form-group full"><label>${f.label}</label><textarea class="form-control" rows="3" ${f.readonly?'readonly':''}>${f.value||''}</textarea></div>`;
        if(f.type==='select') return `<div class="form-group"><label>${f.label}</label><select class="form-control" ${f.readonly?'disabled':''}>${(f.options||[]).map(o=>`<option ${o===f.value?'selected':''}>${o}</option>`).join('')}</select></div>`;
        return `<div class="form-group"><label>${f.label}</label><input class="form-control" type="text" value="${f.value||''}" ${f.readonly?'readonly':''}></div>`;
      }).join('');
      return `<div class="form-section">
        <div class="fs-header"><div class="fs-title">${sec.title}</div></div>
        <div class="fs-body"><div class="form-row">${fieldsHTML}</div></div>
      </div>`;
    }).join('');
  } else {
    // 沒有預設內容的表單：顯示通用框架
    sectionsHTML=`
      <div class="form-section">
        <div class="fs-header"><div class="fs-title">基本資料（自動帶入）</div></div>
        <div class="fs-body">
          <div class="form-row">
            <div class="form-group"><label>個案姓名</label><input class="form-control" value="${c.name}" readonly></div>
            <div class="form-group"><label>病歷號</label><input class="form-control" value="${c.formal?'00073450':'—'}" readonly></div>
            <div class="form-group"><label>照護模式</label><input class="form-control" value="${c.mode}" readonly></div>
            <div class="form-group"><label>記錄日期</label><input class="form-control" type="date" value="2026-06-25"></div>
          </div>
        </div>
      </div>
      <div class="form-section">
        <div class="fs-header"><div class="fs-title">填寫內容</div></div>
        <div class="fs-body">
          <div class="info-note blue">此表單內容依實際使用情境填寫，欄位設計將依業務需求細化。</div>
          <div class="form-group full"><label>主要內容</label><textarea class="form-control" rows="5" placeholder="填寫${formName}相關內容..."></textarea></div>
          <div class="form-group full"><label>備註</label><textarea class="form-control" rows="2" placeholder="其他備註..."></textarea></div>
        </div>
      </div>
    `;
  }

  container.innerHTML=`
    <div class="back-link" onclick="renderPage('detail','${caseId}')">← 返回 ${c.name} 個案詳情</div>

    <div class="form-fill-header">
      <div>
        <div class="ff-title">${formName}</div>
        <div class="ff-meta">${c.name}・${c.mode}・${c.disease}・2026/06/25</div>
      </div>
      <div class="ff-actions">
        <button class="btn btn-secondary btn-sm" onclick="alert('已列印')">🖨️ 列印</button>
        <button class="btn btn-secondary btn-sm" onclick="alert('已預覽')">👁 預覽</button>
        <button class="btn btn-secondary btn-sm" onclick="alert('已暫存')">暫存</button>
        ${isMgr||currentRole==='doc'||currentRole==='nur'?`<button class="btn btn-primary btn-sm" onclick="alert('表單已送出')">送出</button>`:''}
      </div>
    </div>

    ${sectionsHTML}

    <div class="form-footer">
      <div style="font-size:11px;color:var(--gray-500)">最後儲存：2026/06/25 14:30・林美惠</div>
      <div style="display:flex;gap:7px">
        <button class="btn btn-secondary btn-sm" onclick="alert('已暫存')">暫存</button>
        ${isMgr||currentRole==='doc'||currentRole==='nur'?`<button class="btn btn-primary btn-sm" onclick="alert('表單已送出')">送出</button>`:''}
      </div>
    </div>
  `;
}

// ── 正式病歷（杏翔）唯讀詳情頁：由醫療紀錄查看 section 的「正式病歷」卡片點擊進入 ──
function renderHisRecord(container,caseId){
  currentCase=caseId;
  const c=CASES.formal.find(x=>x.id===caseId)||CASES.formal[0];
  document.getElementById('bc').textContent=`個案管理 › ${c.name} › 正式病歷（杏翔）`;

  const isHosp=c.modeType==='hosp';
  const dateLabel1=isHosp?'入院日期':'開案日期';
  const dateLabel2=isHosp?'預計出院日期':'結案日期';

  container.innerHTML=`
    <div class="back-link" onclick="renderPage('detail','${caseId}')">← 返回 ${c.name} 個案詳情</div>

    <div class="form-fill-header">
      <div>
        <div class="ff-title">正式病歷（杏翔）</div>
        <div class="ff-meta">${c.name}・${c.mode}・${c.disease}・${c.openDate||'—'}</div>
      </div>
      <div style="font-size:11px;color:var(--gray-400)">由杏翔系統同步・如需修改請至杏翔操作</div>
    </div>

    <div class="form-section">
      <div class="fs-header"><div class="fs-title">基本資料</div></div>
      <div class="fs-body">
        <div class="form-row">
          <div class="form-group"><label>姓名</label><input class="form-control" value="${c.name}" readonly></div>
          <div class="form-group"><label>性別</label><input class="form-control" value="男" readonly></div>
          <div class="form-group"><label>血型</label><input class="form-control" value="A 型" readonly></div>
          <div class="form-group"><label>生日</label><input class="form-control" value="${c.birthDate||'—'}" readonly></div>
          <div class="form-group"><label>科別</label><input class="form-control" value="${c.department||'—'}" readonly></div>
          <div class="form-group"><label>主治醫師</label><input class="form-control" value="張宗達 醫師" readonly></div>
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="fs-header"><div class="fs-title">診斷</div></div>
      <div class="fs-body">
        <div class="form-row">
          <div class="form-group"><label>主診斷</label><input class="form-control" value="${c.disease}" readonly></div>
          <div class="form-group"><label>藥物過敏</label><input class="form-control" value="盤尼西林" readonly></div>
          <div class="form-group"><label>其他過敏</label><input class="form-control" value="無" readonly></div>
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="fs-header"><div class="fs-title">住院資訊</div></div>
      <div class="fs-body">
        <div class="form-row">
          <div class="form-group"><label>${dateLabel1}</label><input class="form-control" value="${c.openDate||'—'}" readonly></div>
          <div class="form-group"><label>${dateLabel2}</label><input class="form-control" value="${c.closeDate||'—'}" readonly></div>
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="fs-header"><div class="fs-title">病歷內容</div></div>
      <div class="fs-body">
        <div class="form-group full"><label>主訴</label><textarea class="form-control" rows="2" readonly>右側肢體無力合併言語不清，發病約 2 天</textarea></div>
        <div class="form-group full"><label>現在病歷</label><textarea class="form-control" rows="3" readonly>患者於發病當日由家屬送至急診，經影像學確認為左側大腦中動脈梗塞，已接受靜脈血栓溶解治療，病情穩定後轉介 PAC 復健療程。</textarea></div>
        <div class="form-group full"><label>過去病史</label><textarea class="form-control" rows="2" readonly>高血壓 10 年、第二型糖尿病 5 年</textarea></div>
        <div class="form-group full"><label>家族史</label><textarea class="form-control" rows="2" readonly>父親有高血壓病史</textarea></div>
        <div class="form-group full"><label>系統回顧</label><textarea class="form-control" rows="2" readonly>心血管系統：高血壓控制中；神經系統：右側偏癱、輕度失語</textarea></div>
      </div>
    </div>

    <div class="form-footer" style="justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" onclick="renderPage('detail','${caseId}')">← 返回個案詳情</button>
    </div>
  `;
}

// ── 工具函式 ──
function showLinkTip(formName,target){
  alert(`「${formName}」屬於${target}的功能範圍，將跳轉至 ${target} 查看／填寫。\n\n（prototype 示意，實際串接後將直接導向該模組對應頁面）`);
}

// ── 匯出展延／結案資料：依個案照護模式（住院／居家／日照）動態產生項目清單 ──
const EXPORT_EXTEND_ITEMS={
  base:['封面表單','總表（評估量表）','會議記錄','專審表'],
  hosp:['入院病摘','護理紀錄','病程記錄','生命徵象'],
  home:['PAC 居家復健治療紀錄','英文病歷'],
  day:['日照執行記錄表','英文病歷'],
};
const EXPORT_CLOSE_ITEMS={
  base:['PAC照護模式記錄表','病歷摘要','居家環境評估暨危險因子檢核表','個案綜合評估報告書（總表）','PAC會議記錄','PAC個案滿意度調查表','正式病歷'],
  hosp:['PAC個案出院追蹤記錄表','護理紀錄/生命徵象'],
  home:['居家復健治療紀錄','居家訪視護理記錄表'],
  day:[],
};
const EXPORT_EXTRA_LABEL={hosp:'住院個案另附',home:'居家個案另附',day:'日照個案另附'};
function renderExportItems(items,checked){
  return items.map(name=>`<div class="export-item"><input type="checkbox" ${checked?'checked':''}><span>${name}</span></div>`).join('');
}
function renderExportModalBody(baseItems,extraItemsMap,modeType,baseChecked,extraChecked){
  const extraItems=extraItemsMap[modeType]||[];
  return `
    <div class="export-group">
      <div class="export-group-label">基本文件</div>
      <div class="export-items">${renderExportItems(baseItems,baseChecked)}</div>
    </div>
    ${extraItems.length?`
    <div class="export-group">
      <div class="export-group-label">${EXPORT_EXTRA_LABEL[modeType]||'另附'}</div>
      <div class="export-items">${renderExportItems(extraItems,extraChecked)}</div>
    </div>
    `:''}
  `;
}
function openExportExtendModal(){
  const c=getCurrentCaseObj();
  const modeType=c?c.modeType:'hosp';
  document.getElementById('export-extend-body').innerHTML=renderExportModalBody(EXPORT_EXTEND_ITEMS.base,EXPORT_EXTEND_ITEMS,modeType,true,false);
  openModal('modal-export-extend');
}
function openExportCloseModal(){
  const c=getCurrentCaseObj();
  const modeType=c?c.modeType:'hosp';
  document.getElementById('export-close-body').innerHTML=renderExportModalBody(EXPORT_CLOSE_ITEMS.base,EXPORT_CLOSE_ITEMS,modeType,true,true);
  openModal('modal-export-close');
}
function openModal(id){document.getElementById(id).classList.remove('hidden')}
function closeModal(id){document.getElementById(id).classList.add('hidden')}
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',function(e){if(e.target===this)this.classList.add('hidden')}));

function getCurrentCaseObj(){
  return CASES.formal.find(x=>x.id===currentCase)||null;
}

// ── 預估出院動向（總覽 Tab，僅正式病歷個案，個管師可編輯）──
function updateDischargeDest(caseId,value){
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

// ── 展延狀態切換器：不展延／已送出展延（審核中）──
function markNoExtension(caseId){
  const c=getCurrentCaseObj();
  if(c){
    c.status='照護中';
    c.timelineStep='照護中';
    c.timelineSub='展延後';
  }
  alert('已標記不展延，個案將從照護中直接進入照護中（展延後）階段，請繼續照護直到即將結案。');
  if(c) renderPage('detail',currentCase);
}
function markExtensionPending(caseId){
  const c=getCurrentCaseObj();
  if(c){
    c.status='展延中';
    c.timelineStep='展延中';
    c.timelineSub='待展延申請';
  }
  alert('已標記待送出展延，請盡快備妥資料送出審核');
  if(c) renderPage('detail',currentCase);
}
function markExtensionSubmitted(caseId){
  const c=getCurrentCaseObj();
  if(c){
    c.status='展延中';
    c.timelineStep='展延中';
    c.timelineSub='審核中';
  }
  alert('已標記展延已送出，目前審核中，請等待健保署回覆。');
  if(c) renderPage('detail',currentCase);
}
function markExtensionFailed(caseId){
  const c=getCurrentCaseObj();
  if(c){
    c.status='照護中';
    c.timelineStep='照護中';
    c.timelineSub='展延後';
    c.hadExtensionFail=true;
  }
  alert('已標記展延失敗，個案進入照護中（展延後）階段，請留意後續結案評估安排。');
  if(c) renderPage('detail',currentCase);
}

// ── 展延成功：開啟 Modal，依疾病別自動帶入新的預計結案日期（以今日 2026/07/09 為基準）──
function openExtensionSuccessModal(caseId){
  const c=getCurrentCaseObj();
  const period=c?PAC_CARE_PERIOD[c.diseaseCategory||c.disease]:null;
  const weeks=period?period.weeksMax:12;
  const base=new Date('2026-07-09');
  base.setDate(base.getDate()+weeks*7);
  const defaultDate=`${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,'0')}-${String(base.getDate()).padStart(2,'0')}`;
  document.getElementById('ext-success-closedate').value=defaultDate;
  document.getElementById('ext-success-note').value='';
  openModal('modal-extension-success');
}
function confirmExtensionSuccess(){
  const c=getCurrentCaseObj();
  const closeDateVal=document.getElementById('ext-success-closedate').value;
  if(c){
    c.status='照護中';
    c.timelineStep='照護中';
    c.timelineSub='展延後';
    if(closeDateVal) c.closeDate=closeDateVal.replace(/-/g,'/');
  }
  closeModal('modal-extension-success');
  alert('展延成功，預計結案日期已更新，已發送站內通知給復健師。');
  if(c) renderPage('detail',currentCase);
}

// 轉介安排「儲存」：僅更新 c.referral 自己的狀態／備註，與主時間軸節點脫鉤
// 轉介去向改變時，同步更新「已完成轉介」勾選框可用狀態（選擇「無需轉介」時不可勾選，並清除已勾選狀態）
function updateReferralConfirmedAvailability(){
  const sel=document.getElementById('referral-target-select');
  const checkbox=document.getElementById('referral-confirmed');
  if(!sel||!checkbox) return;
  const disable=sel.value==='無需轉介';
  checkbox.disabled=disable;
  if(disable) checkbox.checked=false;
}
function saveReferral(caseId){
  const c=getCurrentCaseObj();
  if(!c||!c.referral) return;
  const targetSel=document.getElementById('referral-target-select');
  const noteVal=document.getElementById('referral-note')?.value||'';
  const confirmedCheckbox=document.getElementById('referral-confirmed');
  const target=targetSel?targetSel.value:'無需轉介';
  // 三態：無需轉介＝獨立狀態；有實際轉介目標時，依「已完成轉介」勾選框決定待轉介／已轉介
  if(target==='無需轉介') c.referral.status='無需轉介';
  else if(confirmedCheckbox&&confirmedCheckbox.checked) c.referral.status='已轉介';
  else c.referral.status='待轉介';
  c.referral.target=target;
  c.referral.note=noteVal;
  alert('轉介安排已儲存');
  renderPage('detail',currentCase);
}

// ── 筆記 Tab：所有角色皆可新增，純累加不可編輯／刪除 ──
const NOTE_ROLE_ICON={'個案管理師':'👤','醫師':'🩺','護理師':'💉','行政':'📋'};
function noteRoleIcon(roleLabel){
  return NOTE_ROLE_ICON[roleLabel]||'👤';
}
function addCaseNote(caseId){
  const input=document.getElementById('new-note-input');
  const text=(input?.value||'').trim();
  if(!text){
    alert('請輸入筆記內容');
    return;
  }
  const c=getCurrentCaseObj();
  if(c){
    if(!c.notes) c.notes=[];
    const cfg=ROLES[currentRole];
    c.notes.unshift({text,author:cfg.name,role:cfg.label,timestamp:'2026/07/09 14:30'});
  }
  renderPage('detail',currentCase);
}
// ── 通知鈴鐺（右上角）：假資料示意行政完成建檔後的通知，僅個管師（mgr）收到此類通知 ──
function renderNotifBell(){
  const container=document.getElementById('notif-bell-container');
  if(!container) return;
  const isMgr=currentRole==='mgr';
  const list=isMgr?NOTIFICATIONS:[];
  const unread=isMgr?NOTIFICATIONS.filter(n=>!n.read).length:0;
  container.innerHTML=`
    <button onclick="toggleNotifDropdown()" style="position:relative;background:none;border:none;cursor:pointer;font-size:18px;padding:4px;line-height:1">
      🔔
      <span style="position:absolute;top:-2px;right:-2px;background:var(--red);color:#fff;font-size:10px;font-weight:700;min-width:15px;height:15px;border-radius:8px;display:${unread>0?'flex':'none'};align-items:center;justify-content:center;padding:0 3px">${unread}</span>
    </button>
    <div style="display:${notifDropdownOpen?'block':'none'};position:absolute;top:32px;right:0;width:300px;background:var(--white);border:1px solid var(--gray-200);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:200;overflow:hidden">
      ${list.length?list.map(n=>`
        <div onclick="markNotifRead(${n.id})" style="padding:10px 12px;font-size:12px;line-height:1.6;border-bottom:1px solid var(--gray-100);cursor:pointer;${n.read?'color:var(--gray-400)':'color:var(--gray-800);background:var(--blue-light)'}">${n.text}</div>
      `).join(''):`<div style="padding:14px;font-size:12px;color:var(--gray-400);text-align:center">目前沒有新通知</div>`}
    </div>
  `;
}
function toggleNotifDropdown(){
  notifDropdownOpen=!notifDropdownOpen;
  renderNotifBell();
}
function markNotifRead(id){
  const n=NOTIFICATIONS.find(x=>x.id===id);
  if(n&&!n.read) n.read=true;
  renderNotifBell();
  alert('已標記為已讀');
}

// ── 轉換照護模式 ──
// 三條路徑：轉住院＝送出申請→登記已排床才真正轉換；轉日照＝單步驟送出即完成；轉居家＝送出通知→登記復健主管回覆→確定轉換才真正轉換。
const MODE_TYPE_MAP={'住院':'hosp','日照':'day','居家':'home'};
let convertModeCtx=null;
function openConvertModeModal(){
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
// 正式病歷・轉住院 第二步：登記已排床（沿用同一個 modal 容器，另開一個步驟狀態）
function openBedAssignForConvert(){
  convertModeCtx={step:'bed'};
  renderConvertModeModal();
  openModal('modal-convert-mode');
}
function renderConvertModeModal(){
  const c=getCurrentCaseObj();
  document.getElementById('convert-mode-title').textContent=convertModeCtx.step==='bed'?'登記已排床':'轉換照護模式';
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
  if(convertModeCtx.step==='bed'){
    document.getElementById('convert-mode-body').innerHTML=`
      <div class="info-note blue" style="margin-bottom:12px">請登記床位資訊，確認後將正式完成轉換為住院。</div>
      <div class="form-group" style="margin-bottom:10px">
        <label>房型 <span class="required">*</span></label>
        <select class="form-control" id="convert-mode-roomtype">
          <option value="">請選擇</option>
          <option value="single">單人房</option>
          <option value="double">雙人房</option>
          <option value="multi">多人房（3人以上）</option>
        </select>
      </div>
      <div class="form-group">
        <label>床位資訊 <span class="required">*</span></label>
        <input class="form-control" id="convert-mode-bedinfo" placeholder="例如：A301">
      </div>
    `;
    document.getElementById('convert-mode-footer').innerHTML=`
      <button class="btn btn-secondary" onclick="closeModal('modal-convert-mode')">取消</button>
      <button class="btn btn-primary" onclick="confirmConvertToHospFinal()">確認轉換</button>
    `;
    return;
  }
  renderConvertModeDetailsStep(c);
}
function renderConvertModeDetailsStep(c){
  const {newMode}=convertModeCtx;
  const fromMode=c?c.mode:null;
  let extraNote='',dischargeDateField='',submitLabel='確認轉換';
  if(newMode==='住院'){
    submitLabel='送出轉換申請';
    if(fromMode==='居家') extraNote=`<div class="info-note amber" style="margin-top:10px">將通知復健主管取消居家排班</div>`;
    else if(fromMode==='日照') extraNote=`<div class="info-note blue" style="margin-top:10px">日照個案排班本來就在院內，轉住院不影響</div>`;
  } else if(newMode==='日照'){
    submitLabel='確認轉換';
    if(fromMode==='住院') dischargeDateField=`<div class="form-group" style="margin-bottom:10px"><label>更新的出院日期 <span class="required">*</span></label><input class="form-control" type="date" id="convert-mode-dischargedate"><div style="font-size:11px;color:var(--gray-400);margin-top:2px">排班不受影響</div></div>`;
    else if(fromMode==='居家') extraNote=`<div class="info-note amber" style="margin-top:10px">將通知復健主管取消居家排班</div>`;
  } else if(newMode==='居家'){
    submitLabel='通知復健主管';
    if(fromMode==='住院') dischargeDateField=`<div class="form-group" style="margin-bottom:10px"><label>更新的出院日期 <span class="required">*</span></label><input class="form-control" type="date" id="convert-mode-dischargedate"></div>`;
    extraNote=`<div class="info-note amber" style="margin-top:10px">將通知復健主管取消院內排班</div>`;
  }
  const defaultClose=c.closeDate?c.closeDate.replace(/\//g,'-'):'';
  document.getElementById('convert-mode-body').innerHTML=`
    <div class="form-group" style="margin-bottom:10px"><label>轉換日期</label><input class="form-control" type="date" id="convert-mode-date" value="2026-07-09"></div>
    <div class="form-group" style="margin-bottom:10px"><label>新的預計結案日期</label><input class="form-control" type="date" id="convert-mode-closedate" value="${defaultClose}"></div>
    ${dischargeDateField}
    <div class="form-group"><label>備註（選填）</label><textarea class="form-control" rows="2" id="convert-mode-note" placeholder="補充說明..."></textarea></div>
    ${extraNote}
  `;
  document.getElementById('convert-mode-footer').innerHTML=`
    <button class="btn btn-secondary" onclick="convertModeBack()">上一步</button>
    <button class="btn btn-primary" onclick="confirmConvertMode()">${submitLabel}</button>
  `;
}
// 統一送出入口：依目標模式分派到對應處理函式
function confirmConvertMode(){
  const c=getCurrentCaseObj();
  if(!c){ closeModal('modal-convert-mode'); return; }
  const {newMode}=convertModeCtx;
  if(newMode==='住院') submitConvertToHosp(c);
  else if(newMode==='日照') confirmConvertToDay(c);
  else if(newMode==='居家') submitConvertToHome(c);
}
// 轉住院 第一步送出：尚未真正轉換，建立 modeConvertPending 等待排床
function submitConvertToHosp(c){
  const fromMode=c.mode;
  const dateVal=document.getElementById('convert-mode-date')?.value;
  const closeVal=document.getElementById('convert-mode-closedate')?.value;
  const noteVal=(document.getElementById('convert-mode-note')?.value||'').trim();
  const dateStr=dateVal?dateVal.replace(/-/g,'/'):'2026/07/09';
  const closeStr=closeVal?closeVal.replace(/-/g,'/'):c.closeDate;
  if(fromMode==='居家') cancelFutureHomeRehab(c);
  c.modeConvertPending={targetMode:'住院',requestDate:dateStr,closeDate:closeStr,note:noteVal};
  closeModal('modal-convert-mode');
  alert('已送出轉換申請，請至排床模組安排床位後回來登記已排床。');
  renderPage('detail',currentCase);
}
// 二-1、正式病歷・轉住院 第二步：登記已排床後才真正執行轉換
function confirmConvertToHospFinal(){
  const c=getCurrentCaseObj();
  if(!c||!c.modeConvertPending){ closeModal('modal-convert-mode'); return; }
  const roomTypeVal=document.getElementById('convert-mode-roomtype')?.value||'';
  const bedInfoVal=(document.getElementById('convert-mode-bedinfo')?.value||'').trim();
  if(!roomTypeVal||!bedInfoVal){ alert('請填寫房型與床位資訊'); return; }
  const pending=c.modeConvertPending;
  if(!c.modeHistory) c.modeHistory=[];
  c.modeHistory.push({from:c.mode,to:'住院',date:pending.requestDate,note:pending.note});
  c.mode='住院';
  c.modeType='hosp';
  c.closeDate=pending.closeDate;
  c.roomPref=roomTypeVal;
  c.bedInfo=bedInfoVal;
  delete c.modeConvertPending;
  closeModal('modal-convert-mode');
  alert('已登記床位資訊，個案已正式轉換為住院模式。');
  renderPage('detail',currentCase);
}
// 二-2、正式病歷・轉日照：單步驟，送出即直接完成轉換
function confirmConvertToDay(c){
  const fromMode=c.mode;
  const dateVal=document.getElementById('convert-mode-date')?.value;
  const closeVal=document.getElementById('convert-mode-closedate')?.value;
  const noteVal=(document.getElementById('convert-mode-note')?.value||'').trim();
  const dateStr=dateVal?dateVal.replace(/-/g,'/'):'2026/07/09';
  const closeStr=closeVal?closeVal.replace(/-/g,'/'):c.closeDate;
  if(fromMode==='住院'){
    const dischargeVal=document.getElementById('convert-mode-dischargedate')?.value;
    if(!dischargeVal){ alert('請填寫更新的出院日期'); return; }
    c.dischargeDate=dischargeVal.replace(/-/g,'/');
  }
  if(fromMode==='居家') cancelFutureHomeRehab(c);
  if(!c.modeHistory) c.modeHistory=[];
  c.modeHistory.push({from:fromMode,to:'日照',date:dateStr,note:noteVal});
  c.mode='日照';
  c.modeType='day';
  c.closeDate=closeStr;
  closeModal('modal-convert-mode');
  alert('照護模式已轉換為日照。');
  renderPage('detail',currentCase);
}
// 二-3、正式病歷・轉居家 第一步送出：尚未真正轉換，建立 modeConvertPending 等待復健主管回覆
function submitConvertToHome(c){
  const fromMode=c.mode;
  const dateVal=document.getElementById('convert-mode-date')?.value;
  const closeVal=document.getElementById('convert-mode-closedate')?.value;
  const noteVal=(document.getElementById('convert-mode-note')?.value||'').trim();
  const dateStr=dateVal?dateVal.replace(/-/g,'/'):'2026/07/09';
  const closeStr=closeVal?closeVal.replace(/-/g,'/'):c.closeDate;
  let dischargeDateVal='';
  if(fromMode==='住院'){
    const dv=document.getElementById('convert-mode-dischargedate')?.value;
    if(!dv){ alert('請填寫更新的出院日期'); return; }
    dischargeDateVal=dv.replace(/-/g,'/');
  }
  c.modeConvertPending={targetMode:'居家',requestDate:dateStr,closeDate:closeStr,note:noteVal,rehabReplied:false};
  if(dischargeDateVal) c.modeConvertPending.dischargeDate=dischargeDateVal;
  closeModal('modal-convert-mode');
  alert('已通知復健主管，待回覆是否可承接。');
  renderPage('detail',currentCase);
}
// 二-3、正式病歷・轉居家 第二步：登記復健主管回覆結果
function registerModeConvertReply(caseId,result){
  const c=getCurrentCaseObj();
  if(!c||!c.modeConvertPending) return;
  if(result==='可承接'){
    c.modeConvertPending.rehabReplied=true;
    alert('已登記復健主管回覆：可承接，請確認完成轉換。');
  } else {
    delete c.modeConvertPending;
    alert('復健主管回覆無法承接，轉換申請已取消');
  }
  renderPage('detail',currentCase);
}
// 二-3、正式病歷・轉居家 第三步：個管師點擊「確定轉換」才真正執行轉換
function confirmConvertToHomeFinal(caseId){
  const c=getCurrentCaseObj();
  if(!c||!c.modeConvertPending) return;
  const pending=c.modeConvertPending;
  const fromMode=c.mode;
  if(!c.modeHistory) c.modeHistory=[];
  c.modeHistory.push({from:fromMode,to:'居家',date:pending.requestDate,note:pending.note});
  c.mode='居家';
  c.modeType='home';
  c.closeDate=pending.closeDate;
  if(pending.dischargeDate) c.dischargeDate=pending.dischargeDate;
  c.homeRehabSchedule=[];
  delete c.modeConvertPending;
  alert('已完成轉換為居家模式，請至居家排班管理模組安排班表。');
  renderPage('detail',currentCase);
}
// 轉換申請中提示卡片：依 targetMode／rehabReplied 決定文字與可操作按鈕
function renderModeConvertPendingCard(c){
  const isMgr=currentRole==='mgr';
  const p=c.modeConvertPending;
  let title='',buttons='';
  if(p.targetMode==='住院'){
    title='🛏️ 轉換申請中：轉住院，排床中，待排床模組排床';
    buttons=isMgr?`<button class="btn btn-secondary btn-xs" onclick="openBedAssignForConvert('${c.id}')">登記已排床</button>`:'';
  } else if(p.targetMode==='居家'){
    if(p.rehabReplied){
      title='✓ 復健主管已回覆可承接，請確認完成轉換';
      buttons=isMgr?`<button class="btn btn-primary btn-xs" onclick="confirmConvertToHomeFinal('${c.id}')">確定轉換</button>`:'';
    } else {
      title='🏠 轉換申請中：轉居家，待復健主管回覆';
      buttons=isMgr?`<div style="display:flex;gap:6px;flex-shrink:0"><button class="btn btn-secondary btn-xs" onclick="registerModeConvertReply('${c.id}','可承接')">登記回覆：可承接</button><button class="btn btn-danger btn-xs" onclick="registerModeConvertReply('${c.id}','無法承接')">登記回覆：無法承接</button></div>`:'';
    }
  }
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid #FECACA;border-radius:7px;background:var(--red-light);margin-bottom:12px">
      <div style="font-size:12px">
        <strong>${title}</strong>
        ${p.note?`<div style="font-size:11px;color:var(--gray-500);margin-top:2px">備註：${p.note}</div>`:''}
      </div>
      ${buttons}
    </div>
  `;
}

// ── 封存 Modal（統一入口，temp/formal 兩套清單 + 可鎖定單一類型）──
// opts: {formal, presetType, locked, showCloseDate, showDischargeDest, successMsg(type)=>string}
let archiveCtx=null;
function openArchiveModal(opts){
  archiveCtx={formal:true,presetType:null,locked:false,showCloseDate:false,showDischargeDest:false,successMsg:null,...opts};
  renderArchiveModalBody();
  openModal('modal-archive');
}

function selectArchiveType(type){
  archiveCtx.presetType=type;
  renderArchiveModalBody();
}

function archiveTypeDef(type){
  if(type==='結案失敗') return {type,field:'結案失敗原因'};
  if(type==='正常結案') return {type};
  return ARCHIVE_TYPES_FORMAL.find(o=>o.type===type)||null;
}

function renderArchiveModalBody(){
  const {presetType,locked,showCloseDate,showDischargeDest}=archiveCtx;
  const list=ARCHIVE_TYPES_FORMAL;
  document.getElementById('archive-modal-title').textContent=locked&&presetType?`結案管理確認：${presetType}`:'結案管理';

  const optsHtml=locked
    ? `<div class="retire-list"><div class="retire-opt selected" style="cursor:default;opacity:.85"><input type="radio" checked disabled><span style="font-size:13px">${presetType}</span></div></div>`
    : `<div class="retire-list">${list.filter(o=>!o.manualHidden).map(o=>`
        <div class="retire-opt ${o.type===presetType?'selected':''}" onclick="selectArchiveType('${o.type}')">
          <input type="radio" name="archive-type" ${o.type===presetType?'checked':''}><span style="font-size:13px">${o.type}</span>
        </div>`).join('')}</div>`;

  const def=presetType?archiveTypeDef(presetType):null;
  const fieldHtml=def&&def.field?`
    <div class="form-group" style="margin-bottom:10px">
      <label>${def.field} <span class="required">*</span></label>
      <textarea class="form-control" rows="2" id="archive-field-input" placeholder="${def.hint||''}"></textarea>
    </div>`:'';

  const dateHtml=showCloseDate?`
    <div class="form-group" style="margin-bottom:10px">
      <label>結案日期</label>
      <input class="form-control" type="date" id="archive-close-date" value="2026-07-09">
    </div>`:'';

  const homeTransferHint=presetType==='轉居家醫療'?`
    <div class="info-note blue" style="margin-bottom:10px">此個案已轉為居家醫療計畫，PAC 系統追蹤到此結束。復健服務將由居家醫療計畫接續，請至居家排班管理模組，將此個案（含已排定的治療班表）之計畫歸屬更新為居家醫療，以利後續獎金結算正確歸類。</div>`:'';

  const currentCaseObj=getCurrentCaseObj();
  const destHtml=showDischargeDest?`
    <div class="form-group" style="margin-bottom:10px">
      <label>出院後去向</label>
      <select class="form-control" id="archive-discharge-dest">
        ${DISCHARGE_DEST_OPTIONS.map(o=>`<option value="${o}" ${currentCaseObj&&currentCaseObj.dischargeDest===o?'selected':''}>${o||'請選擇'}</option>`).join('')}
      </select>
    </div>`:'';

  const note=`<div class="info-note amber">結案管理後個案將歸類為「結案管理」，並記錄以下類型供後續統計。</div>`;

  document.getElementById('archive-modal-body').innerHTML=note+optsHtml+fieldHtml+homeTransferHint+dateHtml+destHtml;
}

function confirmArchive(){
  const {locked,showCloseDate,showDischargeDest,successMsg}=archiveCtx;
  let type=archiveCtx.presetType;
  if(!locked){
    const checked=document.querySelector('input[name="archive-type"]:checked');
    if(!checked){alert('請選擇結案類型');return;}
  }
  if(!type){alert('請選擇結案類型');return;}
  const def=archiveTypeDef(type);
  let reasonText='';
  if(def&&def.field){
    const input=document.getElementById('archive-field-input');
    reasonText=input?input.value.trim():'';
    if(!reasonText){alert(`請填寫「${def.field}」`);return;}
  }
  const c=getCurrentCaseObj();
  if(c){
    const closeDate=showCloseDate?(document.getElementById('archive-close-date')?.value||'2026-07-09').replace(/-/g,'/'):'2026/07/09';
    c.status='封存';
    c.archiveType=type;
    c.archiveReason=reasonText;
    c.archiveDate=closeDate;
    c.archiveOperator='林美惠';
    if(showCloseDate) c.closeDate=closeDate;
    if(showDischargeDest){
      const destSel=document.getElementById('archive-discharge-dest');
      if(destSel) c.dischargeDest=destSel.value;
    }
    if(type==='轉居家醫療'&&c.homeRehabSchedule&&c.homeRehabSchedule.length){
      // 轉居家醫療：尚未發生（日期晚於或等於今日）的班次一律標記取消，已發生的班次維持原樣
      const today=new Date('2026-07-09');
      c.homeRehabSchedule.forEach(item=>{
        if(!item.date) return;
        const itemDate=new Date(item.date.replace(/\//g,'-'));
        if(!isNaN(itemDate)&&itemDate>=today) item.cancelled=true;
      });
    }
    c.timelineStep=null;
    delete c.timelineSub;
  }
  closeModal('modal-archive');
  alert(successMsg?successMsg(type):'個案已移至結案管理');
  if(c) renderPage('detail',currentCase);
}

// ── 家屬聯繫紀錄：新增 ──
function openAddContactModal(caseId){
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
  closeModal('modal-add-contact');
  alert('已新增聯繫紀錄');
  renderPage('detail',currentCase);
}

// ── 上游聯繫紀錄：新增 ──
function openUpstreamContactModal(){
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

  closeModal('modal-upstream-contact');
  alert('已新增上游聯繫紀錄');
  renderPage('detail',currentCase);
}

function switchRole(role){
  currentRole=role;
  const cfg=ROLES[role];
  document.getElementById('user-av').textContent=cfg.ch;
  document.getElementById('user-av').className='user-avatar '+cfg.av;
  document.getElementById('user-name').textContent=cfg.name;
  document.getElementById('user-role-label').textContent=cfg.label;

  if(role==='doc'||role==='nur'){
    currentPage='list';
  }
  // 個管師（mgr）：維持現有行為，無變化

  // 通知鈴鐺：依角色立即更新（僅個管師收到轉正式病歷建檔通知，其他角色為空狀態），不需重新整理頁面
  renderNotifBell();

  // 重新渲染目前頁面
  if(currentPage==='list') renderPage('list');
  else if(currentPage==='detail'&&currentCase) renderPage('detail',currentCase);
  else if(currentPage==='form'&&currentCase&&currentForm) renderPage('form',currentCase,currentForm);
  else if(currentPage==='his-record'&&currentCase) renderPage('his-record',currentCase);
}

// Init
renderPage('list');
renderNotifBell();
