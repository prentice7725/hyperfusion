// Built-in CLI metadata only. Adding a CLI still requires an audited adapter.
// grade: 구현 일꾼의 등급. A급은 중·고난도 구현, B급은 쉬운 구현·문서를 맡고 반려되면 A급으로 넘긴다. 리뷰 전담(Sol)은 등급이 없다.
const general=['code','tests','refactor','ui','docs'];
const high=['low','medium','high','xhigh','max'];
const codex=['minimal','low','medium','high','xhigh'];
// Grok 4.7은 high와 xhigh만 받는다.
const grokEfforts=['high','xhigh'];
export const MEMBERS={
 grok:{vendor:'xai',binary:'grok',env:'HF_GROK_BIN',auth:['XAI_','GROK_'],model:null,implement:true,grade:'A',caps:[...general,'image-gen'],effort:'high',efforts:grokEfforts,rounds:3,role:'A급 구현(high), 이미지 애셋 생성',owns:['image-asset']},
 antigravity:{vendor:'google',binary:'agy',env:'HF_AGY_BIN',auth:['GOOGLE_','GEMINI_','AGY_','ANTIGRAVITY_'],model:null,implement:true,grade:'B',caps:general,effort:'high',efforts:['low','medium','high'],rounds:3,role:'B급 구현(Gemini 3.8 Flash high): UI·프론트엔드, 문서',owns:['ui','docs']},
 sonnet:{vendor:'anthropic',binary:'claude',env:'HF_CLAUDE_BIN',auth:['ANTHROPIC_','CLAUDE_'],model:'claude-sonnet-5-5',implement:true,grade:'A',caps:general,effort:'medium',efforts:high,rounds:3,role:'A급 구현(medium), 리뷰(max)',owns:[]},
 haiku:{vendor:'anthropic',binary:'claude',env:'HF_CLAUDE_BIN',auth:['ANTHROPIC_','CLAUDE_'],model:'claude-haiku-5-5',implement:true,grade:'B',caps:general,effort:'max',efforts:high,rounds:3,role:'B급 구현: 쉬운 코드, 문서, 테스트 보강',owns:[]},
 luna:{vendor:'openai',binary:'codex',env:'HF_CODEX_BIN',auth:['OPENAI_','CODEX_'],model:'gpt-6-luna',implement:true,grade:'B',caps:[...general,'image-gen'],effort:'xhigh',efforts:codex,rounds:3,role:'B급 구현: 쉬운 구현·소규모 수정, 기계적 대량 편집, 이미지 애셋 보조',owns:['code:low']},
 terra:{vendor:'openai',binary:'codex',env:'HF_CODEX_BIN',auth:['OPENAI_','CODEX_'],model:'gpt-6.1-terra',implement:true,grade:'A',caps:general,effort:'medium',efforts:codex,rounds:3,role:'A급 구현 1순위(medium): 중·고난도 코드, 테스트 설계, 리팩터',owns:['code:medium|high','tests','refactor']},
 sol:{vendor:'openai',binary:'codex',env:'HF_CODEX_BIN',auth:['OPENAI_','CODEX_'],model:'gpt-6.1-sol',implement:false,caps:[],effort:'medium',efforts:codex,role:'리뷰 전담(xhigh, 판정 책임), 위원회 상담',owns:[]}
};
export const memberBinary=name=>process.env[MEMBERS[name].env]||MEMBERS[name].binary;
// Preserve the public project roster ordering independently of routing order.
export const PROJECT_MEMBERS=['sonnet',...Object.keys(MEMBERS).filter(n=>n!=='sonnet'&&n!=='sol'),'sol'];
export const vendorOf=name=>name==='lead'?'anthropic':MEMBERS[name]?.vendor;
export const gradeOf=name=>MEMBERS[name]?.grade??null;
export const VENDORS=[...new Set(Object.values(MEMBERS).map(m=>m.vendor))];
