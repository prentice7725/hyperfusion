// 일꾼이 끝났거나 리드의 판단이 필요할 때 휴대폰 등으로 알린다.
// 대상 저장소 설정이 아니라 사용자 환경변수 HF_NOTIFY_URL로만 켠다(저장소 내용이 외부 전송을 결정하지 못하게).
// ntfy(https://ntfy.sh/<topic>)처럼 POST 본문을 그대로 알림으로 보내는 엔드포인트를 가정한다.
export async function notify(title,message,{priority='default'}={}) {
 const url=process.env.HF_NOTIFY_URL;
 if(!url)return false;
 try{
  const r=await fetch(url,{method:'POST',body:message.slice(0,500),headers:{Title:title.replace(/[^\x20-\x7e]/g,'').slice(0,120),Priority:priority,'Content-Type':'text/plain; charset=utf-8'},signal:AbortSignal.timeout(5000)});
  return r.ok;
 }catch{return false;}
}
