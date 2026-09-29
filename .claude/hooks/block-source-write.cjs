#!/usr/bin/env node
// OctoCheck read-only enforcement hook.
//
// Registered as a PreToolUse hook (see settings.hooks.json for the config snippet),
// this runs as a separate process outside the conversation — it cannot be talked
// around by a prompt, a jailbreak attempt, or the model changing its mind mid-task.
// It denies any Edit or Write tool call whose target path is not inside octocheck/.
//
// Exit code 0 = allow. Exit code 2 + a stderr message = block, and Claude Code
// surfaces that message back into the conversation.

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    // Fail closed: if we can't parse what's being asked, block it rather than
    // risk letting an unrecognized write through.
    process.stderr.write('OctoCheck hook: could not parse the tool call payload — blocking as a precaution.\n');
    process.exit(2);
  }

  const toolName = payload.tool_name || payload.toolName || '';
  const toolInput = payload.tool_input || payload.toolInput || {};
  const targetPath = toolInput.file_path || toolInput.path || toolInput.filePath || '';

  const isWriteTool = /^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(toolName);
  const normalizedPath = String(targetPath).replace(/\\/g, '/');
  const isInsideOctocheckFolder = /(^|\/)octocheck\//.test(normalizedPath);

  if (isWriteTool && !isInsideOctocheckFolder) {
    process.stderr.write(
      `OctoCheck is a read-only reviewer. Blocked a ${toolName} call targeting "${targetPath}", ` +
      `which is outside the octocheck/ folder. OctoCheck never modifies source — only its own ` +
      `working files under octocheck/ may be written.\n`
    );
    process.exit(2);
  }

  process.exit(0);
});
