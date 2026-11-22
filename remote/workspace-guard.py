#!/usr/bin/env python3
"""Native Claude PreToolUse hook: route project operations to Windows, not VPS."""
import json, re, shlex, sys, subprocess, os, hashlib, importlib.util
from pathlib import Path
from bridge_paths import ROOT, WORKSPACE_ROOT, WORKSPACE_COMMAND
WORKSPACE_NAMES=('windows-workspace','/usr/local/bin/windows-workspace',WORKSPACE_COMMAND)
AGENT_NAMES=('windows-agent','/usr/local/bin/windows-agent',str(ROOT/'windows-agent'))
WORKSPACE_PATTERN='(?:'+'|'.join(re.escape(x) for x in WORKSPACE_NAMES)+')'

def structured(command):
    match=re.fullmatch(r"\s*"+WORKSPACE_PATTERN+r"\s+'(\{.*\})'\s*",command or '',re.S)
    if match:
        value=json.loads(match.group(1))
        if not isinstance(value,dict):raise ValueError('Expected an operation object')
        return value
    normalized=re.sub(r'^\s*"\$CODEXHOST_CLI_PATH"','windows-agent',command or '')
    argv=shlex.split(normalized)
    if argv and argv[0] in WORKSPACE_NAMES:
        spec=importlib.util.spec_from_file_location('workspace_request',str(ROOT/'workspace-request.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.parse(argv[1:])
    if argv and argv[0] in AGENT_NAMES:
        if argv[1:] and argv[1] in ('start','read','wait','cancel','list','resolve','native-read'):
            raise ValueError('Use action agent with official harness/delegate/thread argv, or explicit nativeAction; legacy shortcut syntax is not permission-mappable')
        return {'action':'agent','argv':argv[1:]}
    raise ValueError('Unsupported command')

def preflight(operation,mode):
    result=subprocess.run([WORKSPACE_COMMAND,'--internal',json.dumps({'action':'preflight','request':operation,'permissionMode':mode})],capture_output=True,text=True,timeout=150)
    if result.returncode:raise ValueError(result.stderr[-2000:])
    return json.loads(result.stdout)

def permitted(command):
    if not isinstance(command, str):
        return False
    # Parse the whole JSON envelope as data, then canonicalize it in updatedInput
    # before Bash sees it. Apostrophes inside PowerShell never become Bash syntax.
    match = re.fullmatch(r"\s*"+WORKSPACE_PATTERN+r"\s+'(\{.*\})'\s*", command, re.S)
    if match:
        try:
            return isinstance(json.loads(match.group(1)), dict)
        except (ValueError, TypeError):
            return False
    # The existing official CLI bridge remains usable with literal argv only.
    normalized = re.sub(r'^\s*"\$CODEXHOST_CLI_PATH"', 'windows-agent', command)
    if re.search(r'[$`\n\r;&|<>()]', normalized):
        return False
    try:
        argv = shlex.split(normalized)
        return bool(argv and argv[0] in AGENT_NAMES+WORKSPACE_NAMES)
    except ValueError:
        return False

def allowed_dynamic_mcp(tool_name):
    if not isinstance(tool_name, str) or not tool_name.startswith('mcp__'):
        return False
    parts = tool_name.split('__')
    if len(parts) < 3 or not parts[1]:
        return False
    server = parts[1]
    allow_file = os.environ.get('WINDOWS_ALLOWED_MCP_FILE', '')
    if not allow_file:
        return False
    try:
        target = Path(allow_file).resolve()
        run_root = (ROOT / 'run').resolve()
        if not target.is_relative_to(run_root) or not target.is_file():
            return False
        data = json.loads(target.read_text(encoding='utf-8'))
        servers = data.get('servers', []) if isinstance(data, dict) else []
        for item in servers:
            if not isinstance(item, str) or not item:
                continue
            normalized = re.sub(r'[^A-Za-z0-9_-]', '_', item)
            if server == item or server == normalized:
                return True
    except Exception:
        return False
    return False

if __name__ == '__main__':
    try:
        request=json.load(sys.stdin)
        name=request.get('tool_name')
        if name=='Bash' and permitted(request.get('tool_input',{}).get('command')):
            raw_cmd=request['tool_input']['command']
            raw_match=re.fullmatch(r"\s*"+WORKSPACE_PATTERN+r"\s+'(\{.*\})'\s*",raw_cmd,re.S)
            if raw_match and "'" in raw_match.group(1):
                print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':'JSON argument contains an unescaped single quote (\'). Replace single quotes inside JSON with \\u0027 and retry.'}}))
                sys.exit(0)
            operation=structured(raw_cmd)
            decision=preflight(operation,request.get('permission_mode'))
            output={'hookEventName':'PreToolUse'}
            if decision['decision'] in ('deny','ask','allow'):
                output.update(permissionDecision=decision['decision'],permissionDecisionReason=decision['reason'])
            if decision.get('additionalContext'):output['additionalContext']=decision['additionalContext']
            print(json.dumps({'hookSpecificOutput':output}))
        elif name=='Read':
            root=((WORKSPACE_ROOT/'.bridge-media')/(os.environ.get('WINDOWS_MEDIA_SESSION') or os.environ.get('WINDOWS_BRIDGE_SESSION','INVALID'))).resolve()
            target=Path(request.get('tool_input',{}).get('file_path','')).resolve()
            # Claude Code saves oversized tool output under this session's own
            # tool-results directory and expects Read to page it back.
            transcript=request.get('transcript_path')
            if isinstance(transcript,str) and transcript.endswith('.jsonl') and target.is_file() and target.is_relative_to((Path(transcript).with_suffix('')/'tool-results').resolve()):
                print('{}')
                sys.exit(0)
            inherited=False
            manifest=root/'.inherited.json'
            if not target.is_relative_to(root) and manifest.is_file():
                for item in json.loads(manifest.read_text()).get('files',[]):
                    if item.get('path')==str(target) and target.is_file():
                        inherited=hashlib.sha256(target.read_bytes()).hexdigest()==item.get('sha256')
                        break
            if (not target.is_relative_to(root) and not inherited) or not target.is_file() or target.suffix.lower() not in ('.png','.jpg','.jpeg','.webp','.gif','.pdf'):
                raise ValueError('Native Read is limited to this chat\'s staged media. Use windows-workspace read for project text.')
            print('{}')
        elif isinstance(name,str) and name.startswith(('mcp__tavily__','mcp__playwright__')):
            decision=preflight({'action':'mcp-call','tool':name,'arguments':request.get('tool_input',{})},request.get('permission_mode'))
            output={'hookEventName':'PreToolUse'}
            if decision['decision'] in ('deny','ask','allow'):
                output.update(permissionDecision=decision['decision'],permissionDecisionReason=decision['reason'])
            if decision.get('additionalContext'):output['additionalContext']=decision['additionalContext']
            print(json.dumps({'hookSpecificOutput':output}))
        elif (isinstance(name,str) and name.startswith('mcp__t3-code__') and os.environ.get('WINDOWS_T3_MCP')=='1') or allowed_dynamic_mcp(name):
            print('{}')
        elif name in ('AskUserQuestion', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch'):
            print('{}')
        else:
            print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':'This session operates a Windows project. Use windows-workspace with one single-quoted JSON argument, or the literal windows-agent CLI. Native VPS filesystem/shell operations are not this workspace. Use action info for project details.'}}))
    except Exception as error:
        print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':str(error)}}))
