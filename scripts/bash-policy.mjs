// 일꾼에게 열어 주는 Bash 규칙의 허용 기준.
//
// 규칙 `Bash(npm *)`는 `npm exec`, `npm publish`까지 열고, `Bash(npm test*)`도 규칙을 해석하는 쪽이 `;`나 `&&`를
// 제대로 나누지 못하면 `npm test; curl ... | sh`를 통과시킨다. 그래서 규칙을 "검증 명령 모양"으로 제한한다.
//   - 셸 메타문자(; & | < > ` $ ( ) { } ! \ 따옴표, 줄바꿈)가 있으면 거절
//   - 와일드카드는 맨 끝의 `*` 하나뿐
//   - 명령은 테스트·린트·빌드·읽기 전용 조회 모양만 허용
// 이 목록 밖의 스크립트가 꼭 필요하면 리드가 HF_BASH_POLICY=permissive로 모양 제한만 풀 수 있다(메타문자와 셸 실행은 계속 거절).

const META=/[;&|<>`$(){}!\\"'#~\n\r\t]/;
const VERB='(?:test|tests|lint|build|check|fmt|format|typecheck|type-check|verify|vet|clippy|coverage|unit|e2e)(?:[:_-][A-Za-z0-9_-]+)*';
const ARG='[A-Za-z0-9_@%+=:,./-]+';
const tail=`(?: ${ARG})*`;
const SHAPES=[
 new RegExp(`^(?:npm|pnpm|yarn|bun)(?: run)? ${VERB}${tail}$`),
 new RegExp(`^node --test${tail}$`),
 new RegExp(`^node --check ${ARG}$`),
 new RegExp(`^(?:pytest|python3? -m pytest|vitest|jest|tsc|eslint|ruff check|mypy|rustfmt --check|gofmt -l)${tail}$`),
 new RegExp(`^prettier --check${tail}$`),
 new RegExp(`^go (?:test|vet|build)${tail}$`),
 new RegExp(`^cargo (?:test|check|build|clippy|fmt)${tail}$`),
 new RegExp(`^dotnet (?:test|build)${tail}$`),
 new RegExp(`^mvn (?:test|verify)${tail}$`),
 new RegExp(`^(?:gradle|\\./gradlew) (?:test|build|check)${tail}$`),
 new RegExp(`^make ${VERB}${tail}$`),
 new RegExp(`^git (?:status|diff|log|show|rev-parse|ls-files|blame)${tail}$`),
 new RegExp(`^(?:ls|cat|head|tail|wc|grep|rg)${tail}$`)
];
// 어떤 명령에 붙어도 다른 프로그램을 실행하거나 파일을 쓰게 하는 옵션
const DANGEROUS_ARG=/(?:^| )--?(?:pre|pre-glob|hostname-bin|exec|eval|output|upload-pack|receive-pack|open-files-in-pager|ext-diff|textconv|config|config-env|git-dir|work-tree|exec-path)(?:[= ]|$)/;
// 셸이나 네트워크·권한 상승 도구. permissive에서도 거절한다.
const NEVER=/^(?:sh|bash|zsh|fish|dash|ksh|csh|cmd|cmd\.exe|powershell|pwsh|env|eval|exec|xargs|find|sudo|su|doas|curl|wget|ssh|scp|sftp|nc|ncat|telnet|ftp|rsync|python3?|perl|ruby|php|node|deno|osascript)(?: |$)/;

const bad=(rule,why)=>Error(`Invalid executor_bash_rules: ${JSON.stringify(rule)} ${why}`);

export function checkBashRule(rule) {
 if(typeof rule!=='string')throw bad(rule,'is not a string');
 const m=/^Bash\(([^()]+)\)$/.exec(rule);
 if(!m)throw bad(rule,'must look like Bash(<command>)');
 let cmd=m[1];
 if(META.test(cmd))throw bad(rule,'contains shell metacharacters or quotes');
 // 맨 끝의 와일드카드 하나만 인정한다: `npm test*`, `npm test *`, `npm test:*`.
 const wild=/(?: \*|:\*|\*)$/.exec(cmd);
 if(wild)cmd=cmd.slice(0,wild.index);
 if(cmd.includes('*')||!cmd.trim()||cmd!==cmd.trim())throw bad(rule,'may use one trailing * only, and must name a command');
 if(DANGEROUS_ARG.test(cmd))throw bad(rule,'passes an option that runs programs or writes files');
 const permissive=process.env.HF_BASH_POLICY==='permissive';
 if(NEVER.test(cmd)&&!/^(?:node --(?:test|check)|python3? -m pytest)(?: |$)/.test(cmd))throw bad(rule,'starts a shell, interpreter, or network tool');
 if(!permissive&&!SHAPES.some(re=>re.test(cmd))){
  throw bad(rule,'is not a test, lint, build, or read-only command (allowed shapes: npm|pnpm|yarn test/run <verb>, node --test, pytest, go/cargo/dotnet/mvn/gradle test, make <verb>, git diff/status/log, ls/cat/rg). Set HF_BASH_POLICY=permissive to allow other scripts on purpose');
 }
 return rule;
}

export function checkBashRules(rules) {
 if(rules===undefined)return [];
 if(!Array.isArray(rules))throw Error('Invalid executor_bash_rules: must be a list');
 return rules.map(checkBashRule);
}

// 이 명령들은 허용 규칙과 상관없이 항상 막는다. git은 서브커맨드 앞에 `-C dir`, `-c k=v` 같은 옵션이 올 수 있어 두 가지 모양을 모두 낸다.
const GIT_BLOCKED=['commit','push','reset','clean','stash','checkout','add','restore','switch','rebase','merge','cherry-pick','revert','tag','am','apply','update-ref','symbolic-ref','config','worktree','submodule','remote','fetch','pull','rm','mv','gc','filter-branch','replace','notes','bisect','init','clone','hash-object','commit-tree','write-tree'];
const TOOLS_BLOCKED=['curl','wget','ssh','scp','sftp','nc','ncat','telnet','ftp','rsync','sudo','su','doas','chmod','chown','rm -rf','rm -fr','mkfs','dd','eval','xargs'];

// style 'grok'은 `Bash(git push*)`, 'claude'는 `Bash(git push *)` 문법이다.
export function denyRules(style) {
 const sp=style==='claude'?' ':'';
 const rules=[];
 for(const sub of GIT_BLOCKED)rules.push(`Bash(git ${sub})`,`Bash(git ${sub}${sp}*)`,`Bash(git * ${sub}${sp}*)`);
 for(const tool of TOOLS_BLOCKED)rules.push(`Bash(${tool}${sp}*)`);
 return [...new Set(rules)];
}
