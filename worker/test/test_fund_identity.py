import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('fund_identity', ROOT / 'fund_identity.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FundIdentityTest(unittest.TestCase):
    def test_canonical_filer_identity_comes_from_cik(self):
        self.assertEqual(
            MODULE.canonical_fund('19617', 'Goldman Sachs Group', 'Goldman AM', 'Bank Asset Manager'),
            ('0000019617', 'JPMORGAN CHASE & CO', 'JPMorgan Chase', 'Bank Asset Manager'),
        )
        self.assertEqual(MODULE.canonical_fund('0000914208', '', 'Jean Hynes', '')[1], 'INVESCO LTD.')


if __name__ == '__main__':
    unittest.main()
