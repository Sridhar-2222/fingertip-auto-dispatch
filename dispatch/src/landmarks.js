// Deterministic destination matcher. No AI here: the transcript from Sarvam
// is checked against a fixed list of local names and spellings.
//
// ⚠ Telugu spellings are a best first guess. Before launch, ask 10–20 people
// at the stands to say each place name into WhatsApp, look at what Sarvam
// writes back (it's logged as raw_transcript), and add those spellings here.

export const LANDMARKS = {
  KOTHIRAMPUR: {
    te: 'కోతిరాంపూర్', en: 'Kothirampur',
    aliases: ['కోతిరాంపూర్', 'కోతిరాంపూరు', 'కొత్తిరాంపూర్', 'కొత్తరాంపూర్', 'కోతి రాంపూర్',
              'kothirampur', 'kotirampur', 'kothi rampur', 'kotharampur', 'kottirampur'],
  },
  ALGUNUR: {
    te: 'అలుగునూరు', en: 'Algunur',
    aliases: ['అలుగునూరు', 'అలుగునూర్', 'అల్గునూర్', 'అల్గునూరు', 'algunur', 'alugunur', 'alugunuru', 'algunoor'],
  },
  BUS_STAND: {
    te: 'కరీంనగర్ బస్ స్టాండ్', en: 'Karimnagar Bus Stand',
    aliases: ['బస్ స్టాండ్', 'బస్టాండ్', 'బస్సు స్టాండ్', 'బస్ స్టేషన్', 'బస్సు స్టేషన్', 'బస్ డిపో',
              'bus stand', 'busstand', 'bus station', 'bus depot'],
  },
  CIVIL_HOSPITAL: {
    te: 'సివిల్ హాస్పిటల్', en: 'Civil Hospital',
    aliases: ['సివిల్ హాస్పిటల్', 'సివిల్ ఆసుపత్రి', 'ప్రభుత్వ ఆసుపత్రి', 'ప్రభుత్వ దవాఖాన', 'సర్కారు దవాఖాన',
              'సర్కార్ దవాఖాన', 'గవర్నమెంట్ హాస్పిటల్', 'పెద్ద దవాఖాన', 'పెద్దాసుపత్రి',
              'civil hospital', 'government hospital', 'govt hospital', 'sarkari hospital'],
  },
  KAMAN: {
    te: 'కమాన్', en: 'Kaman',
    aliases: ['కమాన్', 'కమాను', 'kaman', 'kamaan'],
  },
  HUSNABAD: {
    te: 'హుస్నాబాద్', en: 'Husnabad',
    aliases: ['హుస్నాబాద్', 'హుస్నాబాదు', 'husnabad', 'husnabaad'],
  },
};

// Words that mark "to <place>" — కి / కు / ki / ku / varaku …
const TO_MARKERS = ['కి', 'కు', 'వరకు', 'దాకా', 'ki', 'ku', 'ke', 'varaku', 'daaka', 'daka'];

export function normalize(s) {
  return (s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')     // zero-width joiners Sarvam sometimes emits
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');     // drop spaces & punctuation
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const NORMALIZED = Object.entries(LANDMARKS).map(([key, l]) => ({
  key, aliases: [...new Set(l.aliases.map(normalize))],
}));

// Returns { key, ambiguous } or null.
// If two places are mentioned ("bus stand nundi Kothirampur ki"), the one
// followed by a "to" word wins; otherwise the last one mentioned.
export function matchDestination(transcript) {
  const text = normalize(transcript);
  if (!text) return null;

  const hits = [];
  for (const { key, aliases } of NORMALIZED) {
    let best = -1, bestLen = 0;
    for (const a of aliases) {
      const pos = text.lastIndexOf(a);
      if (pos > best || (pos === best && a.length > bestLen)) { best = pos; bestLen = a.length; }
    }
    if (best >= 0) hits.push({ key, pos: best, end: best + bestLen });
  }

  // Fuzzy fallback for romanised words only (typos like "kothrampur")
  if (!hits.length) {
    const words = (transcript || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5);
    for (const { key, aliases } of NORMALIZED) {
      for (const a of aliases) {
        if (!/^[a-z]+$/.test(a) || a.length < 5) continue;
        if (words.some((w) => levenshtein(w, a) <= 2)) { hits.push({ key, pos: 0, end: 0 }); break; }
      }
    }
  }

  if (!hits.length) return null;
  if (hits.length === 1) return { key: hits[0].key, ambiguous: false };

  const marked = hits.filter((h) => TO_MARKERS.some((m) => text.startsWith(normalize(m), h.end)));
  if (marked.length === 1) return { key: marked[0].key, ambiguous: false };
  hits.sort((a, b) => b.pos - a.pos);
  return { key: hits[0].key, ambiguous: true };
}

export function label(key) {
  const l = LANDMARKS[key];
  return l ? { te: l.te, en: l.en } : { te: 'మీరు చెప్పిన చోటు', en: 'your destination' };
}
