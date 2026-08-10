'use strict';

const { test, eq } = require('./harness/framework');
const AdaptiveMode = require('../src/lib/adaptive-mode.js');

test('adaptive mode: shared derivation keeps popup and settings states aligned', () => {
  eq(AdaptiveMode.mode(null), 'standard');
  eq(AdaptiveMode.mode({ enabled: false, shadow: false }), 'standard');
  eq(AdaptiveMode.mode({ enabled: true }), 'preview');
  eq(AdaptiveMode.mode({ enabled: true, shadow: true }), 'preview');
  eq(AdaptiveMode.mode({ enabled: true, shadow: false }), 'adaptive');
});
