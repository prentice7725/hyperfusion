// 일꾼 구현 지시문에 덧붙이는 코딩 정책. 설정 coding_policy로 켜고, 없으면 지시문은 이전과 같다.
// 정책 본문은 저장소에 고정한 파일이고, 프롬프트에 해시를 남겨 어느 판이 적용됐는지 비교 측정에서 가린다.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {hash} from './artifact.mjs';

// ponytail: https://github.com/DietrichGebert/ponytail (MIT, assets/coding-policies/ponytail.LICENSE)
// 원본 AGENTS.md에서 결과 JSON과 충돌하는 문장(답변 끝 산문, shortcut: 주석 형식)과 저장소 전용 문장을 뺐다.
export const CODING_POLICIES={
 ponytail:{file:'ponytail.md',source:'https://github.com/DietrichGebert/ponytail/blob/09c434ab73ca43761c5d8b0c5d341926c2fba710/AGENTS.md',license:'MIT'}
};

export function validCodingPolicy(id) {
 if(id!==undefined&&!Object.hasOwn(CODING_POLICIES,id))throw Error(`Invalid HyperFusion configuration: coding_policy must be one of ${Object.keys(CODING_POLICIES).join(', ')}`);
 return id;
}

// Windows 체크아웃은 줄바꿈을 CRLF로 바꿀 수 있다. 해시가 OS마다 달라지지 않게 LF로 맞춘다.
export function codingPolicy(id) {
 validCodingPolicy(id);
 const meta=CODING_POLICIES[id],text=fs.readFileSync(fileURLToPath(new URL(`../assets/coding-policies/${meta.file}`,import.meta.url)),'utf8').replaceAll('\r\n','\n').trim();
 return {id,source:meta.source,license:meta.license,sha256:hash(text),text};
}
