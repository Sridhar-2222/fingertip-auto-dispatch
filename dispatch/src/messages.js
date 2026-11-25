// Every passenger-facing line: Telugu first, English second.
// Rides only — never anything about medicines on WhatsApp.
import { label } from './landmarks.js';

export const msg = {
  askLocation: (destKey) => {
    const l = label(destKey);
    return [
      `🛺 ${l.te} కి ఆటో వెతుకుతాం.`,
      'క్రింద ఉన్న బటన్ నొక్కి మీ లొకేషన్ పంపండి.',
      '',
      `We'll find an auto to ${l.en}.`,
      'Tap the button below to send your location.',
      '',
      'ℹ️ ఆటో దొరికితే మీ ఫోన్ నంబర్ ఆ డ్రైవర్‌కి మాత్రమే ఇస్తాం. / Your number is shared only with the driver who accepts.',
    ].join('\n');
  },

  askDestinationBody:
    'ఎక్కడికి వెళ్ళాలి? క్రింద ఎంచుకోండి లేదా వాయిస్ మెసేజ్ పంపండి.\nWhere do you want to go? Pick below or send a voice note.',
  askDestinationButton: 'చోటు ఎంచుకోండి',

  notHeard:
    'క్షమించండి, మీ మాట సరిగ్గా వినిపించలేదు. ఎక్కడికి వెళ్ళాలో క్రింద ఎంచుకోండి.\nSorry, we couldn\'t hear that clearly. Please pick your destination below.',

  searching: (n) => [
    `🔔 దగ్గరలో ఉన్న ${n} ఆటోలకు చెప్పాము. 30 సెకన్లలో తెలియజేస్తాం.`,
    `We've alerted ${n} nearby auto${n === 1 ? '' : 's'}. We'll tell you within 30 seconds.`,
  ].join('\n'),

  confirmed: ({ driver, ride_code }, link) => [
    '✅ ఆటో వస్తోంది!',
    `డ్రైవర్: ${driver.name_te || driver.name}`,
    `ఆటో నంబర్: ${driver.auto_number}`,
    `కాల్: +${driver.phone}`,
    `రైడ్ కోడ్: ${ride_code}`,
    '',
    `Auto confirmed! ${driver.name} · ${driver.auto_number}`,
    '',
    `లైవ్ లొకేషన్ / రద్దు చేయడానికి / Track or cancel: ${link}`,
  ].join('\n'),

  noAuto: [
    '😔 క్షమించండి, ఇప్పుడు 3 కి.మీ. లోపల ఆటోలు అందుబాటులో లేవు. కొద్దిసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి.',
    'Sorry, no autos are free within 3 km right now. Please try again in a few minutes.',
  ].join('\n'),

  ridesOnly: [
    'ఈ నంబర్ ఆటో బుకింగ్ కోసం మాత్రమే. 🛺 ఎక్కడికి వెళ్ళాలో వాయిస్ మెసేజ్ పంపండి.',
    'This number is only for booking autos. Send a voice note saying where you want to go.',
  ].join('\n'),

  stillSearching: 'ఇంకా ఆటో కోసం వెతుకుతున్నాం, కొద్ది సెకన్లు ఆగండి.\nStill looking for your auto, please wait a few seconds.',

  alreadyConfirmed: (link) => `మీ ఆటో ఇప్పటికే బుక్ అయింది. / Your auto is already booked: ${link}`,

  cancelled: 'మీ రైడ్ రద్దు చేయబడింది. / Your ride has been cancelled.',

  // Shown in the driver app (API response), not sent on WhatsApp
  driver: {
    taken: 'ఈ రైడ్ వేరే డ్రైవర్ తీసుకున్నారు. / Ride already taken.',
    expired: 'సమయం అయిపోయింది. / This ride request has expired.',
    driver_not_available: 'మీరు ఇప్పటికే ఒక రైడ్‌లో ఉన్నారు. / You are already on a ride.',
    not_pinged: 'ఈ రైడ్ మీకు పంపలేదు. / This ride was not sent to you.',
    not_found: 'రైడ్ కనిపించలేదు. / Ride not found.',
  },
};
