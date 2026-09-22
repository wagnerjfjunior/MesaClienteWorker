# MesaClienteWorker

Worker Cloudflare do fallback de processamento da Mesa Cliente.

## Production security contract

Production processing is server-to-server only:

```text
authenticated FECH.AI browser
→ FECH.AI /api/mesa-worker mediator
→ x-fechai-worker-key
→ POST /parse
→ Worker
→ MAKE_URL
```

The Worker must not be called directly by browser code.

### Required Worker secrets / environment

Configure in Cloudflare without committing values:

- `MESA_WORKER_SERVICE_SECRET` — current FECH.AI→Worker credential.
- `MESA_WORKER_SERVICE_SECRET_NEXT` — optional overlap credential for bounded rotation.
- `MAKE_URL` — downstream Make webhook URL.

Never place these values in GitHub, `VITE_*`, browser responses, URLs or normal logs.

## Routes

- `GET /health` — public minimal health/version response.
- `POST /parse` — requires the service credential and a bounded JSON contract.
- all other routes — 404.

## Safety boundaries

- JSON only.
- 1 MiB request ceiling.
- 900 KiB text ceiling.
- 2 MiB response ceiling.
- `mode` allowlist currently contains only `mergeY`.
- explicit downstream timeout.
- no browser CORS grant.
- no default/fallback Make webhook in source.

## Deployment order

To avoid breaking the supported fallback:

1. Provision the same production service credential in Vercel and Cloudflare.
2. Deploy the FECH.AI authenticated mediator/client migration first.
3. Confirm the mediator can reach the current Worker.
4. Deploy this Worker hardening so direct anonymous/browser processing fails closed.
5. Run non-hostile post-deploy checks and then proceed to rate/abuse controls.

Security Go remains a separate FECH.AI gate.
