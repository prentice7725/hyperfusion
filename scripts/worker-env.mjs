// 일꾼 프로세스에 넘기는 환경변수. 컨트롤러 환경에는 GITHUB_TOKEN, AWS_*, DB 주소 같은 비밀값이 있을 수 있는데
// 일꾼은 셸을 쓸 수 있으므로 통째로 넘기면 그대로 읽어 간다. 실행에 필요한 것과 그 일꾼 자신의 인증값만 통과시킨다.
//
// 추가로 통과시킬 이름은 HF_ENV_PASS에 쉼표로 적는다(예: 사내 프록시 토큰). 리드가 명시한 것만 넘어간다.

const BASE=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA',
 'PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','TEMP','TMP','TMPDIR','USER','USERNAME','LOGNAME','SHELL','PSMODULEPATH',
 'LANG','LANGUAGE','TERM','COLORTERM','TZ','NO_COLOR','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE',
 'HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR']);

// 일꾼마다 자기 벤더의 인증값만 받는다. Grok에게 OPENAI_API_KEY를 줄 이유가 없다.
const VENDOR={
 grok:['XAI_','GROK_'],
 sonnet:['ANTHROPIC_','CLAUDE_'],
 haiku:['ANTHROPIC_','CLAUDE_'],
 antigravity:['GOOGLE_','GEMINI_','AGY_','ANTIGRAVITY_'],
 luna:['OPENAI_','CODEX_'],
 sol:['OPENAI_','CODEX_']
};

export function workerEnv(executor,env=process.env) {
 const extra=new Set((env.HF_ENV_PASS??'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));
 const prefixes=['LC_',...(VENDOR[executor]??[])];
 const out={};
 for(const [key,value] of Object.entries(env)){
  const k=key.toUpperCase();
  if(value===undefined)continue;
  if(BASE.has(k)||extra.has(k)||prefixes.some(p=>k.startsWith(p)))out[key]=value;
 }
 // 바이트코드 캐시(.pyc)는 무시된 위치에 실행 가능한 파일을 만든다. 수용 테스트 전 무시된 파일 비교를 흔들지 않게 끈다.
 out.PYTHONDONTWRITEBYTECODE='1';
 return out;
}
