// 모델 레지스트리. 계열(family)은 모델을 만든 회사이고, 리뷰 독립성은 이 값으로만 판단한다.
// 호스트나 CLI 이름으로 계열을 짐작하지 않는다(agy는 Gemini 말고 Claude도 돌린다).
// 레지스트리에 없는 모델은 'unknown'이다. unknown은 모든 모델과 같은 계열로 치므로 독립 리뷰어가 될 수 없다.
// 이 표와 일꾼 프로필은 권한을 정하는 값이다. 저장소 설정이나 일꾼 JSON으로 덮어쓰지 않는다.

export const TIERS=['fast','standard','frontier'];
export const UNKNOWN='unknown';

// model_base → 계열·등급. 강도 접미사를 뗀 이름이 키다. aliases는 호스트가 보내는 표시 이름이다.
export const MODELS={
 'claude-opus-5-5':{family:'anthropic',tier:'frontier',aliases:['Claude Opus 5.5']},
 'claude-sonnet-5-5':{family:'anthropic',tier:'frontier',aliases:['Claude Sonnet 5.5']},
 'claude-haiku-5-5':{family:'anthropic',tier:'fast',aliases:['Claude Haiku 5.5']},
 'gpt-6.1-astra':{family:'openai',tier:'frontier',aliases:['GPT 6.1 Astra']},
 'gpt-6.1-sol':{family:'openai',tier:'frontier',aliases:['GPT 6.1 Sol']},
 'gpt-6-luna':{family:'openai',tier:'standard',aliases:['GPT 6 Luna']},
 'gemini-4-argon':{family:'google',tier:'frontier',aliases:['Gemini 4 Argon']}
};

// 일꾼 프로필. 모델을 고정하지 않는 CLI(Grok, AGY)는 CLI 기본 모델의 계열을 쓴다.
// 운영자가 다른 모델을 지정하면 그 모델의 계열을 따른다(memberFamily).
// review_rank: 두 번째 리뷰 자리를 고르는 순서(작을수록 먼저). review_effort·deep_review_effort는 지금의
// REVIEW_EFFORT와 이중 리뷰 때 Grok xhigh 규칙을 옮긴 값이다.
export const MEMBER_PROFILES={
 sol:{cli:'codex',model:'gpt-6.1-sol',review_rank:1,review_effort:'medium'},
 grok:{cli:'grok',model:null,default_family:'xai',tier:'standard',review_rank:2,deep_review_effort:'xhigh'},
 sonnet:{cli:'claude',model:'claude-sonnet-5-5',review_rank:3,review_effort:'high'},
 antigravity:{cli:'agy',model:null,default_family:'google',tier:'standard',review_rank:4},
 luna:{cli:'codex',model:'gpt-6-luna',review_rank:5},
 haiku:{cli:'claude',model:'claude-haiku-5-5',review_rank:6}
};

const EFFORT_SUFFIX=/-(?:low|medium|high)$/;
const HOST_CHOSEN=['auto','default',''];

// 호스트가 보고한 모델 값을 레지스트리 키로 바꾼다. 찾지 못하면 null.
export function modelBase(reported) {
 if(typeof reported!=='string')return null;
 const raw=reported.trim();
 if(HOST_CHOSEN.includes(raw.toLowerCase()))return null;
 if(MODELS[raw])return raw;
 const stripped=raw.replace(EFFORT_SUFFIX,'');
 if(MODELS[stripped])return stripped;
 // 표시 이름은 등록된 별칭만 받는다. "(Medium)" 같은 강도 표기는 뗀다.
 const display=raw.replace(/\s*\([^)]*\)\s*$/,'');
 return Object.keys(MODELS).find(k=>MODELS[k].aliases?.includes(display))??null;
}

// 회사가 자기 이름으로 내는 모델 id 접두사. 등급은 모르므로 계열만 정한다(이전·다음 버전 Opus 등).
// gpt-oss처럼 가중치를 공개해 다른 회사가 서빙하는 모델은 넣지 않는다.
export const FAMILY_PREFIXES=[[/^claude-/,'anthropic'],[/^gpt-\d/,'openai'],[/^gemini-/,'google'],[/^grok-/,'xai']];

export function familyOf(reported) {
 const base=modelBase(reported);
 if(base)return MODELS[base].family;
 if(typeof reported!=='string'||HOST_CHOSEN.includes(reported.trim().toLowerCase()))return UNKNOWN;
 return FAMILY_PREFIXES.find(([re])=>re.test(reported.trim()))?.[1]??UNKNOWN;
}
// 사람이 읽는 모델 이름. 등록된 모델은 첫 별칭, 아니면 받은 값 그대로다. 값이 없으면 null.
export const displayModel=reported=>{const base=modelBase(reported);return base?MODELS[base].aliases?.[0]??base:typeof reported==='string'&&reported.trim()?reported.trim():null;};
export const tierOf=reported=>MODELS[modelBase(reported)]?.tier??null;

// 일꾼의 계열과 등급. model은 운영자가 지정한 모델(없으면 프로필 기본값).
export function memberFamily(name,model) {
 const p=MEMBER_PROFILES[name];
 if(!p)return UNKNOWN;
 const chosen=model??p.model;
 return chosen==null?p.default_family??UNKNOWN:familyOf(chosen);
}
export function memberTier(name,model) {
 const p=MEMBER_PROFILES[name];
 if(!p)return null;
 const chosen=model??p.model;
 return chosen==null?p.tier??null:tierOf(chosen);
}

// 두 계열이 독립인지. unknown은 누구와도 독립이 아니다.
export const independent=(a,b)=>a!==UNKNOWN&&b!==UNKNOWN&&a!==b;
