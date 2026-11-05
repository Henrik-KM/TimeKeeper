export const CODEX_ACTIVITY_POLICY_VERSION = 1;
export const CODEX_ACTIVITY_POLICY_REQUIRED_AFTER = '2026-11-05T00:00:00.000Z';

export function isPassiveAgentTool(tool) {
  const name = String(tool?.name || '')
    .split(/[._]+/)
    .at(-1);
  if (
    /^(AskUserQuestion|ExitPlanMode|Monitor|TaskOutput|request_user_input|request_user_input_async|wait|wait_agent|sleep)$/i.test(
      name
    ) ||
    /(?:^|[._])(?:request_user_input(?:_async)?|wait_agent)$/.test(
      String(tool?.name || '')
    )
  )
    return true;
  const input = tool?.input || {};
  const command = String(input.command || input.cmd || '');
  const waits =
    /\bsleep\s+\d|\bStart-Sleep\b|\btimeout\s+\d+(?:\.\d+)?\s+tail\s+-f\s+\/dev\/null|\btime\.sleep\s*\(/i.test(
      command
    );
  const readOnlyPython =
    /\bimport\s+json\b/.test(command) &&
    /\bprint\s*\(/.test(command) &&
    !/\b(?:write|write_text|write_bytes|dump|save|fit|train|run|call|Popen)\s*\(/.test(
      command
    );
  const startsWork =
    /\b(?:sbatch|salloc|mpirun|mpiexec|make|cmake|ninja|pytest|ctest|npm(?:\.cmd)?|node(?:\.exe)?|pip|uv|Rscript)\s/i.test(
      command
    ) ||
    (/\bsrun\s/.test(command) &&
      !/\bsrun\s[^;]*--overlap\b[^;]*\b(?:wc|tail|grep|cat)\b/.test(command)) ||
    (!readOnlyPython &&
      /\bpython[\d.]*(?:\.exe)?\s+(?!-c\s+["'](?:import\s+time\s*;\s*)?time\.sleep\()/i.test(
        command
      ));
  return waits && !startsWork;
}

/** Track explicit pauses across bookkeeping events without retaining content. */
export function createCodexActivityTracker() {
  let turnOpen = true;
  const passiveCalls = new Set();
  return {
    get active() {
      return turnOpen && passiveCalls.size === 0;
    },
    observe(event) {
      const payload = event?.payload || {};
      const type = payload.type;
      if (event?.type === 'turn_context') turnOpen = true;
      if (event?.type === 'event_msg') {
        if (['task_complete', 'turn_aborted'].includes(type)) {
          turnOpen = false;
          passiveCalls.clear();
        } else if (['task_started', 'user_message'].includes(type)) {
          turnOpen = true;
        }
      }
      if (event?.type !== 'response_item') return;
      if (type === 'message') {
        if (payload.role === 'user') turnOpen = true;
        if (
          payload.role === 'assistant' &&
          (payload.channel === 'final' || payload.phase === 'final_answer')
        )
          turnOpen = false;
      }
      if (['function_call', 'custom_tool_call', 'tool_call'].includes(type)) {
        let input = payload.arguments ?? payload.input ?? {};
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = { code: input };
          }
        }
        const name = String(payload.name || '');
        // Generic exec polling can be waiting for actual work, such as a build.
        const passive =
          !/(?:^|[._])wait$/.test(name) && isPassiveAgentTool({ name, input });
        const code = String(input?.code || '');
        const sleepOnly =
          /\bclock(?:\.|__)sleep\s*\(/.test(code) &&
          !/\b(?:exec_command|web__|fetch|readFile|writeFile|spawn)\b/.test(
            code
          );
        if ((passive || sleepOnly) && payload.call_id)
          passiveCalls.add(payload.call_id);
      } else if (
        [
          'function_call_output',
          'custom_tool_call_output',
          'tool_call_output'
        ].includes(type)
      ) {
        passiveCalls.delete(payload.call_id);
      }
    }
  };
}

export function acceptsCodexActivityRecord(record) {
  return (
    Number(record?.activityPolicyVersion) >= CODEX_ACTIVITY_POLICY_VERSION ||
    Date.parse(record?.endTime || '') <
      Date.parse(CODEX_ACTIVITY_POLICY_REQUIRED_AFTER) ||
    record?.usageSource === 'henrik-email'
  );
}
