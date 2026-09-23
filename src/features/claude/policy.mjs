/** @type {{ version: number, idleGapMinutes: number, matureMinutes: number, delegationCredit: number, modelFactors: Record<string, number> }} */
export const DEFAULT_CLAUDE_POLICY = Object.freeze({
  version: 1,
  idleGapMinutes: 15,
  matureMinutes: 17,
  delegationCredit: 0.35,
  modelFactors: Object.freeze({
    fable: 0.75,
    opus: 0.5,
    sonnet: 0.4,
    haiku: 0.3,
    unknown: 0.4
  })
});

/** @param {Record<string, any>} value */
export function normalizeClaudePolicy(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const factors =
    input.modelFactors && typeof input.modelFactors === 'object'
      ? input.modelFactors
      : {};
  const modelFactors = Object.fromEntries(
    Object.entries(DEFAULT_CLAUDE_POLICY.modelFactors).map(
      ([key, fallback]) => {
        const number = Number(factors[key]);
        return [
          key,
          Number.isFinite(number) && number >= 0 && number <= 2
            ? number
            : fallback
        ];
      }
    )
  );
  const delegationCredit = Number(input.delegationCredit);
  return {
    version: DEFAULT_CLAUDE_POLICY.version,
    idleGapMinutes: DEFAULT_CLAUDE_POLICY.idleGapMinutes,
    matureMinutes: DEFAULT_CLAUDE_POLICY.matureMinutes,
    delegationCredit:
      Number.isFinite(delegationCredit) &&
      delegationCredit >= 0 &&
      delegationCredit <= 1
        ? delegationCredit
        : DEFAULT_CLAUDE_POLICY.delegationCredit,
    modelFactors
  };
}

export function getClaudeModelFamily(model = '') {
  const name = String(model || '').toLowerCase();
  for (const family of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (name.includes(family)) return family;
  }
  return 'unknown';
}

export function getClaudeModelFactor(
  model = '',
  policy = DEFAULT_CLAUDE_POLICY
) {
  const family = getClaudeModelFamily(model);
  return normalizeClaudePolicy(policy).modelFactors[family];
}
