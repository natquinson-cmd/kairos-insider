"""Evidence-based insider transaction classification shared by collectors.

SEC P describes a reported purchase, not an investor's motivation. Compensation
and employee-plan evidence is kept separately so it cannot become a buy signal.
Only transaction-linked footnotes belong here; never scan filing-wide remarks.
"""
import html
import json
import math
import re
import unicodedata
import xml.etree.ElementTree as ET


EVIDENCE_FIELDS = ('code', 'transactionCode', 'transCode', 'trans_code', 'nature', 'nature_raw', 'transactionNature', 'ad',
                   'securityTitle', 'security_title', 'instrument', 'security', 'securityType', 'security_type', 'isDerivative', 'transactionFootnotes',
                   'form10b5One', 'purchaseSignalEligible', 'purchaseSignalReason',
                   'currency', 'currencySource', 'currencyFootnoteIds', 'sourceUrl')
CODE_FIELDS = ('code', 'transactionCode', 'transCode', 'trans_code')
CODE_REASONS = {'A': 'grant', 'G': 'gift', 'M': 'exercise', 'X': 'exercise',
                'O': 'exercise', 'C': 'conversion', 'F': 'tax-withholding',
                **{code: 'not-purchase' for code in ('D', 'I', 'J', 'W', 'Z', 'L', 'U', 'E', 'H')}}
EXCLUSIONS = (
    ('grant', r'\b(?:actions? gratuites?|acquisition gratuite|attribution(?:s)?(?: gratuite(?:s)?)?|free shares?|stock awards?|share awards?|restricted stock units?|rsus?|performance share awards?|aktienzuteilung)\b'),
    ('gift', r'\b(?:gifts?|donation|don manuel|schenkung|schenkungen)\b'),
    ('exercise', r'\b(?:(?:exercise|exercised|exercising|exercice|levee|ausubung)\b.{0,45}\b(?:options?|warrants?|stock appreciation rights)|(?:options?|warrants?)\b.{0,35}\b(?:exercise|exercised|exercice|ausubung))\b'),
    ('conversion', r'\b(?:conversion|converted|umwandlung)\b.{0,45}\b(?:securit(?:y|ies)|shares?|stock|actions?|options?|titres?|obligations?)\b'),
    ('tax-withholding', r'\b(?:tax withholding|withheld.{0,30}(?:tax|exercise price)|withholding.{0,30}tax|sell.to.cover|retenue.{0,30}(?:fiscale|impot)|paiement.{0,25}(?:impot|prix d.exercice))\b'),
    ('employee-plan', r'\b(?:espp|fcpe|employee (?:stock|share) (?:purchase|ownership) (?:plans?|schemes?)|employee (?:stock|share|equity|savings|compensation) plans?|(?:stock|share|equity) (?:incentive|compensation) plans?|stock purchase plan for employees|salary sacrifice|plan d.epargne (?:d.entreprise|entreprise|salariale|groupe)|plan d.actionnariat salarie|mitarbeiteraktien\w*|belegschaftsaktien\w*)\b'),
    ('mandatory-acquisition', r'\b(?:(?:mandatory|compulsory|required|obligatoire)\s+(?:share |stock )?(?:purchase|acquisition|subscription)|(?:achat|acquisition|souscription)\s+obligatoire)\b'),
)


def _text(value):
    if not isinstance(value, str):
        return ''
    return ' '.join(html.unescape(value).split())


def _normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', _text(value).lower())
                   if not unicodedata.combining(c)).replace('’', "'")


def raw_code(row):
    return next((_text(row.get(key)) for key in CODE_FIELDS if _text(row.get(key))), '')


