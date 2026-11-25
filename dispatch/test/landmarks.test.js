import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDestination } from '../src/landmarks.js';

const key = (t) => matchDestination(t)?.key ?? null;

test('Telugu voice transcripts', () => {
  assert.equal(key('కోతిరాంపూర్ కి ఆటో కావాలి'), 'KOTHIRAMPUR');
  assert.equal(key('నాకు బస్టాండ్ కు ఆటో కావాలి అన్నా'), 'BUS_STAND');
  assert.equal(key('సర్కారు దవాఖాన కి పోవాలి'), 'CIVIL_HOSPITAL');
  assert.equal(key('అలుగునూరు వెళ్ళాలి'), 'ALGUNUR');
  assert.equal(key('కమాన్ దగ్గరికి'), 'KAMAN');
});

test('Zero-width joiners and spacing do not break matching', () => {
  assert.equal(key('బస్‌ స్టాండ్'), 'BUS_STAND');
  assert.equal(key('కోతి   రాంపూర్'), 'KOTHIRAMPUR');
});

test('Romanised / typed English', () => {
  assert.equal(key('Kothirampur ki auto kavali'), 'KOTHIRAMPUR');
  assert.equal(key('need auto to bus stand please'), 'BUS_STAND');
  assert.equal(key('husnabad'), 'HUSNABAD');
});

test('Small typos in romanised words', () => {
  assert.equal(key('kothrampur ki'), 'KOTHIRAMPUR');
  assert.equal(key('alugunoor'), 'ALGUNUR');
});

test('From X to Y picks the destination', () => {
  assert.equal(key('bus stand nundi kothirampur ki'), 'KOTHIRAMPUR');
  assert.equal(key('కోతిరాంపూర్ నుండి బస్టాండ్ కి'), 'BUS_STAND');
  assert.equal(key('kothirampur ki bus stand nundi'), 'KOTHIRAMPUR');
});

test('No match', () => {
  assert.equal(key('hello'), null);
  assert.equal(key(''), null);
  assert.equal(key('auto kavali'), null);
});
