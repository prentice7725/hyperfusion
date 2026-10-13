// Built-in CLI metadata only. Adding a CLI still requires an audited adapter.
const general=['code','tests','refactor','ui','docs'];
const high=['low','medium','high','xhigh','max'];
const codex=['minimal','low','medium','high','xhigh'];
export const MEMBERS={
 grok:{vendor:'xai',binary:'grok',env:'HF_GROK_BIN',auth:['XAI_','GROK_'],model:null,implement:true,caps:[...general,'image-gen'],effort:'xhigh',efforts:high,rounds:3,role:'이미지 애셋 생성, 빠른 일반 구현',owns:['image-asset']},
 antigravity:{vendor:'google',binary:'agy',env:'HF_AGY_BIN',auth:['GOOGLE_','GEMINI_','AGY_','ANTIGRAVITY_'],model:null,implement:true,caps:general,effort:'high',efforts:high,rounds:3,role:'UI·프론트엔드, 문서',owns:['ui','docs']},
 sonnet:{vendor:'anthropic',binary:'claude',env:'HF_CLAUDE_BIN',auth:['ANTHROPIC_','CLAUDE_'],model:'claude-sonnet-5-5',implement:true,caps:general,effort:'high',efforts:high,rounds:3,role:'핵심 구현: 중·고난도 코드, 테스트 설계, 리팩터',owns:['code:medium|high','tests','refactor']},
 haiku:{vendor:'anthropic',binary:'claude',env:'HF_CLAUDE_BIN',auth:['ANTHROPIC_','CLAUDE_'],model:'claude-haiku-5-5',implement:true,caps:general,effort:'max',efforts:high,rounds:3,role:'빠른 구현 보조: 쉬운 코드, 문서, 테스트 보강',owns:[]},
 luna:{vendor:'openai',binary:'codex',env:'HF_CODEX_BIN',auth:['OPENAI_','CODEX_'],model:'gpt-6-luna',implement:true,caps:[...general,'image-gen'],effort:'xhigh',efforts:codex,rounds:3,role:'쉬운 구현·소규모 수정, 기계적 대량 편집, 이미지 애셋 보조',owns:['code:low']},
 sol:{vendor:'openai',binary:'codex',env:'HF_CODEX_BIN',auth:['OPENAI_','CODEX_'],model:'gpt-6.1-sol',implement:false,caps:[],effort:'medium',efforts:codex,role:'리뷰 전담(판정 책임), 위원회 상담',owns:[]}
};
export const memberBinary=name=>process.env[MEMBERS[name].env]||MEMBERS[name].binary;
// Preserve the public project roster ordering independently of routing order.
export const PROJECT_MEMBERS=['sonnet',...Object.keys(MEMBERS).filter(n=>n!=='sonnet'&&n!=='sol'),'sol'];
export const vendorOf=name=>name==='lead'?'anthropic':MEMBERS[name]?.vendor;
export const VENDORS=[...new Set(Object.values(MEMBERS).map(m=>m.vendor))];
