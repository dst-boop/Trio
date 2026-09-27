// Optional workspace tools an operator can turn off with TRIO_DISABLED_FEATURES, a
// comma-separated list of these names. Everything is on by default. A disabled tool is
// hidden in the workspace and its API routes refuse requests, so hiding it is not just cosmetic.
export const optionalFeatures = ['quality', 'comparison', 'work', 'audio', 'image', 'memory'] as const;
export type Feature = (typeof optionalFeatures)[number];
export type Features = Record<Feature, boolean>;
export const allFeatures: Features = Object.fromEntries(optionalFeatures.map(name => [name, true])) as Features;

export function enabledFeatures(env: { TRIO_DISABLED_FEATURES?: string }): Features {
  const off = new Set((env.TRIO_DISABLED_FEATURES ?? '').split(',').map(name => name.trim().toLowerCase()));
  return Object.fromEntries(optionalFeatures.map(name => [name, !off.has(name)])) as Features;
}

/** A 404 reply when `feature` is turned off for this workspace, or null when it is on. */
export function featureDisabled(env: { TRIO_DISABLED_FEATURES?: string }, feature: Feature) {
  if (enabledFeatures(env)[feature]) return null;
  return Response.json({ error: 'This tool is turned off for this workspace.' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
}
