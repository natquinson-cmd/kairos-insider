"""
Helper pour logger la derniere execution d'un script pipeline dans KV CACHE.

Usage :
  from kv_lastrun import log_last_run
  # A la fin d'un script :
  log_last_run('prefetch-all', summary=f'{count} transactions')

  # Si le script a echoue :
  log_last_run('prefetch-all', status='failed', error=str(e))

Les payload sont lus par /api/admin/jobs pour afficher le statut dans
le tableau de bord admin (panel "Jobs & Cron").

Best-effort : si wrangler n'est pas dispo, le script continue sans erreur.
"""
import json
import subprocess
import time
from datetime import datetime

NAMESPACE_ID = 'aca7ff9d2a244b06ae92d6a7129b4cc4'


def _kv_put(key, value_str, timeout=30):
    """Helper interne : execute wrangler kv key put. Renvoie (ok, stderr_str)."""
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put',
             f'--namespace-id={NAMESPACE_ID}',
             '--remote',
             key,
             value_str],
            capture_output=True, timeout=timeout, shell=False
        )
        if result.returncode == 0:
            return True, ''
        err = result.stderr.decode('utf-8', errors='replace')[:200] if result.stderr else ''
        return False, err
    except subprocess.TimeoutExpired:
        return False, 'timeout'
    except Exception as e:
        return False, str(e)


def _kv_get(key, timeout=30):
    """Helper interne : execute wrangler kv key get. Renvoie (parsed_json, ok)."""
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'get',
             f'--namespace-id={NAMESPACE_ID}',
             '--remote',
             key],
            capture_output=True, timeout=timeout, shell=False
        )
        if result.returncode != 0:
            return None, False
        raw = result.stdout.decode('utf-8', errors='replace')
        if not raw.strip():
            return None, True
        return json.loads(raw), True
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return None, False


# Cap historique : 300 entries / job. Suffit pour :
# - cron quotidien : 300 jours
# - cron */30min : 6 jours
# - cron */5min : 25h (notre fenetre Gantt 24h, OK)
RUN_HISTORY_CAP = 300


def append_run_history(job_name, payload, max_entries=RUN_HISTORY_CAP):
    """Append a un historique de runs en KV pour le Gantt admin (24h+).
    Read-modify-write : pas atomique mais OK car les jobs ne tournent
    rarement en concurrence avec eux-memes."""
    try:
        existing, _ = _kv_get(f'runHistory:{job_name}', timeout=15)
        runs = []
        if existing and isinstance(existing, dict) and isinstance(existing.get('runs'), list):
            runs = existing['runs']
        # Prepend nouveau run au debut (head = most recent)
        runs.insert(0, payload)
        # Cap : on garde les MAX_ENTRIES plus recents
        if len(runs) > max_entries:
            runs = runs[:max_entries]
        new_doc = {
            'jobId': job_name,
            'updatedAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'count': len(runs),
            'runs': runs,
        }
        ok, err = _kv_put(f'runHistory:{job_name}', json.dumps(new_doc, separators=(',', ':')), timeout=30)
        if not ok:
            print(f'[kv_lastrun] WARN: append_run_history failed for {job_name}: {err}')
        return ok
    except Exception as e:
        print(f'[kv_lastrun] WARN: append_run_history {job_name}: {e}')
        return False


def log_last_run(job_name, status='ok', summary='', error='', duration_sec=None):
    """Ecrit le dernier run dans 'lastRun:{job}' ET append a 'runHistory:{job}'.

    Args:
        job_name : identifiant court du job (ex: 'prefetch-all')
        status   : 'ok' | 'failed' | 'partial'
        summary  : resume court (ex: '12345 tx, 500 insiders')
        error    : message d'erreur si status=failed
        duration_sec : duree en secondes (optionnel)

    Returns:
        True si AU MOINS le lastRun: a reussi (l'historique est best-effort).
    """
    payload = {
        'ts': int(time.time()),
        'iso': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'status': status,
        'summary': (summary or '')[:200],
        'error': (error or '')[:500],
    }
    if duration_sec is not None:
        payload['durationSec'] = round(float(duration_sec), 1)

    # 1. Ecrit lastRun:* (synchrone, prioritaire)
    ok, err = _kv_put(f'lastRun:{job_name}', json.dumps(payload), timeout=30)
    if not ok:
        print(f'[kv_lastrun] WARN: lastRun failed for {job_name}: {err}')
        # On essaie quand meme l'historique
    # 2. Append a runHistory:* (best-effort, important pour le Gantt 24h)
    append_run_history(job_name, payload)
    return ok
