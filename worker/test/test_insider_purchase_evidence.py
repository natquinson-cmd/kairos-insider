import ast
import io
import json
import os
import re
import sqlite3
import sys
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER))
NOW = '2026-10-08'
FREE_SHARES = "Acquisition définitive d'actions gratuites (livraison)"


def definitions(filename, **extra):
    """Load real parsers/writers without starting collection, downloads or uploads."""
    path = WORKER / filename
    tree = ast.parse(path.read_text(encoding='utf-8'))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             or isinstance(node, ast.Assign) and any(isinstance(t, ast.Name)
                 and (t.id.startswith('RE_') or t.id in ('OP_TO_TYPE', 'MONTHS_FR')) for t in node.targets)]
    env = dict(re=re, io=io, json=json, os=os, sys=sys, datetime=datetime,
               now=datetime.fromisoformat(NOW), TODAY=NOW, INSERT_VERB='INSERT OR IGNORE')
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), env)
    env.update(extra)
    return env


def transaction_xml(code='P', footnote='F1', ad='A'):
    return f'''<nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-10-07</value></transactionDate>
      <transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100</value><footnoteId id="{footnote}"/></transactionShares>
        <transactionPricePerShare><value>10</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>{ad}</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>200</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>'''


def form_xml(transactions, notes=None):
    notes = notes or {'F1': 'Open market purchase with personal funds.',
                      'F2': 'Shares purchased pursuant to the Employee Stock Purchase Plan (ESPP).',
                      'F3': 'Shares awarded under a restricted stock unit award.'}
    return '<ownershipDocument><aff10b5One>1</aff10b5One><issuerTradingSymbol>TEST</issuerTradingSymbol>' \
        '<issuerName>Example</issuerName><rptOwnerName>Alice</rptOwnerName><rptOwnerCik>00123</rptOwnerCik>' \
        '<nonDerivativeTable>' + transactions + '</nonDerivativeTable><footnotes>' + ''.join(
            f'<footnote id="{key}">{value}</footnote>' for key, value in notes.items()
        ) + '</footnotes></ownershipDocument>'


def history_database():
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE insider_transactions_history (filing_date,trans_date,source,accession,cik,ticker,company,insider,insider_cik,title,trans_type,trans_code,shares,price,value,shares_after,line_num,transaction_evidence, PRIMARY KEY(source,accession,cik,insider,trans_date,trans_type,line_num))')
    return db


def history_statements(rows):
    env = definitions('push-insiders-to-d1.py', CANDIDATE_FILES=[('fixture.json', None)])
    with patch('os.path.exists', return_value=True), patch('builtins.open', return_value=io.StringIO(json.dumps({'transactions': rows}))):
        return env['collect_inserts']()


