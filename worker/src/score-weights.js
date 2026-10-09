// Retired axes are deliberately excluded, including from saved admin settings.
export const SCORE_BASE_MAX = Object.freeze({insider:20,smartMoney:20,momentum:15,valuation:10,analyst:10,health:10,earnings:5});
export const SCORE_WEIGHT_KEYS = Object.freeze(Object.keys(SCORE_BASE_MAX));
export function normalizeScoreWeights(input = {}) {
  const weights = Object.fromEntries(SCORE_WEIGHT_KEYS.map(key => [key,
    typeof input?.[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 100 ? input[key] : SCORE_BASE_MAX[key]]));
  const sum = Object.values(weights).reduce((a,b) => a+b,0);
  if (!sum) return normalizeScoreWeights(SCORE_BASE_MAX);
  return Object.fromEntries(SCORE_WEIGHT_KEYS.map(key => [key, weights[key] / sum * 100]));
}
export const SCORE_DEFAULT_WEIGHTS = Object.freeze(normalizeScoreWeights());
