// Synthetic purchased content. Shared by the reference seller and the local testnet seller;
// these response bodies are not part of the payment requirements or their purpose hash.
export const WEATHER = {
  demo: true,
  source: 'TrustRail synthetic hourly forecast',
  location: 'Tokyo',
  units: { temperature: 'C', precipitationProbability: '%' },
  hourly: [
    { time: '2026-12-01T09:00:00Z', temperature: 18, condition: 'clear', precipitationProbability: 5 },
    { time: '2026-12-01T10:00:00Z', temperature: 19, condition: 'partly cloudy', precipitationProbability: 10 },
    { time: '2026-12-01T11:00:00Z', temperature: 20, condition: 'cloudy', precipitationProbability: 20 },
  ],
};

export const DATASET = {
  demo: true,
  source: 'TrustRail synthetic demand dataset',
  description: 'Three illustrative rows from a fictional 1,000-row export; no full dataset is supplied.',
  columns: ['hourUtc', 'temperatureC', 'demandClass'],
  rows: [
    { hourUtc: '2026-12-01T09:00:00Z', temperatureC: 18, demandClass: 'low' },
    { hourUtc: '2026-12-01T10:00:00Z', temperatureC: 19, demandClass: 'medium' },
    { hourUtc: '2026-12-01T11:00:00Z', temperatureC: 20, demandClass: 'high' },
  ],
};
