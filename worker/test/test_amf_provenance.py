import importlib.util
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1]


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, WORKER / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


legacy = load_script('fetch_amf_thresholds', 'fetch-amf-thresholds.py')
bdif = load_script('fetch_amf_bdif', 'fetch-amf-bdif.py')
tier3 = load_script('fetch_tier3_thresholds', 'fetch-tier3-thresholds.py')
uk = load_script('fetch_uk_thresholds', 'fetch-uk-thresholds.py')


class AmfProvenanceTest(unittest.TestCase):
    def test_google_news_item_is_an_honest_press_report(self):
        filing = legacy.make_filing(
            'Votre ETF World contient-il trop de Nvidia ?',
            '2026-09-13',
            {'target': 'Votre ETF World', 'filer': None, 'direction': 'up', 'threshold': None},
            {'url': 'https://news.google.com/rss/articles/example', 'source': 'Café de la Bourse'},
            provenance_kind='press-report',
        )

        self.assertEqual(filing['source'], 'press')
        self.assertIsNone(filing['regulator'])
        self.assertEqual(filing['sourceProvider'], 'Café de la Bourse')
        self.assertFalse(filing['regulatorySignalEligible'])

    def test_bdif_record_has_explicit_official_provenance(self):
        filing = bdif.make_filing(
            {
                'numero': '226C1234',
                'dateAction': '2026-09-12',
                'documents': [{'path': 'example.pdf'}],
            },
            'LVMH MOET HENNESSY LOUIS VUITTON SE',
            'BlackRock, Inc.',
        )

        self.assertEqual(filing['provenance']['kind'], 'official-regulator')
        self.assertTrue(filing['regulatorySignalEligible'])
        self.assertEqual(filing['source'], 'amf')

    def test_tier3_news_item_does_not_claim_the_regulator_as_its_source(self):
        filing = tier3.make_filing(
            'Example company stake report', '2026-09-13', 6.0,
            'Example Company', 'Example Fund', 'SE', 'FI',
            'https://www.fi.se/en/our-registers/large-shareholdings/',
            'Financial Times', 'https://news.google.com/rss/articles/example',
        )

        self.assertEqual(filing['source'], 'press')
        self.assertIsNone(filing['regulator'])
        self.assertFalse(filing['regulatorySignalEligible'])

    def test_official_fca_relative_url_is_resolved_and_tr1_is_eligible(self):
        filing = uk.make_uk_filing(
            'Example PLC TR-1 notification', '2026-09-13',
            {'type_label': 'SHAREHOLDER >3% (TR-1)', 'type_short': 'tr1'},
            'Example PLC', 'EXM', {'url': '/documents/tr1/123'},
        )

        self.assertEqual(filing['sourceUrl'], 'https://data.fca.org.uk/documents/tr1/123')
        self.assertTrue(filing['regulatorySignalEligible'])

    def test_official_fca_pdmr_document_is_not_a_threshold_signal(self):
        filing = uk.make_uk_filing(
            'Example PLC PDMR notification', '2026-09-13',
            {'type_label': 'DIRECTOR PDMR', 'type_short': 'pdmr'},
            'Example PLC', 'EXM', {'url': '/documents/pdmr/123'},
        )

        self.assertTrue(filing['provenance']['officialDocument'])
        self.assertFalse(filing['regulatorySignalEligible'])


if __name__ == '__main__':
    unittest.main()
