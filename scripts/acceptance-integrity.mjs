import {changes} from './artifact.mjs';
// Conservative signal, not a semantic proof that assertions became weaker.
const testPath=p=>/(^|\/)(?:tests?|spec|__tests__)(\/|$)|(^|\/)(?:test_|check[._-]|verify[._-])|(?:\.test\.|\.spec\.|_test\.|Test\.java$|Spec\.java$)/i.test(p);
export function modifiedAcceptanceTests(baseline,now,brief) {
 if(!brief?.acceptance_commands?.length)return [];
 return changes(baseline,now).filter(file=>{
  if(!Object.hasOwn(baseline.files,file)||file.startsWith('.git/'))return false;
  const literal=file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replaceAll('/','[/\\\\]');
  const reference=new RegExp('(?:^|[\\s\\\"\\\'=])(?:\\./)?'+literal+'(?=$|[\\s\\\"\\\';|&])');
  return testPath(file)||brief.acceptance_commands.some(c=>{
   if(file==='package.json'&&/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint)\b/.test(c))return true;
   // Inline scripts reference application data too; those are not test entrypoints.
   return !/(?:^|\s)(?:-e|--eval|-p|--print|-c)(?:\s|=)/.test(c)&&reference.test(c);
  });
 });
}
