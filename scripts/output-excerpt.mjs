// 수용 명령 출력은 끝부분(output_tail)만 저장한다. 그보다 앞에서 처음 난 실패는 꼬리에서 사라지므로
// 첫 실패 줄과 바로 뒤 몇 줄을 따로 남긴다. 실패 판정에는 쓰지 않는 보조 증거다.
export const FAILURE=/\b(?:not ok|fail(?:ed|ure|ures|ing)?|errors?|assert(?:ion)?(?:error)?|exception|panic(?:ked)?|traceback)\b/i;
export const TAIL_CHARS=4000;
const EXCERPT_LINES=20,EXCERPT_CHARS=2000;

// text 전체에서 꼬리(마지막 tailChars 글자) 앞부분만 본다. 꼬리 안의 실패는 이미 output_tail에 있다.
export function failureExcerpt(text,tailChars=TAIL_CHARS) {
 const head=String(text??'').slice(0,Math.max(0,text.length-tailChars)).replaceAll('\r\n','\n');
 if(!head)return null;
 const lines=head.split('\n'),index=lines.findIndex(l=>FAILURE.test(l));
 if(index<0)return null;
 return {line:index+1,text:lines.slice(index,index+EXCERPT_LINES).join('\n').slice(0,EXCERPT_CHARS)};
}
