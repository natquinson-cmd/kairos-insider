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


def log_last_run(job_name, status='ok', summary='', error='', duration_sec=None):
    """Ecrit un payload JSON dans la cle KV 'lastRun:{job_name}'.

    Args:
        job_name : identifiant court du job (ex: 'prefetch-all')
        status   : 'ok' | 'failed' | 'partial'
        summary  : resume court (ex: '12345 tx, 500 insiders')
        error    : message d'erreur si status=failed
        duration_sec : duree en secondes (optionnel)

    Returns:
        True si le write a reussi, False sinon (silent fail).
    """
    try:
        payload = {
            'ts': int(time.time()),
            'iso': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'status': status,
            'summary': (summary or '')[:200],  # cap pour eviter les gros KV values
            'error': (error or '')[:500],
        }
        if duration_sec is not None:
            payload['durationSec'] = round(float(duration_sec), 1)

        result = subprocess.run(
            ['npx', 'wrangler', 'kv', 'key', 'put',
             f'--namespace-id={NAMESPACE_ID}',
             '--remote',
             f'lastRun:{job_name}',
             json.dumps(payload)],
            capture_output=True, timeout=30, shell=True
        )
        if result.returncode == 0:
            return True
        # Log l'erreur mais ne l'ignore pas (pour debug dans GitHub Actions)
        err = result.stderr.decode('utf-8', errors='replace')[:200] if result.stderr else ''
        print(f'[kv_lastrun] WARN: wrangler failed for {job_name}: {err}')
        return False
    except subprocess.TimeoutExpired:
        print(f'[kv_lastrun] WARN: wrangler timeout for {job_name}')
        return False
    except Exception as e:
        print(f'[kv_lastrun] WARN: {job_name}: {e}')
        return False
