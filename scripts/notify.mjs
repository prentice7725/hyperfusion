// 일꾼이 끝났거나 리드의 판단이 필요할 때 휴대폰 등으로 알린다.
// 대상 저장소 설정이 아니라 사용자 환경변수 HF_NOTIFY_URL로만 켠다(저장소 내용이 외부 전송을 결정하지 못하게).
// ntfy(https://ntfy.sh/<topic>)처럼 POST 본문을 그대로 알림으로 보내는 엔드포인트를 가정한다.
//
// 알림은 외부 서비스로 나간다. 보내면 서비스에 남을 수 있으므로 다음을 지킨다.
//   - 본문은 작업 ID, 일꾼 이름, 라운드, 상태 같은 고정 형식만 담는다. 일꾼의 요약이나 오류 문장은 넣지 않는다(호출하는 쪽 책임).
//   - 영숫자와 일부 기호 밖의 글자는 '?'로 바꾼다. 제목과 본문 모두 길이를 제한한다.
//   - 평문 http는 로컬(localhost, 127.0.0.1, ::1)에서만 허용한다. 그 밖은 https만. 꼭 필요하면 HF_NOTIFY_ALLOW_HTTP=1.
const plain=(v,max)=>String(v).replace(/[^A-Za-z0-9 _.:()#,/\-]/g,'?').slice(0,max);
const LOCAL=new Set(['localhost','127.0.0.1','[::1]','::1']);

export function allowedUrl(raw) {
 let u;
 try{u=new URL(raw);}catch{return null;}
 if(u.protocol==='https:')return u;
 if(u.protocol==='http:'&&(LOCAL.has(u.hostname)||process.env.HF_NOTIFY_ALLOW_HTTP==='1'))return u;
 return null;
}

export async function notify(title,message,{priority='default'}={}) {
 const raw=process.env.HF_NOTIFY_URL;
 if(!raw)return false;
 const url=allowedUrl(raw);
 if(!url)return false;
 try{
  const r=await fetch(url,{method:'POST',body:plain(message,300),headers:{Title:plain(title,120),Priority:priority==='high'?'high':'default','Content-Type':'text/plain; charset=utf-8'},signal:AbortSignal.timeout(5000)});
  return r.ok;
 }catch{return false;}
}
