export const DEFAULT_CODEX_FOCUS_FACTOR = 0.4;

export const DEFAULT_CODEX_FOCUS_POLICY = {
  version: 6,
  defaultFactor: DEFAULT_CODEX_FOCUS_FACTOR,
  minimumFactor: 0.2,
  maximumFactor: 0.8,
  fastModeMultiplier: 1.2,
  delegationCredit: 0.35,
  modelBaseFactors: {
    luna: 0.3,
    terra: 0.4,
    sol: 0.5
  },
  modelOverrides: {},
  repositoryMultipliers: {},
  repositoryMultiplierPolicyVersion: 4,
  effortAdjustments: {
    low: 0,
    medium: 0,
    high: 0,
    xhigh: 0,
    max: 0,
    ultra: 0
  }
};

function getFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumberMap(value, fallback, { positiveOnly = false } = {}) {
  const source = /** @type {Record<string, any>} */ (
    value && typeof value === 'object' ? value : {}
  );
  const normalized = { ...fallback };
  Object.entries(source).forEach(([key, rawValue]) => {
    const name = String(key || '')
      .trim()
      .toLowerCase();
    const number = Number(rawValue);
    if (!name || !Number.isFinite(number) || (positiveOnly && number <= 0)) {
      return;
    }
    normalized[name] = number;
  });
  return normalized;
}

export function normalizeCodexFocusPolicy(
  value = {},
  fallbackFactor = DEFAULT_CODEX_FOCUS_FACTOR
) {
  const source = /** @type {Record<string, any>} */ (
    value && typeof value === 'object' ? value : {}
  );
  const minimumFactor = Math.max(
    0.01,
    getFiniteNumber(
      source.minimumFactor,
      DEFAULT_CODEX_FOCUS_POLICY.minimumFactor
    )
  );
  const maximumFactor = Math.max(
    minimumFactor,
    getFiniteNumber(
      source.maximumFactor,
      DEFAULT_CODEX_FOCUS_POLICY.maximumFactor
    )
  );
  const requestedDefault = getFiniteNumber(
    source.defaultFactor,
    getFiniteNumber(fallbackFactor, DEFAULT_CODEX_FOCUS_FACTOR)
  );
  return {
    version: Math.max(
      1,
      Math.floor(
        getFiniteNumber(source.version, DEFAULT_CODEX_FOCUS_POLICY.version)
      )
    ),
    defaultFactor: Math.min(
      maximumFactor,
      Math.max(minimumFactor, requestedDefault)
    ),
    minimumFactor,
    maximumFactor,
    fastModeMultiplier: Math.max(
      0.01,
      getFiniteNumber(
        source.fastModeMultiplier,
        DEFAULT_CODEX_FOCUS_POLICY.fastModeMultiplier
      )
    ),
    delegationCredit: Math.max(
      0,
      getFiniteNumber(
        source.delegationCredit,
        DEFAULT_CODEX_FOCUS_POLICY.delegationCredit
      )
    ),
    modelBaseFactors: normalizeNumberMap(
      source.modelBaseFactors,
      DEFAULT_CODEX_FOCUS_POLICY.modelBaseFactors,
      { positiveOnly: true }
    ),
    modelOverrides: normalizeNumberMap(
      source.modelOverrides,
      {},
      { positiveOnly: true }
    ),
    repositoryMultipliers: normalizeNumberMap(
      source.repositoryMultipliers,
      {},
      { positiveOnly: true }
    ),
    repositoryMultiplierPolicyVersion: Math.max(
      1,
      Math.floor(
        getFiniteNumber(
          source.repositoryMultiplierPolicyVersion,
          DEFAULT_CODEX_FOCUS_POLICY.repositoryMultiplierPolicyVersion
        )
      )
    ),
    // Keep this compatibility field for old readers. v6 deliberately ignores
    // its values when resolving a focus factor.
    effortAdjustments: { ...DEFAULT_CODEX_FOCUS_POLICY.effortAdjustments }
  };
}

export function normalizeCodexEffort(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (normalized === 'light') return 'low';
  if (normalized === 'extra-high' || normalized === 'extra-high-reasoning') {
    return 'xhigh';
  }
  return normalized;
}

export function normalizeCodexFastMode(value, missingDefault = false) {
  if (
    value === true ||
    ['on', 'true'].includes(String(value || '').toLowerCase())
  ) {
    return true;
  }
  if (
    value === false ||
    ['off', 'false'].includes(String(value || '').toLowerCase())
  ) {
    return false;
  }
  return missingDefault;
}

/**
 * Resolve the effective-work factor before repository and delegation modifiers.
 * Reasoning effort remains in the result for analytics but is intentionally not
 * part of this calculation.
 */
export function resolveCodexFocusFactor({
  model = '',
  effort = '',
  fastMode = false,
  focusPolicy = {},
  fallbackFactor = DEFAULT_CODEX_FOCUS_FACTOR
} = {}) {
  const policy = normalizeCodexFocusPolicy(focusPolicy, fallbackFactor);
  const normalizedModel = String(model || '')
    .trim()
    .toLowerCase();
  const normalizedEffort = normalizeCodexEffort(effort);
  let modelFamily = '';
  let baseFactor = policy.modelOverrides[normalizedModel];
  const hasModelRule = Number.isFinite(baseFactor);
  if (!hasModelRule) {
    const modelParts = normalizedModel.split(/[-_.]+/).filter(Boolean);
    modelFamily = Object.keys(policy.modelBaseFactors).find((family) =>
      modelParts.includes(family)
    );
    baseFactor = modelFamily
      ? policy.modelBaseFactors[modelFamily]
      : policy.defaultFactor;
  }
  const normalizedBaseFactor = Number(
    Math.min(
      policy.maximumFactor,
      Math.max(policy.minimumFactor, baseFactor)
    ).toFixed(4)
  );
  const appliedFastModeMultiplier = fastMode ? policy.fastModeMultiplier : 1;
  const factor = Number(
    Math.min(
      policy.maximumFactor,
      Math.max(
        policy.minimumFactor,
        normalizedBaseFactor * appliedFastModeMultiplier
      )
    ).toFixed(4)
  );
  return {
    factor,
    baseFactor: normalizedBaseFactor,
    model: normalizedModel,
    modelFamily,
    effort: normalizedEffort,
    fastMode: fastMode === true,
    fastModeMultiplier: appliedFastModeMultiplier,
    policyVersion: policy.version,
    source: hasModelRule || modelFamily ? 'model' : 'default'
  };
}
