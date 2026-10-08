import ast
import re
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'prefetch-all.py'
sys.path.insert(0, str(SCRIPT.parent))
TREE = ast.parse(SCRIPT.read_text(encoding='utf-8'))
PARSER = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'parse_form4')
APPEND = next(node for node in ast.walk(TREE)
              if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and isinstance(node.func.value, ast.Name)
              and node.func.value.id == 'all_transactions' and node.func.attr == 'append')


def collect_transaction(execution_date):
    # Execute the real parser and row assembly, excluding the script's top-level
    # network collection/upload loop. No provider, filesystem write or clock mock.
    namespace = {'re': re}
    exec(compile(ast.Module(body=[PARSER], type_ignores=[]), str(SCRIPT), 'exec'), namespace)
    date_xml = '' if execution_date is None else f'<transactionDate><value>{execution_date}</value></transactionDate>'
    xml = f'''<ownershipDocument><issuerTradingSymbol>TEST</issuerTradingSymbol>
      <issuerName>Example</issuerName><rptOwnerName>Alice</rptOwnerName><rptOwnerCik>123</rptOwnerCik>
      <nonDerivativeTransaction>{date_xml}<transactionCode>P</transactionCode>
      <transactionShares><value>10</value></transactionShares>
      <transactionPricePerShare><value>100</value></transactionPricePerShare>
      </nonDerivativeTransaction></ownershipDocument>'''
    parsed = namespace['parse_form4'](xml, '2026-10-08')
    namespace.update(tx=parsed['transactions'][0], parsed=parsed, all_transactions=[],
                     file_date='2026-10-08', company_cik='999', parsed_ticker=parsed['ticker'],
                     parsed_title=parsed['title'], company_name_meta='Example', insider_name='Alice', adsh='filing-1')
    assembly = ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=APPEND)], type_ignores=[]))
    exec(compile(assembly, str(SCRIPT), 'exec'), namespace)
    return namespace['all_transactions'][0]


class Form4DatesTest(unittest.TestCase):
    def test_missing_execution_date_stays_unknown_while_publication_date_is_preserved(self):
        row = collect_transaction(None)
        self.assertIsNone(row['date'])
        self.assertEqual(row['fileDate'], '2026-10-08')
        self.assertEqual(row['value'], 1000)

    def test_observed_execution_date_is_not_replaced_by_the_later_publication_date(self):
        row = collect_transaction('2026-09-01')
        self.assertEqual(row['date'], '2026-09-01')
        self.assertEqual(row['fileDate'], '2026-10-08')

    def test_output_ordering_accepts_unknown_execution_dates(self):
        records = [collect_transaction(None), collect_transaction('2026-09-01')]
        sort_call = next(node for node in ast.walk(TREE)
                         if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                         and isinstance(node.func.value, ast.Name)
                         and node.func.value.id == 'all_transactions' and node.func.attr == 'sort')
        operation = ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=sort_call)], type_ignores=[]))
        exec(compile(operation, str(SCRIPT), 'exec'), {'all_transactions': records})
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]['date'], '2026-09-01')
        self.assertIsNone(records[1]['date'])


if __name__ == '__main__':
    unittest.main()
