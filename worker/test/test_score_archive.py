import copy
import importlib.util
import io
import pathlib
import sqlite3
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('score_archive', ROOT / 'push-scores-to-d1.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def current_score():
    weights = [22.22, 22.22, 16.67, 11.11, 11.11, 11.11, 5.56]
    return {'total': 50, 'breakdown': {
        key: {'score': weight / 2, 'max': weight, 'dataOk': True}
        for key, weight in zip(MODULE.ACTIVE_PILLAR_KEYS, weights)
    }}


class ScoreArchiveTest(unittest.TestCase):
    def test_fetch_accepts_only_supported_seven_axis_scores(self):
        score = current_score()
        with patch.object(MODULE, 'http_get_json', return_value={'score': score}):
            self.assertEqual(MODULE.fetch_score('AAPL'), ('AAPL', score, None))
        cases = []
        old = copy.deepcopy(score)
        old['breakdown']['govGuru'] = {'score': 5, 'max': 10, 'dataOk': True}
        cases.append(old)
        no_data = copy.deepcopy(score)
        for axis in no_data['breakdown'].values():
            axis['dataOk'] = False
        cases.append(no_data)
        for field, value in [('score', float('nan')), ('score', 30), ('score', -1), ('max', True)]:
            invalid = copy.deepcopy(score)
            invalid['breakdown']['insider'][field] = value
            cases.append(invalid)
        for total in [101, -1, True, float('inf'), 51]:
            invalid = copy.deepcopy(score)
            invalid['total'] = total
            cases.append(invalid)
        for invalid in cases:
            with self.subTest(invalid=invalid), patch.object(MODULE, 'http_get_json', return_value={'score': invalid}):
                self.assertIsNone(MODULE.fetch_score('AAPL')[1])

    def test_archive_keeps_decimal_weights_and_retires_gov_column_as_null(self):
        score = current_score()
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE score_history (date TEXT, ticker TEXT, total INTEGER, insider INTEGER, smart_money INTEGER, gov_guru INTEGER, momentum INTEGER, valuation INTEGER, analyst INTEGER, health INTEGER, earnings INTEGER)')
        db.execute(MODULE.build_sql('AAPL', score))
        row = db.execute('SELECT total, insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings FROM score_history').fetchone()
        self.assertEqual(row, MODULE.score_tuple(score))
        self.assertIsNone(row[3])
        self.assertEqual(row[4], 8.335)
        self.assertAlmostEqual(sum(value for value in row[1:] if value is not None), 50)

    def test_prior_weighted_scores_are_never_spliced_into_current_method(self):
        score = current_score()
        score['breakdown']['insider']['dataOk'] = False
        for historical in [(95, 20, 20, 10, 15, 10, 10, 10, 5), (95, 90, 1, None, 1, 1, 1, 1, 0)]:
            before = copy.deepcopy(score)
            result, fallbacks = MODULE.apply_last_known_good_fallback('AAPL', score, historical)
            self.assertEqual(result, before)
            self.assertEqual(fallbacks, [])

    def test_method_transition_is_written_without_triggering_outage_breaker(self):
        calls = []
        old_eight_axis = (100, 20, 20, 10, 15, 10, 10, 10, 5)
        with patch.object(MODULE, 'load_tickers', return_value=['AAPL']), \
             patch.object(MODULE, 'fetch_last_scores_from_d1', return_value={'AAPL': old_eight_axis}), \
             patch.object(MODULE, 'fetch_score', return_value=('AAPL', current_score(), None)), \
             patch.object(MODULE, 'push_chunk_to_d1', side_effect=lambda rows, label: calls.extend(rows) or True), \
             patch.object(MODULE, 'send_anomalies_report') as report, redirect_stdout(io.StringIO()):
            MODULE.main()
        self.assertEqual(len(calls), 1)
        self.assertIn('NULL', calls[0])
        report.assert_not_called()


if __name__ == '__main__':
    unittest.main()
