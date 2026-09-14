import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateEuThresholds } from '../src/eu_thresholds_aggregator.js';
import {
  normalizeThresholdFilingProvenance,
  partitionThresholdFilings,
} from '../src/threshold_provenance.js';

const officialAmf = {
  fileDate: '2026-09-12',
  form: 'FRANCHISSEMENT DE SEUIL (AMF)',
  accession: '226C1234',
  targetName: 'LVMH MOET HENNESSY LOUIS VUITTON SE',
  filerName: 'BlackRock, Inc.',
  percentOfClass: 5.12,
  source: 'amf',
  regulator: 'AMF (BDIF)',
  sourceUrl: 'https://bdif.amf-france.org/back/api/v1/documents/example.pdf',
};

const contaminatedEditorial = {
  fileDate: '2026-09-13',
  form: 'FRANCHISSEMENT 5%',
  accession: null,
  ticker: '',
  targetName: 'LVMH MOET HENNESSY - Votre ETF World contient-il trop de Nvidia ?',
  filerName: '',
  percentOfClass: null,
  source: 'amf',
  regulator: 'AMF',
  sourceProvider: 'Café de la Bourse',
  sourceUrl: 'https://news.google.com/rss/articles/example',
  rawTitle: 'Votre ETF World contient-il trop de Nvidia ? La méthode pour calculer votre exposition réelle...',
};

test('official AMF evidence remains eligible as a regulatory signal', () => {
  const filing = normalizeThresholdFilingProvenance(officialAmf, {
    method: 'amf-bdif-official',
    regulator: 'AMF (BDIF)',
  });

  assert.equal(filing.provenance.kind, 'official-regulator');
  assert.equal(filing.regulatorySignalEligible, true);
  assert.equal(filing.source, 'amf');
});

test('a Google News editorial never inherits an AMF label or regulatory eligibility', () => {
  const filing = normalizeThresholdFilingProvenance(contaminatedEditorial, {
    method: 'google-news-rss',
    regulator: 'AMF',
  });

  assert.equal(filing.provenance.kind, 'press-report');
  assert.equal(filing.regulatorySignalEligible, false);
  assert.equal(filing.source, 'press');
  assert.equal(filing.regulator, null);
  assert.equal(filing.sourceProvider, 'Café de la Bourse');
});

test('cached press contamination is excluded while official filings remain available', async () => {
  const cache = {
    async get(key) {
      return key === 'amf-thresholds-recent'
        ? { method: 'mixed-legacy', regulator: 'AMF', filings: [contaminatedEditorial, officialAmf] }
        : null;
    },
  };

  const result = await aggregateEuThresholds('MC.PA', { CACHE: cache });

  assert.equal(result.totalFilings, 1);
  assert.equal(result.filings[0].accession, '226C1234');
  assert.equal(result.excludedPressReports, 1);
});

test('partitioning exposes press reports separately without treating them as filings', () => {
  const result = partitionThresholdFilings([officialAmf, contaminatedEditorial], {
    method: 'mixed-legacy',
    regulator: 'AMF',
  });

  assert.deepEqual(result.regulatoryFilings.map((f) => f.accession), ['226C1234']);
  assert.deepEqual(result.pressReports.map((f) => f.sourceProvider), ['Café de la Bourse']);
});

test('an official SIX significant-shareholder notice remains eligible', () => {
  const filing = normalizeThresholdFilingProvenance({
    source: 'six', regulator: 'SIX-Disclosure', announcementType: 'shareholding',
    accession: '12345', targetName: 'Example AG', filerName: 'Example Fund',
    sourceUrl: 'https://www.ser-ag.com/en/resources/notifications-market-participants/significant-shareholders.html?notificationId=12345',
  }, { method: 'six-ser-official' });

  assert.equal(filing.provenance.officialDocument, true);
  assert.equal(filing.regulatorySignalEligible, true);
});

test('an official non-shareholding document never becomes a threshold signal', () => {
  const filing = normalizeThresholdFilingProvenance({
    source: 'cnmv', regulator: 'CNMV (OIR)', announcementType: 'agm',
    accession: '999', targetName: 'Example SA',
    sourceUrl: 'https://www.cnmv.es/portal/Otra-Informacion-Relevante/Detalle-OIR?nreg=999',
  }, { method: 'cnmv-oir-official' });

  assert.equal(filing.provenance.officialDocument, true);
  assert.equal(filing.regulatorySignalEligible, false);
});

test('legacy official BaFin and AFM threshold rows remain eligible', () => {
  const fixtures = [
    {
      row: { form: 'STIMMRECHTSMITTEILUNG WpHG §33', sourceUrl: 'https://portal.mvp.bafin.de/database/AnteileInfo/' },
      payload: { source: 'bafin' },
    },
    {
      row: { form: 'AFM SUBSTANTIAL HOLDING', sourceUrl: 'https://www.afm.nl/registers/meldingenregisters/substantiele-deelnemingen' },
      payload: { method: 'afm-csv-official' },
    },
  ];

  for (const fixture of fixtures) {
    const filing = normalizeThresholdFilingProvenance(fixture.row, fixture.payload);
    assert.equal(filing.provenance.officialDocument, true);
    assert.equal(filing.regulatorySignalEligible, true);
  }
});
