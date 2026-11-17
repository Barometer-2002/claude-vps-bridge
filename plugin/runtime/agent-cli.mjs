import {optionValue} from './agent-binding.mjs';

export async function executeAgentCli(argv,run){
  const help=argv.includes('--help')||argv.includes('-h');
  const format=optionValue(argv,'--format')??'json';
  if(!['json','compact','text'].includes(format))throw Object.assign(new Error('--format must be json, compact or text'),{code:'INVALID_ARGUMENT'});
  const tracked=!help&&(argv[0]==='delegate'&&argv[1]==='start'||argv[0]==='thread'&&['send','read','wait'].includes(argv[1]));
  let actual=argv;
  // json and compact are both JSON carrying thread and status; only text must be
  // replaced. Keeping compact avoids returning a full Thread export to the model.
  if(tracked&&format==='text'){
    actual=[];
    for(let index=0;index<argv.length;index++){
      if(argv[index]==='--format'){index++;continue;}
      if(argv[index].startsWith('--format='))continue;
      actual.push(argv[index]);
    }
    actual.push('--format','json');
  }
  // run rejects on a nonzero exit. A presentation choice cannot change admission.
  const {stdout}=await run(actual);
  if(help||!tracked&&format==='text')return {text:stdout};
  return JSON.parse(stdout);
}
