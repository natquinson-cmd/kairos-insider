CANONICAL_BY_CIK = {
    '0000019617': ('JPMORGAN CHASE & CO', 'JPMorgan Chase', 'Bank Asset Manager'),
    '0000914208': ('INVESCO LTD.', 'Invesco', 'Asset Manager'),
}


def normalize_cik(cik):
    digits = ''.join(ch for ch in str(cik or '') if ch.isdigit())
    return digits.zfill(10)[-10:] if digits else ''


def canonical_fund(cik, name, label, category):
    normalized = normalize_cik(cik)
    canonical = CANONICAL_BY_CIK.get(normalized)
    if canonical:
        name, label, category = canonical
    return normalized, name, label, category