def classify_transaction(row):
    """Return display type plus conservative eligibility, preserving source facts."""
    code = raw_code(row)
    codes = [_text(row.get(key)) for key in CODE_FIELDS if _text(row.get(key))]
    broad = _normalized(row.get('type') or row.get('transType') or row.get('trans_type'))
    upper = code.upper()
    nature = [_text(row.get(k)) for k in ('nature', 'nature_raw', 'transactionNature')]
    operation = '\n'.join(codes + nature)
    security = ' '.join(_text(row.get(k)) for k in ('securityTitle', 'security_title', 'instrument', 'security', 'securityType', 'security_type'))
    linked = row.get('transactionFootnotes')
    notes = ' '.join(_text(n.get('text')) if isinstance(n, dict) else _text(n)
                     for n in linked) if isinstance(linked, list) else ''
    evidence = _normalized(' '.join((operation, notes)))
    source = _normalized(row.get('source'))
    is_purchase = upper == 'P'
    is_sale = upper == 'S'
    op = _normalized(operation)
    if source not in ('sec', 'edgar'):
        is_purchase |= bool(re.match(r'^(?:acquisitions?|achats?|souscription|subscription|kauf|ankauf|erwerb)\b', op))
        is_sale |= bool(re.match(r'^(?:cession|vente|verkauf|verausserung)\b', op))
    reason = next((CODE_REASONS[c.upper()] for c in codes if c.upper() in CODE_REASONS), None)
    if not reason:
        reason = next((reason for reason, pattern in EXCLUSIONS if re.search(pattern, evidence)), None)
    if not reason and op.strip() in ('exercice', 'exercise', 'ausubung'):
        reason = 'exercise'
    if not reason and (row.get('isDerivative') is True or re.search(r'\b(?:options?|warrants?|rsus?|restricted stock units?|derivative|derivatives|derives?|convertible (?:notes?|bonds?|securities)|performance (?:share|stock) units?)\b', _normalized(security + ' ' + operation).replace('non-derivative', ''))):
        reason = 'derivative-security'
    if not reason and broad in ('grant', 'award', 'gift', 'exercise', 'option-exercise', 'conversion'):
        reason = {'award': 'grant', 'option-exercise': 'exercise'}.get(broad, broad)
    if reason:
        display = 'buy' if is_purchase and reason in ('employee-plan', 'mandatory-acquisition') else 'other'
        return {'type': display, 'purchaseSignalEligible': False, 'purchaseSignalReason': reason}
    directions = set('buy' if c.upper() == 'P' or re.match(r'^(?:acquisitions?|achats?|souscription|subscription|kauf|ankauf|erwerb)\b', _normalized(c))
                     else 'sell' if c.upper() == 'S' or re.match(r'^(?:cession|vente|verkauf|verausserung)\b', _normalized(c))
                     else 'unknown' for c in codes)
    if len(directions) > 1:
        return {'type': 'other', 'purchaseSignalEligible': False,
                'purchaseSignalReason': 'conflicting-direction' if {'buy', 'sell'} <= directions else 'unknown'}
    ad = _text(row.get('ad') or row.get('adType') or row.get('transactionAcquiredDisposedCode') or row.get('acquiredDisposed') or row.get('acquiredDisposedCode')).upper()
    if is_purchase and (ad == 'D' or any(re.match(r'^(?:cession|vente|verkauf)\b', _normalized(n)) for n in nature)):
        return {'type': 'other', 'purchaseSignalEligible': False, 'purchaseSignalReason': 'conflicting-direction'}
    if is_purchase and row.get('purchaseSignalEligible') is False:
        return {'type': 'buy', 'purchaseSignalEligible': False,
                'purchaseSignalReason': _text(row.get('purchaseSignalReason')) or 'unknown'}
    if is_purchase:
        return {'type': 'buy', 'purchaseSignalEligible': True, 'purchaseSignalReason': 'reported-purchase'}
    if is_sale or not code and broad in ('s', 'sell', 'sale', 'vente'):
        return {'type': 'sell', 'purchaseSignalEligible': False, 'purchaseSignalReason': 'not-purchase'}
    return {'type': 'buy' if not code and broad in ('p', 'buy', 'purchase', 'achat') else 'other',
            'purchaseSignalEligible': False, 'purchaseSignalReason': 'unknown'}


def transaction_evidence(row):
    """Bounded evidence object for KV/D1; never copy a filing-wide notes field."""
    result = {key: row[key] for key in EVIDENCE_FIELDS if key in row}
    if raw_code(row):
        result['code'] = raw_code(row)
    result.update({key: value for key, value in classify_transaction(row).items() if key != 'type'})
    return result


def evidence_json(row):
    return json.dumps(transaction_evidence(row), ensure_ascii=False, separators=(',', ':'))


def history_evidence_upsert():
    """Enrich an identical referenced D1 row, with no writes for unchanged data.

    Type belongs to the existing primary key. This deliberately does not guess
    matches across type partitions or overwrite a different economic line.
    """
    table = 'insider_transactions_history'
    return (
        ' ON CONFLICT(source,accession,cik,insider,trans_date,trans_type,line_num) DO UPDATE SET '
        'trans_code=excluded.trans_code,transaction_evidence=excluded.transaction_evidence '
        "WHERE excluded.accession IS NOT NULL AND excluded.accession != '' AND excluded.trans_code IS NOT NULL "
        + ''.join(f'AND {table}.{field} IS excluded.{field} ' for field in ('ticker', 'shares', 'price', 'value', 'shares_after'))
        + f'AND ({table}.trans_code IS NOT excluded.trans_code OR {table}.transaction_evidence IS NOT excluded.transaction_evidence) '
        + "AND (json_type(excluded.transaction_evidence,'$.transactionFootnotes') IS NOT NULL "
        + f"OR json_type(CASE WHEN json_valid({table}.transaction_evidence) THEN {table}.transaction_evidence ELSE '{{}}' END,'$.transactionFootnotes') IS NULL)"
    )


