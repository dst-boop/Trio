import test from 'node:test';
import assert from 'node:assert/strict';
import { allFeatures, enabledFeatures, featureDisabled, optionalFeatures } from '../lib/features.ts';

test('every optional tool is on unless the operator lists it', () => {
  assert.deepEqual(enabledFeatures({}), allFeatures);
  assert.deepEqual(enabledFeatures({ TRIO_DISABLED_FEATURES: '' }), allFeatures);
  assert.ok(optionalFeatures.every(name => allFeatures[name]));
});

test('listed tools are off; spacing, case and unknown names are tolerated', async () => {
  const features = enabledFeatures({ TRIO_DISABLED_FEATURES: ' Quality, comparison ,image,unknown,' });
  assert.deepEqual(features, { quality: false, comparison: false, work: true, audio: true, image: false, memory: true });
  const refused = featureDisabled({ TRIO_DISABLED_FEATURES: 'audio' }, 'audio')!;
  assert.equal(refused.status, 404);
  assert.match(((await refused.json()) as { error: string }).error, /turned off/);
  assert.equal(featureDisabled({ TRIO_DISABLED_FEATURES: 'audio' }, 'image'), null);
});