class PurchaseEvidenceTest(unittest.TestCase):
    def sec_rows(self, xml):
        for filename in ('prefetch-all.py', 'prefetch-transactions.py', 'backfill-insiders-history.py'):
            parser = definitions(filename)['parse_form4']
            yield filename, parser(xml, NOW) if filename != 'prefetch-transactions.py' else parser(xml)

    def test_sec_employee_plan_does_not_become_a_purchase_signal(self):
        xml = form_xml(transaction_xml(footnote='F2'))
        for filename, parsed in self.sec_rows(xml):
            with self.subTest(filename=filename):
                row = parsed['transactions'][0]
                self.assertEqual(row['type'], 'buy')
                self.assertFalse(row['purchaseSignalEligible'])
                self.assertEqual(row['purchaseSignalReason'], 'employee-plan')
                self.assertEqual(row['code'], 'P')

    def test_linked_footnotes_do_not_contaminate_a_separate_purchase(self):
        xml = form_xml(transaction_xml() + transaction_xml('A', 'F3'))
        for filename, parsed in self.sec_rows(xml):
            with self.subTest(filename=filename):
                buy, award = parsed['transactions']
                self.assertEqual(buy['type'], 'buy')
                self.assertTrue(buy.get('purchaseSignalEligible'))
                self.assertEqual(buy.get('securityTitle'), 'Common Stock')
                self.assertEqual(buy.get('transactionFootnotes'), [{'id': 'F1', 'text': 'Open market purchase with personal funds.'}])
                self.assertTrue(buy.get('form10b5One'))
                self.assertFalse(award.get('purchaseSignalEligible'))

    def test_sec_price_footnote_preserves_native_currency_without_converting_amounts(self):
        # BBD filings 0001292814-26-004850 / 004852 attach F1 to the price,
        # with the complete note "Brazilian reais" (optionally a final period).
        line = transaction_xml(footnote='F2').replace(
            '<transactionPricePerShare><value>10</value></transactionPricePerShare>',
            '<transactionPricePerShare><value>17.14</value><footnoteId id="F1"/></transactionPricePerShare>')
        for note in ('Brazilian reais', 'Brazilian reais.'):
            for filename, parsed in self.sec_rows(form_xml(line, {'F1': note, 'F2': 'Open market purchase.'})):
                with self.subTest(filename=filename, note=note):
                    row = parsed['transactions'][0]
                    self.assertEqual(row.get('currency'), 'BRL')
                    self.assertEqual(row.get('currencySource'), 'sec-price-footnote')
                    self.assertEqual(row.get('currencyFootnoteIds'), ['F1'])
                    self.assertEqual(row['price'], 17.14)
                    self.assertEqual(row['value'], 1714)
                    self.assertTrue(row['purchaseSignalEligible'])

    def test_sec_currency_requires_unambiguous_price_linked_evidence(self):
        from insider_transaction import parse_form4_document
        price_linked = transaction_xml().replace(
            '<transactionPricePerShare><value>10</value></transactionPricePerShare>',
            '<transactionPricePerShare><value>10</value><footnoteId id="F2"/></transactionPricePerShare>')
        cases = [
            (form_xml(transaction_xml(), {'F1': 'Brazilian reais'}), None),
            (form_xml(price_linked, {'F1': 'Open market.', 'F2': '$10 per share.'}), None),
            (form_xml(price_linked, {'F1': 'Open market.', 'F2': 'BRL 10, equivalent to USD 2.'}), None),
            (form_xml(price_linked, {'F1': 'Open market.', 'F2': 'The broker also holds an account in USD.'}), None),
            (form_xml(price_linked, {'F1': 'Open market.', 'F2': 'The price is not denominated in USD.'}), None),
            (form_xml(price_linked, {'F1': 'Open market.', 'F2': 'The price is stated in U.S. dollars.'}), 'USD'),
            (form_xml(price_linked, {'F1': 'Open market.', 'F2': 'Price reported in EUR.'}), 'EUR'),
        ]
        for xml, expected in cases:
            row = parse_form4_document(xml, NOW)['transactions'][0]
            with self.subTest(expected=expected, xml=xml):
                self.assertEqual(row.get('currency'), expected)
                if expected is None:
                    self.assertNotIn('currencySource', row)

    def test_collection_paths_keep_sec_source_url_and_currency_in_history_evidence(self):
        from insider_transaction import evidence_json
        source = 'https://www.sec.gov/Archives/edgar/data/999/000000099926000001/form4.xml'
        xml = form_xml(transaction_xml()).replace(
            '<transactionPricePerShare><value>10</value></transactionPricePerShare>',
            '<transactionPricePerShare><value>10</value><footnoteId id="F2"/></transactionPricePerShare>')
        xml = xml.replace('Shares purchased pursuant to the Employee Stock Purchase Plan (ESPP).', 'Brazilian reais.')
        for filename in ('prefetch-all.py', 'prefetch-transactions.py', 'backfill-insiders-history.py'):
            parser = definitions(filename)['parse_form4']
            parsed = parser(xml, source_url=source) if filename == 'prefetch-transactions.py' else parser(xml, NOW, source_url=source)
            row = parsed['transactions'][0]
            with self.subTest(filename=filename):
                self.assertEqual(row['sourceUrl'], source)
                evidence = json.loads(evidence_json(row))
                self.assertEqual(evidence['sourceUrl'], source)
                self.assertEqual(evidence['currency'], 'BRL')
                self.assertEqual(evidence['securityTitle'], 'Common Stock')
                self.assertEqual(evidence['currencyFootnoteIds'], ['F2'])
        env = definitions('backfill-insiders-history.py', fetch=lambda _: xml)
        hit = {'_source': {'ciks': ['123', '999'], 'file_date': NOW,
                         'display_names': ['Alice (CIK 123)', 'Example (CIK 999)']},
               '_id': '0000000999-26-000001:form4.xml'}
        evidence = json.loads(env['_process_filing'](hit, NOW, NOW)[0]['transaction_evidence'])
        self.assertEqual(evidence['sourceUrl'], source)
        self.assertEqual(evidence['currency'], 'BRL')

    def test_price_note_conflicts_remain_unknown_and_only_explicit_notes_support_currency(self):
        from insider_transaction import sec_price_currency
        self.assertEqual(sec_price_currency([
            {'id': 'F1', 'text': 'USD'},
            {'id': 'F2', 'text': 'The price is not denominated in USD.'},
        ]), {})
        self.assertEqual(sec_price_currency([
            {'id': 'F1', 'text': 'USD'},
            {'id': 'F2', 'text': 'Canadian dollars.'},
        ]), {})
        evidence = sec_price_currency([
            {'id': 'F1', 'text': 'The price is reported in Canadian dollars.'},
            {'id': 'F2', 'text': 'The broker also holds an account in CAD.'},
        ])
        self.assertEqual(evidence['currency'], 'CAD')
        self.assertEqual(evidence['currencyFootnoteIds'], ['F1'])

    def test_explicit_sec_currency_survives_the_existing_merge_and_history_writer(self):
        from insider_transaction import parse_form4_document
        line = transaction_xml().replace(
            '<transactionPricePerShare><value>10</value></transactionPricePerShare>',
            '<transactionPricePerShare><value>10</value><footnoteId id="F2"/></transactionPricePerShare>')
        parsed = parse_form4_document(form_xml(line, {'F1': 'Open market.', 'F2': 'Brazilian reais'}), NOW)
        row = dict(parsed['transactions'][0], insider='Alice', ticker='BBD', cik='123', adsh='filing', fileDate=NOW)
        definitions('merge-sources.py')['tag_sec_rows']([row])
        self.assertEqual(row['currency'], 'BRL')
        db = history_database()
        for statement in history_statements([row]):
            db.execute(statement)
        evidence = json.loads(db.execute('SELECT transaction_evidence FROM insider_transactions_history').fetchone()[0])
        self.assertEqual(evidence['currency'], 'BRL')

    def test_full_collection_row_retains_evidence_from_the_parser(self):
        path = WORKER / 'prefetch-all.py'
        tree = ast.parse(path.read_text(encoding='utf-8'))
        append = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                      and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                      and node.func.value.id == 'all_transactions' and node.func.attr == 'append')
        env = definitions('prefetch-all.py')
        parsed = env['parse_form4'](form_xml(transaction_xml(footnote='F2')), NOW)
        env.update(tx=parsed['transactions'][0], parsed=parsed, all_transactions=[], file_date=NOW,
                   company_cik='999', parsed_ticker='TEST', parsed_title='', company_name_meta='Example',
                   insider_name='Alice', adsh='test-filing')
        assembly = ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=append)], type_ignores=[]))
        exec(compile(assembly, str(path), 'exec'), env)
        row = env['all_transactions'][0]
        self.assertEqual(row['transactionFootnotes'][0]['id'], 'F2')
        self.assertEqual(row['securityTitle'], 'Common Stock')
        self.assertFalse(row['purchaseSignalEligible'])

    def test_historical_filing_path_persists_employee_plan_evidence(self):
        env = definitions('backfill-insiders-history.py', fetch=lambda _: form_xml(transaction_xml(footnote='F2')))
        hit = {'_source': {'ciks': ['123', '999'], 'file_date': NOW,
                         'display_names': ['Alice (CIK 123)', 'Example (CIK 999)']},
               '_id': '0000000999-26-000001:form4.xml'}
        rows = env['_process_filing'](hit, NOW, NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['trans_type'], 'other')
        evidence = json.loads(rows[0]['transaction_evidence'])
        self.assertEqual(evidence['code'], 'P')
        self.assertEqual(evidence['purchaseSignalReason'], 'employee-plan')

    def test_all_collection_paths_keep_missing_execution_dates_unknown(self):
        xml = form_xml(transaction_xml()).replace('<transactionDate><value>2026-10-07</value></transactionDate>', '')
        for filename in ('prefetch-all.py', 'prefetch-transactions.py'):
            path = WORKER / filename
            tree = ast.parse(path.read_text(encoding='utf-8'))
            append = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                          and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                          and node.func.value.id == 'all_transactions' and node.func.attr == 'append')
            env = definitions(filename)
            parsed = env['parse_form4'](xml, NOW) if filename == 'prefetch-all.py' else env['parse_form4'](xml)
            env.update(tx=parsed['transactions'][0], parsed=parsed, all_transactions=[], file_date=NOW,
                       company_cik='999', parsed_ticker='TEST', parsed_title='', company_name_meta='Example',
                       insider_name='Alice', adsh='test-filing')
            assembly = ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=append)], type_ignores=[]))
            exec(compile(assembly, str(path), 'exec'), env)
            with self.subTest(filename=filename):
                self.assertIsNone(env['all_transactions'][0]['date'])
                self.assertEqual(env['all_transactions'][0]['fileDate'], NOW)
        env = definitions('backfill-insiders-history.py', fetch=lambda _: xml)
        hit = {'_source': {'ciks': ['123', '999'], 'file_date': NOW,
                         'display_names': ['Alice (CIK 123)', 'Example (CIK 999)']},
               '_id': '0000000999-26-000001:form4.xml'}
        row = env['_process_filing'](hit, NOW, NOW)[0]
        self.assertEqual(row['trans_date'], '')
        self.assertEqual(row['file_date'], NOW)

    def test_history_writer_does_not_substitute_publication_for_missing_execution(self):
        row = dict(insider='Alice', ticker='TEST', cik='123', source='sec', date=None,
                   fileDate=NOW, type='buy', code='P', shares=100, price=10, value=1000)
        db = history_database()
        for statement in history_statements([row]):
            db.execute(statement)
        self.assertEqual(db.execute('SELECT trans_date,filing_date FROM insider_transactions_history').fetchone(), ('', NOW))

    def test_merge_sort_accepts_unknown_execution_dates(self):
        path = WORKER / 'merge-sources.py'
        tree = ast.parse(path.read_text(encoding='utf-8'))
        sorts = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                 and node.func.value.id == 'combined' and node.func.attr == 'sort']
        env = {'combined': [{'fileDate': NOW, 'date': None}, {'fileDate': NOW, 'date': '2026-09-01'}]}
        for sort in sorts:
            operation = ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=sort)], type_ignores=[]))
            exec(compile(operation, str(path), 'exec'), env)
        self.assertIsNone(env['combined'][1]['date'])

    def test_cash_bonus_and_filing_wide_remarks_are_not_transaction_mechanisms(self):
        from insider_transaction import classify_transaction
        for row in ({'code': 'P', 'securityTitle': 'Bonus Group Common Stock'},
                    {'code': 'P', 'transactionFootnotes': [{'id': 'F1', 'text': 'Purchased with cash saved from a cash bonus.'}]},
                    {'code': 'P', 'remarks': 'Other transactions include gifts and an employee stock purchase plan.'}):
            with self.subTest(row=row):
                self.assertTrue(classify_transaction(row)['purchaseSignalEligible'])

    def test_aliases_known_european_purchases_and_unknown_buy_labels(self):
        from insider_transaction import classify_transaction
        for field in ('code', 'transCode', 'transactionCode', 'trans_code'):
            self.assertFalse(classify_transaction({field: 'M', 'type': 'buy'})['purchaseSignalEligible'])
        for source, code in (('amf', 'Acquisition'), ('bafin', 'Kauf'), ('bafin', 'Erwerb')):
            self.assertTrue(classify_transaction({'source': source, 'code': code})['purchaseSignalEligible'])
        self.assertFalse(classify_transaction({'source': 'sec', 'type': 'buy'})['purchaseSignalEligible'])

    def test_conflicting_code_aliases_never_supply_purchase_evidence(self):
        from insider_transaction import classify_transaction
        for row in ({'code': 'P', 'transCode': 'M'}, {'code': 'P', 'transactionCode': 'S'},
                    {'code': 'P', 'trans_code': 'Unknown acquisition'}, {'type': 'P'}):
            with self.subTest(row=row):
                self.assertFalse(classify_transaction(row)['purchaseSignalEligible'])

    def test_known_compensation_plans_and_derivative_aliases_are_excluded(self):
        from insider_transaction import classify_transaction
        for row in ({'code': 'P', 'security_type': 'Derivative'},
                    {'code': 'P', 'isDerivative': True},
                    {'code': 'P', 'transactionFootnotes': [{'id': 'F1', 'text': 'Acquired pursuant to the equity incentive plan.'}]}):
            with self.subTest(row=row):
                self.assertFalse(classify_transaction(row)['purchaseSignalEligible'])

    def test_conflicting_disposal_and_missing_purchase_code_are_not_buy_evidence(self):
        for xml in (form_xml(transaction_xml(ad='D')), form_xml(transaction_xml(code=''))):
            for filename, parsed in self.sec_rows(xml):
                with self.subTest(filename=filename, xml=xml):
                    self.assertNotEqual(parsed['transactions'][0]['type'], 'buy')

    def test_legacy_amf_does_not_infer_a_purchase_from_acquisition_or_css_alone(self):
        normalize = definitions('fetch-amf.py')['normalize_type']
        for nature in (FREE_SHARES, "Acquisition par exercice d'options", 'Donation', 'Inconnue'):
            with self.subTest(nature=nature):
                self.assertNotEqual(normalize(nature, 'quote_up'), 'buy')
        self.assertEqual(normalize('Acquisition', 'quote_up'), 'buy')
        self.assertEqual(normalize('Cession', 'quote_down'), 'sell')

    def test_official_amf_ipsos_free_share_delivery_is_not_a_purchase(self):
        text = f'''FR0000073298 - IPSOS
NOM /FONCTION DE LA PERSONNE EXERÇANT DES RESPONSABILITES DIRIGEANTES :
Olivier Champourlier, Membre du Comité Exécutif
COORDONNEES DE L'EMETTEUR
NOM : IPSOS
LEI : 9695002OY2X35E9X8W87
DATE DE LA TRANSACTION : 16 mai 2026
NATURE DE LA TRANSACTION : {FREE_SHARES}
DESCRIPTION DE L'INSTRUMENT FINANCIER : Action
INFORMATIONS AGREGEES
PRIX : 36.4800 Euro
VOLUME : 1200.0000
'''
        # Replace only PDF decoding; the real field extraction/classification runs.
        reader = lambda _: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text)])
        parsed = definitions('fetch-amf-dd.py', PdfReader=reader)['parse_amf_dd_pdf'](b'pdf-boundary')
        self.assertIsNotNone(parsed)
        self.assertNotIn(parsed['type'], ('P', 'buy'))
        self.assertEqual(parsed['nature_raw'], FREE_SHARES)
        self.assertEqual(parsed['value'], 43776)

    def test_bafin_employee_plan_is_excluded_before_kauf(self):
        normalize = definitions('fetch-bafin.py')['type_from_geschaeft']
        self.assertEqual(normalize('Kauf'), 'buy')
        self.assertEqual(normalize('Verkauf'), 'sell')
        # The operation remains a purchase for display, but is not a signal.
        from insider_transaction import classify_transaction
        self.assertFalse(classify_transaction({'source': 'bafin', 'code': 'Kauf im Rahmen eines Mitarbeiteraktienprogramms'})['purchaseSignalEligible'])

    def test_d1_keeps_nature_and_exclusion_evidence_without_uploading(self):
        rows = [dict(insider='Alice', ticker='IPS', cik='AMF_FR0000073298', source='amf',
                     date='2026-05-16', fileDate='2026-05-21', type='P', code=FREE_SHARES, value=43776, shares=1200, price=36.48),
                dict(insider='Bob', ticker='TEST', cik='123', source='sec', date=NOW, fileDate=NOW,
                     type='buy', code='P', shares=100, price=10, value=1000, securityTitle='Common Stock',
                     transactionFootnotes=[{'id': 'F2', 'text': 'Purchased under the Employee Stock Purchase Plan.'}], form10b5One=True),
                dict(insider='Carol', ticker='TEST', cik='123', source='sec', date=NOW, fileDate=NOW,
                     type='buy', shares=100, price=10, value=1000)]
        # The collector itself and emitted SQL are real; only local input IO is replaced.
        db = history_database()
        for statement in history_statements(rows):
            db.execute(statement)
        output = db.execute('SELECT insider,trans_type,trans_code,transaction_evidence FROM insider_transactions_history ORDER BY insider').fetchall()
        self.assertEqual([r[1] for r in output], ['other', 'other', 'other'])
        self.assertEqual(output[0][2], FREE_SHARES)
        evidence = json.loads(output[1][3])
        self.assertEqual(evidence['transactionFootnotes'][0]['id'], 'F2')
        self.assertTrue(evidence['form10b5One'])
        self.assertFalse(evidence['purchaseSignalEligible'])

    def test_identical_history_key_receives_evidence_once_and_cannot_be_downgraded(self):
        row = dict(insider='Alice', ticker='TEST', cik='123', source='sec', adsh='0000000123-26-000001',
                   date=NOW, fileDate=NOW, type='buy', code='P', shares=100, price=10, value=1000, sharesAfter=200)
        db = history_database()
        for statement in history_statements([row]):
            db.execute(statement)
        richer = dict(row, transactionFootnotes=[{'id': 'F1', 'text': 'Open market purchase.'}], securityTitle='Common Stock', form10b5One=False)
        enriched_sql = history_statements([richer])
        for statement in enriched_sql:
            db.execute(statement)
        evidence = json.loads(db.execute('SELECT transaction_evidence FROM insider_transactions_history').fetchone()[0])
        self.assertEqual(evidence.get('transactionFootnotes'), richer['transactionFootnotes'])
        writes = db.total_changes
        for statement in enriched_sql + history_statements([row]):
            db.execute(statement)
        self.assertEqual(db.total_changes, writes)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM insider_transactions_history').fetchone()[0], 1)

    def test_history_enrichment_never_overwrites_a_conflicting_economic_line(self):
        row = dict(insider='Alice', ticker='TEST', cik='123', source='sec', adsh='0000000123-26-000001',
                   date=NOW, fileDate=NOW, type='buy', code='P', shares=100, price=10, value=1000, sharesAfter=200)
        db = history_database()
        for statement in history_statements([row]):
            db.execute(statement)
        original = db.execute('SELECT transaction_evidence FROM insider_transactions_history').fetchone()[0]
        changed = dict(row, shares=200, value=2000, transactionFootnotes=[{'id': 'F1', 'text': 'Separate purchase.'}])
        for statement in history_statements([changed]):
            db.execute(statement)
        self.assertEqual(db.execute('SELECT shares,transaction_evidence FROM insider_transactions_history').fetchone(), (100, original))

    def test_cluster_builder_does_not_count_award_recipients_or_sellers_as_buyers(self):
        path = WORKER / 'prefetch-all.py'
        tree = ast.parse(path.read_text(encoding='utf-8'))
        start = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'company_insiders_full' for t in n.targets))
        end = next(i for i, n in enumerate(tree.body[start:], start) if isinstance(n, ast.Expr)
                   and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute)
                   and isinstance(n.value.func.value, ast.Name) and n.value.func.value.id == 'clusters'
                   and n.value.func.attr == 'sort')
        base = dict(cik='123', ticker='TEST', company='Example', date=NOW, fileDate=NOW,
                    shares=100, price=10, value=1000, source='sec')
        env = {'all_transactions': [dict(base, insider='Alice', type='buy', code='P'),
                                    dict(base, insider='Bob', type='other', code='M'),
                                    dict(base, insider='Carol', type='sell', code='S')]}
        exec(compile(ast.Module(body=tree.body[start:end], type_ignores=[]), str(path), 'exec'), env)
        self.assertEqual(env['clusters'], [])


if __name__ == '__main__':
    unittest.main()