def sec_price_currency(price_notes):
    """Read an explicit native currency only from notes attached to the price.

    SEC jurisdiction and the issuer's country/ticker are not currency evidence.
    Conflicting currencies (for example a conversion) remain unresolved. A bare
    dollar sign is intentionally ambiguous; no amount is converted here.
    """
    aliases = {
        'BRL': r'\b(?:BRL|Brazilian reai?s|Brazilian real)\b',
        'USD': r'\b(?:USD|U\.?\s?S\.?\s+dollars?|United States dollars?)\b',
        'EUR': r'\b(?:EUR|euros?)\b',
        'GBP': r'\b(?:GBP|British pounds?|pounds? sterling)\b',
        'CAD': r'\b(?:CAD|Canadian dollars?)\b',
        'AUD': r'\b(?:AUD|Australian dollars?)\b',
        'HKD': r'\b(?:HKD|Hong Kong dollars?)\b',
        'JPY': r'\b(?:JPY|Japanese yen)\b',
        'CHF': r'\b(?:CHF|Swiss francs?)\b',
        'CNY': r'\b(?:CNY|RMB|Chinese yuan|renminbi)\b',
        'INR': r'\b(?:INR|Indian rupees?)\b',
        'KRW': r'\b(?:KRW|South Korean won|Korean won)\b',
        'MXN': r'\b(?:MXN|Mexican pesos?)\b',
        'SGD': r'\b(?:SGD|Singapore dollars?)\b',
        'TWD': r'\b(?:TWD|New Taiwan dollars?)\b',
        'SEK': r'\b(?:SEK|Swedish kron[ao]r?)\b',
        'NOK': r'\b(?:NOK|Norwegian kron[ae]r?)\b',
        'DKK': r'\b(?:DKK|Danish kron[ae]r?)\b',
        'ILS': r'\b(?:ILS|Israeli (?:new )?shekels?)\b',
        'ZAR': r'\b(?:ZAR|South African rand)\b',
    }
    found = {}
    explicit = set()
    for note in price_notes:
        text = _text(note.get('text'))
        for code, pattern in aliases.items():
            if re.search(pattern, text, re.I):
                found.setdefault(code, []).append(note['id'])
                # A currency mentioned in another context is not a statement
                # about this price, even inside its attached footnote.
                if not re.search(r'\b(?:not|except|excluding|other than)\b', text, re.I) and (
                        re.fullmatch(r'\W*' + pattern + r'\W*', text, re.I)
                        or re.search(r'\b(?:prices?|amounts?)\b[^;\n]{0,80}\b(?:in|denominated|reported|expressed|stated|quoted)\b[^;\n]{0,30}' + pattern, text, re.I)):
                    explicit.add(code)
    if len(found) != 1 or set(found) != explicit:
        return {}
    code, ids = next(iter(found.items()))
    return {'currency': code, 'currencySource': 'sec-price-footnote',
            'currencyFootnoteIds': list(dict.fromkeys(ids))}


def parse_form4_document(xml, now_str, source_url=None):
    """Parse Table I only and attach each line's referenced footnotes."""
    empty = {'ticker': '', 'company': '', 'owner': '', 'ownerCik': '', 'title': '', 'transactions': []}
    try:
        root = ET.fromstring(xml)
    except (ET.ParseError, TypeError):
        return empty
    # EDGAR documents may carry a namespace. Local element names are stable.
    for element in root.iter():
        element.tag = element.tag.rsplit('}', 1)[-1]

    def text(parent, path):
        node = parent.find(path)
        return _text(''.join(node.itertext())) if node is not None else ''

    def number(parent, path):
        try:
            value = float(text(parent, path) or 0)
            return value if math.isfinite(value) else 0
        except ValueError:
            return 0

    flag = text(root, './/aff10b5One').lower()
    planned = True if flag in ('1', 'true') else False if flag in ('0', 'false') else None
    footnotes = {n.get('id'): _text(''.join(n.itertext())) for n in root.findall('.//footnote') if n.get('id')}
    rows = []
    for block in root.findall('.//nonDerivativeTransaction'):
        shares = number(block, './/transactionShares/value')
        price = number(block, './/transactionPricePerShare/value')
        date = text(block, './/transactionDate/value')
        if shares <= 0 or date and date > now_str:
            continue
        ids = list(dict.fromkeys(n.get('id') for n in block.findall('.//footnoteId') if n.get('id')))
        price_ids = list(dict.fromkeys(n.get('id') for n in block.findall('.//transactionPricePerShare//footnoteId') if n.get('id')))
        price_notes = [{'id': key, 'text': footnotes[key]} for key in price_ids if key in footnotes]
        row = {'date': date, 'code': text(block, './/transactionCode'),
               'ad': text(block, './/transactionAcquiredDisposedCode/value'),
               'securityTitle': text(block, './/securityTitle/value'),
               'transactionFootnotes': [{'id': key, 'text': footnotes[key]} for key in ids if key in footnotes],
               'form10b5One': planned, 'shares': round(shares), 'price': round(price, 2),
               'value': round(shares * price, 2),
               'sharesAfter': round(number(block, './/sharesOwnedFollowingTransaction/value'))}
        row.update(sec_price_currency(price_notes))
        if isinstance(source_url, str) and re.fullmatch(r'https://(?:www\.)?sec\.gov/Archives/[^?#\s]+', source_url):
            row['sourceUrl'] = source_url
        row.update(classify_transaction(dict(row, source='sec')))
        rows.append(row)
    return {'ticker': text(root, './/issuerTradingSymbol'), 'company': text(root, './/issuerName'),
            'owner': text(root, './/rptOwnerName'), 'ownerCik': text(root, './/rptOwnerCik').lstrip('0'),
            'title': text(root, './/officerTitle'), 'transactions': rows}
